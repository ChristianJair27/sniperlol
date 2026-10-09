// Highlights desde el VOD de Twitch (con la voz del caster) → clips del torneo en ATAK.GG.
//
// El reloj del juego no va "a tiempo" con el VOD (retraso del espectador, pausas, descansos),
// así que cada partida lleva puntos de calibración leídos a mano del reloj del overlay:
//   calib: [[segundoVOD, segundoJuego], ...]  → interpolación lineal por tramos.
// Uso:
//   node vod-clips.mjs plan.json          corta y sube; con --dry solo corta (out/vod/*.mp4)
// plan.json: { "vod": "https://www.twitch.tv/videos/…", "games": [ { "gameId": 1754175332, "calib": [[2401,353],[3001,953]], "keys": ["fight-904", …] } ] }
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
try { for (const l of fs.readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z_]+)\s*=\s*(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"|"$/g, ''); } } catch { /* sin .env */ }
const BACKEND = (process.env.ATAK_BACKEND || 'https://atakback.revolution505.com').replace(/\/$/, '');
const TOKEN = (process.env.RENDER_TOKEN || '').trim();
const REGION = 'LA1';
const FFMPEG = path.join(here, 'bin', 'ffmpeg.exe');
const ASSETS = path.join(here, 'assets');
const OUT = path.join(here, 'out', 'vod');
const DRY = process.argv.includes('--dry');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => (e ? rej(new Error(String(err || e.message).slice(-800))) : res(String(out)))));
const hms = (s) => { s = Math.max(0, Math.round(s)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const ff = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');

/** segundo de juego → segundo del VOD, interpolando entre los puntos de calibración. */
function mapT(calib, t) {
  const pts = [...calib].sort((a, b) => a[1] - b[1]);
  if (t <= pts[0][1]) return pts[0][0] - (pts[0][1] - t);
  for (let i = 1; i < pts.length; i++) {
    const [v0, g0] = pts[i - 1], [v1, g1] = pts[i];
    if (t <= g1) { const r = (t - g0) / Math.max(1, g1 - g0); return v0 + r * (v1 - v0); }
  }
  const [v, g] = pts[pts.length - 1]; return v + (t - g);
}

async function atak(p) { const r = await fetch(`${BACKEND}${p}`); if (!r.ok) throw new Error(`${p} → ${r.status}`); return r.json(); }

async function cutClip(vod, start, end, file) {
  // yt-dlp baja solo el tramo (HLS) y lo deja en mp4; luego se re-encoda con la tarjeta.
  const raw = file.replace(/\.mp4$/, '.raw.mp4');
  const ytExe = path.join(here, 'bin', 'yt-dlp.exe');
  const ytArgs = ['-q', '--no-warnings', '--force-overwrites', '--ffmpeg-location', path.dirname(FFMPEG), '--download-sections', `*${hms(start)}-${hms(end)}`, '-f', 'best[height<=1080]', '-o', raw, vod];
  if (fs.existsSync(ytExe)) await run(ytExe, ytArgs); else await run('python', ['-m', 'yt_dlp', ...ytArgs]);
  return raw;
}

async function brand(raw, mp4, m, match, brandImg) {
  const dir = path.dirname(mp4);
  const titleTxt = path.join(dir, path.basename(mp4) + '.title.txt'), metaTxt = path.join(dir, path.basename(mp4) + '.meta.txt'), brandTxt = path.join(dir, 'brand.txt');
  const who = (m.players && m.players[0]) ? ` / ${m.players[0].name}` : '';
  const title = String(m.title || '').split(' · ')[0].toUpperCase() + who.toUpperCase();
  const meta = (match.round ? `${match.team1} vs ${match.team2} · Ronda ${match.round} · Juego ${match.gameNumber} · ${mmss(m.t)}` : `${match.team1} vs ${match.team2} · ${mmss(m.t)}`).toUpperCase() + ' · STREAM';
  await fsp.writeFile(titleTxt, title, 'utf8'); await fsp.writeFile(metaTxt, meta, 'utf8'); await fsp.writeFile(brandTxt, 'ATAK.GG', 'utf8');
  const fOrb = ff(path.join(ASSETS, 'Orbitron-900.ttf')), fMono = ff(path.join(ASSETS, 'JetBrainsMono-700.ttf'));
  // Tarjeta arriba a la izquierda (abajo va el tablero del overlay del stream).
  const filter = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x020b1c[v0]`,
    `[1:v]scale=-1:34[lqc]`, `[2:v]scale=-1:40[atak]`,
    `[v0]drawbox=x=40:y=190:w=980:h=112:color=0x020b1c@0.88:t=fill:enable='lt(t,3.2)',drawbox=x=40:y=190:w=6:h=112:color=0x4ea1ff@1:t=fill:enable='lt(t,3.2)'[v1]`,
    `[v1][lqc]overlay=66:229:enable='lt(t,3.2)'[v2]`,
    `[v2]drawbox=x=196:y=203:w=1:h=86:color=0xffffff@0.35:t=fill:enable='lt(t,3.2)'[v3]`,
    `[v3]drawtext=fontfile='${fOrb}':textfile='${ff(titleTxt)}':fontcolor=white:fontsize=32:x=216:y=206:enable='lt(t,3.2)'[v4]`,
    `[v4]drawtext=fontfile='${fMono}':textfile='${ff(metaTxt)}':fontcolor=0xbcd0ee:fontsize=18:x=216:y=258:enable='lt(t,3.2)'[v5]`,
    `[v5]drawbox=x=1660:y=190:w=220:h=54:color=0x020b1c@0.88:t=fill:enable='lt(t,3.2)'[v6]`,
    `[v6][atak]overlay=1672:197:enable='lt(t,3.2)'[v7]`,
    `[v7]drawtext=fontfile='${fMono}':textfile='${ff(brandTxt)}':fontcolor=white:fontsize=22:x=1724:y=206:enable='lt(t,3.2)'[vout]`,
  ].join(';');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-i', path.join(ASSETS, brandImg), '-i', path.join(ASSETS, 'atak-logo-mark.png'),
    '-filter_complex', filter, '-map', '[vout]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', mp4]);
}

// Vertical 1080×1920 del clip del stream: la acción al centro, fondo desenfocado, tarjeta solo 3 s.
async function brandVertical(raw, mp4, m, match, brandImg) {
  const dir = path.dirname(mp4);
  const titleTxt = path.join(dir, path.basename(mp4) + '.title.txt'), metaTxt = path.join(dir, path.basename(mp4) + '.meta.txt'), brandTxt = path.join(dir, 'brand.txt');
  const who = (m.players && m.players[0]) ? ` / ${m.players[0].name}` : '';
  await fsp.writeFile(titleTxt, (String(m.title || '').split(' · ')[0] + who).toUpperCase(), 'utf8');
  await fsp.writeFile(metaTxt, `${match.team1} vs ${match.team2} · ${mmss(m.t)} · STREAM`.toUpperCase(), 'utf8');
  await fsp.writeFile(brandTxt, 'ATAK.GG', 'utf8');
  const fOrb = ff(path.join(ASSETS, 'Orbitron-900.ttf')), fMono = ff(path.join(ASSETS, 'JetBrainsMono-700.ttf'));
  const filter = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x020b1c,split=2[a][b]`,
    `[a]crop=1080:1080:420:0[sq]`,
    `[b]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:3,eq=brightness=-0.25[bg]`,
    `[bg][sq]overlay=0:420[v0]`,
    `[1:v]scale=-1:44[lqc]`, `[2:v]scale=-1:52[atak]`,
    `[v0]drawbox=x=0:y=250:w=1080:h=150:color=0x020b1c@0.85:t=fill:enable='lt(t,3.2)',drawbox=x=0:y=250:w=8:h=150:color=0x4ea1ff@1:t=fill:enable='lt(t,3.2)'[v1]`,
    `[v1][lqc]overlay=40:303:enable='lt(t,3.2)'[v2]`,
    `[v2]drawtext=fontfile='${fOrb}':textfile='${ff(titleTxt)}':fontcolor=white:fontsize=34:x=40:y=262:enable='lt(t,3.2)'[v3]`,
    `[v3]drawtext=fontfile='${fMono}':textfile='${ff(metaTxt)}':fontcolor=0xbcd0ee:fontsize=22:x=200:y=314:enable='lt(t,3.2)'[v4]`,
    `[v4]drawbox=x=0:y=1500:w=1080:h=90:color=0x020b1c@0.85:t=fill[v5]`,
    `[v5][atak]overlay=430:1519[v6]`,
    `[v6]drawtext=fontfile='${fMono}':textfile='${ff(brandTxt)}':fontcolor=white:fontsize=30:x=500:y=1530[vout]`,
  ].join(';');
  await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-i', path.join(ASSETS, brandImg), '-i', path.join(ASSETS, 'atak-logo-mark.png'),
    '-filter_complex', filter, '-map', '[vout]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', mp4]);
}


