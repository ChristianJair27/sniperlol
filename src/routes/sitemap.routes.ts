// Sitemap dinámico para buscadores: páginas fijas + torneos públicos + perfiles
// de invocador buscados (long tail "Nombre#TAG stats") + páginas de campeón. El frontend lo declara
// en robots.txt (Sitemap: https://atakback…/api/sitemap.xml); Google acepta
// sitemaps en otro host cuando vienen de robots.txt. Caché de 30 min.
import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();
const SITE = (process.env.CLIENT_URL || process.env.WEB_ORIGIN || 'https://atakgg.revolution505.com').replace(/\/$/, '');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
let cache: { at: number; xml: string } | null = null;

const STATIC: Array<[string, string, string]> = [
  ['/', 'daily', '1.0'], ['/tournaments', 'daily', '0.9'], ['/crear-torneo', 'monthly', '0.8'],
  ['/stats', 'weekly', '0.8'], ['/meta', 'daily', '0.7'], ['/social', 'daily', '0.6'], ['/companion', 'monthly', '0.8'],
];

let champCache: { at: number; ids: string[] } | null = null;
async function championIds(): Promise<string[]> {
  if (champCache && Date.now() - champCache.at < 24 * 3600_000) return champCache.ids;
  try {
    const sig = () => AbortSignal.timeout(8000);
    const [v] = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json', { signal: sig() })).json() as string[];
    const data = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${v}/data/es_MX/champion.json`, { signal: sig() })).json() as { data: Record<string, { id: string }> };
    champCache = { at: Date.now(), ids: Object.values(data.data).map((c) => c.id).sort() };
  } catch (e: any) { console.warn('[sitemap] campeones:', e.message); }
  return champCache?.ids ?? [];
}

async function build(): Promise<string> {
  const urls: string[] = [];
  const add = (path: string, changefreq: string, priority: string, lastmod?: string | Date | null) => {
    const lm = lastmod ? new Date(lastmod) : null;
    urls.push(`  <url><loc>${esc(SITE + path)}</loc>${lm && !isNaN(lm.getTime()) ? `<lastmod>${lm.toISOString().slice(0, 10)}</lastmod>` : ''}<changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`);
  };
  for (const [p, f, pr] of STATIC) add(p, f, pr);
  try {
    const [ts] = await pool.query<any[]>("SELECT id, phase, created_at FROM tournaments WHERE COALESCE(hidden,0)=0 AND COALESCE(archived,0)=0 AND COALESCE(is_private,0)=0 AND name NOT REGEXP 'prueba|test|demo' ORDER BY created_at DESC LIMIT 500");
    for (const t of ts) add(`/tournaments/${encodeURIComponent(t.id)}`, t.phase === 'active' ? 'hourly' : t.phase === 'complete' ? 'monthly' : 'daily', t.phase === 'complete' ? '0.6' : '0.9', t.created_at);
  } catch (e: any) { console.warn('[sitemap] torneos:', e.message); }
  try {
    const [ps] = await pool.query<any[]>('SELECT game_name, tag_line, platform, last_seen FROM seen_summoners WHERE searches >= 2 ORDER BY searches DESC, last_seen DESC LIMIT 2000');
    for (const p of ps) add(`/stats/${encodeURIComponent(String(p.platform || 'la1').toLowerCase())}/${encodeURIComponent(`${p.game_name}#${p.tag_line}`)}`, 'weekly', '0.5', p.last_seen);
  } catch (e: any) { console.warn('[sitemap] invocadores:', e.message); }
  // Campeones: long tail "build/runas/counters de <campeón>" (la página más buscada de cualquier sitio de LoL).
  for (const id of await championIds()) add(`/champion/${encodeURIComponent(id)}`, 'weekly', '0.7');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

router.get(['/sitemap.xml', '/api/sitemap.xml'], async (_req, res) => {
  try {
    if (!cache || Date.now() - cache.at > 30 * 60_000) cache = { at: Date.now(), xml: await build() };
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=1800');
    res.send(cache.xml);
  } catch (e: any) { res.status(500).send(`<!-- sitemap error: ${esc(e.message)} -->`); }
});

export default router;
