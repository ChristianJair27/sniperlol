// src/routes/live-feed.routes.ts
// Canal de transmisión de datos en vivo para el broadcast en el navegador.
// El ATAK Spectator Companion (companion/atak-companion.mjs) corre en la PC
// que está ESPECTEANDO la partida, lee la Live Client Data API oficial de Riot
// (127.0.0.1:2999) y empuja snapshots aquí; el frontend los lee en /broadcast.
//
// Diseño:
//  - Snapshot vivo por canal en MySQL, TTL 60s. Si el companion muere, el
//    canal simplemente expira. OJO: antes era un Map en memoria — con el
//    backend corriendo en varias instancias, el push caía en un proceso y el
//    GET en otro → "esperando transmisión" intermitente. La BD es la única
//    fuente de verdad compartida entre instancias.
//  - Escritura protegida por token compartido (env LIVE_FEED_TOKEN). Sin token
//    configurado el push queda deshabilitado (503) — seguro por defecto.
//  - Lectura pública con CORS abierto (mismo espíritu que public-api).
//  - Todo sanitizado con whitelist: nunca se re-publica el body tal cual.
import { Router } from 'express';
import { pool } from '../db.js';

const router = Router();

const TOKEN = (process.env.LIVE_FEED_TOKEN || '').trim();
const CHANNEL_RE = /^[a-z0-9_-]{2,64}$/i;
const TTL_MS = 60_000;

async function initLiveFeedTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_feed_channels (
      channel  VARCHAR(64) PRIMARY KEY,
      seq      INT NOT NULL DEFAULT 1,
      at       BIGINT NOT NULL,
      snapshot LONGTEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
initLiveFeedTable().catch((e) => console.error('[live-feed] init error:', e.message));

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
    // Hechizos de invocador (token canónico "SummonerFlash") y runa clave (id):
    // el overlay los pinta en cada fila. Solo letras: es un nombre de archivo de icono.
    spells: Array.isArray(p?.spells)
      ? p.spells.slice(0, 2).map((x: any) => str(x, 32).replace(/[^A-Za-z0-9_]/g, ''))
      : [],
    keystone: num(p?.keystone),
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
    // Color de acento del overlay (hex #rrggbb) — personalización del caster
    accent: /^#[0-9a-fA-F]{6}$/.test(String(body?.accent || '')) ? String(body.accent) : '',
    players: Array.isArray(body?.players) ? body.players.slice(0, 10).map(sanitizePlayer) : [],
    // El companion manda TODOS los eventos de objetivos y estructuras + las
    // últimas kills: con 80 una partida larga perdía dragones y torres viejos.
    events: Array.isArray(body?.events) ? body.events.slice(-300).map(sanitizeEvent) : [],
    // ¿El historial de eventos arranca en el inicio de la partida? Si el
    // espectador entró a medias, el overlay no puede dar por vivo un objetivo.
    // null = companion viejo (no lo dice).
    eventsComplete: typeof body?.eventsComplete === 'boolean' ? body.eventsComplete : null,
    // 'player' = lo manda un jugador de la partida (eventos completos); 'spectator' = el caster.
    source: body?.source === 'player' ? 'player' : 'spectator',
    activePlayer: String(body?.activePlayer || '').slice(0, 64),
  };
}

