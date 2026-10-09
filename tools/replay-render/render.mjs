#!/usr/bin/env node
// ATAK.GG · worker de render de highlights (Windows, junto al cliente de League).
//
// Flujo por partida:
//   1. Pide a ATAK.GG los "momentos clave" del juego (timeline de Riot).
//   2. Hace que el cliente de League baje el replay (.rofl) y lo abra.
//   3. Con la Replay API del juego (https://127.0.0.1:2999/replay/*) salta a cada
//      momento, coloca la cámara y graba un clip (webm) con /replay/recording.
//   4. Convierte a MP4 con ffmpeg y lo sube a ATAK.GG (POST /api/replays/…/clips).
//   5. Cierra el juego.
//
// Requisitos: cliente de League abierto y logueado, en reposo (no en partida);
// game.cfg con EnableReplayApi=1 (el worker lo añade si falta); ffmpeg en PATH;
// archivo .env junto a este script con RENDER_TOKEN=… (y opcional ATAK_BACKEND).
//
//   node render.mjs --game 1753784829 [--region LA1] [--top 6] [--keep]
//   node render.mjs --tournament lqc-2026            → todas las partidas sin clips
//   node render.mjs --tournament lqc-2026 --watch    → se queda vigilando (cada 10 min)
//   --direct   abre el replay lanzando "League of Legends.exe <archivo.rofl>" sin pasar
//              por el cliente (no hace falta sesión iniciada en League): baja el .rofl de
//              ATAK.GG. Pensado para correr en una sesión de Windows aparte ("tilin").
//
// La Replay API y la Live Client API del juego comparten el puerto 2999: si hay una
// partida en curso en ESTA máquina (en cualquier sesión), el worker espera a que termine.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// .env sencillo (sin dependencias).
try { for (const l of fs.readFileSync(path.join(here, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ''); } } catch { /* sin .env */ }

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d; };
const BACKEND = (process.env.ATAK_BACKEND || 'https://atakback.revolution505.com').replace(/\/$/, '');
const TOKEN = (process.env.RENDER_TOKEN || '').trim();
const REGION = String(opt('region', process.env.REGION || 'LA1')).toUpperCase();
const TOP = Number(opt('top', 6)) || 6;
const KEEP = !!opt('keep', false);
const LOL_DIR = process.env.LOL_DIR || 'C:\\Riot Games\\League of Legends';
const OUT = process.env.OUT_DIR || path.join(os.tmpdir(), 'atak-render');
const ROFL_DIR = process.env.ROFL_DIR || path.join(OUT, 'rofl');
let DIRECT = !!opt('direct', false);
const FFMPEG = process.env.FFMPEG || (fs.existsSync(path.join(here, 'bin', 'ffmpeg.exe')) ? path.join(here, 'bin', 'ffmpeg.exe') : 'ffmpeg');
const FPS = Number(process.env.FPS || 30);
const WIDTH = Number(process.env.WIDTH || 1920), HEIGHT = Number(process.env.HEIGHT || 1080);
const REPLAY_API = 'https://127.0.0.1:2999';
const ASSETS_URL = process.env.AGENT_UPDATE_URL ? `${process.env.AGENT_UPDATE_URL.replace(/\/$/, '')}/assets` : '';
const ASSETS_DIR = path.join(here, 'assets');
const ASSET_FILES = ['Orbitron-900.ttf', 'JetBrainsMono-700.ttf', 'lqc-wordmark.png', 'atak-logo-mark.png'];
const insecure = new https.Agent({ rejectUnauthorized: false });

// Log también a archivo en la carpeta del worker (legible desde otra sesión de Windows).
const LOG_FILE = path.join(here, 'out', 'worker.log');
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch { /* */ }
const log = (...a) => { const line = `${new Date().toLocaleString('es-MX')} ${a.join(' ')}`; if (!process.env.ATAK_QUIET) console.log(line); try { fs.appendFileSync(LOG_FILE, line + os.EOL); } catch { /* */ } };
// config.json (opcional) se relee en cada ciclo de --watch: { "enabled": true, "top": 6, "tournament": "lqc-2026" }
function readConfig() { try { return JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8')); } catch { return {}; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!TOKEN) { console.error('Falta RENDER_TOKEN en .env'); process.exit(1); }

// ── LCU ──────────────────────────────────────────────────────────────────────
// Varios usuarios de Windows comparten la instalación (y el lockfile), así que
// el cliente se localiza por su proceso LeagueClientUx.exe DE ESTA SESIÓN
// (--app-port / --remoting-auth-token). El lockfile solo como respaldo.
let lockCache = null;
function lockfile() {
  if (lockCache && Date.now() - lockCache.at < 30_000) return lockCache.v;
  let v = null;
  try {
    const ps = "$me=(Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\").SessionId; Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Where-Object { $_.SessionId -eq $me } | Select-Object -First 1 -ExpandProperty CommandLine";
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 }).toString();
    const port = /--app-port=(\d+)/.exec(out)?.[1], pw = /--remoting-auth-token=([\w-]+)/.exec(out)?.[1];
    if (port && pw) v = { port: Number(port), pw };
  } catch { /* sin PowerShell o sin cliente en esta sesión */ }
  if (!v) {
    for (const p of [path.join(LOL_DIR, 'lockfile')]) {
      try { const [, , port, pw] = fs.readFileSync(p, 'utf8').split(':'); if (port && pw) v = { port: Number(port), pw }; } catch { /* siguiente */ }
    }
  }
  lockCache = { at: Date.now(), v };
  return v;
}
// fetch de Node no acepta `agent`; para HTTPS local autofirmado usamos https.request.
function httpsJson(method, url, body, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: insecure, headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': payload.length } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let d = null; try { d = JSON.parse(b); } catch { d = b; } resolve({ status: res.statusCode || 0, data: d }); });
    });
    req.on('error', reject); req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload); req.end();
  });
}
async function lcuReq(method, p, body, timeoutMs = 20_000) {
  const lf = lockfile(); if (!lf) throw new Error('Cliente de League no detectado (lockfile)');
  return httpsJson(method, `https://127.0.0.1:${lf.port}${p}`, body, { Authorization: `Basic ${Buffer.from(`riot:${lf.pw}`).toString('base64')}` }, timeoutMs);
}
const replay = (method, p, body) => httpsJson(method, `${REPLAY_API}${p}`, body);

// ── game.cfg: EnableReplayApi=1 ─────────────────────────────────────────────
function ensureReplayApi() {
  const cfg = path.join(LOL_DIR, 'Config', 'game.cfg');
  let s = ''; try { s = fs.readFileSync(cfg, 'utf8'); } catch { log('No encuentro game.cfg en', cfg, '— sigo igual'); return; }
  if (/^\s*EnableReplayApi\s*=\s*1/mi.test(s)) return;
  if (/^\s*EnableReplayApi\s*=/mi.test(s)) s = s.replace(/^\s*EnableReplayApi\s*=.*$/mi, 'EnableReplayApi=1');
  else if (/^\[General\]/m.test(s)) s = s.replace(/^\[General\]\s*$/m, '[General]\r\nEnableReplayApi=1');
  else s += '\r\n[General]\r\nEnableReplayApi=1\r\n';
  fs.writeFileSync(cfg, s); log('game.cfg: EnableReplayApi=1 activado');
}

