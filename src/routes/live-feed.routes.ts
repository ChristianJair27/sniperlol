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
  // Objetivos marcados a mano por el caster (el espectador no recibe dragón/larvas/heraldo/barón).
  await pool.query('ALTER TABLE live_feed_channels ADD COLUMN IF NOT EXISTS manual LONGTEXT NULL').catch(() => {});
  // Champ select en curso (overlay de selección para OBS): aparte del snapshot in-game.
  await pool.query('ALTER TABLE live_feed_channels ADD COLUMN IF NOT EXISTS champselect LONGTEXT NULL').catch(() => {});
  await pool.query('ALTER TABLE live_feed_channels ADD COLUMN IF NOT EXISTS cs_at BIGINT NULL').catch(() => {});
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
    // true si lo leyó el companion del HUD del espectador (no viene del Live Client).
    ...(e?.hud === true ? { hud: true } : {}),
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
    // true/false cuando el companion del jugador lo sabe por el LCU (solo las customs son de torneo).
    isCustom: typeof body?.isCustom === 'boolean' ? body.isCustom : null,
    // true cuando el companion del caster lee los objetivos del HUD del
    // espectador (companion >= 0.4.8): el overlay puede fiarse de dragones/barón.
    hud: body?.hud === true,
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
/** ¿A qué torneo y equipos pertenece esta partida? Cada lado debe ser un equipo registrado
 *  (≥ 3 jugadores de la misma plantilla por lado, equipos distintos). Un equipo del torneo
 *  jugando flex/normales contra desconocidos NO cuenta: antes eso se publicaba en el tablero. */
async function matchTournament(snapshot: any) {
  if (snapshot?.isCustom === false) return null;
  const players: any[] = snapshot.players || [];
  const teamOf = (idx: RosterIndex, riotId: string) => { const r = String(riotId || '').toLowerCase(); return idx.byId.get(r) || idx.byName.get(r.split('#')[0]) || null; };
  let best: { idx: RosterIndex; n: number; sides: Record<string, Record<string, number>> } | null = null;
  for (const idx of await rosters()) {
    const sides: Record<string, Record<string, number>> = { ORDER: {}, CHAOS: {} };
    let n = 0;
    for (const p of players) { const team = teamOf(idx, p.riotId); if (!team) continue; n++; const side = p.team === 'CHAOS' ? 'CHAOS' : 'ORDER'; sides[side][team] = (sides[side][team] || 0) + 1; }
    const topOf = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1])[0] || ['', 0];
    const [t1, n1] = topOf(sides.ORDER), [t2, n2] = topOf(sides.CHAOS);
    const twoTeams = Number(n1) >= 3 && Number(n2) >= 3 && String(t1).trim().toLowerCase() !== String(t2).trim().toLowerCase();
    if (twoTeams && n >= 6 && (!best || n > best.n)) best = { idx, n, sides };
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
    void resetManualIfNewGame(hit.channel, Number(snap.gameTime) || 0);
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
    const snap: any = sanitizeSnapshot(req.body);
    // Equipos y rótulo automáticos: si los 10 jugadores coinciden con una plantilla del
    // torneo de este canal, se ignora lo que el caster escribió (suele quedar la serie anterior).
    try {
      const hit = await matchTournament(snap);
      if (hit && hit.channel === channel) { snap.team1 = hit.team1; snap.team2 = hit.team2; snap.matchLabel = hit.matchLabel; snap.logo1 = ''; snap.logo2 = ''; }
    } catch { /* sin plantillas: se respeta lo configurado */ }
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
    void resetManualIfNewGame(channel, Number(snap.gameTime) || 0);
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

