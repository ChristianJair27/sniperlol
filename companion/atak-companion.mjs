#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
//  ATAK Spectator Companion
//  Corre en la PC que está ESPECTEANDO (o jugando) una partida de LoL.
//  Lee la Live Client Data API oficial de Riot (https://127.0.0.1:2999) y
//  empuja snapshots al backend de ATAK para el broadcast en el navegador:
//  https://atakgg.revolution505.com/broadcast/<canal>
//
//  Uso (PowerShell o cmd, con la partida abierta como espectador):
//    node atak-companion.mjs --channel lqc-2026 --token TU_TOKEN
//
//  Flags:
//    --channel <id>     Canal del broadcast (ej. lqc-2026). Obligatorio.
//    --token <token>    LIVE_FEED_TOKEN del backend. Obligatorio.
//    --backend <url>    Backend ATAK (default: https://atakback.revolution505.com)
//    --label "<texto>"  Título del match (ej. "Semifinal: Lobos vs Cuervos")
//    --stream <url>     URL HLS (.m3u8) si además transmites video con OBS
//    --interval <ms>    Frecuencia de envío (default 2000)
//    --source <url>     (debug) URL alternativa de Live Client Data
//
//  Requiere Node 18+. Sin dependencias. Ctrl+C para terminar (cierra el canal).
// ═══════════════════════════════════════════════════════════════════════════
import https from 'node:https';
import http from 'node:http';

// ── Args ─────────────────────────────────────────────────────────────────────
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
}

const CHANNEL = (args.channel || '').toLowerCase();
const TOKEN = args.token || process.env.LIVE_FEED_TOKEN || '';
const BACKEND = (args.backend || 'https://atakback.revolution505.com').replace(/\/$/, '');
const SOURCE = args.source || 'https://127.0.0.1:2999/liveclientdata/allgamedata';
const INTERVAL = Math.max(1000, Number(args.interval) || 2000);
const LABEL = args.label || '';
const STREAM = args.stream || '';
// Para el overlay de caster (/broadcast/<canal>/overlay en OBS)
const TEAM1 = args.team1 || '';
const TEAM2 = args.team2 || '';
const LOGO1 = args.logo1 || '';
const LOGO2 = args.logo2 || '';

if (!CHANNEL || !/^[a-z0-9_-]{2,64}$/.test(CHANNEL) || !TOKEN) {
  console.error('Uso: node atak-companion.mjs --channel <canal> --token <LIVE_FEED_TOKEN> [--backend <url>] [--label "..."] [--stream <m3u8>]');
  process.exit(1);
}

// ── HTTP helpers (sin deps; el cliente de Riot usa cert self-signed) ─────────
function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function send(method, url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const body = payload ? JSON.stringify(payload) : '';
    const req = lib.request(u, {
      method,
      timeout: 5000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Feed-Token': TOKEN,
      },
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── allgamedata → snapshot compacto ──────────────────────────────────────────
function buildSnapshot(d) {
  const players = (d.allPlayers || []).slice(0, 10).map((p) => ({
    riotId: p.riotId || p.riotIdGameName || p.summonerName || '',
    championName: p.championName || '',
    team: p.team === 'CHAOS' ? 'CHAOS' : 'ORDER',
    level: p.level || 1,
    scores: {
      kills: p.scores?.kills ?? 0,
      deaths: p.scores?.deaths ?? 0,
      assists: p.scores?.assists ?? 0,
      creepScore: p.scores?.creepScore ?? 0,
      wardScore: p.scores?.wardScore ?? 0,
    },
    isDead: !!p.isDead,
    respawnTimer: p.respawnTimer || 0,
    position: p.position || '',
    items: (p.items || []).map((it) => ({ itemID: it.itemID })),
  }));

  const events = (d.events?.Events || []).slice(-80);

  return {
    gameTime: Math.round(d.gameData?.gameTime ?? 0),
    gameMode: d.gameData?.gameMode ?? '',
    mapName: d.gameData?.mapName ?? '',
    matchLabel: LABEL,
    streamUrl: STREAM,
    team1: TEAM1,
    team2: TEAM2,
    logo1: LOGO1,
    logo2: LOGO2,
    players,
    events,
  };
}

// ── Loop principal ───────────────────────────────────────────────────────────
const PUSH_URL = `${BACKEND}/api/live-feed/${CHANNEL}/push`;
let connected = false;
let pushed = 0;

console.log(`\n  ⚔️  ATAK Spectator Companion`);
console.log(`  canal:   ${CHANNEL}`);
console.log(`  backend: ${BACKEND}`);
if (LABEL) console.log(`  match:   ${LABEL}`);
if (STREAM) console.log(`  stream:  ${STREAM}`);
console.log(`\n  Esperando partida (abre LoL como espectador o jugador)...\n`);

async function tick() {
  let data;
  try {
    data = await getJson(SOURCE);
  } catch {
    if (connected) {
      connected = false;
      console.log('  ⏸  Partida terminada o cliente cerrado. Esperando la siguiente...');
    }
    return setTimeout(tick, 5000);
  }

  if (!connected) {
    connected = true;
    console.log(`  ▶  Partida detectada (${data.gameData?.gameMode || '?'}). Transmitiendo cada ${INTERVAL / 1000}s...`);
  }

  try {
    const r = await send('POST', PUSH_URL, buildSnapshot(data));
    if (r.status === 200) {
      pushed++;
      if (pushed % 15 === 1) {
        const t = Math.round(data.gameData?.gameTime ?? 0);
        console.log(`  ✓  snapshot #${pushed} · minuto ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`);
      }
    } else {
      console.warn(`  ⚠  backend respondió ${r.status}: ${r.body.slice(0, 120)}`);
    }
  } catch (e) {
    console.warn(`  ⚠  no se pudo enviar al backend: ${e.message}`);
  }
  setTimeout(tick, INTERVAL);
}

process.on('SIGINT', async () => {
  console.log('\n  Cerrando canal...');
  try { await send('DELETE', `${BACKEND}/api/live-feed/${CHANNEL}`); } catch {}
  process.exit(0);
});

tick();