// ── Plantillas de torneos activos (para reconocer una partida por sus jugadores) ──
type RosterIndex = { tournamentId: string; tournamentName: string; byId: Map<string, string>; byName: Map<string, string>; bracket: any[] };
let rosterCache: { at: number; list: RosterIndex[] } = { at: 0, list: [] };
async function rosters(): Promise<RosterIndex[]> {
  if (Date.now() - rosterCache.at < 60_000) return rosterCache.list;
  const [ts] = await pool.query<any[]>("SELECT id, name, bracket FROM tournaments WHERE phase IN ('active') AND name NOT REGEXP 'prueba|test|demo'");
  const list: RosterIndex[] = [];
  for (const t of ts) {
    const [regs] = await pool.query<any[]>('SELECT team_name, captain_riot_id, players FROM tournament_registrations WHERE tournament_id = ?', [t.id]);
    const byId = new Map<string, string>(), byName = new Map<string, string>();
    const add = (riotId: any, team: string) => { const r = String(riotId || '').trim().toLowerCase(); if (!r) return; byId.set(r, team); byName.set(r.split('#')[0], team); };
    for (const r of regs) { add(r.captain_riot_id, r.team_name); let ps: any[] = []; try { ps = typeof r.players === 'string' ? JSON.parse(r.players) : (r.players || []); } catch { ps = []; } for (const p of ps) add(p?.riotId, r.team_name); }
    let bracket: any[] = []; try { bracket = typeof t.bracket === 'string' ? JSON.parse(t.bracket) : (t.bracket || []); } catch { bracket = []; }
    list.push({ tournamentId: String(t.id), tournamentName: String(t.name), byId, byName, bracket: Array.isArray(bracket) ? bracket : [] });
  }
  rosterCache = { at: Date.now(), list };
  return list;
}
/** ¿A qué torneo y equipos pertenece esta partida? (≥ 5 de los 10 jugadores registrados) */
async function matchTournament(snapshot: any) {
  const players: any[] = snapshot.players || [];
  const teamOf = (idx: RosterIndex, riotId: string) => { const r = String(riotId || '').toLowerCase(); return idx.byId.get(r) || idx.byName.get(r.split('#')[0]) || null; };
  let best: { idx: RosterIndex; n: number; sides: Record<string, Record<string, number>> } | null = null;
  for (const idx of await rosters()) {
    const sides: Record<string, Record<string, number>> = { ORDER: {}, CHAOS: {} };
    let n = 0;
    for (const p of players) { const team = teamOf(idx, p.riotId); if (!team) continue; n++; const side = p.team === 'CHAOS' ? 'CHAOS' : 'ORDER'; sides[side][team] = (sides[side][team] || 0) + 1; }
    if (n >= 5 && (!best || n > best.n)) best = { idx, n, sides };
  }
  if (!best) return null;
  const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const team1 = top(best.sides.ORDER), team2 = top(best.sides.CHAOS);
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const m = best.idx.bracket.find((x: any) => (same(x.team1, team1) && same(x.team2, team2)) || (same(x.team1, team2) && same(x.team2, team1)));
  const played = m ? (m.games || []).length : 0;
  const bo = m ? (Number(m.bestOf) || Number(m.bo) || (Number(m.score1) + Number(m.score2) >= 2 ? 3 : 3)) : 3;
  const matchLabel = m ? `${best.idx.tournamentName.toUpperCase()} / RONDA ${m.round} / JUEGO ${played + 1} DE ${bo}` : best.idx.tournamentName.toUpperCase();
  return { channel: best.idx.tournamentId, team1, team2, matchLabel, matched: best.n };
}

// ── POST /api/live-feed/auto/push (companion de un JUGADOR de torneo; sin token) ──
// El backend reconoce la partida por la plantilla registrada y la publica en el
// canal del torneo con los nombres de los equipos y el rótulo de la serie.
router.post('/auto/push', async (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'bad_body' });
  try {
    const snap: any = sanitizeSnapshot(req.body);
    if (snap.source !== 'player' || (snap.players || []).length < 6) return res.json({ ok: false, reason: 'not_player' });
    const hit = await matchTournament(snap);
    if (!hit) return res.json({ ok: false, reason: 'not_tournament' });
    snap.team1 = hit.team1; snap.team2 = hit.team2; snap.matchLabel = hit.matchLabel;
    const [result] = await pool.query<any>(
      `INSERT INTO live_feed_channels (channel, seq, at, snapshot)
       VALUES (?, LAST_INSERT_ID(1), ?, ?)
       ON DUPLICATE KEY UPDATE
         seq = LAST_INSERT_ID(seq + 1), at = VALUES(at), snapshot = VALUES(snapshot)`,
      [hit.channel, Date.now(), JSON.stringify(snap)]
    );
    return res.json({ ok: true, channel: hit.channel, team1: hit.team1, team2: hit.team2, matched: hit.matched, seq: Number(result.insertId) || 1 });
  } catch (e: any) {
    console.error('[live-feed] auto push error:', e.message);
    return res.status(500).json({ error: 'push_failed' });
  }
});