// ── Objetivos a mano (caster): POST /:channel/mark · DELETE /:channel/mark/last · DELETE /:channel/mark ──
// El espectador no recibe DragonKill/HordeKill/HeraldKill/BaronKill. Desde la
// página /broadcast/:canal/control el caster los marca con un clic y el GET los
// mezcla con el feed como si fueran eventos reales (killer = un jugador del lado).
const MARK_NAMES = new Set(['DragonKill', 'HordeKill', 'HeraldKill', 'BaronKill', 'TurretKilled']);
const DRAGON_TYPES = new Set(['Fire', 'Water', 'Earth', 'Air', 'Hextech', 'Chemtech', 'Elder']);
function parseManual(raw: any): Array<{ id: number; t: number; name: string; killer: string; victim: string; assisters: string[]; extra: string; side: string; manual: true }> {
  try { const v = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(v) ? v : []; } catch { return []; }
}
router.post('/:channel/mark', async (req, res) => {
  if (!TOKEN || String(req.headers['x-feed-token'] || '') !== TOKEN) return res.status(401).json({ error: 'bad_token' });
  const channel = String(req.params.channel).toLowerCase();
  if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'bad_channel' });
  const name = String(req.body?.name || '');
  const side = req.body?.side === 'red' ? 'red' : 'blue';
  const extra = String(req.body?.extra || '');
  if (!MARK_NAMES.has(name)) return res.status(400).json({ error: 'name inválido' });
  if (name === 'DragonKill' && !DRAGON_TYPES.has(extra)) return res.status(400).json({ error: 'tipo de dragón inválido' });
  try {
    const [[row]] = await pool.query<any[]>('SELECT at, snapshot, manual FROM live_feed_channels WHERE channel = ?', [channel]);
    if (!row) return res.status(409).json({ error: 'No hay partida en vivo en este canal (el companion del caster no está enviando).' });
    const snap = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    const players: any[] = Array.isArray(snap?.players) ? snap.players : [];
    const killer = players.find((p) => (p.team === 'CHAOS') === (side === 'red'))?.riotId || (side === 'red' ? 'CHAOS' : 'ORDER');
    const manual = parseManual(row.manual);
    const t = Number.isFinite(Number(req.body?.t)) ? Math.max(0, Math.round(Number(req.body.t))) : Math.round(Number(snap?.gameTime) || 0);
    const ev = { id: 900000 + manual.length + 1, t, name, killer, victim: '', assisters: [], extra: name === 'TurretKilled' ? (side === 'red' ? 'Turret_T1_manual' : 'Turret_T2_manual') : extra, side, manual: true as const };
    manual.push(ev);
    await pool.query('UPDATE live_feed_channels SET manual = ? WHERE channel = ?', [JSON.stringify(manual), channel]);
    return res.json({ ok: true, count: manual.length, event: ev });
  } catch (e: any) { console.error('[live-feed] mark error:', e.message); return res.status(500).json({ error: 'mark_failed' }); }
});
router.get('/:channel/mark', async (req, res) => {
  const channel = String(req.params.channel).toLowerCase();
  try {
    const [[row]] = await pool.query<any[]>('SELECT manual FROM live_feed_channels WHERE channel = ?', [channel]);
    return res.json({ ok: true, events: row ? parseManual(row.manual) : [] });
  } catch { return res.json({ ok: true, events: [] }); }
});
router.delete('/:channel/mark/last', async (req, res) => {
  if (!TOKEN || String(req.headers['x-feed-token'] || '') !== TOKEN) return res.status(401).json({ error: 'bad_token' });
  const channel = String(req.params.channel).toLowerCase();
  try {
    const [[row]] = await pool.query<any[]>('SELECT manual FROM live_feed_channels WHERE channel = ?', [channel]);
    const manual = row ? parseManual(row.manual) : [];
    const removed = manual.pop() || null;
    if (row) await pool.query('UPDATE live_feed_channels SET manual = ? WHERE channel = ?', [manual.length ? JSON.stringify(manual) : null, channel]);
    return res.json({ ok: true, removed, count: manual.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});
router.delete('/:channel/mark', async (req, res) => {
  if (!TOKEN || String(req.headers['x-feed-token'] || '') !== TOKEN) return res.status(401).json({ error: 'bad_token' });
  const channel = String(req.params.channel).toLowerCase();
  try { await pool.query('UPDATE live_feed_channels SET manual = NULL WHERE channel = ?', [channel]); return res.json({ ok: true }); }
  catch (e: any) { return res.status(500).json({ error: e.message }); }
});
// Partida nueva (el reloj vuelve a empezar): los marcados de la anterior se borran solos.
async function resetManualIfNewGame(channel: string, gameTime: number) {
  if (!(gameTime < 120)) return;
  try {
    const [[row]] = await pool.query<any[]>('SELECT manual FROM live_feed_channels WHERE channel = ?', [channel]);
    const manual = row ? parseManual(row.manual) : [];
    if (manual.some((m) => m.t > gameTime + 30)) await pool.query('UPDATE live_feed_channels SET manual = NULL WHERE channel = ?', [channel]);
  } catch { /* mejor esfuerzo */ }
}

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
// ── Champ select (overlay /broadcast/:canal/champselect) ─────────────────────
// El companion del caster (en el lobby de la custom como espectador) manda el
// estado de la selección cada segundo; termina con {ended:true}. TTL corto.
const CS_TTL_MS = 120_000;
const ID_LIST = (v: any, max = 10) => (Array.isArray(v) ? v.slice(0, max).map((x) => num(x)).filter((n) => n > 0) : []);
function sanitizeCell(c: any) {
  return {
    cellId: num(c?.cellId),
    championId: num(c?.championId),
    championName: str(c?.championName, 40),
    championKey: str(c?.championKey, 40).replace(/[^A-Za-z0-9]/g, ''),
    position: str(c?.position, 12).toLowerCase(),
    summonerName: str(c?.summonerName, 32),
    tagLine: str(c?.tagLine, 8),
    acting: !!c?.acting,
    locked: !!c?.locked,
  };
}
function sanitizeChampSelect(body: any) {
  if (body?.ended === true) return { ended: true };
  return {
    ended: false,
    phase: str(body?.phase, 24),
    actionType: str(body?.actionType, 12),
    timerSecs: Math.max(0, Math.round(num(body?.timerSecs))),
    timerTotalSecs: Math.max(0, Math.round(num(body?.timerTotalSecs))),
    blue: Array.isArray(body?.blue) ? body.blue.slice(0, 5).map(sanitizeCell) : [],
    red: Array.isArray(body?.red) ? body.red.slice(0, 5).map(sanitizeCell) : [],
    bans: { blue: ID_LIST(body?.bans?.blue, 5), red: ID_LIST(body?.bans?.red, 5) },
    // Fearless: campeones ya usados en la serie por cada lado.
    used: { blue: ID_LIST(body?.used?.blue, 30), red: ID_LIST(body?.used?.red, 30) },
    game: Math.max(1, Math.min(9, Math.round(num(body?.game)) || 1)),
    matchLabel: str(body?.matchLabel, 120),
    team1: str(body?.team1, 40), team2: str(body?.team2, 40),
    logo1: str(body?.logo1, 300), logo2: str(body?.logo2, 300),
    accent: /^#[0-9a-fA-F]{6}$/.test(String(body?.accent || '')) ? String(body.accent) : '',
  };
}

router.post('/:channel/champselect', async (req, res) => {
  if (!TOKEN) return res.status(503).json({ error: 'live_feed_disabled' });
  if (String(req.headers['x-feed-token'] || '') !== TOKEN) return res.status(401).json({ error: 'bad_token' });
  const channel = String(req.params.channel).toLowerCase();
  if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'bad_channel' });
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: 'bad_body' });
  try {
    const cs = sanitizeChampSelect(req.body);
    // Si los 10 jugadores coinciden con plantillas del torneo del canal, los nombres de
    // equipo salen de ahí (igual que en el snapshot in-game).
    if (!cs.ended) {
      try {
        const players = [...cs.blue.map((c: any) => ({ riotId: `${c.summonerName}#${c.tagLine}`, team: 'ORDER' })), ...cs.red.map((c: any) => ({ riotId: `${c.summonerName}#${c.tagLine}`, team: 'CHAOS' }))];
        const hit = await matchTournament({ players });
        if (hit && hit.channel === channel) { cs.team1 = hit.team1; cs.team2 = hit.team2; cs.matchLabel = hit.matchLabel; }
      } catch { /* sin plantillas */ }
    }
    await pool.query(
      `INSERT INTO live_feed_channels (channel, seq, at, snapshot, champselect, cs_at)
       VALUES (?, 1, 0, '{}', ?, ?)
       ON DUPLICATE KEY UPDATE champselect = VALUES(champselect), cs_at = VALUES(cs_at)`,
      [channel, JSON.stringify(cs), Date.now()]
    );
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('[live-feed] champselect push error:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

router.get('/:channel/champselect', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const channel = String(req.params.channel).toLowerCase();
  if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'bad_channel' });
  try {
    const [[row]] = await pool.query<any[]>('SELECT champselect, cs_at FROM live_feed_channels WHERE channel = ?', [channel]);
    if (!row?.champselect || Date.now() - Number(row.cs_at) > CS_TTL_MS) return res.status(204).end();
    const cs = typeof row.champselect === 'string' ? JSON.parse(row.champselect) : row.champselect;
    if (cs?.ended) return res.status(204).end();
    return res.json({ ok: true, ageMs: Date.now() - Number(row.cs_at), ...cs });
  } catch (e: any) {
    console.error('[live-feed] champselect get error:', e.message);
    return res.status(204).end();
  }
});

