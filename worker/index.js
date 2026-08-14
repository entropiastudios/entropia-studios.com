// Entropía Studios — site Worker.
//
// Everything the public sees is a static file built by Astro and served from
// the ASSETS binding. This Worker only adds the private editor at /admin:
// it authenticates with a password, and writes the changes back to the
// repository through the GitHub API, which triggers the usual redeploy.
//
// Secrets it needs (Cloudflare → Workers → entropia-studios → Settings):
//   ADMIN_PASSWORD  the password for /admin
//   GITHUB_TOKEN    fine-grained token with Contents: read & write on the repo
// Plain vars (wrangler.jsonc): GITHUB_REPO, GIT_BRANCH.

import adminHtml from './admin.html';
import { headCommit, treeFiles, readTextFile, commitFiles } from './github.js';

const DATA_FILES = {
  projects: 'src/data/projects.json',
  synopses: 'src/data/synopses.json',
  awards: 'src/data/awards.json',
};
const BUILD_ID_FILE = 'public/build-id.txt';
const IMAGE_DIR = 'public/images/projects/';

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

async function makeSession(env) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  return `${exp}.${await sign(env.ADMIN_PASSWORD, `session-v1.${exp}`)}`;
}

async function validSession(env, request) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)es_session=([^;]+)/);
  if (!match) return false;
  const [exp, sig] = decodeURIComponent(match[1]).split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now()) return false;
  return timingSafeEqual(sig, await sign(env.ADMIN_PASSWORD, `session-v1.${exp}`));
}

function sessionCookie(value, url, maxAge) {
  const secure = url.protocol === 'https:' ? ' Secure;' : '';
  return `es_session=${value}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${maxAge}`;
}

const configured = (env) => Boolean(env.ADMIN_PASSWORD && env.GITHUB_TOKEN && env.GITHUB_REPO);

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

  const { password } = await request.json().catch(() => ({}));
  if (typeof password !== 'string' || !timingSafeEqual(password, env.ADMIN_PASSWORD)) {
    noteFailure(ip);
    return json({ error: 'Contraseña incorrecta.' }, 401);
  }
  attempts.delete(ip);
  return json(
    { ok: true },
    200,
    { 'set-cookie': sessionCookie(await makeSession(env), url, SESSION_HOURS * 3600) }
  );
}

async function handleData(env) {
  const commit = await headCommit(env);
  const [projects, synopses, awards] = await Promise.all(
    Object.values(DATA_FILES).map((path) => readTextFile(env, path, commit))
  );
  // Never fall back to empty data: publishing on top of it would wipe the
  // site's content. If a file is missing, something is wrong upstream.
  for (const [name, content] of Object.entries({ projects, synopses, awards })) {
    if (content === null) throw new Error(`falta el archivo de ${name} en el repositorio`);
  }
  return json({
    commit,
    projects: JSON.parse(projects),
    synopses: JSON.parse(synopses),
    awards: JSON.parse(awards),
    options: { categories: CATEGORIES, statuses: STATUSES, creditKeys: CREDIT_KEYS },
  });
}

async function handlePublish(request, env) {
  const body = await request.json();
  const { projects, synopses, awards, uploads = [], message, baseCommit } = body;

  const invalid =
    validateProjects(projects) ||
    validateTexts(synopses, new Set(projects.map((p) => p.slug)), 'Sinopsis') ||
    validateTexts(awards, new Set(projects.map((p) => p.slug)), 'Premios');
  if (invalid) return json({ error: invalid }, 400);

  let total = 0;
  for (const up of uploads) {
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
  const incoming = new Set(uploads.map((u) => IMAGE_DIR + u.name));
  for (const p of projects) {
    for (const ref of [p.image, p.thumb]) {
      const path = 'public' + ref;
      if (!files.has(path) && !incoming.has(path)) return json({ error: `Falta la foto de ${p.slug}.` }, 400);
    }
  }

  const buildId = `${Date.now()}`;
  const newCommit = await commitFiles(env, {
    baseCommit: head,
    message: message || 'Panel: actualización de proyectos',
    texts: {
      [DATA_FILES.projects]: JSON.stringify(projects, null, 2) + '\n',
      [DATA_FILES.synopses]: JSON.stringify(synopses, null, 2) + '\n',
      [DATA_FILES.awards]: JSON.stringify(awards, null, 2) + '\n',
      [BUILD_ID_FILE]: buildId + '\n',
    },
    uploads: uploads.map((u) => ({ path: IMAGE_DIR + u.name, base64: u.base64 })),
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
    return json({ configured: configured(env), authenticated: configured(env) && (await validSession(env, request)) });
  }

  if (!configured(env)) return json({ error: 'El panel todavía no está configurado.' }, 503);
  if (!(await validSession(env, request))) return json({ error: 'Sesión vencida. Volvé a entrar.' }, 401);

  try {
    if (path === '/api/admin/data' && request.method === 'GET') return await handleData(env);
    if (path === '/api/admin/publish' && request.method === 'POST') return await handlePublish(request, env);
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
