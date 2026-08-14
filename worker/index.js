// Entropía Studios — site Worker.
//
// Everything the public sees is a static file built by Astro and served from
// the ASSETS binding. This Worker only adds the private editor at /admin:
// it authenticates with a password, and writes the changes back to the
// repository through the GitHub API, which triggers the usual redeploy.
//
// Secrets it needs (Cloudflare → Workers → entropia-studios → Settings):
//   ADMIN_PASSWORD_SEBASTIAN, ADMIN_PASSWORD_JAVIER  one password per person
//   GITHUB_TOKEN    fine-grained token with Contents: read & write on the repo
// Plain vars (wrangler.jsonc): GITHUB_REPO, GIT_BRANCH.
//
// To add someone: one line in USERS below plus their own secret. Nobody shares
// a password, and every change is committed in that person's name.

import adminHtml from './admin.html';
import { headCommit, treeFiles, readTextFile, commitFiles } from './github.js';

const DATA_FILES = {
  projects: 'src/data/projects.json',
  synopses: 'src/data/synopses.json',
  awards: 'src/data/awards.json',
  about: 'src/data/about.json',
  contact: 'src/data/contact.json',
  privacy: 'src/data/privacy.json',
  site: 'src/data/site.json',
};
const PAGE_KEYS = ['about', 'contact', 'privacy', 'site'];
const BUILD_ID_FILE = 'public/build-id.txt';
// Uploads may only land in these folders, addressed by their short name.
const UPLOAD_DIRS = { projects: 'public/images/projects/', team: 'public/images/team/' };

// Keep these in sync with src/i18n/ui.js (cat.*, status.*, credit.*).
const CATEGORIES = ['Film', 'Series', 'Doc', 'Short', 'TV'];
const STATUSES = ['production', 'preproduction', 'development', 'financing'];
const CREDIT_KEYS = [
  'producedBy',
  'executiveProducers',
  'producers',
  'serviceProduction',
  'distribution',
  'starring',
  'writtenBy',
  'directedBy',
  'releaseDate',
  'runtime',
];

// Who can enter the panel. Each person has their own password, stored as its
// own Cloudflare secret — nothing is shared and nothing lives in this file.
const USERS = [
  { email: 'sebastian@entropia-studios.com', name: 'Sebastián Cepeda', secret: 'ADMIN_PASSWORD_SEBASTIAN' },
  { email: 'javier@entropia-studios.com', name: 'Javier Krause', secret: 'ADMIN_PASSWORD_JAVIER' },
];
const findUser = (email) => USERS.find((u) => u.email === String(email || '').trim().toLowerCase());

const SESSION_HOURS = 8;
const MAX_UPLOAD_BYTES = 6 * 1024 * 1024; // per file, after the browser resized it
const MAX_TOTAL_UPLOAD_BYTES = 24 * 1024 * 1024;

// ---------------------------------------------------------------- helpers

const enc = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      ...extraHeaders,
    },
  });
}

function timingSafeEqual(a, b) {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function sign(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The session is signed with that person's own password, so changing a
// password only logs that person out.
async function makeSession(env, user) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = `${user.email}|${exp}`;
  return `${btoa(payload)}.${await sign(env[user.secret], `session-v2.${payload}`)}`;
}

/** Returns the signed-in user, or null. */
async function sessionUser(env, request) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)es_session=([^;]+)/);
  if (!match) return null;
  const [encoded, sig] = decodeURIComponent(match[1]).split('.');
  if (!encoded || !sig) return null;

  let payload;
  try {
    payload = atob(encoded);
  } catch {
    return null;
  }
  const [email, exp] = payload.split('|');
  const user = findUser(email);
  if (!user || !env[user.secret]) return null;
  if (!Number(exp) || Number(exp) < Date.now()) return null;
  if (!timingSafeEqual(sig, await sign(env[user.secret], `session-v2.${payload}`))) return null;
  return user;
}