// ── Serie en curso (cinemática de intro, tablero): equipos, marcador, plantillas, récord ──
// Los equipos salen del champ select (si está fresco), si no del snapshot in-game,
// y si no de ?t1=&t2=. Con ellos se busca el partido del bracket del torneo activo.
const slugify = (s: string) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
router.get('/:channel/series', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const channel = String(req.params.channel).toLowerCase();
  if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'bad_channel' });
  try {
    const [[row]] = await pool.query<any[]>('SELECT at, snapshot, champselect, cs_at FROM live_feed_channels WHERE channel = ?', [channel]);
    let t1 = String(req.query.t1 || ''), t2 = String(req.query.t2 || ''), from = 'query';
    const parse = (v: any) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
    if (!t1 || !t2) {
      const cs = row?.champselect && Date.now() - Number(row.cs_at) < CS_TTL_MS ? parse(row.champselect) : null;
      const snap = row?.snapshot && Date.now() - Number(row.at) < TTL_MS ? parse(row.snapshot) : null;
      if (cs && !cs.ended && cs.team1 && cs.team2) { t1 = cs.team1; t2 = cs.team2; from = 'champselect'; }
      else if (snap?.team1 && snap?.team2) { t1 = snap.team1; t2 = snap.team2; from = 'snapshot'; }
    }
    if (!t1 || !t2) return res.status(204).end();
    const norm = (x: string) => String(x || '').trim().toLowerCase();
    let hit: { idx: RosterIndex; match: any } | null = null;
    for (const idx of await rosters()) {
      const m = idx.bracket.find((bm: any) => (norm(bm.team1) === norm(t1) && norm(bm.team2) === norm(t2)) || (norm(bm.team1) === norm(t2) && norm(bm.team2) === norm(t1)));
      if (m) { hit = { idx, match: m }; break; }
    }
    const teamInfo = async (tournamentId: string | null, name: string) => {
      let roster: Array<{ name: string; riotId: string; role: string }> = []; let captain = '';
      if (tournamentId) {
        const [[reg]] = await pool.query<any[]>('SELECT team_name, captain_riot_id, players FROM tournament_registrations WHERE tournament_id = ? AND LOWER(team_name) = ? LIMIT 1', [tournamentId, norm(name)]);
        if (reg) {
          captain = String(reg.captain_riot_id || '');
          const ps = parse(reg.players) || [];
          roster = (Array.isArray(ps) ? ps : []).map((p: any) => ({ name: String(p?.name || p?.playerName || p?.riotId || '').split('#')[0].slice(0, 32), riotId: String(p?.riotId || '').slice(0, 48), role: String(p?.role || p?.position || '').slice(0, 16) }));
        }
      }
      return { name, slug: slugify(name), captain, roster };
    };
    let standings: any[] = [];
    if (hit) {
      const [[tr]] = await pool.query<any[]>('SELECT standings, fearless FROM tournaments WHERE id = ?', [hit.idx.tournamentId]);
      standings = parse(tr?.standings) || [];
      (hit as any).season = null; (hit as any).fearless = !!tr?.fearless;
    }
    const rec = (name: string) => { const st = (Array.isArray(standings) ? standings : []).find((x: any) => norm(x?.team) === norm(name)); return st ? { wins: Number(st.wins) || 0, losses: Number(st.losses) || 0, position: Number(st.position) || null } : null; };
    const m = hit?.match;
    // El bracket guarda team1/team2 en su orden; la transmisión usa azul/rojo. Se respeta el orden pedido.
    const swap = m && norm(m.team1) !== norm(t1);
    const score = m ? { team1: Number(swap ? m.score2 : m.score1) || 0, team2: Number(swap ? m.score1 : m.score2) || 0 } : { team1: 0, team2: 0 };
    const tid = hit ? hit.idx.tournamentId : null;
    return res.json({
      ok: true, from,
      tournament: hit ? { id: tid, name: hit.idx.tournamentName, season: (hit as any).season, fearless: (hit as any).fearless } : null,
      match: m ? { id: m.id, round: m.round, matchNumber: m.matchNumber, status: m.matchStatus, seriesTo: Number(m.seriesTo) || 1, gamesPlayed: Array.isArray(m.games) ? m.games.length : (m.gameId ? 1 : 0), score } : null,
      team1: { ...(await teamInfo(tid, t1)), record: rec(t1) },
      team2: { ...(await teamInfo(tid, t2)), record: rec(t2) },
    });
  } catch (e: any) {
    console.error('[live-feed] series error:', e.message);
    return res.status(500).json({ error: 'server_error' });
  }
});