// ── ATAK.GG ──────────────────────────────────────────────────────────────────
async function atak(p) { const r = await fetch(`${BACKEND}${p}`); if (!r.ok) throw new Error(`${p} → ${r.status}`); return r.json(); }
// Las cabeceras HTTP solo admiten Latin-1: los nombres con otros caracteres se escapan como \uXXXX (sigue siendo JSON valido).
const asciiJson = (v) => JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
async function uploadClip(gameId, m, file) {
  const buf = await fsp.readFile(file);
  const r = await fetch(`${BACKEND}/api/replays/${REGION}/${gameId}/clips/${encodeURIComponent(m.key)}`, {
    method: 'POST', body: buf,
    headers: { 'Content-Type': 'video/mp4', 'X-Render-Token': TOKEN, 'X-Clip-Start': String(m.tStart), 'X-Clip-End': String(m.tEnd), 'X-Clip-Kind': m.kind, 'X-Clip-Title': encodeURIComponent(m.title), 'X-Clip-Players': asciiJson(m.players || []).slice(0, 1900) },
  });
  if (!r.ok) throw new Error(`subida ${m.key} → ${r.status} ${await r.text()}`);
  return r.json();
}

// ── Assets del overlay (fuentes y logos), bajados del host si faltan ───────────
async function ensureAssets() {
  await fsp.mkdir(ASSETS_DIR, { recursive: true });
  for (const f of ASSET_FILES) {
    const dst = path.join(ASSETS_DIR, f);
    if (fs.existsSync(dst) && fs.statSync(dst).size > 1000) continue;
    if (!ASSETS_URL) continue;
    try { const r = await fetch(`${ASSETS_URL}/${f}`); if (r.ok) await fsp.writeFile(dst, Buffer.from(await r.arrayBuffer())); } catch { /* sin overlay */ }
  }
  return ASSET_FILES.every((f) => fs.existsSync(path.join(ASSETS_DIR, f)));
}
// ffmpeg: rutas con barras normales y ':' escapado para los filtros.
const ff = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** Convierte el webm a MP4 1920×1080 con el overlay de la liga (título del momento, serie, ronda, hora). */
async function encodeClip(webm, mp4, m, match) {
  const hasAssets = await ensureAssets();
  const base = ['-i', webm];
  if (!hasAssets) {
    await ffmpeg([...base, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
    return;
  }
  const tdir = path.dirname(mp4);
  const titleTxt = path.join(tdir, 'ov-title.txt'), metaTxt = path.join(tdir, 'ov-meta.txt'), brandTxt = path.join(tdir, 'ov-brand.txt');
  // Orbitron no tiene el punto medio: el título usa " / " (como los rótulos de la liga).
  const title = String(m.title || '').split(' · ')[0].toUpperCase();
  const who = (m.players && m.players[0]) ? ` / ${m.players[0].name}` : '';
  const meta = match ? (match.round ? `${match.team1} vs ${match.team2} · Ronda ${match.round} · Juego ${match.gameNumber} · ${mmss(m.t)}` : `${match.team1} vs ${match.team2} · ${mmss(m.t)}`) : mmss(m.t);
  const brandImg = match && match.tournamentId === 'lqc-2026' ? 'lqc-wordmark.png' : 'atak-logo-mark.png';
  await fsp.writeFile(titleTxt, title + who.toUpperCase(), 'utf8');
  await fsp.writeFile(metaTxt, meta.toUpperCase(), 'utf8');
  await fsp.writeFile(brandTxt, 'ATAK.GG', 'utf8');
  const fOrb = ff(path.join(ASSETS_DIR, 'Orbitron-900.ttf')), fMono = ff(path.join(ASSETS_DIR, 'JetBrainsMono-700.ttf'));
  const filter = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x020b1c[v0]`,
    `[1:v]scale=-1:40[lqc]`,
    `[2:v]scale=-1:44[atak]`,
    `[v0]drawbox=x=60:y=890:w=1120:h=130:color=0x020b1c@0.88:t=fill,drawbox=x=60:y=890:w=6:h=130:color=0x4ea1ff@1:t=fill,drawbox=x=66:y=890:w=1114:h=1:color=0x60a5ff@0.5:t=fill[v1]`,
    `[v1][lqc]overlay=90:935[v2]`,
    `[v2]drawbox=x=226:y=905:w=1:h=100:color=0xffffff@0.35:t=fill[v3]`,
    `[v3]drawtext=fontfile='${fOrb}':textfile='${ff(titleTxt)}':fontcolor=white:fontsize=36:x=250:y=908:borderw=0:shadowcolor=0x3f97ff@0.8:shadowx=0:shadowy=0[v4]`,
    `[v4]drawtext=fontfile='${fMono}':textfile='${ff(metaTxt)}':fontcolor=0xbcd0ee:fontsize=20:x=250:y=966[v5]`,
    `[v5]drawbox=x=1420:y=962:w=220:h=58:color=0x020b1c@0.88:t=fill[v6]`,
    `[v6][atak]overlay=1434:969[v7]`,
    `[v7]drawtext=fontfile='${fMono}':textfile='${ff(brandTxt)}':fontcolor=white:fontsize=22:x=1490:y=980[vout]`,
  ].join(';');
  await ffmpeg(['-i', webm, '-i', path.join(ASSETS_DIR, brandImg), '-i', path.join(ASSETS_DIR, 'atak-logo-mark.png'),
    '-filter_complex', filter, '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
}

// ── Versión vertical 1080×1920 (redes): la acción al centro, fondo desenfocado y tarjeta arriba ──
async function encodeVertical(webm, mp4, m, match) {
  const tdir = path.dirname(mp4);
  const titleTxt = path.join(tdir, 'ov-title.txt'), metaTxt = path.join(tdir, 'ov-meta.txt'), brandTxt = path.join(tdir, 'ov-brand.txt');
  const brandImg = match && match.tournamentId === 'lqc-2026' ? 'lqc-wordmark.png' : 'atak-logo-mark.png';
  const fOrb = ff(path.join(ASSETS_DIR, 'Orbitron-900.ttf')), fMono = ff(path.join(ASSETS_DIR, 'JetBrainsMono-700.ttf'));
  const filter = [
    `[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x020b1c,split=2[a][b]`,
    `[a]crop=1080:1080:420:0[sq]`,
    `[b]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:3,eq=brightness=-0.25[bg]`,
    `[bg][sq]overlay=0:420[v0]`,
    `[1:v]scale=-1:44[lqc]`, `[2:v]scale=-1:52[atak]`,
    `[v0]drawbox=x=0:y=250:w=1080:h=150:color=0x020b1c@0.85:t=fill,drawbox=x=0:y=250:w=8:h=150:color=0x4ea1ff@1:t=fill[v1]`,
    `[v1][lqc]overlay=40:303[v2]`,
    `[v2]drawtext=fontfile='${fOrb}':textfile='${ff(titleTxt)}':fontcolor=white:fontsize=34:x=40:y=262:borderw=0[v3]`,
    `[v3]drawtext=fontfile='${fMono}':textfile='${ff(metaTxt)}':fontcolor=0xbcd0ee:fontsize=22:x=200:y=314[v4]`,
    `[v4]drawbox=x=0:y=1500:w=1080:h=90:color=0x020b1c@0.85:t=fill[v5]`,
    `[v5][atak]overlay=430:1519[v6]`,
    `[v6]drawtext=fontfile='${fMono}':textfile='${ff(brandTxt)}':fontcolor=white:fontsize=30:x=500:y=1530[vout]`,
  ].join(';');
  // Los textos ya los escribió encodeClip (misma carpeta); si no existen, se escriben aquí.
  if (!fs.existsSync(titleTxt)) { const who = (m.players && m.players[0]) ? ` / ${m.players[0].name}` : ''; await fsp.writeFile(titleTxt, (String(m.title || '').split(' · ')[0] + who).toUpperCase(), 'utf8'); }
  if (!fs.existsSync(metaTxt)) await fsp.writeFile(metaTxt, (match ? `${match.team1} vs ${match.team2} · ${mmss(m.t)}` : mmss(m.t)).toUpperCase(), 'utf8');
  if (!fs.existsSync(brandTxt)) await fsp.writeFile(brandTxt, 'ATAK.GG', 'utf8');
  await ffmpeg(['-i', webm, '-i', path.join(ASSETS_DIR, brandImg), '-i', path.join(ASSETS_DIR, 'atak-logo-mark.png'),
    '-filter_complex', filter, '-map', '[vout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
}

// ── ffmpeg ───────────────────────────────────────────────────────────────────
function ffmpeg(argv) { return new Promise((res, rej) => execFile(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { windowsHide: true }, (e, _o, err) => (e ? rej(new Error(err || e.message)) : res()))); }

// ── Puerto 2999 libre (sin partida en curso en la máquina) ───────────────────
function port2999Busy() {
  return new Promise((resolve) => execFile('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }, (e, out) => resolve(!e && /:2999\s+\S+\s+LISTENING/i.test(out || ''))));
}
async function waitPortFree(maxMin = 120) {
  for (let i = 0; i < maxMin * 6; i++) {
    if (!(await port2999Busy())) return true;
    if (i % 6 === 0) log('Hay una partida/replay usando el puerto 2999 en esta máquina: esperando…');
    await sleep(10_000);
  }
  return false;
}

// ── Modo directo: .rofl desde ATAK.GG + "League of Legends.exe <rofl>" ───────
async function downloadRofl(gameId) {
  await fsp.mkdir(ROFL_DIR, { recursive: true });
  const file = path.join(ROFL_DIR, `${REGION}-${gameId}.rofl`);
  if (fs.existsSync(file) && fs.statSync(file).size > 64 * 1024) return file;
  log('Bajando el replay de ATAK.GG…');
  const r = await fetch(`${BACKEND}/api/replays/${REGION}/${gameId}`);
  if (!r.ok) throw new Error(`ATAK.GG no tiene el replay (${r.status})`);
  await fsp.writeFile(file, Buffer.from(await r.arrayBuffer()));
  return file;
}
// Idioma instalado: el juego exige el WAD Localized/Global.<locale>.wad.client de la instalación
// (es_MX en la del jugador, en_US en otras). Se detecta por los archivos presentes.
function detectLocale() {
  try {
    const dir = path.join(LOL_DIR, 'Game', 'DATA', 'FINAL', 'Localized');
    const found = fs.readdirSync(dir).map((f) => /^Global\.([a-z]{2}_[A-Z]{2})\.wad\.client$/.exec(f)?.[1]).filter(Boolean);
    const pref = ['es_MX', 'es_ES', 'en_US'];
    return pref.find((l) => found.includes(l)) || found[0] || 'en_US';
  } catch { return 'en_US'; }
}
function launchDirect(rofl) {
  const exe = path.join(LOL_DIR, 'Game', 'League of Legends.exe');
  if (!fs.existsSync(exe)) throw new Error(`no encuentro ${exe}`);
  // Si un arranque anterior dejó marca de reparación, quitarla (en la VM no hay parcheador).
  try { fs.unlinkSync(path.join(LOL_DIR, 'SOFT_REPAIR')); } catch { /* no existía */ }
  const locale = detectLocale();
  log(`Idioma del juego: ${locale}`);
  log('Abriendo el replay directamente con el juego…');
  // Primer intento: CreateProcess directo. Solo si Windows lo niega (EPERM: p. ej. políticas
  // de la sesión o "ejecutar como administrador" en el exe) se intenta por ShellExecute.
  return new Promise((resolve) => {
    let failed = false;
    try {
      // Mismos argumentos que usa el cliente al abrir un replay (ver r3dlog): sin -GameBaseDir el juego
      // no encuentra Config\game.cfg (y con ello EnableReplayApi y el modo ventana).
      const args = [rofl, `-GameBaseDir=${LOL_DIR}`, `-Region=${REGION}`, `-PlatformID=${REGION}`, `-Locale=${locale}`, '-SkipBuild', '-EnableCrashpad=false'];
      const child = spawn(exe, args, { cwd: path.join(LOL_DIR, 'Game'), detached: true, stdio: 'ignore', windowsHide: false });
      child.on('error', (e) => { failed = true; log('spawn directo falló:', e.code || e.message, '→ intento con start'); });
      child.unref();
    } catch (e) { failed = true; log('spawn directo falló:', e.code || e.message, '→ intento con start'); }
    setTimeout(() => {
      if (failed) {
        const viaStart = spawn('cmd.exe', ['/c', 'start', '""', '/D', path.join(LOL_DIR, 'Game'), exe, rofl, `-GameBaseDir=${LOL_DIR}`, `-Region=${REGION}`, `-PlatformID=${REGION}`, `-Locale=${locale}`, '-SkipBuild', '-EnableCrashpad=false'], { detached: true, stdio: 'ignore', windowsHide: true });
        viaStart.on('error', (e) => log('start falló:', e.code || e.message));
        viaStart.unref();
      }
      resolve();
    }, 3000);
  });
}

// Cola del último r3dlog del juego (diagnóstico cuando no arranca o no responde la Replay API).
function dumpGameLog(n = 40) {
  try {
    const root = path.join(LOL_DIR, 'Logs', 'GameLogs');
    const dirs = fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.statSync(d).isDirectory()).sort().reverse();
    if (!dirs.length) { log('  (sin logs del juego en', root + ')'); return; }
    const f = fs.readdirSync(dirs[0]).find((x) => x.endsWith('r3dlog.txt'));
    if (!f) { log('  (sin r3dlog en', dirs[0] + ')'); return; }
    const lines = fs.readFileSync(path.join(dirs[0], f), 'utf8').split(/\r?\n/).filter(Boolean);
    log(`  --- ${path.join(dirs[0], f)} (${lines.length} líneas, últimas ${Math.min(n, lines.length)}):`);
    for (const l of lines.slice(-n)) log('  | ' + l.slice(0, 220));
  } catch (e) { log('  (no pude leer el log del juego:', e.message + ')'); }
}
async function gameRunning() {
  return new Promise((resolve) => execFile('tasklist', ['/FI', 'IMAGENAME eq League of Legends.exe', '/FO', 'CSV'], { windowsHide: true }, (e, out) => resolve(!e && /League of Legends\.exe/i.test(out || ''))));
}

// ── Cámara: coordenadas del mapa → posición de cámara ───────────────────────
function cameraFor(pos) {
  if (!pos) return null;
  // El mapa va de 0 a ~14800 en x y z; la cámara "top" mira hacia -z con cierta inclinación,
  // así que se coloca un poco al sur del punto y a ~1900 de altura.
  return { x: Number(pos.x) || 7400, y: 1900, z: (Number(pos.y) || 7400) - 1300 };
}

// ── Render de UNA partida ───────────────────────────────────────────────────
async function renderGame(gameId) {
  log(`== ${REGION}-${gameId} ==`);
  const info = await atak(`/api/replays/${REGION}/${gameId}/moments`);
  const cfgNow = readConfig();
  const allKeys = cfgNow.force ? [] : (await atak(`/api/replays/${REGION}/${gameId}/clips`)).clips.map((c) => String(c.key));
  const have = new Set(allKeys.filter((k) => !k.startsWith('vod-') && !k.startsWith('v-')));
  const haveV = new Set(allKeys.filter((k) => k.startsWith('v-')).map((k) => k.slice(2)));
  const wantV = cfgNow.vertical !== false;
  const want = Number(cfgNow.top) || TOP;
  const todo = (info.top || []).slice(0, want).filter((m) => !have.has(m.key) || (wantV && !haveV.has(m.key))).map((m) => ({ ...m, onlyVertical: have.has(m.key) })).sort((a, b) => a.t - b.t);
  if (!todo.length) { log('Sin momentos nuevos que grabar'); return 0; }
  log(`${todo.length} clips por grabar:`, todo.map((m) => `${m.key}`).join(' '));

  ensureReplayApi();
  if (!(await waitPortFree())) throw new Error('el puerto 2999 siguió ocupado (partida en curso) demasiado tiempo');

  const alreadyOpen = await port2999Busy();
  if (alreadyOpen) {
    log('Ya hay un juego/replay abierto en la máquina: uso ese');
  } else if (DIRECT) {
    await launchDirect(await downloadRofl(gameId));
  } else {
    // Cliente en reposo
    const phase = (await lcuReq('GET', '/lol-gameflow/v1/gameflow-phase')).data;
    if (!['None', 'Lobby', 'EndOfGame', 'PreEndOfGame', 'WaitingForStats'].includes(String(phase).replace(/"/g, ''))) throw new Error(`El cliente está en ${phase}: no se puede abrir un replay ahora`);
    // Replay descargado y abierto
    let meta = (await lcuReq('GET', `/lol-replays/v1/metadata/${gameId}`)).data;
    if (meta?.state !== 'watch') {
      const d = await lcuReq('POST', `/lol-replays/v1/rofls/${gameId}/download`, { componentType: 'replay-button_match-history' });
      if (d.status >= 400) throw new Error(`el cliente no quiso bajar el replay (${d.status})`);
      for (let i = 0; i < 60 && meta?.state !== 'watch'; i++) { await sleep(2000); meta = (await lcuReq('GET', `/lol-replays/v1/metadata/${gameId}`)).data; if (['lost', 'incompatible', 'missing', 'error'].includes(meta?.state)) throw new Error(`replay no disponible (${meta.state})`); }
      if (meta?.state !== 'watch') throw new Error('la descarga del replay no terminó');
    }
    let w = { status: 0 };
    try { w = await lcuReq('POST', `/lol-replays/v1/rofls/${gameId}/watch`, { componentType: 'replay-button_match-history' }, 90_000); }
    catch (e) { log('watch sin respuesta del cliente (' + e.message + '); sigo esperando al juego'); }
    if (w.status >= 400) throw new Error(`no se pudo abrir el replay (${w.status})`);
  }
  log('Abriendo el replay… esperando la Replay API');
  let ready = false;
  let lastApi = '';
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    try { const r = await replay('GET', '/replay/playback'); lastApi = `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`; if (r.status === 200 && r.data && typeof r.data.length === 'number') { ready = true; break; } } catch (e) { lastApi = e.message; }
    if (i >= 5 && i % 5 === 0 && !(await gameRunning())) { log('  el juego se cerró solo mientras cargaba el replay'); dumpGameLog(); throw new Error('el juego se cerró al abrir el replay (ver r3dlog arriba)'); }
    if (i % 30 === 29) log('  aún sin Replay API:', lastApi);
  }
  if (!ready) { dumpGameLog(); throw new Error(`la Replay API no respondió (última respuesta: ${lastApi}) — ¿EnableReplayApi=1 en Config\game.cfg?`); }
  await sleep(4000);

  await fsp.mkdir(OUT, { recursive: true });
  let done = 0;
  try {
    for (const m of todo) {
      const base = path.join(OUT, `${REGION}-${gameId}-${m.key}`);
      const webm = `${base}.webm`, mp4 = `${base}.mp4`;
      log(`▶ ${m.title} (${m.tStart}s–${m.tEnd}s)`);
      // Interfaz de espectador visible, niebla de guerra desactivada, cámara en el punto.
      const cam = cameraFor(m.pos);
      await replay('POST', '/replay/render', { fogOfWar: false, interfaceAll: true, interfaceReplay: false, interfaceTimeline: false, cameraMode: 'top', ...(cam ? { cameraPosition: cam } : {}) });
      await replay('POST', '/replay/playback', { time: Math.max(0, m.tStart - 2), paused: true, speed: 1 });
      await sleep(2500);
      if (cam) await replay('POST', '/replay/render', { cameraPosition: cam });
      await replay('POST', '/replay/recording', { recording: true, path: webm, codec: 'webm', startTime: m.tStart, endTime: m.tEnd, width: WIDTH, height: HEIGHT, framesPerSecond: FPS, enforceFrameRate: true, replaySpeed: 1 });
      // Espera a que termine (duración del clip + margen).
      const maxWait = (m.tEnd - m.tStart + 25) * 1000; const t0 = Date.now();
      while (Date.now() - t0 < maxWait) { await sleep(1500); const r = await replay('GET', '/replay/recording'); if (r.data && r.data.recording === false) break; }
      if (!fs.existsSync(webm)) { log('  ✗ no se generó el archivo', webm); continue; }
      if (!m.onlyVertical) {
        await encodeClip(webm, mp4, m, info.match);
        const up = await uploadClip(gameId, m, mp4);
        log(`  ✓ subido ${up.url}`);
        done++;
      }
      // Vertical para redes (1080×1920): misma grabación, clave v-<key>, kind vertical_<kind>
      const vmp4 = `${base}.vertical.mp4`;
      if (cfgNow.vertical !== false) {
        try {
          await encodeVertical(webm, vmp4, m, info.match);
          const upv = await uploadClip(gameId, { ...m, key: `v-${m.key}`, kind: `vertical_${m.kind}`, title: `${m.title} · Vertical` }, vmp4);
          log(`  ✓ vertical ${upv.url}`);
        } catch (e) { log(`  ✗ vertical: ${e.message}`); }
      }
      if (!KEEP) { for (const f of [webm, mp4, vmp4]) { try { await fsp.unlink(f); } catch { /* */ } } }
    }
  } finally {
    // Cerrar el juego (el replay) para dejar el cliente libre.
    spawn('taskkill', ['/F', '/IM', 'League of Legends.exe'], { windowsHide: true, stdio: 'ignore' });
    await sleep(3000);
  }
  return done;
}

// ── Lotes ────────────────────────────────────────────────────────────────────
async function pendingGames(tournamentId, want = TOP) {
  const { replays } = await atak(`/api/replays/tournament/${tournamentId}`);
  const { clips } = await atak(`/api/replays/tournament/${tournamentId}/clips`);
  const count = new Map(), vcount = new Map();
  for (const c of clips) {
    const key = String(c.key); const k = `${c.region}:${c.gameId}`;
    if (key.startsWith('vod-')) continue;
    if (key.startsWith('v-')) vcount.set(k, (vcount.get(k) || 0) + 1); else count.set(k, (count.get(k) || 0) + 1);
  }
  // Pendiente = partida con replay y menos clips de los que se quieren, o con verticales por hacer.
  const wantV = readConfig().vertical !== false;
  return replays.filter((r) => { const k = `${r.region}:${r.gameId}`; const h = count.get(k) || 0; return r.region === REGION && (h < want || (wantV && (vcount.get(k) || 0) < Math.min(h, want))); }).map((r) => r.gameId);
}


// ── Cliente de League dentro de la VM ─────────────────────────────────────────
// La VM solo tenía el juego (carpeta Game). Para que ella misma baje los replays
// con la API del cliente (LCU) hace falta el cliente: se copia desde el host en
// tres .tar servidos por AGENT_UPDATE_URL/pkg (client.tar = instalación sin Game,
// riotclient.tar = Riot Client, riotdata.tar = metadatos de ProgramData) y se
// reescriben las rutas. Uso: node render.mjs install-client
const PKG_URL = process.env.AGENT_UPDATE_URL ? `${process.env.AGENT_UPDATE_URL.replace(/\/$/, '')}/pkg` : '';
const RC_DIR = 'C:\\Riot Games\\Riot Client';
const RC_EXE = path.join(RC_DIR, 'RiotClientServices.exe');
const PROGRAMDATA_RG = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Riot Games');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const fwd = (p) => p.replace(/\\/g, '/');

async function downloadTo(url, file) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`${url} → ${r.status}`);
  const total = Number(r.headers.get('content-length') || 0);
  const ws = fs.createWriteStream(file);
  let got = 0, lastLog = Date.now();
  for await (const chunk of r.body) {
    got += chunk.length;
    if (!ws.write(chunk)) await new Promise((res) => ws.once('drain', res));
    if (Date.now() - lastLog > 15_000) { lastLog = Date.now(); log(`  ${path.basename(file)}: ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`); }
  }
  await new Promise((res, rej) => { ws.on('error', rej); ws.end(res); });
  return file;
}
function untar(file, dest, excludes = []) {
  fs.mkdirSync(dest, { recursive: true });
  const args = ['-xf', file, '-C', dest, ...excludes.flatMap((e) => ['--exclude', e])];
  const r = execFileSync(TAR, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return String(r || '');
}
async function installClient() {
  if (!PKG_URL) throw new Error('sin AGENT_UPDATE_URL');
  const tmp = path.join(OUT, 'pkg');
  await fsp.mkdir(tmp, { recursive: true });
  const lolRoot = path.dirname(LOL_DIR); // p. ej. J:\Riot Games
  log(`Instalando el cliente de League en ${LOL_DIR} (Riot Client en ${RC_DIR})…`);
  // 1) Riot Client
  if (!fs.existsSync(RC_EXE)) {
    const f = await downloadTo(`${PKG_URL}/riotclient.tar`, path.join(tmp, 'riotclient.tar'));
    untar(f, path.dirname(RC_DIR));
    log('  Riot Client copiado');
  } else log('  Riot Client ya estaba');
  // 2) Cliente de League (sin Game: ya está en el disco del juego)
  if (!fs.existsSync(path.join(LOL_DIR, 'LeagueClient.exe'))) {
    const f = await downloadTo(`${PKG_URL}/client.tar`, path.join(tmp, 'client.tar'));
    untar(f, lolRoot, ['League of Legends/Config']);
    log('  LeagueClient copiado');
  } else log('  LeagueClient ya estaba');
  // 3) Metadatos de ProgramData con las rutas de esta máquina
  const f = await downloadTo(`${PKG_URL}/riotdata.tar`, path.join(tmp, 'riotdata.tar'));
  untar(f, PROGRAMDATA_RG);
  const fixes = [
    [path.join(PROGRAMDATA_RG, 'RiotClientInstalls.json'), (t) => t.replace(/C:\/Riot Games\/League of Legends\//g, `${fwd(LOL_DIR)}/`).replace(/C:\/Riot Games\/Riot Client\/RiotClientServices\.exe/g, fwd(RC_EXE))],
    [path.join(PROGRAMDATA_RG, 'Metadata', 'league_of_legends.live', 'league_of_legends.live.product_settings.yaml'), (t) => t.replace(/product_install_full_path: ".*"/, `product_install_full_path: "${fwd(LOL_DIR)}"`).replace(/product_install_root: ".*"/, `product_install_root: "${fwd(lolRoot)}"`).replace(/should_repair: true/, 'should_repair: false')],
    [path.join(PROGRAMDATA_RG, 'Metadata', 'Riot Client', 'Riot Client.settings.yaml'), () => `user_data_paths:\n- "${fwd(path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'Riot Client'))}"\n`],
  ];
  for (const [file, fn] of fixes) { try { await fsp.writeFile(file, fn(await fsp.readFile(file, 'utf8'))); } catch (e) { log(`  aviso: ${path.basename(file)}: ${e.message}`); } }
  log('  metadatos listos');
  // 4) Limpieza y arranque del cliente (la sesión la inicia una persona en la consola de la VM)
  try { await fsp.rm(tmp, { recursive: true, force: true }); } catch { /* */ }
  await launchClient();
}
// El Riot Client, al pedirle que abra League, se para en la comprobación de Vanguard y se
// queda en "Play"; con un clic en Play sí abre el cliente (VAN 59 en pantalla, pero la API LCU
// funciona). El botón se busca relativo a la ventana del Riot Client (tamaño fijo en la VM).
function clickPlay() {
  const ps = `Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd); public struct RECT { public int L; public int T; public int R; public int B; }';
    $p = Get-Process | Where-Object { $_.MainWindowTitle -eq 'Riot Client' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if (-not $p) { 'no-window'; exit }
    [W.U]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; Start-Sleep -m 500; [W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; Start-Sleep -m 400; $r = New-Object W.U+RECT; [W.U]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
    $w = $r.R - $r.L; $h = $r.B - $r.T; if ($w -lt 600 -or $h -lt 400 -or $r.L -lt -5000) { 'no-window'; exit }
    $x = $r.L + [int]($w * 0.165); $y = $r.T + [int]($h * 0.357)
    [W.U]::SetCursorPos($x, $y) | Out-Null; Start-Sleep -m 150; [W.U]::mouse_event(2,0,0,0,0); Start-Sleep -m 60; [W.U]::mouse_event(4,0,0,0,0); "clic Play en $x,$y (ventana $w x $h)"`;
  const r = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30_000 }).toString().trim();
  log(`ui: ${r}`);
  return r !== 'no-window';
}
// ¿Responde la API del cliente? (el lockfile puede quedarse viejo cuando VAN 59 cierra el cliente)
async function lcuAlive() {
  lockCache = null; if (!lockfile()) return false;
  try { const r = await lcuReq('GET', '/lol-summoner/v1/current-summoner', undefined, 6000); return r.status > 0; } catch { return false; }
}
async function lcuSession() {
  try { const me = (await lcuReq('GET', '/lol-summoner/v1/current-summoner', undefined, 6000)).data; return !!(me?.summonerId || me?.puuid); } catch { return false; }
}
/** Deja el cliente de League abierto y con sesión (lo reabre si VAN 59 lo cerró). */
async function ensureClient() {
  if (await lcuAlive()) { if (await lcuSession()) return true; }
  else { try { fs.unlinkSync(path.join(LOL_DIR, 'lockfile')); } catch { /* no había */ } lockCache = null; await launchClient(); }
  for (let i = 0; i < 30; i++) { if (await lcuAlive()) break; await sleep(5000); }
  for (let i = 0; i < 12; i++) { if (await lcuSession()) return true; await sleep(5000); }
  log('replays: el cliente no quedó listo (sin API o sin sesión)');
  return false;
}
/** Cierra el cliente de League (no el Riot Client): abierto, el juego directo se cierra al cargar el replay. */
async function closeLeagueClient() {
  if (!(await lcuAlive())) return;
  log('Cerrando el cliente de League antes de renderizar…');
  for (const img of ['LeagueClientUxRender.exe', 'LeagueClientUx.exe', 'LeagueClient.exe']) { try { execFileSync('taskkill', ['/F', '/T', '/IM', img], { windowsHide: true, stdio: 'ignore' }); } catch { /* */ } }
  try { fs.unlinkSync(path.join(LOL_DIR, 'lockfile')); } catch { /* */ }
  lockCache = null; await sleep(4000);
}
async function waitRiotWindow(sec) {
  for (let i = 0; i < sec / 3; i++) {
    try { const t = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "(Get-Process | Where-Object { $_.MainWindowTitle -eq 'Riot Client' }).Count"], { windowsHide: true, timeout: 20_000 }).toString().trim(); if (Number(t) > 0) return true; } catch { /* */ }
    await sleep(3000);
  }
  return false;
}
async function launchClient() {
  if (!fs.existsSync(RC_EXE)) throw new Error('Riot Client no instalado (install-client)');
  if (lockfile()) { log('El cliente ya está abierto'); return; }
  let rcRunning = false;
  try { rcRunning = /RiotClientServices/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq RiotClientServices.exe', '/NH'], { windowsHide: true }).toString()); } catch { /* */ }
  const lcExe = path.join(LOL_DIR, 'LeagueClient.exe');
  void lcExe;
  if (rcRunning && (await waitRiotWindow(3))) {
    // Riot Client abierto en "Play": basta con pulsarlo.
    clickPlay();
    return;
  }
  log('Abriendo el Riot Client con League…');
  const child = spawn(RC_EXE, ['--launch-product=league_of_legends', '--launch-patchline=live'], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  // Con "mantener sesión" entra solo; en cuanto aparece la ventana (y carga), se pulsa Play.
  if (await waitRiotWindow(90)) { await sleep(20_000); clickPlay(); }
}

// ── Replays: del cliente (LCU) a ATAK.GG ──────────────────────────────────────
// Lo mismo que hace el companion, pero desde la VM: pide a ATAK.GG qué partidas
// faltan, el cliente las baja (solo con sesión iniciada y mismo parche) y se
// suben. En --watch corre antes de cada ciclo de render (config.fetch !== false).
const SKIP_FILE = path.join(here, 'out', 'fetch-skip.json');
const fetchSkip = new Set((() => { try { return JSON.parse(fs.readFileSync(SKIP_FILE, 'utf8')); } catch { return []; } })());
const fetchTried = new Map();
const saveSkip = () => { try { fs.writeFileSync(SKIP_FILE, JSON.stringify([...fetchSkip])); } catch { /* */ } };
// Lista propia de partidas que faltan: bracket del torneo menos replays ya guardados,
// de la más reciente a la más antigua (las viejas ya no se pueden bajar: otro parche).
async function wantedGames(tournamentId) {
  const t = await atak(`/api/tournaments/${tournamentId}`); const tour = t?.tournament ?? t;
  const { replays } = await atak(`/api/replays/tournament/${tournamentId}`);
  const have = new Set((replays || []).map((r) => `${r.region}:${r.gameId}`));
  const out = [];
  for (const m of tour?.bracket || []) for (const g of m.games || []) {
    const gameId = Number(g.gameId); if (!gameId || have.has(`${REGION}:${gameId}`)) continue;
    out.push({ gameId, region: REGION, matchId: m.id, team1: m.team1, team2: m.team2, round: m.round });
  }
  return out.sort((a, b) => b.gameId - a.gameId);
}
async function fetchReplays(limit = 10, tournamentId = 'lqc-2026', explicit = null) {
  if (!(await lcuAlive())) { log('replays: el cliente de League no está abierto en la VM'); return 0; }
  let me; try { me = (await lcuReq('GET', '/lol-summoner/v1/current-summoner')).data; } catch { /* */ }
  if (!me?.summonerId && !me?.puuid) { log('replays: el cliente está abierto pero sin sesión iniciada'); return 0; }
  const wanted = explicit || await wantedGames(tournamentId);
  const todo = wanted.filter((w) => !fetchSkip.has(w.gameId) && Date.now() - (fetchTried.get(w.gameId) || 0) > 30 * 60_000).slice(0, limit);
  log(`replays: ${wanted.length} sin replay (${wanted.length - todo.length} descartadas o ya probadas), intento ${todo.length}`);
  let done = 0;
  const bad = new Set(['lost', 'incompatible', 'error', 'missing']);
  for (const w of todo) {
    fetchTried.set(w.gameId, Date.now());
    const label = `${w.team1} vs ${w.team2} (${w.gameId})`;
    try {
      let meta = (await lcuReq('GET', `/lol-replays/v1/metadata/${w.gameId}`)).data;
      if (meta?.state && bad.has(meta.state)) { fetchSkip.add(w.gameId); saveSkip(); log(`  ✗ ${label}: no disponible (${meta.state})`); continue; }
      if (meta?.state !== 'watch') {
        const r = await lcuReq('POST', `/lol-replays/v1/rofls/${w.gameId}/download`, { componentType: 'replay-button_match-history' });
        if (r.status >= 300) { log(`  ✗ ${label}: el cliente rechazó la descarga (${r.status})`); continue; }
        for (let i = 0; i < 90; i++) {
          await sleep(2000);
          meta = (await lcuReq('GET', `/lol-replays/v1/metadata/${w.gameId}`)).data;
          if (meta?.state === 'watch') break;
          if (meta?.state && bad.has(meta.state)) break;
        }
        if (meta?.state && bad.has(meta.state)) { fetchSkip.add(w.gameId); saveSkip(); log(`  ✗ ${label}: no disponible (${meta.state})`); continue; }
        if (meta?.state !== 'watch') { log(`  ✗ ${label}: la descarga no terminó (${meta?.state})`); continue; }
      }
      let dir = (await lcuReq('GET', '/lol-replays/v1/rofls/path')).data;
      if (typeof dir !== 'string') dir = (await lcuReq('GET', '/lol-replays/v1/rofls-path')).data;
      if (typeof dir !== 'string') { log(`  ✗ ${label}: el cliente no dice dónde guarda los replays`); continue; }
      let file = null;
      for (const c of [path.join(dir, `${REGION}-${w.gameId}.rofl`), path.join(dir, `${w.region}-${w.gameId}.rofl`)]) if (fs.existsSync(c)) { file = c; break; }
      if (!file) { const found = (await fsp.readdir(dir).catch(() => [])).find((f) => f.includes(String(w.gameId)) && f.endsWith('.rofl')); if (found) file = path.join(dir, found); }
      if (!file) { log(`  ✗ ${label}: el archivo no apareció en ${dir}`); continue; }
      const buf = await fsp.readFile(file);
      const up = await fetch(`${BACKEND}/api/replays/${encodeURIComponent(w.region)}/${w.gameId}`, { method: 'POST', body: buf, headers: { 'Content-Type': 'application/octet-stream', 'X-Patch': String(meta?.gameVersion || ''), 'X-Uploader': 'atak-render-vm', 'X-Render-Token': TOKEN } });
      if (!up.ok) { log(`  ✗ ${label}: ATAK.GG respondió ${up.status}`); continue; }
      done++; log(`  ✓ ${label}: subido (${(buf.length / 1048576).toFixed(1)} MB)`);
      try { await fsp.unlink(file); } catch { /* */ }
    } catch (e) { log(`  ✗ ${label}: ${e.message}`); if (/no detectado/i.test(e.message)) break; }
  }
  return done;
}

// ── Pequeñas acciones de interfaz dentro de la VM (clic / teclas) ─────────────
// El worker corre en la sesión interactiva de la VM, así que puede pulsar en la
// pantalla sin pasar por la consola. Uso: node render.mjs ui-click 1480 894
//                                         node render.mjs ui-keys ENTER
function uiClick(x, y) {
  const ps = `Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);'; [W.U]::SetCursorPos(${x},${y}); Start-Sleep -m 120; [W.U]::mouse_event(2,0,0,0,0); Start-Sleep -m 60; [W.U]::mouse_event(4,0,0,0,0)`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 });
  log(`ui: clic en ${x},${y}`);
}
function uiKeys(keys) {
  const map = { ENTER: '{ENTER}', ESC: '{ESC}', TAB: '{TAB}', SPACE: ' ' };
  const seq = keys.map((k) => map[k.toUpperCase()] || k).join('');
  const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${seq.replace(/'/g, "''")}')`;
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 });
  log(`ui: teclas ${keys.join(' ')}`);
}
function uiFocus(title) {
  const ps = `Add-Type -Name U -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'; $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*${title.replace(/'/g, "''")}*' } | Select-Object -First 1; if ($p) { [W.U]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; 'ok ' + $p.MainWindowTitle } else { 'no' }`;
  const r = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 }).toString().trim();
  log(`ui: foco "${title}" → ${r}`);
}