function sessionCookie(value, url, maxAge) {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `es_session=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

/** Which secrets are still missing, so /admin can say exactly what to add. */
function missingSecrets(env) {
  const missing = USERS.filter((u) => !env[u.secret]).map((u) => u.secret);
  if (!env.GITHUB_TOKEN) missing.push('GITHUB_TOKEN');
  return missing;
}
// One password is enough to work; the panel only refuses when nobody can enter.
const configured = (env) => Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO && USERS.some((u) => env[u.secret]));

// Very small brute-force brake. Per isolate, which is enough to make guessing
// impractical without adding any storage.
const attempts = new Map();
function throttle(ip) {
  const now = Date.now();
  const rec = attempts.get(ip) || { fails: 0, until: 0 };
  if (rec.until > now) return Math.ceil((rec.until - now) / 1000);
  return 0;
}
function noteFailure(ip) {
  const rec = attempts.get(ip) || { fails: 0, until: 0 };
  rec.fails += 1;
  if (rec.fails >= 5) rec.until = Date.now() + Math.min(15 * 60, 2 ** (rec.fails - 4) * 10) * 1000;
  attempts.set(ip, rec);
}

// ------------------------------------------------------------- validation

const isSlug = (s) => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 60;
const isImagePath = (s) => typeof s === 'string' && /^\/images\/projects\/[a-z0-9._-]+\.webp$/.test(s);

function validateProjects(projects) {
  if (!Array.isArray(projects) || projects.length === 0) return 'La lista de proyectos está vacía.';
  const seen = new Set();
  for (const p of projects) {
    if (!isSlug(p.slug)) return `Dirección inválida: ${p.slug}`;
    if (seen.has(p.slug)) return `Hay dos proyectos con la misma dirección: ${p.slug}`;
    seen.add(p.slug);
    if (typeof p.title !== 'string' || !p.title.trim()) return `Falta el título de ${p.slug}`;
    if (!CATEGORIES.includes(p.category)) return `Categoría inválida en ${p.slug}`;
    if (!STATUSES.includes(p.status) && !/^\d{4}$/.test(String(p.status))) return `Estado inválido en ${p.slug}`;
    if (!isImagePath(p.image) || !isImagePath(p.thumb)) return `Falta la foto de ${p.slug}`;
    for (const field of ['thumbW', 'thumbH', 'imageW', 'imageH']) {
      if (!Number.isInteger(p[field]) || p[field] <= 0) return `Medidas de foto inválidas en ${p.slug}`;
    }
    if (!Array.isArray(p.credits)) return `Créditos inválidos en ${p.slug}`;
    for (const credit of p.credits) {
      if (!Array.isArray(credit) || credit.length !== 2) return `Créditos inválidos en ${p.slug}`;
      if (!CREDIT_KEYS.includes(credit[0])) return `Tipo de crédito desconocido en ${p.slug}: ${credit[0]}`;
      if (typeof credit[1] !== 'string') return `Crédito vacío en ${p.slug}`;
    }
    if (p.video != null) {
      if (!['youtube', 'vimeo'].includes(p.video.provider)) return `Trailer inválido en ${p.slug}`;
      if (typeof p.video.id !== 'string' || !/^[A-Za-z0-9_-]{5,40}$/.test(p.video.id))
        return `Identificador de trailer inválido en ${p.slug}`;
    }
  }
  return null;
}

const isText = (v, max = 20000) => typeof v === 'string' && v.length <= max;
const isTextList = (v, max = 20000) => Array.isArray(v) && v.every((item) => isText(item, max));
const isTeamImage = (s) => typeof s === 'string' && /^\/images\/team\/[a-z0-9._-]+\.(webp|jpg|png)$/.test(s);

/** Shape checks for the page content, per locale. Returns an error or null. */
function validatePages(pages) {
  for (const key of PAGE_KEYS) {
    if (!(key in pages)) return `Falta el contenido de ${key}`;
  }

  for (const lang of ['en', 'es']) {
    const a = pages.about?.[lang];
    if (!a || !isText(a.heading, 200) || !isTextList(a.paragraphs) || !isText(a.network))
      return 'El texto de Nosotros no es válido.';
    if (!isText(a.teamHeading, 200) || !isText(a.officesHeading, 200)) return 'Los títulos de Nosotros no son válidos.';
    if (!Array.isArray(a.team)) return 'El equipo de Nosotros no es válido.';
    for (const member of a.team) {
      if (!isText(member.name, 200) || !isText(member.role, 200)) return 'Falta el nombre o el rol de alguien del equipo.';
      if (member.img && !isTeamImage(member.img)) return 'La foto de alguien del equipo no es válida.';
    }

    const c = pages.contact?.[lang];
    if (!c || !isText(c.heading, 200) || !isTextList(c.paragraphs) || !isText(c.cta, 200))
      return 'El texto de Contacto no es válido.';

    const p = pages.privacy?.[lang];
    if (!p || !isText(p.title, 200) || !isText(p.updated, 200) || !isText(p.intro))
      return 'El texto de Privacidad no es válido.';
    if (!Array.isArray(p.sections)) return 'Las secciones de Privacidad no son válidas.';
    for (const section of p.sections) {
      if (!isText(section.h, 300) || !isTextList(section.p)) return 'Una sección de Privacidad no es válida.';
    }
  }

  const s = pages.site;
  if (!s || !isText(s.name, 200) || !isText(s.legalName, 200)) return 'Faltan los datos del estudio.';
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(s.email || '')) return 'El email del estudio no es válido.';
  if (!Array.isArray(s.offices) || !s.offices.length) return 'Tiene que haber al menos una oficina.';
  for (const office of s.offices) {
    for (const field of ['country', 'name', 'street', 'city']) {
      if (!isText(office[field], 200)) return 'Faltan datos en una de las oficinas.';
    }
  }
  if (!Array.isArray(s.socials)) return 'Las redes sociales no son válidas.';
  for (const social of s.socials) {
    if (!isText(social.name, 100)) return 'Falta el nombre de una red social.';
    if (!/^https?:\/\/\S+$/.test(social.url || '')) return `El enlace de ${social.name} tiene que empezar con https://`;
  }
  return null;
}