async function uploadPoster(gameId, key, mp4) {
  const jpg = mp4.replace(/\.mp4$/, '.poster.jpg');
  try {
    await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.2', '-i', mp4, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', jpg]);
    const r = await fetch(`${BACKEND}/api/replays/${REGION}/${gameId}/clips/${encodeURIComponent(key)}/poster`, { method: 'POST', body: await fsp.readFile(jpg), headers: { 'Content-Type': 'image/jpeg', 'X-Render-Token': TOKEN } });
    if (!r.ok) console.log(`    póster ${key} → ${r.status}`);
  } catch (e) { console.log(`    póster ${key}: ${e.message}`); }
  finally { try { await fsp.unlink(jpg); } catch { /* */ } }
}
async function upload(gameId, m, key, file) {
  const buf = await fsp.readFile(file);
  const ascii = (v) => JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  const r = await fetch(`${BACKEND}/api/replays/${REGION}/${gameId}/clips/${encodeURIComponent(key)}`, {
    method: 'POST', body: buf,
    headers: { 'Content-Type': 'video/mp4', 'X-Render-Token': TOKEN, 'X-Clip-Start': String(m.tStart), 'X-Clip-End': String(m.tEnd), 'X-Clip-Kind': key.startsWith('vv-') ? `vertical_stream_${m.kind}` : `stream_${m.kind}`, 'X-Clip-Title': encodeURIComponent(`${m.title} · Stream${key.startsWith('vv-') ? ' · Vertical' : ''}`), 'X-Clip-Players': ascii(m.players || []).slice(0, 1900) },
  });
  if (!r.ok) throw new Error(`subida ${key} → ${r.status} ${await r.text()}`);
  return r.json();
}