function diag() {
  try { log('procesos: ' + execFileSync('tasklist', ['/NH'], { windowsHide: true }).toString().split(/\r?\n/).filter((l) => /league|riot|vgc|vgtray/i.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 2).join(':')).join(' | ')); } catch (e) { log('tasklist: ' + e.message); }
  for (const dir of [path.join(LOL_DIR, 'Logs', 'LeagueClient Logs'), path.join(os.homedir(), 'AppData', 'Local', 'Riot Games', 'Riot Client', 'Logs', 'Riot Client Logs')]) {
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 2);
      for (const { f } of files) { const txt = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/); log(`--- ${f} (${txt.length} líneas)`); for (const l of txt.filter((x) => /error|fatal|vanguard|exit|crash|warn/i.test(x)).slice(-25)) log('   ' + l.slice(0, 220)); }
    } catch (e) { log(`sin logs en ${dir}: ${e.message}`); }
  }
  log('lockfile: ' + JSON.stringify(lockfile()));
}

(async () => {
  if (args[0] === 'diag') { diag(); return; }
  if (args[0] === 'ui-click') { uiClick(Number(args[1]), Number(args[2])); return; }
  if (args[0] === 'ui-keys') { uiKeys(args.slice(1)); return; }
  if (args[0] === 'ui-focus') { uiFocus(args.slice(1).join(' ')); return; }
  if (args[0] === 'fetch-file') {
    // Baja un archivo de la carpeta replay-render del host (bin/yt-dlp.exe, vod-clips.mjs, out/vod/plan.json…)
    // El agente solo deja pasar letras, números, guion y guion bajo: alias → ruta real.
    const alias = { 'yt-dlp': 'bin/yt-dlp.exe', 'vod-clips': 'vod-clips.mjs', 'ffmpeg': 'bin/ffmpeg.exe' };
    const raw = String(args[1] || '');
    const name = alias[raw] || (/^plan-[A-Za-z0-9_-]{1,40}$/.test(raw) ? `out/vod/${raw}.json` : '');
    if (!name) { log('nombre no permitido (usa yt-dlp | vod-clips | plan-<nombre>)'); return; }
    const url = `${(process.env.AGENT_UPDATE_URL || '').replace(/\/$/, '')}/${name}`;
    const r = await fetch(url); if (!r.ok) { log(`${name} → ${r.status}`); return; }
    const dest = path.join(here, name); await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.writeFile(dest, Buffer.from(await r.arrayBuffer()));
    log(`bajado ${name} (${fs.statSync(dest).size} bytes)`); return;
  }
  if (args[0] === 'vod') {
    // Highlights desde el VOD de Twitch (vod-clips.mjs) con el plan indicado, en la VM.
    const plan = String(args[1] || ''); if (!/^plan-[A-Za-z0-9_-]{1,40}$/.test(plan)) { log('plan no permitido (plan-<nombre>)'); return; }
    await new Promise((resolve) => { const c = spawn(process.execPath, [path.join(here, 'vod-clips.mjs'), path.join(here, 'out', 'vod', `${plan}.json`)], { cwd: here, windowsHide: true }); c.stdout.on('data', (d) => log(String(d).trimEnd())); c.stderr.on('data', (d) => log(String(d).trimEnd())); c.on('exit', resolve); });
    return;
  }
  if (args[0] === 'update-agent') {
    // Baja agent.mjs del host y cierra el agente actual (su .cmd lo vuelve a lanzar con el archivo nuevo).
    if (!process.env.AGENT_UPDATE_URL) { log('sin AGENT_UPDATE_URL'); return; }
    const url = `${process.env.AGENT_UPDATE_URL.replace(/\/$/, '')}/agent.mjs`;
    const r = await fetch(url); if (!r.ok) { log(`agent.mjs → ${r.status}`); return; }
    const txt = await r.text(); if (!/listen\(PORT/.test(txt)) { log('agent.mjs descargado no parece válido'); return; }
    await fsp.writeFile(path.join(here, 'agent.mjs'), txt, 'utf8');
    log(`agent.mjs actualizado (${txt.length} bytes); reiniciando el agente (pid ${process.ppid})…`);
    setTimeout(() => { try { execFileSync('taskkill', ['/F', '/PID', String(process.ppid)], { windowsHide: true, stdio: 'ignore' }); } catch { /* */ } }, 500);
    await sleep(1500);
    return;
  }
  if (args.includes('install-client')) { await installClient(); return; }
  if (args.includes('launch-client')) { await launchClient(); return; }
  if (args[0] === 'test-download') {
    // Prueba real de descarga por LCU (partida cualquiera del parche actual), sin subir nada.
    const gid = Number(args[1]); if (!gid) { log('uso: test-download <gameId>'); return; }
    if (!(await ensureClient())) { log('test: cliente no abierto'); return; }
    let meta = (await lcuReq('GET', `/lol-replays/v1/metadata/${gid}`)).data; log(`test: estado inicial ${JSON.stringify(meta).slice(0, 200)}`);
    const r = await lcuReq('POST', `/lol-replays/v1/rofls/${gid}/download`, { componentType: 'replay-button_match-history' }); log(`test: download → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    for (let i = 0; i < 60; i++) { await sleep(2000); meta = (await lcuReq('GET', `/lol-replays/v1/metadata/${gid}`)).data; if (['watch', 'lost', 'incompatible', 'error', 'missing'].includes(meta?.state)) break; }
    log(`test: estado final ${JSON.stringify(meta).slice(0, 300)}`);
    const dir = (await lcuReq('GET', '/lol-replays/v1/rofls/path')).data; log(`test: carpeta ${dir}`);
    try { const f = fs.readdirSync(String(dir)).filter((x) => x.includes(String(gid))); log(`test: archivos ${JSON.stringify(f.map((x) => [x, fs.statSync(path.join(String(dir), x)).size]))}`); } catch (e) { log(`test: ${e.message}`); }
    return;
  }
  if (args[0] === 'player') {
    // Partidas sueltas de un jugador (pruebas): node render.mjs player Nombre Tag [n]
    const name = String(args[1] || ''), tag = String(args[2] || ''), n = Number(args[3]) || 3;
    DIRECT = true; // el render en la VM siempre abre el replay con el juego directamente
    if (!name || !tag) { log('uso: player <nombre> <tag> [n]'); return; }
    const acc = await atak(`/api/stats/resolve?region=${REGION.toLowerCase()}&gameName=${encodeURIComponent(name)}&tagLine=${encodeURIComponent(tag)}`);
    if (!acc?.puuid) { log('jugador no encontrado'); return; }
    const ids = await atak(`/api/stats/matches/americas/${acc.puuid}/ids?count=${n + 4}`);
    const list = (Array.isArray(ids) ? ids : []).filter((x) => String(x).startsWith(`${REGION}_`)).slice(0, n).map((x) => ({ gameId: Number(String(x).split('_')[1]), region: REGION, matchId: 'manual', team1: name, team2: 'rival' }));
    log(`${name}#${tag}: ${list.length} partidas recientes: ${list.map((x) => x.gameId).join(' ')}`);
    if (!(await ensureClient())) return;
    const have = new Set(((await atak(`/api/replays/tournament/manual`)).replays || []).map((r) => r.gameId));
    const todo = list.filter((x) => !have.has(x.gameId));
    const up = todo.length ? await fetchReplays(todo.length, 'manual', todo) : 0;
    log(`replays subidos: ${up} (ya había ${list.length - todo.length})`);
    await closeLeagueClient();
    for (const g of list) { if (have.has(g.gameId) || todo.find((x) => x.gameId === g.gameId)) { try { const c = await renderGame(g.gameId); log(`${g.gameId}: ${c} clips`); } catch (e) { log(`✗ ${g.gameId}: ${e.message}`); } } }
    return;
  }
  if (args.includes('fetch-replays')) { await ensureClient(); const n = await fetchReplays(120, opt('tournament', 'lqc-2026')); log(`replays subidos: ${n}`); return; }
  const game = opt('game'); const tournament = opt('tournament');
  if (game) { const n = await renderGame(Number(game)); log(`listo: ${n} clips`); return; }
  if (!tournament) { console.log('uso: node render.mjs --game <gameId> | --tournament <id> [--watch] | install-client | fetch-replays'); return; }
  const watch = !!opt('watch', false);
  do {
    const cfg = readConfig();
    if (cfg.enabled === false) { log('config.json: enabled=false, en pausa'); await sleep(5 * 60_000); continue; }
    // 1) Replays que falten, desde el cliente de la VM (si está abierto y con sesión)
    let fetched = 0;
    if (watch && cfg.fetch !== false) {
      try {
        // El cliente en la VM se cierra solo al rato (VAN 59): se reabre y se espera a que tenga sesión.
        const ready = cfg.autoLaunchClient !== false && fs.existsSync(RC_EXE) ? await ensureClient() : await lcuAlive();
        if (ready) fetched = await fetchReplays(Number(cfg.fetchPerCycle) || 20, cfg.tournament || tournament);
      } catch (e) { log(`replays: ${e.message}`); }
    }
    // 2) Render de lo que tenga replay y no tenga clips
    const ids = await pendingGames(cfg.tournament || tournament, Number(cfg.top) || TOP);
    log(`${tournament}: ${ids.length} partidas con replay y sin clips`);
    let rendered = 0;
    if (ids.length) await closeLeagueClient();
    for (const id of ids) { try { await renderGame(id); rendered++; } catch (e) { log(`✗ ${id}: ${e.message}`); if (/cliente está en|no detectado|puerto 2999/i.test(e.message)) break; } }
    if (watch) await sleep(fetched || rendered ? 20_000 : (Number(cfg.idleMinutes) || 3) * 60_000);
  } while (watch);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
