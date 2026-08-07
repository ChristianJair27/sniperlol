// src/routes/live-feed.routes.ts
// Canal de transmisión de datos en vivo para el broadcast en el navegador.
// El ATAK Spectator Companion (companion/atak-companion.mjs) corre en la PC
// que está ESPECTEANDO la partida, lee la Live Client Data API oficial de Riot
// (127.0.0.1:2999) y empuja snapshots aquí; el frontend los lee en /broadcast.
//
// Diseño:
//  - Solo memoria (sin BD): un snapshot vivo por canal, TTL 60s. Si el
//    companion muere, el canal simplemente expira.
//  - Escritura protegida por token compartido (env LIVE_FEED_TOKEN). Sin token
//    configurado el push queda deshabilitado (503) — seguro por defecto.
//  - Lectura pública con CORS abierto (mismo espíritu que public-api).
//  - Todo sanitizado con whitelist: nunca se re-publica el body tal cual.
import { Router } from 'express';

const router = Router();

const TOKEN = (process.env.LIVE_FEED_TOKEN || '').trim();
const CHANNEL_RE = /^[a-z0-9_-]{2,64}$/i;
const TTL_MS = 60_000;

interface ChannelEntry { at: number; seq: number; snapshot: any }
const channels = new Map<string, ChannelEntry>();

const str = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function sanitizePlayer(p: any) {
  return {
    riotId: str(p?.riotId || p?.summonerName, 48),
    championName: str(p?.championName, 40),
    team: p?.team === 'CHAOS' ? 'CHAOS' : 'ORDER',
    level: num(p?.level),
    kills: num(p?.scores?.kills ?? p?.kills),
    deaths: num(p?.scores?.deaths ?? p?.deaths),
    assists: num(p?.scores?.assists ?? p?.assists),
    creepScore: num(p?.scores?.creepScore ?? p?.creepScore),
    wardScore: Math.round(num(p?.scores?.wardScore ?? p?.wardScore)),
    isDead: !!p?.isDead,
    respawnTimer: Math.max(0, Math.round(num(p?.respawnTimer))),
    position: str(p?.position, 12),
    items: Array.isArray(p?.items)
      ? p.items.slice(0, 7).map((it: any) => num(it?.itemID ?? it)).filter((n: number) => n > 0)
      : [],
  };
}

function sanitizeEvent(e: any) {
  return {
    id: num(e?.EventID ?? e?.id),
    t: Math.round(num(e?.EventTime ?? e?.t)),
    name: str(e?.EventName ?? e?.name, 32),
    killer: str(e?.KillerName ?? e?.killer, 48),
    victim: str(e?.VictimName ?? e?.victim, 48),
    assisters: Array.isArray(e?.Assisters ?? e?.assisters)
      ? (e.Assisters ?? e.assisters).slice(0, 4).map((a: any) => str(a, 48))
      : [],
    // Para TurretKilled/DragonKill etc.
    extra: str(e?.TurretKilled ?? e?.DragonType ?? e?.extra, 40),
  };
}

function sanitizeSnapshot(body: any) {
  return {
    gameTime: Math.max(0, Math.round(num(body?.gameTime))),
    gameMode: str(body?.gameMode, 32),
    mapName: str(body?.mapName, 40),
    // Metadatos del broadcast (los define quien corre el companion)
    matchLabel: str(body?.matchLabel, 120),
    streamUrl: str(body?.streamUrl, 300),
    tournamentId: str(body?.tournamentId, 64),
    // Para el overlay de caster: nombres y logos de los equipos
    team1: str(body?.team1, 40),
    team2: str(body?.team2, 40),
    logo1: str(body?.logo1, 300),
    logo2: str(body?.logo2, 300),
    players: Array.isArray(body?.players) ? body.players.slice(0, 10).map(sanitizePlayer) : [],
    events: Array.isArray(body?.events) ? body.events.slice(-80).map(sanitizeEvent) : [],
  };
}

// ── POST /api/live-feed/:channel/push (companion → backend; requiere token) ──
router.post('/:channel/push', (req, res) => {
  if (!TOKEN) {
    return res.status(503).json({ error: 'live_feed_disabled', message: 'Configura LIVE_FEED_TOKEN en el backend para habilitar el broadcast en vivo.' });
  }
  if (String(req.headers['x-feed-token'] || '') !== TOKEN) {
    return res.status(401).json({ error: 'bad_token' });
  }
  const channel = String(req.params.channel).toLowerCase();
  if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'bad_channel' });
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'bad_body' });

  const prev = channels.get(channel);
  const entry: ChannelEntry = {
    at: Date.now(),
    seq: (prev?.seq ?? 0) + 1,
    snapshot: sanitizeSnapshot(req.body),
  };
  channels.set(channel, entry);

  // GC de canales muertos (mantiene el Map chico sin timers)
  if (channels.size > 50) {
    for (const [k, v] of channels) {
      if (Date.now() - v.at > 10 * 60_000) channels.delete(k);
    }
  }
  return res.json({ ok: true, seq: entry.seq });
});

// ── DELETE /api/live-feed/:channel (companion al terminar; requiere token) ──
router.delete('/:channel', (req, res) => {
  if (!TOKEN || String(req.headers['x-feed-token'] || '') !== TOKEN) {
    return res.status(401).json({ error: 'bad_token' });
  }
  channels.delete(String(req.params.channel).toLowerCase());
  return res.json({ ok: true });
});

// ── GET /api/live-feed/:channel (público, sin caché) ────────────────────────
// OJO: NO fijar Access-Control-Allow-Origin:* aquí — el frontend manda
// withCredentials y el navegador rechaza respuestas con wildcard; el
// middleware global de CORS ya refleja el origin permitido.
router.get('/:channel', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const channel = String(req.params.channel).toLowerCase();
  if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'bad_channel' });
  const entry = channels.get(channel);
  if (!entry || Date.now() - entry.at > TTL_MS) return res.status(204).end();
  return res.json({ ok: true, seq: entry.seq, ageMs: Date.now() - entry.at, ...entry.snapshot });
});

export default router;