function validateTexts(map, slugs, label) {
  if (typeof map !== 'object' || map === null) return `${label}: formato inválido`;
  for (const [slug, value] of Object.entries(map)) {
    if (!slugs.has(slug)) return `${label}: ${slug} no es un proyecto`;
    if (typeof value !== 'object' || value === null) return `${label}: formato inválido en ${slug}`;
    for (const [lang, text] of Object.entries(value)) {
      if (!['en', 'es'].includes(lang)) return `${label}: idioma desconocido en ${slug}`;
      if (typeof text !== 'string' || text.length > 20000) return `${label}: texto inválido en ${slug}`;
    }
  }
  return null;
}

// ------------------------------------------------------------------ admin

async function handleLogin(request, env, url) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const wait = throttle(ip);
  if (wait) return json({ error: `Demasiados intentos. Probá de nuevo en ${wait} segundos.` }, 429);

  const { email, password } = await request.json().catch(() => ({}));
  const user = findUser(email);
  const stored = user && env[user.secret];
  if (!stored || typeof password !== 'string' || !timingSafeEqual(password, stored)) {
    noteFailure(ip);
    // Same message either way: no need to tell a stranger which email exists.
    return json({ error: 'Email o contraseña incorrectos.' }, 401);
  }
  attempts.delete(ip);
  return json(
    { ok: true, name: user.name },
    200,
    { 'set-cookie': sessionCookie(await makeSession(env, user), url, SESSION_HOURS * 3600) }
  );
}

async function handleData(env) {
  const commit = await headCommit(env);
  const names = Object.keys(DATA_FILES);
  const contents = await Promise.all(names.map((name) => readTextFile(env, DATA_FILES[name], commit)));

  const loaded = {};
  names.forEach((name, i) => {
    // Never fall back to empty data: publishing on top of it would wipe the
    // site's content. If a file is missing, something is wrong upstream.
    if (contents[i] === null) throw new Error(`falta el archivo de ${name} en el repositorio`);
    loaded[name] = JSON.parse(contents[i]);
  });

  const pages = {};
  for (const key of PAGE_KEYS) pages[key] = loaded[key];

  return json({
    commit,
    projects: loaded.projects,
    synopses: loaded.synopses,
    awards: loaded.awards,
    pages,
    options: { categories: CATEGORIES, statuses: STATUSES, creditKeys: CREDIT_KEYS },
  });
}

