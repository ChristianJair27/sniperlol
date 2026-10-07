#!/usr/bin/env node
// ATAK.GG · agente de la sesión de render. Corre DENTRO de la sesión de Windows
// del usuario "tilin" (se registra al iniciar sesión) y permite, desde otra
// sesión de la MISMA máquina, manejar el worker de render sin iniciar sesión ni
// escribir contraseñas. Solo escucha en 127.0.0.1, exige el token de
// .agent-token y NO ejecuta comandos arbitrarios: únicamente las acciones de
// abajo (worker, juego, logs, captura, config).
//
//   GET  /status                       sesión, usuario, worker vivo, puerto 2999, juego abierto
//   POST /worker/start {args:[...]}    arranca render.mjs (p. ej. ["--tournament","lqc-2026","--watch","--direct"])
//   POST /worker/stop                  lo detiene
//   POST /game/kill                    cierra "League of Legends.exe" (replay colgado)
//   GET  /log?tail=200                 cola de out/worker.log
//   GET  /screenshot                   PNG de la pantalla de esta sesión
//   POST /config {…}                   escribe config.json (enabled/top/tournament)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.AGENT_PORT || 47777);
const TOKEN = fs.readFileSync(path.join(here, '.agent-token'), 'utf8').trim();
const NODE = process.execPath;
const LOG = path.join(here, 'out', 'worker.log');
let worker = null;
const log = (...a) => console.log(new Date().toLocaleTimeString('es-MX'), ...a);
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });
const exec = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => resolve({ ok: !e, out: String(out || ''), err: String(err || '') })));
const port2999 = async () => /:2999\s+\S+\s+LISTENING/i.test((await exec('netstat', ['-ano', '-p', 'tcp'])).out);
const gameOpen = async () => /League of Legends\.exe/i.test((await exec('tasklist', ['/FI', 'IMAGENAME eq League of Legends.exe', '/FO', 'CSV'])).out);
const ALLOWED_ARGS = /^(--(game|region|top|keep|tournament|watch|direct)|[A-Za-z0-9_-]{1,40})$/;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.headers['x-agent-token'] !== TOKEN) return json(res, 401, { ok: false, error: 'token' });
  try {
    if (req.method === 'GET' && url.pathname === '/status') {
      return json(res, 200, { ok: true, user: os.userInfo().username, session: process.env.SESSIONNAME || null, uptime: Math.round(process.uptime()), workerAlive: !!worker && worker.exitCode === null, workerPid: worker?.pid ?? null, port2999Busy: await port2999(), gameOpen: await gameOpen() });
    }
    if (req.method === 'POST' && url.pathname === '/worker/start') {
      if (worker && worker.exitCode === null) return json(res, 409, { ok: false, error: 'el worker ya corre' });
      const { args } = await body(req);
      const a = Array.isArray(args) ? args.map(String) : ['--tournament', 'lqc-2026', '--watch', '--direct'];
      if (!a.every((x) => ALLOWED_ARGS.test(x))) return json(res, 400, { ok: false, error: 'argumento no permitido' });
      await fsp.mkdir(path.dirname(LOG), { recursive: true });
      const out = fs.openSync(LOG, 'a');
      worker = spawn(NODE, [path.join(here, 'render.mjs'), ...a], { cwd: here, stdio: ['ignore', out, out], windowsHide: false });
      worker.on('exit', (code) => log('worker terminó', code));
      log('worker iniciado', a.join(' '));
      return json(res, 200, { ok: true, pid: worker.pid });
    }
    if (req.method === 'POST' && url.pathname === '/worker/stop') {
      if (!worker || worker.exitCode !== null) return json(res, 200, { ok: true, note: 'no corría' });
      await exec('taskkill', ['/F', '/T', '/PID', String(worker.pid)]);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/game/kill') {
      return json(res, 200, { ok: true, ...(await exec('taskkill', ['/F', '/IM', 'League of Legends.exe'])) });
    }
    if (req.method === 'GET' && url.pathname === '/log') {
      const tail = Math.min(2000, Number(url.searchParams.get('tail') || 200));
      let text = ''; try { text = await fsp.readFile(LOG, 'utf8'); } catch { /* sin log */ }
      return json(res, 200, { ok: true, lines: text.split(/\r?\n/).filter(Boolean).slice(-tail) });
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      const cfg = await body(req);
      const clean = { enabled: cfg.enabled !== false, top: Math.min(12, Math.max(1, Number(cfg.top) || 6)), tournament: String(cfg.tournament || 'lqc-2026').slice(0, 64) };
      await fsp.writeFile(path.join(here, 'config.json'), JSON.stringify(clean, null, 2));
      return json(res, 200, { ok: true, config: clean });
    }
    if (req.method === 'GET' && url.pathname === '/screenshot') {
      const f = path.join(os.tmpdir(), 'atak-agent-screen.png');
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${f.replace(/\\/g, '\\\\')}')`;
      const r = await exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      if (!r.ok || !fs.existsSync(f)) return json(res, 500, { ok: false, error: r.err });
      res.writeHead(200, { 'Content-Type': 'image/png' }); return fs.createReadStream(f).pipe(res);
    }
    json(res, 404, { ok: false, error: 'ruta' });
  } catch (e) { json(res, 500, { ok: false, error: e.message }); }
}).listen(PORT, '127.0.0.1', () => log(`agente ATAK en 127.0.0.1:${PORT} como ${os.userInfo().username} (sesión ${process.env.SESSIONNAME || '?'})`));