// ── POST /api/live-feed/:channel/push (companion → backend; requiere token) ──
router.post('/:channel/push', async (req, res) => {
  if (!TOKEN) {
    return res.status(503).json({ error: 'live_feed_disabled', message: 'Configura LIVE_FEED_TOKEN en el backend para habilitar el broadcast en vivo.' });
  }
  if (String(req.headers['x-feed-token'] || '') !== TOKEN) {
    return res.status(401).json({ error: 'bad_token' });
  }
  const channel = String(req.params.channel).toLowerCase();
  if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'bad_channel' });
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'bad_body' });

  try {
    const snap = sanitizeSnapshot(req.body);
    // Si un JUGADOR de la partida está mandando el feed (eventos completos), el del
    // espectador no lo pisa mientras esté fresco.
    if (snap.source !== 'player') {
      const [[cur]] = await pool.query<any[]>('SELECT at, snapshot FROM live_feed_channels WHERE channel = ?', [channel]);
      if (cur && Date.now() - Number(cur.at) < 8000) {
        let prev: any = null; try { prev = typeof cur.snapshot === 'string' ? JSON.parse(cur.snapshot) : cur.snapshot; } catch { /* */ }
        if (prev?.source === 'player') return res.json({ ok: true, skipped: 'player_feed' });
      }
    }
    const snapshot = JSON.stringify(snap);
    // Truco LAST_INSERT_ID: el seq incrementado queda en result.insertId sin
    // necesidad de un SELECT extra ni de estado en memoria.
    const [result] = await pool.query<any>(
      `INSERT INTO live_feed_channels (channel, seq, at, snapshot)
       VALUES (?, LAST_INSERT_ID(1), ?, ?)
       ON DUPLICATE KEY UPDATE
         seq = LAST_INSERT_ID(seq + 1), at = VALUES(at), snapshot = VALUES(snapshot)`,
      [channel, Date.now(), snapshot]
    );
    // GC ocasional de canales muertos (~1 de cada 50 pushes)
    if (Math.random() < 0.02) {
      pool.query('DELETE FROM live_feed_channels WHERE at < ?', [Date.now() - 10 * 60_000]).catch(() => {});
    }
    return res.json({ ok: true, seq: Number(result.insertId) || 1 });
  } catch (e: any) {
    console.error('[live-feed] push error:', e.message);
    return res.status(500).json({ error: 'push_failed' });
  }
});

// ── DELETE /api/live-feed/:channel (companion al terminar; requiere token) ──
router.delete('/:channel', async (req, res) => {
  if (!TOKEN || String(req.headers['x-feed-token'] || '') !== TOKEN) {
    return res.status(401).json({ error: 'bad_token' });
  }
  try {
    await pool.query('DELETE FROM live_feed_channels WHERE channel = ?', [String(req.params.channel).toLowerCase()]);
  } catch (e: any) {
    console.error('[live-feed] delete error:', e.message);
  }
  return res.json({ ok: true });
});

// ── GET /api/live-feed/:channel (público, sin caché) ────────────────────────
// OJO: NO fijar Access-Control-Allow-Origin:* aquí — el frontend manda
// withCredentials y el navegador rechaza respuestas con wildcard; el
// middleware global de CORS ya refleja el origin permitido.
router.get('/:channel', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const channel = String(req.params.channel).toLowerCase();
  if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'bad_channel' });
  try {
    const [[row]] = await pool.query<any[]>(
      'SELECT seq, at, snapshot FROM live_feed_channels WHERE channel = ?',
      [channel]
    );
    if (!row || Date.now() - Number(row.at) > TTL_MS) return res.status(204).end();
    const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    return res.json({ ok: true, seq: Number(row.seq), ageMs: Date.now() - Number(row.at), ...snapshot });
  } catch (e: any) {
    console.error('[live-feed] get error:', e.message);
    return res.status(204).end();
  }
});

export default router;