async function handlePublish(request, env, user) {
  const body = await request.json();
  const { projects, synopses, awards, pages, uploads = [], message, baseCommit } = body;

  const invalid =
    validateProjects(projects) ||
    validateTexts(synopses, new Set(projects.map((p) => p.slug)), 'Sinopsis') ||
    validateTexts(awards, new Set(projects.map((p) => p.slug)), 'Premios') ||
    validatePages(pages || {});
  if (invalid) return json({ error: invalid }, 400);

  let total = 0;
  for (const up of uploads) {
    if (!UPLOAD_DIRS[up.dir]) return json({ error: `Destino de imagen inválido: ${up.dir}` }, 400);
    if (!/^[a-z0-9._-]+\.webp$/.test(up.name || '')) return json({ error: `Nombre de imagen inválido: ${up.name}` }, 400);
    const bytes = Math.floor((up.base64?.length || 0) * 0.75);
    total += bytes;
    if (bytes > MAX_UPLOAD_BYTES) return json({ error: 'Una de las fotos es demasiado pesada.' }, 400);
  }
  if (total > MAX_TOTAL_UPLOAD_BYTES) return json({ error: 'Las fotos pesan demasiado en total.' }, 400);

  const head = await headCommit(env);
  if (baseCommit && baseCommit !== head) {
    return json({ error: 'Alguien más publicó un cambio mientras editabas. Recargá la página y volvé a intentarlo.' }, 409);
  }

  // Every image referenced must exist in the repo or be uploaded right now.
  const { files } = await treeFiles(env, head);
  const incoming = new Set(uploads.map((u) => UPLOAD_DIRS[u.dir] + u.name));
  const missing = (ref) => !files.has('public' + ref) && !incoming.has('public' + ref);
  for (const p of projects) {
    for (const ref of [p.image, p.thumb]) {
      if (missing(ref)) return json({ error: `Falta la foto de ${p.slug}.` }, 400);
    }
  }
  for (const lang of ['en', 'es']) {
    for (const member of pages.about[lang].team) {
      if (member.img && missing(member.img)) return json({ error: `Falta la foto de ${member.name}.` }, 400);
    }
  }

  const buildId = `${Date.now()}`;
  const texts = {
    [DATA_FILES.projects]: JSON.stringify(projects, null, 2) + '\n',
    [DATA_FILES.synopses]: JSON.stringify(synopses, null, 2) + '\n',
    [DATA_FILES.awards]: JSON.stringify(awards, null, 2) + '\n',
    [BUILD_ID_FILE]: buildId + '\n',
  };
  for (const key of PAGE_KEYS) texts[DATA_FILES[key]] = JSON.stringify(pages[key], null, 2) + '\n';

  const newCommit = await commitFiles(env, {
    baseCommit: head,
    message: message || 'Panel: actualización del sitio',
    texts,
    uploads: uploads.map((u) => ({ path: UPLOAD_DIRS[u.dir] + u.name, base64: u.base64 })),
    // So the history says who changed what, not just "the panel".
    author: { name: user.name, email: user.email },
  });

  return json({ ok: true, commit: newCommit, buildId });
}

async function handleApi(request, env, url) {
  const path = url.pathname;

  if (path === '/api/admin/login' && request.method === 'POST') {
    if (!configured(env)) return json({ error: 'setup' }, 503);
    return handleLogin(request, env, url);
  }

  if (path === '/api/admin/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', url, 0) });
  }

  if (path === '/api/admin/session') {
    const user = configured(env) ? await sessionUser(env, request) : null;
    return json({
      configured: configured(env),
      missing: missingSecrets(env),
      authenticated: Boolean(user),
      name: user ? user.name : null,
    });
  }

  if (!configured(env)) return json({ error: 'El panel todavía no está configurado.' }, 503);
  const user = await sessionUser(env, request);
  if (!user) return json({ error: 'Sesión vencida. Volvé a entrar.' }, 401);

  try {
    if (path === '/api/admin/data' && request.method === 'GET') return await handleData(env);
    if (path === '/api/admin/publish' && request.method === 'POST') return await handlePublish(request, env, user);
  } catch (err) {
    return json({ error: `No se pudo guardar: ${err.message}` }, 502);
  }

  return json({ error: 'No encontrado' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(adminHtml, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
        },
      });
    }

    if (url.pathname.startsWith('/api/admin/')) return handleApi(request, env, url);

    return env.ASSETS.fetch(request);
  },
};
