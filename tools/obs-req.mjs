// tools/obs-req.mjs — manda peticiones a TU OBS local (obs-websocket) para preparar escenas.
// Uso: node tools/obs-req.mjs '<json: [{"requestType":"...","requestData":{...}}, ...]>'
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const arg = process.argv[2] || '[]';
const reqs = JSON.parse(arg.startsWith('@') ? readFileSync(arg.slice(1), 'utf8') : arg);
const cfg = JSON.parse(readFileSync(join(process.env.APPDATA, 'obs-studio', 'plugin_config', 'obs-websocket', 'config.json'), 'utf8'));
const ws = new WebSocket(`ws://127.0.0.1:${cfg.server_port || 4455}`);
let i = 0; const ids = new Map();
const next = () => {
  if (i >= reqs.length) { ws.close(); return; }
  const r = reqs[i++]; const requestId = `q${i}`; ids.set(requestId, r.requestType);
  ws.send(JSON.stringify({ op: 6, d: { requestType: r.requestType, requestId, requestData: r.requestData || {} } }));
};
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.op === 0) {
    const d = { rpcVersion: 1, eventSubscriptions: 0 }; const a = m.d?.authentication;
    if (a) d.authentication = createHash('sha256').update(createHash('sha256').update(cfg.server_password + a.salt).digest('base64') + a.challenge).digest('base64');
    ws.send(JSON.stringify({ op: 1, d }));
  } else if (m.op === 2) next();
  else if (m.op === 7) {
    const s = m.d.requestStatus;
    console.log(ids.get(m.d.requestId), s?.result ? 'ok' : `✗ ${s?.comment || s?.code}`, s?.result ? (process.env.FULL ? JSON.stringify(m.d.responseData || {}) : JSON.stringify(m.d.responseData || {}).slice(0, 400)) : '');
    next();
  }
};
ws.onerror = () => { console.error('OBS no responde'); process.exit(1); };
