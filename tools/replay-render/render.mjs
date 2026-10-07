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
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
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
const OUT = process.env.OUT_DIR || path.join(here, 'out');
const FPS = Number(process.env.FPS || 30);
const WIDTH = Number(process.env.WIDTH || 1920), HEIGHT = Number(process.env.HEIGHT || 1080);
const REPLAY_API = 'https://127.0.0.1:2999';
const insecure = new https.Agent({ rejectUnauthorized: false });

const log = (...a) => console.log(new Date().toLocaleTimeString('es-MX'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!TOKEN) { console.error('Falta RENDER_TOKEN en .env'); process.exit(1); }

// ── LCU ──────────────────────────────────────────────────────────────────────
function lockfile() {
  for (const p of [path.join(LOL_DIR, 'lockfile'), path.join(process.env.LOCALAPPDATA || '', 'Riot Games', 'League of Legends', 'lockfile')]) {
    try { const [, , port, pw] = fs.readFileSync(p, 'utf8').split(':'); if (port && pw) return { port: Number(port), pw }; } catch { /* siguiente */ }
  }
  return null;
}
async function lcu(method, p, body) {
  const lf = lockfile(); if (!lf) throw new Error('Cliente de League no detectado (lockfile)');
  const r = await fetch(`https://127.0.0.1:${lf.port}${p}`, { method, headers: { Authorization: `Basic ${Buffer.from(`riot:${lf.pw}`).toString('base64')}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), dispatcher: undefined, // @ts-ignore
    agent: insecure });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}
// fetch de Node no acepta `agent`; para HTTPS local autofirmado usamos https.request.
function httpsJson(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, agent: insecure, headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': payload.length } : {}), ...headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let d = null; try { d = JSON.parse(b); } catch { d = b; } resolve({ status: res.statusCode || 0, data: d }); });
    });
    req.on('error', reject); req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    if (payload) req.write(payload); req.end();
  });
}
async function lcuReq(method, p, body) {
  const lf = lockfile(); if (!lf) throw new Error('Cliente de League no detectado (lockfile)');
  return httpsJson(method, `https://127.0.0.1:${lf.port}${p}`, body, { Authorization: `Basic ${Buffer.from(`riot:${lf.pw}`).toString('base64')}` });
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
async function uploadClip(gameId, m, file) {
  const buf = await fsp.readFile(file);
  const r = await fetch(`${BACKEND}/api/replays/${REGION}/${gameId}/clips/${encodeURIComponent(m.key)}`, {
    method: 'POST', body: buf,
    headers: { 'Content-Type': 'video/mp4', 'X-Render-Token': TOKEN, 'X-Clip-Start': String(m.tStart), 'X-Clip-End': String(m.tEnd), 'X-Clip-Kind': m.kind, 'X-Clip-Title': encodeURIComponent(m.title), 'X-Clip-Players': JSON.stringify(m.players || []).slice(0, 1900) },
  });
  if (!r.ok) throw new Error(`subida ${m.key} → ${r.status} ${await r.text()}`);
  return r.json();
}

// ── ffmpeg ───────────────────────────────────────────────────────────────────
function ffmpeg(argv) { return new Promise((res, rej) => execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv], { windowsHide: true }, (e, _o, err) => (e ? rej(new Error(err || e.message)) : res()))); }

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
  const have = new Set((await atak(`/api/replays/${REGION}/${gameId}/clips`)).clips.map((c) => c.key));
  const todo = (info.top || []).slice(0, TOP).filter((m) => !have.has(m.key)).sort((a, b) => a.t - b.t);
  if (!todo.length) { log('Sin momentos nuevos que grabar'); return 0; }
  log(`${todo.length} clips por grabar:`, todo.map((m) => `${m.key}`).join(' '));

  // Cliente en reposo
  const phase = (await lcuReq('GET', '/lol-gameflow/v1/gameflow-phase')).data;
  if (!['None', 'Lobby', 'EndOfGame', 'PreEndOfGame', 'WaitingForStats'].includes(String(phase).replace(/"/g, ''))) throw new Error(`El cliente está en ${phase}: no se puede abrir un replay ahora`);
  ensureReplayApi();

  // Replay descargado y abierto
  let meta = (await lcuReq('GET', `/lol-replays/v1/metadata/${gameId}`)).data;
  if (meta?.state !== 'watch') {
    const d = await lcuReq('POST', `/lol-replays/v1/rofls/${gameId}/download`, { componentType: 'replay-button_match-history' });
    if (d.status >= 400) throw new Error(`el cliente no quiso bajar el replay (${d.status})`);
    for (let i = 0; i < 60 && meta?.state !== 'watch'; i++) { await sleep(2000); meta = (await lcuReq('GET', `/lol-replays/v1/metadata/${gameId}`)).data; if (['lost', 'incompatible', 'missing', 'error'].includes(meta?.state)) throw new Error(`replay no disponible (${meta.state})`); }
    if (meta?.state !== 'watch') throw new Error('la descarga del replay no terminó');
  }
  const w = await lcuReq('POST', `/lol-replays/v1/rofls/${gameId}/watch`, { componentType: 'replay-button_match-history' });
  if (w.status >= 400) throw new Error(`no se pudo abrir el replay (${w.status})`);
  log('Abriendo el replay… esperando la Replay API');
  let ready = false;
  for (let i = 0; i < 90; i++) { await sleep(2000); try { const r = await replay('GET', '/replay/playback'); if (r.status === 200 && r.data && typeof r.data.length === 'number') { ready = true; break; } } catch { /* aún no */ } }
  if (!ready) throw new Error('la Replay API no respondió (¿EnableReplayApi=1? ¿el juego abrió?)');
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
      await ffmpeg(['-i', webm, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);
      const up = await uploadClip(gameId, m, mp4);
      log(`  ✓ subido ${up.url}`);
      done++;
      if (!KEEP) { for (const f of [webm, mp4]) { try { await fsp.unlink(f); } catch { /* */ } } }
    }
  } finally {
    // Cerrar el juego (el replay) para dejar el cliente libre.
    spawn('taskkill', ['/F', '/IM', 'League of Legends.exe'], { windowsHide: true, stdio: 'ignore' });
    await sleep(3000);
  }
  return done;
}

// ── Lotes ────────────────────────────────────────────────────────────────────
async function pendingGames(tournamentId) {
  const { replays } = await atak(`/api/replays/tournament/${tournamentId}`);
  const { clips } = await atak(`/api/replays/tournament/${tournamentId}/clips`);
  const withClips = new Set(clips.map((c) => `${c.region}:${c.gameId}`));
  return replays.filter((r) => r.region === REGION && !withClips.has(`${r.region}:${r.gameId}`)).map((r) => r.gameId);
}

(async () => {
  const game = opt('game'); const tournament = opt('tournament');
  if (game) { const n = await renderGame(Number(game)); log(`listo: ${n} clips`); return; }
  if (!tournament) { console.log('uso: node render.mjs --game <gameId> | --tournament <id> [--watch]'); return; }
  const watch = !!opt('watch', false);
  do {
    const ids = await pendingGames(tournament);
    log(`${tournament}: ${ids.length} partidas con replay y sin clips`);
    for (const id of ids) { try { await renderGame(id); } catch (e) { log(`✗ ${id}: ${e.message}`); if (/cliente está en|no detectado/i.test(e.message)) break; } }
    if (watch) await sleep(10 * 60_000);
  } while (watch);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