router.get('/:channel', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const channel = String(req.params.channel).toLowerCase();
  if (!CHANNEL_RE.test(channel)) return res.status(400).json({ error: 'bad_channel' });
  try {
    const [[row]] = await pool.query<any[]>(
      'SELECT seq, at, snapshot, manual FROM live_feed_channels WHERE channel = ?',
      [channel]
    );
    if (!row || Date.now() - Number(row.at) > TTL_MS) return res.status(204).end();
    const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    const manual = parseManual(row.manual);
    if (manual.length) {
      // Un objetivo que el feed ya trae (companion de un jugador) no se duplica.
      const feedEvents: any[] = Array.isArray(snapshot.events) ? snapshot.events : [];
      const extra = manual.filter((m) => !feedEvents.some((e) => e.name === m.name && Math.abs(Number(e.t) - m.t) < 120 && (m.name !== 'DragonKill' || e.extra === m.extra)));
      snapshot.events = [...feedEvents, ...extra].sort((a, b) => Number(a.t) - Number(b.t));
      snapshot.eventsComplete = true;
      snapshot.manualEvents = manual.length;
    }
    if (snapshot.hud === true) snapshot.eventsComplete = true;
    return res.json({ ok: true, seq: Number(row.seq), ageMs: Date.now() - Number(row.at), ...snapshot });
  } catch (e: any) {
    console.error('[live-feed] get error:', e.message);
    return res.status(204).end();
  }
});

export default router;
