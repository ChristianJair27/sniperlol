// tools/deck.mjs — acciones del Stream Deck para producir el stream (las lanza E:\ATAKGG\streamdeck\*.vbs).
//   show <seg> [lenta] [prev]   repetición de la segunda cámara al aire (la última, o la anterior con prev)
//   hide                        quitar la repetición
//   sound <nombre>              sonido al stream (lo reproduce el overlay del caster)
//   vol up|down|mute            volumen de esos sonidos (se recuerda en deck-state.json)
//   obs-mute desktop|mic        silenciar/activar el audio de escritorio o el micro de TU OBS
//   mark <Nombre> <blue|red> [dragón]   objetivo al overlay (dragón, larva, heraldo, barón, torre)
//   undo                        deshacer el último objetivo marcado
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CHANNEL = process.env.ATAK_CHANNEL || 'lqc-2026';
const BACKEND = 'https://atakback.revolution505.com';
const env = Object.fromEntries(readFileSync(join(here, '..', '.env'), 'utf8').split(/\r?\n/).map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
const TOKEN = (env.LIVE_FEED_TOKEN || '').trim();
const STATE = join(here, 'deck-state.json');
const LOG = join(here, 'deck.log');
const log = (m) => { try { appendFileSync(LOG, `${new Date().toLocaleString()} ${m}\n`); } catch { /* */ } };
const state = (() => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { vol: 0.8, muted: false }; } })();
const post = (path, body) => fetch(`${BACKEND}/api/live-feed/${CHANNEL}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Feed-Token': TOKEN }, body: JSON.stringify(body) }).then((r) => r.json());

async function obsToggle(kind) {
  const cfg = JSON.parse(readFileSync(join(process.env.APPDATA, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json'), 'utf8'));
  const ws = new WebSocket(`ws://127.0.0.1:${cfg.server_port || 4455}`);
  let id = 0; const waiting = new Map();
  const req = (requestType, requestData = {}) => new Promise((res, rej) => { const requestId = `d${++id}`; waiting.set(requestId, { res, rej }); ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } })); });
  await new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('OBS no responde')), 4000);
    ws.onerror = () => reject(new Error('OBS cerrado'));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.op === 0) {
        const d = { rpcVersion: 1, eventSubscriptions: 0 }; const a = m.d?.authentication;
        if (a) d.authentication = createHash('sha256').update(createHash('sha256').update(cfg.server_password + a.salt).digest('base64') + a.challenge).digest('base64');
        ws.send(JSON.stringify({ op: 1, d }));
      } else if (m.op === 2) resolve();
      else if (m.op === 7) { const w = waiting.get(m.d.requestId); if (w) { waiting.delete(m.d.requestId); m.d.requestStatus?.result ? w.res(m.d.responseData || {}) : w.rej(new Error(m.d.requestStatus?.comment)); } }
    };
  });
  const sp = await req('GetSpecialInputs');
  const name = kind === 'mic' ? sp.mic1 : sp.desktop1;
  if (!name) throw new Error(`OBS no tiene ${kind === 'mic' ? 'micrófono' : 'audio de escritorio'}`);
  const r = await req('ToggleInputMute', { inputName: name });
  log(`OBS ${name} → ${r.inputMuted ? 'silenciado' : 'activo'}`);
  ws.close();
}

const [cmd, a, b, c] = process.argv.slice(2);
try {
  if (cmd === 'show') {
    const { clips = [] } = await fetch(`${BACKEND}/api/live-feed/${CHANNEL}/clips`).then((r) => r.json());
    const clip = [a, b, c].includes('prev') ? clips[1] : clips[0];
    if (!clip) throw new Error('no hay repeticiones subidas');
    const r = await post('clip-state', { show: true, id: clip.id, last: Number(a) || 15, slow: [a, b, c].includes('lenta') });
    log(`al aire #${clip.id} ${JSON.stringify(r.state)}`);
  } else if (cmd === 'hide') {
    await post('clip-state', { show: false }); log('repetición quitada');
  } else if (cmd === 'sound') {
    if (state.muted) log(`sonido ${a} omitido (sonidos silenciados)`);
    else {
    const r = await post('cue', { sound: a, vol: state.vol }); log(`sonido ${a} ${r.ok ? 'enviado' : r.error}`); }
  } else if (cmd === 'vol') {
    if (a === 'mute') state.muted = !state.muted;
    else state.vol = Math.round(Math.min(1, Math.max(0.1, state.vol + (a === 'up' ? 0.1 : -0.1))) * 10) / 10;
    writeFileSync(STATE, JSON.stringify(state));
    log(`sonidos: volumen ${Math.round(state.vol * 100)}%${state.muted ? ' (silenciados)' : ''}`);
    if (a !== 'mute') await post('cue', { sound: 'ding', vol: state.vol }); // muestra de cómo suena
  } else if (cmd === 'mark') {
    // Objetivo para el overlay (igual que la mesa de control): mark <DragonKill|HordeKill|HeraldKill|BaronKill|TurretKilled> <blue|red> [tipo de dragón]
    const r = await post('mark', { name: a, side: b, extra: c || '' });
    log(r.ok ? `✓ ${a}${c ? ` ${c}` : ''} → ${b} (${Math.floor((r.event?.t || 0) / 60)}:${String((r.event?.t || 0) % 60).padStart(2, '0')})` : `✗ ${a} ${b}: ${r.error}`);
    if (!r.ok) process.exitCode = 1;
  } else if (cmd === 'undo') {
    const r = await fetch(`${BACKEND}/api/live-feed/${CHANNEL}/mark/last`, { method: 'DELETE', headers: { 'X-Feed-Token': TOKEN } }).then((x) => x.json());
    log(`deshacer: ${r.removed ? `${r.removed.name} ${r.removed.side}` : 'nada que deshacer'}`);
  } else if (cmd === 'obs-mute') {
    await obsToggle(a);
  } else throw new Error(`orden desconocida: ${cmd}`);
} catch (e) { log(`✗ ${cmd} ${a || ''}: ${e.message}`); process.exitCode = 1; }