(async () => {
  await fsp.mkdir(OUT, { recursive: true });
  for (const g of plan.games) {
    const info = await atak(`/api/replays/${REGION}/${g.gameId}/moments`);
    const match = info.match || { team1: 'Azul', team2: 'Rojo', round: 0, gameNumber: 1, tournamentId: 'manual' };
    const brandImg = match.tournamentId === 'lqc-2026' ? 'lqc-wordmark.png' : 'atak-logo-mark.png';
    const want = (g.keys && g.keys.length) ? info.moments.filter((m) => g.keys.includes(m.key)) : info.top;
    const existing = new Set(DRY ? [] : ((await atak(`/api/replays/${REGION}/${g.gameId}/clips`)).clips || []).map((c) => String(c.key)));
    const wantVertical = plan.vertical !== false;
    console.log(`== ${g.gameId} (${match.team1} vs ${match.team2}) · ${want.length} clips`);
    for (const m of want) {
      const key = `vod-${m.key}`, vkey = `vv-${m.key}`;
      const needH = !existing.has(key), needV = wantVertical && !existing.has(vkey);
      if (!needH && !needV) { console.log(`  = ${m.title}: ya estaba`); continue; }
      const start = mapT(g.calib, m.tStart) - (g.pad ?? 2), end = mapT(g.calib, m.tEnd) + (g.pad ?? 2);
      const mp4 = path.join(OUT, `${g.gameId}-${key}.mp4`), vmp4 = path.join(OUT, `${g.gameId}-${vkey}.mp4`);
      try {
        console.log(`  ▶ ${m.title} · juego ${mmss(m.tStart)}–${mmss(m.tEnd)} → VOD ${hms(start)}–${hms(end)}`);
        const raw = await cutClip(plan.vod, start, end, mp4);
        if (needH) { await brand(raw, mp4, m, match, brandImg); if (!DRY) { const r = await upload(g.gameId, m, key, mp4); console.log(`    ✓ subido ${r.url}`); await uploadPoster(g.gameId, key, mp4); } }
        if (needV) { await brandVertical(raw, vmp4, m, match, brandImg); if (!DRY) { const r = await upload(g.gameId, m, vkey, vmp4); console.log(`    ✓ vertical ${r.url}`); await uploadPoster(g.gameId, vkey, vmp4); } }
        try { await fsp.unlink(raw); } catch { /* */ }
        if (DRY) console.log(`    listo (sin subir): ${mp4}`);
      } catch (e) { console.log(`    ✗ ${e.message}`); }
    }
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
