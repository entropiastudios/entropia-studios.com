export const prerender = true;

import { site } from '../data/site.js';
import projects from '../data/projects.json';
import { synopses } from '../i18n/synopses.js';
import { locales } from '../i18n/ui.js';

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const playerUrl = (v) =>
  v.provider === 'youtube'
    ? `https://www.youtube.com/embed/${v.id}`
    : `https://player.vimeo.com/video/${v.id}`;

export async function GET() {
  const withVideo = projects.filter((p) => p.video);
  const urls = [];

  for (const lang of locales) {
    for (const p of withVideo) {
      const pageUrl = `${site.url}/${lang}/work/${p.slug}/`;
      const thumb = new URL(p.thumb, site.url).href;
      const title = `${p.title} — Trailer`;
      const rawDesc = synopses[p.slug]?.[lang] || synopses[p.slug]?.en || `${p.title} trailer.`;
      const description = rawDesc.replace(/^["“”]|["“”]$/g, '').slice(0, 2000);

      urls.push(
        `  <url>
    <loc>${esc(pageUrl)}</loc>
    <video:video>
      <video:thumbnail_loc>${esc(thumb)}</video:thumbnail_loc>
      <video:title>${esc(title)}</video:title>
      <video:description>${esc(description)}</video:description>
      <video:player_loc allow_embed="yes">${esc(playerUrl(p.video))}</video:player_loc>
      <video:family_friendly>yes</video:family_friendly>
      <video:requires_subscription>no</video:requires_subscription>
      <video:live>no</video:live>
    </video:video>
  </url>`
      );
    }
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${urls.join('\n')}
</urlset>
`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}
