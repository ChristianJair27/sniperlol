// tools/live-cam2.mjs — "segunda cámara" de repeticiones para el stream.
// Corre en la PC de quien espectea la partida con su propio OBS:
//   1. se conecta al OBS local (obs-websocket, lee puerto/contraseña de su config),
//   2. crea la escena "ATAK Cámara 2" con la captura del espectador y arranca el búfer de repetición,
//   3. cada vez que se guarda una repetición (Ctrl+Shift+R o el botón de OBS) la sube a ATAK.GG,
//      y aparece en la mesa de control (/broadcast/<canal>/control) para mostrarla en el overlay.
// Uso: node tools/live-cam2.mjs [canal]   (token LIVE_FEED_TOKEN del .env de sniperlol)
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHANNEL = process.argv[2] || 'lqc-2026';
const BACKEND = process.env.ATAK_BACKEND || 'https://atakback.revolution505.com';
const env = Object.fromEntries(readFileSync(join(here, '..', '.env'), 'utf8').split(/\r?\n/).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
const TOKEN = (process.env.LIVE_FEED_TOKEN || env.LIVE_FEED_TOKEN || '').trim();
if (!TOKEN) { console.error('Falta LIVE_FEED_TOKEN'); process.exit(1); }
const wsCfg = JSON.parse(readFileSync(join(process.env.APPDATA, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json'), 'utf8'));
const SCENE = 'ATAK Cámara 2';
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

let ws; let reqId = 0; const waiting = new Map();
function request(requestType, requestData = {}) {
  const requestId = `r${++reqId}`;
  return new Promise((resolve, reject) => {
    waiting.set(requestId, { resolve, reject });
    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
    setTimeout(() => { if (waiting.delete(requestId)) reject(new Error(`${requestType}: sin respuesta`)); }, 8000);
  });
}

async function upload(file) {
  // Espera a que OBS termine de escribir (tamaño estable).
  let prev = -1;
  for (let i = 0; i < 20; i++) { const s = statSync(file).size; if (s > 0 && s === prev) break; prev = s; await new Promise((r) => setTimeout(r, 300)); }
  const buf = readFileSync(file);
  const ext = extname(file).toLowerCase();
  if (ext !== '.mp4') log(`⚠ ${basename(file)} no es MP4: el overlay puede no reproducirlo (Ajustes → Salida → Formato de grabación: MP4)`);
  const title = `Cámara 2 · ${new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  const t0 = Date.now();
  const r = await fetch(`${BACKEND}/api/live-feed/${CHANNEL}/clips`, { method: 'POST', body: buf, headers: { 'Content-Type': ext === '.mp4' ? 'video/mp4' : 'video/x-matroska', 'X-Feed-Token': TOKEN, 'X-Clip-Title': encodeURIComponent(title) } });
  const j = await r.json().catch(() => ({}));
  if (r.ok) log(`✓ subida #${j.id} (${(buf.length / 1048576).toFixed(1)} MB en ${((Date.now() - t0) / 1000).toFixed(1)} s) → ya está en la mesa de control`);
  else log(`✗ no se subió (${r.status}): ${j.error || ''}`);
}

async function setup() {
  const { scenes = [] } = await request('GetSceneList');
  if (!scenes.some((s) => s.sceneName === SCENE)) {
    await request('CreateScene', { sceneName: SCENE });
    await request('CreateInput', {
      sceneName: SCENE, inputName: 'Espectador LoL', inputKind: 'game_capture',
      inputSettings: { capture_mode: 'window', window: 'League of Legends (TM) Client:RiotWindowClass:League of Legends.exe', priority: 2, capture_cursor: false },
    }).catch((e) => log('captura de juego:', e.message));
    log(`escena "${SCENE}" creada con la captura del espectador`);
  }
  await request('SetCurrentProgramScene', { sceneName: SCENE }).catch(() => {});
  const st = await request('GetReplayBufferStatus').catch((e) => ({ err: e.message }));
  if (st.err) { log('✗ búfer de repetición no disponible:', st.err); return; }
  if (!st.outputActive) await request('StartReplayBuffer');
  log('✓ búfer de repetición activo (30 s). Guarda una jugada con Ctrl+Shift+R o el botón "Guardar repetición" de OBS.');
}

function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${wsCfg.server_port || 4455}`);
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.op === 0) {
      const identify = { rpcVersion: 1, eventSubscriptions: 1 << 6 };
      const auth = msg.d?.authentication;
      if (auth) {
        const secret = createHash('sha256').update(wsCfg.server_password + auth.salt).digest('base64');
        identify.authentication = createHash('sha256').update(secret + auth.challenge).digest('base64');
      }
      ws.send(JSON.stringify({ op: 1, d: identify }));
    } else if (msg.op === 2) {
      log('conectado a OBS'); setup().catch((e) => log('✗ setup:', e.message));
    } else if (msg.op === 5 && msg.d?.eventType === 'ReplayBufferSaved') {
      const file = msg.d.eventData?.savedReplayPath; log('repetición guardada:', basename(file || ''));
      if (file) upload(file).catch((e) => log('✗ subida:', e.message));
    } else if (msg.op === 7) {
      const w = waiting.get(msg.d.requestId); if (!w) return; waiting.delete(msg.d.requestId);
      if (msg.d.requestStatus?.result) w.resolve(msg.d.responseData || {}); else w.reject(new Error(msg.d.requestStatus?.comment || `código ${msg.d.requestStatus?.code}`));
    }
  };
  ws.onclose = () => { log('OBS desconectado; reintento en 3 s (¿OBS abierto?)'); setTimeout(connect, 3000); };
  ws.onerror = () => {};
}
log(`segunda cámara → canal ${CHANNEL}`);
connect();
