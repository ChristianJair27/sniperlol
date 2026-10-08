// Replays (.rofl) de las partidas de torneo.
//
// El cliente de League permite descargar el replay de CUALQUIER partida de la
// región mientras esté dentro de los últimos parches (endpoint LCU
// /lol-replays). El companion, en la PC de cualquier jugador o caster, pide
// aquí qué partidas de torneo faltan (GET /wanted), las baja del cliente y las
// sube (POST). El archivo se guarda en la base (LONGBLOB: MariaDB con
// max_allowed_packet de 1 GB, respaldado con el resto) y se sirve público
// (GET) para "descargar replay" en la app y para el render a video.
import { Router, raw } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import { riot, getMatchById } from '../services/riot.js';
import { upsertClipPost } from './social.routes.js';

const router = Router();
const MAX_BYTES = 80 * 1024 * 1024;
const MIN_BYTES = 64 * 1024;

const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const readLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false });

async function initTables() {
  // Clips de video (highlights) renderizados a partir del replay.
  await pool.query(`CREATE TABLE IF NOT EXISTS tournament_clips (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tournament_id VARCHAR(64) NOT NULL,
    match_id VARCHAR(32) NOT NULL,
    game_id BIGINT NOT NULL,
    game_region VARCHAR(8) NOT NULL,
    clip_key VARCHAR(64) NOT NULL,
    t_start INT NOT NULL,
    t_end INT NOT NULL,
    kind VARCHAR(32) NOT NULL,
    title VARCHAR(160) NOT NULL,
    players TEXT DEFAULT NULL,
    mime VARCHAR(40) NOT NULL DEFAULT 'video/mp4',
    size INT NOT NULL,
    data LONGBLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_clip (game_region, game_id, clip_key),
    KEY idx_clip_t (tournament_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tournament_replays (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tournament_id VARCHAR(64) NOT NULL,
    match_id VARCHAR(32) NOT NULL,
    game_id BIGINT NOT NULL,
    game_region VARCHAR(8) NOT NULL,
    patch VARCHAR(32) DEFAULT NULL,
    game_length_ms INT DEFAULT NULL,
    size INT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    data LONGBLOB NOT NULL,
    uploaded_by VARCHAR(128) DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_game (game_region, game_id),
    KEY idx_tournament (tournament_id)
  )`);
}
initTables().catch((e) => console.error('[replays] initTables:', e.message));

// ── Partidas de torneo conocidas (gameId ↔ torneo/serie) ─────────────────────
export interface TournamentGame {
  tournamentId: string; tournamentName: string; matchId: string; round: number;
  gameId: number; region: string; team1: string; team2: string; winner: string | null; gameNumber: number;
}
let gamesCache: { at: number; list: TournamentGame[] } | null = null;
const parseJson = (v: any) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const normRegion = (r: any, fallback = 'la1') => String(r || fallback).toUpperCase();

export async function tournamentGames(): Promise<TournamentGame[]> {
  if (gamesCache && Date.now() - gamesCache.at < 60_000) return gamesCache.list;
  // Torneos reales: fuera los de prueba (sus gameId son inventados y el cliente nunca los tendrá).
  const [rows] = await pool.query<any[]>("SELECT id, name, region, bracket FROM tournaments WHERE phase IN ('active','complete') AND name NOT REGEXP 'prueba|test|demo'");
  const list: TournamentGame[] = [];
  for (const row of rows) {
    const bracket = parseJson(row.bracket);
    if (!Array.isArray(bracket)) continue;
    for (const m of bracket) {
      if (!m || m.team2 === 'BYE' || m.team1 === 'BYE') continue;
      const games: any[] = Array.isArray(m.games) && m.games.length ? m.games : (m.gameId ? [{ gameId: m.gameId, gameRegion: m.gameRegion, winner: m.winner }] : []);
      games.forEach((g, i) => {
        const gameId = Number(g?.gameId);
        if (!gameId) return;
        list.push({
          tournamentId: row.id, tournamentName: row.name, matchId: String(m.id), round: Number(m.round) || 0,
          gameId, region: normRegion(g.gameRegion || m.gameRegion || row.region), team1: m.team1, team2: m.team2,
          winner: g.winner ?? null, gameNumber: i + 1,
        });
      });
    }
  }
  // Las más recientes primero (los gameId de Riot crecen con el tiempo).
  list.sort((a, b) => b.gameId - a.gameId);
  gamesCache = { at: Date.now(), list };
  return list;
}

/** Partida de torneo o, si no, partida "manual" (de prueba) que ya tenga replay guardado. */
async function gameInfo(region: string, gameId: number): Promise<TournamentGame | null> {
  const t = (await tournamentGames()).find((g) => g.gameId === gameId && g.region === region);
  if (t) return t;
  const [[row]] = await pool.query<any[]>("SELECT tournament_id, match_id FROM tournament_replays WHERE game_region = ? AND game_id = ? AND tournament_id = 'manual' LIMIT 1", [region, gameId]);
  if (!row) return null;
  return { tournamentId: 'manual', tournamentName: 'Pruebas', matchId: String(row.match_id), round: 0, gameId, region, team1: 'Lado azul', team2: 'Lado rojo', winner: null, gameNumber: 1 };
}

async function storedSet(): Promise<Set<string>> {
  const [rows] = await pool.query<any[]>('SELECT game_region, game_id FROM tournament_replays');
  return new Set(rows.map((r) => `${r.game_region}:${r.game_id}`));
}
const key = (region: string, gameId: number) => `${normRegion(region)}:${gameId}`;

// Metadatos del .rofl: el formato actual ("RIOT") lleva al FINAL del archivo
// un JSON con gameLength (ms), lastGameChunkId y statsJson. gameVersion no
// siempre viene (el companion lo manda en X-Patch). Mejor esfuerzo con regex
// sobre la cola del archivo.
function roflMeta(buf: Buffer): { gameVersion?: string; gameLength?: number } | null {
  try {
    if (buf.length < 64 || buf.toString('latin1', 0, 4) !== 'RIOT') return null;
    const tail = buf.toString('latin1', Math.max(0, buf.length - 6_000_000));
    const len = /"gameLength":(\d+)/.exec(tail);
    const ver = /"gameVersion":"([^"]+)"/.exec(tail);
    if (!len && !ver) return null;
    return { gameVersion: ver?.[1], gameLength: len ? Number(len[1]) : undefined };
  } catch { return null; }
}

const publicUrl = (req: any, region: string, gameId: number) => `${req.protocol}://${req.get('host')}/api/replays/${region}/${gameId}`;

// ── GET /api/replays/wanted?region=LA1&limit=20 ──────────────────────────────
// Partidas de torneo sin replay guardado, para que el companion las baje.
router.get('/wanted', readLimiter, async (req, res) => {
  try {
    const region = req.query.region ? normRegion(req.query.region) : null;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const have = await storedSet();
    const list = (await tournamentGames()).filter((g) => !have.has(key(g.region, g.gameId)) && (!region || g.region === region)).slice(0, limit);
    res.json({ ok: true, wanted: list });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/replays/tournament/:id ───────────────────────────────────────────
router.get('/tournament/:id', readLimiter, async (req, res) => {
  try {
    const [rows] = await pool.query<any[]>(
      'SELECT match_id, game_id, game_region, patch, game_length_ms, size, created_at FROM tournament_replays WHERE tournament_id = ? ORDER BY game_id DESC', [req.params.id]);
    const games = (await tournamentGames()).filter((g) => g.tournamentId === req.params.id);
    const have = new Set(rows.map((r) => key(r.game_region, r.game_id)));
    res.json({
      ok: true,
      replays: rows.map((r) => ({
        matchId: r.match_id, gameId: Number(r.game_id), region: r.game_region, patch: r.patch, gameLengthMs: r.game_length_ms,
        size: r.size, createdAt: r.created_at, url: publicUrl(req, r.game_region, Number(r.game_id)),
      })),
      pending: games.filter((g) => !have.has(key(g.region, g.gameId))).length,
    });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/replays/tournament/:id/clips — todos los clips del torneo (galería)
router.get('/tournament/:id/clips', readLimiter, async (req, res) => {
  try {
    const [rows] = await pool.query<any[]>('SELECT match_id, game_id, game_region, clip_key, t_start, t_end, kind, title, players, mime, size, created_at FROM tournament_clips WHERE tournament_id = ? ORDER BY game_id DESC, t_start', [req.params.id]);
    res.json({ ok: true, clips: rows.map((r) => ({ matchId: r.match_id, gameId: Number(r.game_id), region: r.game_region, key: r.clip_key, tStart: r.t_start, tEnd: r.t_end, kind: r.kind, title: r.title, players: parseJson(r.players) || [], mime: r.mime, size: r.size, createdAt: r.created_at, url: clipUrl(req, r.game_region, Number(r.game_id), r.clip_key) })) });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── POST /api/replays/:region/:gameId  (cuerpo = .rofl crudo) ─────────────────
router.post('/:region/:gameId', uploadLimiter, raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
  try {
    const region = normRegion(req.params.region);
    const gameId = Number(req.params.gameId);
    if (!gameId) return res.status(400).json({ ok: false, error: 'gameId inválido' });
    let game = await gameInfo(region, gameId);
    if (!game) {
      // Fuera de torneo solo el worker de render (pruebas / partidas sueltas): tournament_id 'manual'.
      const token = (process.env.RENDER_TOKEN || '').trim();
      if (token && req.get('x-render-token') === token) game = { tournamentId: 'manual', tournamentName: 'Pruebas', matchId: `manual-${gameId}`, round: 0, gameId, region, team1: 'Lado azul', team2: 'Lado rojo', winner: null, gameNumber: 1 };
      else return res.status(404).json({ ok: false, error: 'esa partida no es de ningún torneo de ATAK.GG' });
    }
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.length < MIN_BYTES) return res.status(400).json({ ok: false, error: 'archivo demasiado pequeño' });
    if (buf.toString('latin1', 0, 4) !== 'RIOT') return res.status(400).json({ ok: false, error: 'no es un archivo .rofl' });
    const meta = roflMeta(buf);
    const patch = String(req.get('x-patch') || meta?.gameVersion || '').slice(0, 32) || null;
    const uploadedBy = String(req.get('x-uploader') || '').slice(0, 128) || null;
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const [r] = await pool.query<any>(
      `INSERT IGNORE INTO tournament_replays (tournament_id, match_id, game_id, game_region, patch, game_length_ms, size, sha256, data, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [game.tournamentId, game.matchId, gameId, region, patch, meta?.gameLength ?? null, buf.length, sha, buf, uploadedBy]);
    const stored = Number(r?.affectedRows) > 0;
    console.log(`[replays] ${stored ? 'guardado' : 'ya existía'} ${region}-${gameId} (${(buf.length / 1048576).toFixed(1)} MB, ${game.tournamentId} ${game.matchId}) de ${uploadedBy || '?'}`);
    res.status(stored ? 201 : 200).json({ ok: true, stored, url: publicUrl(req, region, gameId) });
  } catch (e: any) {
    if (e?.type === 'entity.too.large') return res.status(413).json({ ok: false, error: 'archivo demasiado grande' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Momentos clave (highlights) desde el timeline de match-v5 ─────────────────
// Lo usa el render de video para saber qué cortar y la app para listar "momentos".
const REGIONAL: Record<string, string> = { LA1: 'americas', LA2: 'americas', NA1: 'americas', BR1: 'americas', OC1: 'sea', EUW1: 'europe', EUN1: 'europe', TR1: 'europe', RU: 'europe', KR: 'asia', JP1: 'asia' };
export interface Moment { key: string; t: number; tStart: number; tEnd: number; kind: string; title: string; score: number; team?: 'blue' | 'red'; pos?: { x: number; y: number }; players: Array<{ name: string; champion: string; team: 'blue' | 'red' }> }
const momentsCache = new Map<string, { at: number; data: any }>();
const MULTI: Record<number, [string, number]> = { 2: ['Doble asesinato', 3], 3: ['Triple asesinato', 6], 4: ['Cuádruple asesinato', 9], 5: ['PENTAKILL', 12] };
const MONSTER: Record<string, [string, number]> = { BARON_NASHOR: ['Barón Nashor', 5], RIFTHERALD: ['Heraldo', 2], DRAGON: ['Dragón', 1], HORDE: ['Vacuolarvas', 0] };

const tlCache = new Map<string, { at: number; tl: any }>();
async function getTimeline(region: string, matchId: string) {
  const c = tlCache.get(matchId);
  if (c && Date.now() - c.at < 6 * 3600_000) return c.tl;
  const regional = REGIONAL[region] || 'americas';
  const { data: tl } = await riot.get(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`, { headers: { 'X-Riot-Token': (process.env.RIOT_API_KEY || '').trim() } });
  tlCache.set(matchId, { at: Date.now(), tl });
  return tl;
}

async function computeMoments(region: string, gameId: number) {
  const platform = region.toLowerCase();
  const matchId = `${region}_${gameId}`;
  const match = await getMatchById(platform, matchId);
  if (!match?.info) return null;
  const tl = await getTimeline(region, matchId);
  const parts = new Map<number, { name: string; champion: string; team: 'blue' | 'red' }>();
  for (const p of match.info.participants || []) parts.set(Number(p.participantId), { name: p.riotIdGameName || p.summonerName || `P${p.participantId}`, champion: p.championName || '', team: Number(p.teamId) === 100 ? 'blue' : 'red' });
  const who = (id: any) => parts.get(Number(id));
  const sec = (ms: number) => Math.round(ms / 1000);
  const moments: Moment[] = [];
  const kills: Array<{ t: number; killer?: number; victim: number; assists: number[]; pos?: { x: number; y: number } }> = [];
  let lastKillPos: { x: number; y: number } | undefined;
  for (const f of tl?.info?.frames || []) {
    for (const ev of f.events || []) {
      const t = sec(ev.timestamp || 0);
      const pos = ev.position && Number.isFinite(ev.position.x) ? { x: Number(ev.position.x), y: Number(ev.position.y) } : undefined;
      if (ev.type === 'CHAMPION_KILL') { kills.push({ t, killer: ev.killerId, victim: ev.victimId, assists: ev.assistingParticipantIds || [], pos }); lastKillPos = pos || lastKillPos; }
      else if (ev.type === 'CHAMPION_SPECIAL_KILL') {
        const k = who(ev.killerId); if (!k) continue;
        if (ev.killType === 'KILL_FIRST_BLOOD') moments.push({ key: `fb-${t}`, t, tStart: t - 10, tEnd: t + 4, kind: 'first_blood', title: `Primera sangre · ${k.name}`, score: 3, team: k.team, pos: pos || lastKillPos, players: [k] });
        else if (ev.killType === 'KILL_MULTI' && MULTI[ev.multiKillLength]) { const [label, sc] = MULTI[ev.multiKillLength]; moments.push({ key: `multi${ev.multiKillLength}-${t}`, t, tStart: t - 14, tEnd: t + 5, kind: `multikill_${ev.multiKillLength}`, title: `${label} · ${k.name} (${k.champion})`, score: sc, team: k.team, pos: pos || lastKillPos, players: [k] }); }
        else if (ev.killType === 'KILL_ACE') moments.push({ key: `ace-${t}`, t, tStart: t - 16, tEnd: t + 5, kind: 'ace', title: `ACE · ${k.team === 'blue' ? 'lado azul' : 'lado rojo'}`, score: 7, team: k.team, pos: pos || lastKillPos, players: [k] });
      } else if (ev.type === 'ELITE_MONSTER_KILL') {
        const base = MONSTER[ev.monsterType]; if (!base) continue;
        const k = who(ev.killerId); const team: 'blue' | 'red' = Number(ev.killerTeamId) === 100 ? 'blue' : 'red';
        let [label, sc] = base;
        if (ev.monsterType === 'DRAGON' && ev.monsterSubType === 'ELDER_DRAGON') { label = 'Dragón Anciano'; sc = 6; }
        if (sc <= 0) continue;
        moments.push({ key: `${ev.monsterType.toLowerCase()}-${t}`, t, tStart: t - 12, tEnd: t + 4, kind: ev.monsterType.toLowerCase(), title: `${label} · ${team === 'blue' ? 'lado azul' : 'lado rojo'}${k ? ` (${k.name})` : ''}`, score: sc, team, pos, players: k ? [k] : [] });
      } else if (ev.type === 'BUILDING_KILL' && ev.buildingType === 'INHIBITOR_BUILDING') {
        const team: 'blue' | 'red' = Number(ev.teamId) === 100 ? 'red' : 'blue'; // teamId = dueño del edificio
        moments.push({ key: `inhib-${t}`, t, tStart: t - 10, tEnd: t + 3, kind: 'inhibitor', title: `Inhibidor destruido · ${team === 'blue' ? 'lado azul' : 'lado rojo'}`, score: 2, team, pos, players: [] });
      }
    }
  }
  // Peleas: 3+ asesinatos en una ventana de 20 s.
  kills.sort((a, b) => a.t - b.t);
  let i = 0;
  while (i < kills.length) {
    let j = i; while (j + 1 < kills.length && kills[j + 1].t - kills[i].t <= 20) j++;
    const n = j - i + 1;
    if (n >= 3) {
      const t0 = kills[i].t, t1 = kills[j].t;
      const involved = new Map<number, number>();
      for (let x = i; x <= j; x++) { if (kills[x].killer) involved.set(kills[x].killer!, (involved.get(kills[x].killer!) || 0) + 1); }
      const top = [...involved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => who(id)!).filter(Boolean);
      const blueKills = kills.slice(i, j + 1).filter((kk) => who(kk.killer)?.team === 'blue').length;
      moments.push({ key: `fight-${t0}`, t: t0, tStart: t0 - 8, tEnd: t1 + 5, kind: 'teamfight', title: `Pelea de equipo · ${n} asesinatos (${blueKills}–${n - blueKills})`, score: 2 + n, team: blueKills * 2 > n ? 'blue' : blueKills * 2 < n ? 'red' : undefined, pos: kills[i].pos, players: top });
      i = j + 1;
    } else i++;
  }
  moments.sort((a, b) => a.t - b.t);
  const clamp = (m: Moment) => ({ ...m, tStart: Math.max(0, m.tStart), tEnd: Math.min(sec(match.info.gameDuration * 1000), m.tEnd) });
  return {
    gameId, region, gameDuration: Number(match.info.gameDuration) || 0, patch: match.info.gameVersion,
    teams: { blue: [...parts.values()].filter((p) => p.team === 'blue'), red: [...parts.values()].filter((p) => p.team === 'red') },
    moments: moments.map(clamp),
    top: [...moments].sort((a, b) => b.score - a.score || a.t - b.t).slice(0, 8).map(clamp),
  };
}

// GET /api/replays/:region/:gameId/moments
router.get('/:region/:gameId/moments', readLimiter, async (req, res) => {
  try {
    const region = normRegion(req.params.region); const gameId = Number(req.params.gameId);
    if (!gameId) return res.status(400).json({ ok: false, error: 'gameId inválido' });
    const k = key(region, gameId); const c = momentsCache.get(k);
    if (c && Date.now() - c.at < 3600_000) return res.json({ ok: true, ...c.data });
    const game = await gameInfo(region, gameId);
    if (!game) return res.status(404).json({ ok: false, error: 'esa partida no es de ningún torneo de ATAK.GG' });
    const data: any = await computeMoments(region, gameId);
    if (!data) return res.status(404).json({ ok: false, error: 'partida sin datos en Riot todavía' });
    data.match = { tournamentId: game.tournamentId, tournamentName: game.tournamentName, matchId: game.matchId, round: game.round, gameNumber: game.gameNumber, team1: game.team1, team2: game.team2 };
    momentsCache.set(k, { at: Date.now(), data });
    res.json({ ok: true, ...data });
  } catch (e: any) { res.status(e?.response?.status || 500).json({ ok: false, error: e?.response?.data?.status?.message || e.message }); }
});

// ── Stats de una pelea (ventana de un clip) ───────────────────────────────────
// Daño a campeones, daño recibido y oro salen de la diferencia entre los frames
// de la timeline (1 por minuto) que encierran la ventana; las bajas y asistencias
// son exactas (eventos CHAMPION_KILL dentro de la ventana).
const fightCache = new Map<string, { at: number; data: any }>();
async function computeFight(region: string, gameId: number, start: number, end: number) {
  const platform = region.toLowerCase();
  const matchId = `${region}_${gameId}`;
  const match = await getMatchById(platform, matchId);
  if (!match?.info) return null;
  const tl = await getTimeline(region, matchId);
  const frames: any[] = tl?.info?.frames || [];
  if (!frames.length) return null;
  const parts = new Map<number, any>();
  for (const p of match.info.participants || []) parts.set(Number(p.participantId), { id: Number(p.participantId), name: p.riotIdGameName || p.summonerName || `P${p.participantId}`, champion: p.championName || '', team: Number(p.teamId) === 100 ? 'blue' : 'red', kills: 0, deaths: 0, assists: 0, damage: 0, damageTaken: 0, gold: 0, killDamage: 0 });
  const startMs = start * 1000, endMs = end * 1000;
  // Frames que encierran la ventana
  let f0 = frames[0], f1 = frames[frames.length - 1];
  for (const f of frames) { if (f.timestamp <= startMs) f0 = f; if (f.timestamp >= endMs) { f1 = f; break; } }
  const pf = (f: any, id: number) => f?.participantFrames?.[String(id)] || null;
  for (const p of parts.values()) {
    const a = pf(f0, p.id), b = pf(f1, p.id);
    if (a && b) {
      p.damage = Math.max(0, (b.damageStats?.totalDamageDoneToChampions || 0) - (a.damageStats?.totalDamageDoneToChampions || 0));
      p.damageTaken = Math.max(0, (b.damageStats?.totalDamageTaken || 0) - (a.damageStats?.totalDamageTaken || 0));
      p.gold = Math.max(0, (b.totalGold || 0) - (a.totalGold || 0));
    }
  }
  const kills: any[] = [];
  for (const f of frames) for (const ev of f.events || []) {
    if (ev.type !== 'CHAMPION_KILL' || ev.timestamp < startMs || ev.timestamp > endMs) continue;
    const k = parts.get(Number(ev.killerId)), v = parts.get(Number(ev.victimId));
    if (k) k.kills++;
    if (v) v.deaths++;
    for (const aid of ev.assistingParticipantIds || []) { const a = parts.get(Number(aid)); if (a) a.assists++; }
    // Daño exacto que recibió la víctima, por atacante → "daño en bajas"
    for (const d of ev.victimDamageReceived || []) { const a = parts.get(Number(d.participantId)); if (a && v && a.team !== v.team) a.killDamage += (d.physicalDamage || 0) + (d.magicDamage || 0) + (d.trueDamage || 0); }
    kills.push({ t: Math.round(ev.timestamp / 1000), killer: k ? { name: k.name, champion: k.champion, team: k.team } : null, victim: v ? { name: v.name, champion: v.champion, team: v.team } : null, assists: (ev.assistingParticipantIds || []).map((x: any) => parts.get(Number(x))?.champion).filter(Boolean), bounty: ev.bounty || 0, shutdown: ev.shutdownBounty || 0 });
  }
  const players = [...parts.values()];
  const team = (t: 'blue' | 'red') => { const ps = players.filter((p) => p.team === t); return { kills: ps.reduce((s, p) => s + p.kills, 0), deaths: ps.reduce((s, p) => s + p.deaths, 0), damage: ps.reduce((s, p) => s + p.damage, 0), damageTaken: ps.reduce((s, p) => s + p.damageTaken, 0), gold: ps.reduce((s, p) => s + p.gold, 0) }; };
  const totalDamage = players.reduce((s, p) => s + p.damage, 0) || 1;
  const mvp = [...players].sort((a, b) => b.damage - a.damage || b.kills - a.kills)[0];
  return {
    region, gameId, start, end, frameStart: Math.round((f0?.timestamp || 0) / 1000), frameEnd: Math.round((f1?.timestamp || 0) / 1000),
    teams: { blue: team('blue'), red: team('red') },
    players: players.map((p) => ({ ...p, damagePct: Math.round((p.damage / totalDamage) * 100) })).sort((a, b) => (a.team === b.team ? b.damage - a.damage : a.team === 'blue' ? -1 : 1)),
    mvp: mvp && mvp.damage > 0 ? { name: mvp.name, champion: mvp.champion, team: mvp.team, damage: mvp.damage } : null,
    kills,
  };
}

// GET /api/replays/:region/:gameId/fight?start=&end=   (segundos)
router.get('/:region/:gameId/fight', readLimiter, async (req, res) => {
  try {
    const region = normRegion(req.params.region); const gameId = Number(req.params.gameId);
    const start = Math.max(0, Math.floor(Number(req.query.start) || 0)); const end = Math.floor(Number(req.query.end) || 0);
    if (!gameId || !(end > start) || end - start > 600) return res.status(400).json({ ok: false, error: 'ventana inválida (start < end, máx. 10 min)' });
    const k = `${key(region, gameId)}:${start}-${end}`; const c = fightCache.get(k);
    if (c && Date.now() - c.at < 6 * 3600_000) return res.json({ ok: true, ...c.data });
    const game = await gameInfo(region, gameId);
    if (!game) return res.status(404).json({ ok: false, error: 'esa partida no es de ningún torneo de ATAK.GG' });
    const data = await computeFight(region, gameId, start, end);
    if (!data) return res.status(404).json({ ok: false, error: 'partida sin datos en Riot todavía' });
    fightCache.set(k, { at: Date.now(), data });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({ ok: true, ...data });
  } catch (e: any) { res.status(e?.response?.status || 500).json({ ok: false, error: e?.response?.data?.status?.message || e.message }); }
});

// ── Gráfica de la partida (post-game): oro por minuto y objetivos desde la timeline ──
const graphCache = new Map<string, { at: number; data: any }>();
router.get('/:region/:gameId/graph', readLimiter, async (req, res) => {
  try {
    const region = normRegion(req.params.region); const gameId = Number(req.params.gameId);
    if (!gameId) return res.status(400).json({ ok: false, error: 'gameId inválido' });
    const k = key(region, gameId); const c = graphCache.get(k);
    if (c && Date.now() - c.at < 6 * 3600_000) return res.json({ ok: true, ...c.data });
    const game = await gameInfo(region, gameId);
    if (!game) return res.status(404).json({ ok: false, error: 'esa partida no es de ningún torneo de ATAK.GG' });
    const matchId = `${region}_${gameId}`;
    const match = await getMatchById(region.toLowerCase(), matchId);
    if (!match?.info) return res.status(404).json({ ok: false, error: 'partida sin datos en Riot todavía' });
    const tl = await getTimeline(region, matchId);
    const teamOf = new Map<number, 'blue' | 'red'>();
    for (const p of match.info.participants || []) teamOf.set(Number(p.participantId), Number(p.teamId) === 100 ? 'blue' : 'red');
    const gold: Array<{ t: number; blue: number; red: number }> = [];
    const elders = { blue: 0, red: 0 }, grubs = { blue: 0, red: 0 }, barons = { blue: 0, red: 0 }, heralds = { blue: 0, red: 0 };
    const dragons: { blue: string[]; red: string[] } = { blue: [], red: [] };
    const kills: Array<{ t: number; side: 'blue' | 'red' }> = [];
    for (const f of tl?.info?.frames || []) {
      let blue = 0, red = 0;
      for (const [id, pf] of Object.entries<any>(f.participantFrames || {})) { if (teamOf.get(Number(id)) === 'red') red += pf.totalGold || 0; else blue += pf.totalGold || 0; }
      gold.push({ t: Math.round((f.timestamp || 0) / 1000), blue, red });
      for (const ev of f.events || []) {
        const side: 'blue' | 'red' = Number(ev.killerTeamId) === 200 ? 'red' : 'blue';
        if (ev.type === 'ELITE_MONSTER_KILL') {
          if (ev.monsterType === 'DRAGON') { if (ev.monsterSubType === 'ELDER_DRAGON') elders[side]++; else dragons[side].push(String(ev.monsterSubType || 'DRAGON').replace('_DRAGON', '').toLowerCase()); }
          else if (ev.monsterType === 'HORDE') grubs[side]++;
          else if (ev.monsterType === 'BARON_NASHOR') barons[side]++;
          else if (ev.monsterType === 'RIFTHERALD') heralds[side]++;
        } else if (ev.type === 'CHAMPION_KILL') {
          const ks = teamOf.get(Number(ev.killerId)); const vs = teamOf.get(Number(ev.victimId));
          kills.push({ t: Math.round((ev.timestamp || 0) / 1000), side: ks || (vs === 'blue' ? 'red' : 'blue') });
        }
      }
    }
    const data = { region, gameId, gameDuration: Number(match.info.gameDuration) || 0, gold, elders, grubs, barons, heralds, dragons, kills };
    graphCache.set(k, { at: Date.now(), data });
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json({ ok: true, ...data });
  } catch (e: any) { res.status(e?.response?.status || 500).json({ ok: false, error: e?.response?.data?.status?.message || e.message }); }
});

// ── Clips (MP4 renderizados por el worker) ────────────────────────────────────
const clipUrl = (req: any, region: string, gameId: number, k: string) => `${req.protocol}://${req.get('host')}/api/replays/${region}/${gameId}/clips/${encodeURIComponent(k)}`;

// GET /api/replays/:region/:gameId/clips
router.get('/:region/:gameId/clips', readLimiter, async (req, res) => {
  try {
    const region = normRegion(req.params.region); const gameId = Number(req.params.gameId);
    const [rows] = await pool.query<any[]>('SELECT clip_key, t_start, t_end, kind, title, players, mime, size, created_at FROM tournament_clips WHERE game_region = ? AND game_id = ? ORDER BY t_start', [region, gameId]);
    res.json({ ok: true, clips: rows.map((r) => ({ key: r.clip_key, tStart: r.t_start, tEnd: r.t_end, kind: r.kind, title: r.title, players: parseJson(r.players) || [], mime: r.mime, size: r.size, createdAt: r.created_at, url: clipUrl(req, region, gameId, r.clip_key) })) });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/replays/:region/:gameId/clips/:key  (cuerpo = MP4; cabeceras X-Clip-*)
// Solo el worker de render (token RENDER_TOKEN) puede subir video.
router.post('/:region/:gameId/clips/:key', uploadLimiter, raw({ type: () => true, limit: 120 * 1024 * 1024 }), async (req, res) => {
  try {
    const token = (process.env.RENDER_TOKEN || '').trim();
    if (!token || req.get('x-render-token') !== token) return res.status(401).json({ ok: false, error: 'token de render inválido' });
    const region = normRegion(req.params.region); const gameId = Number(req.params.gameId);
    const game = await gameInfo(region, gameId);
    if (!game) return res.status(404).json({ ok: false, error: 'esa partida no es de ningún torneo de ATAK.GG' });
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.length < 10_000) return res.status(400).json({ ok: false, error: 'video demasiado pequeño' });
    const k = String(req.params.key).slice(0, 64);
    const players = String(req.get('x-clip-players') || '[]').slice(0, 2000);
    await pool.query(
      `INSERT INTO tournament_clips (tournament_id, match_id, game_id, game_region, clip_key, t_start, t_end, kind, title, players, mime, size, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE t_start = VALUES(t_start), t_end = VALUES(t_end), kind = VALUES(kind), title = VALUES(title), players = VALUES(players), mime = VALUES(mime), size = VALUES(size), data = VALUES(data), created_at = CURRENT_TIMESTAMP`,
      [game.tournamentId, game.matchId, gameId, region, k, Number(req.get('x-clip-start')) || 0, Number(req.get('x-clip-end')) || 0, String(req.get('x-clip-kind') || 'clip').slice(0, 32), decodeURIComponent(String(req.get('x-clip-title') || k)).slice(0, 160), players, String(req.get('content-type') || 'video/mp4').slice(0, 40), buf.length, buf]);
    console.log(`[replays] clip ${k} de ${region}-${gameId} (${(buf.length / 1048576).toFixed(1)} MB)`);
    const url = clipUrl(req, region, gameId, k);
    // Publicación automática en el feed social del torneo
    let postId: number | null = null;
    if (game.tournamentId !== 'manual') try {
      postId = await upsertClipPost({
        tournamentId: game.tournamentId, tournamentName: game.tournamentName, region, gameId, key: k,
        title: decodeURIComponent(String(req.get('x-clip-title') || k)).slice(0, 200), mediaUrl: url,
        meta: { team1: game.team1, team2: game.team2, round: game.round, gameNumber: game.gameNumber, matchId: game.matchId, tStart: Number(req.get('x-clip-start')) || 0, tEnd: Number(req.get('x-clip-end')) || 0, kind: String(req.get('x-clip-kind') || 'clip') },
      });
    } catch (e: any) { console.warn('[replays] no se pudo publicar el clip en social:', e.message); }
    res.status(201).json({ ok: true, url, postId });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

// GET /api/replays/:region/:gameId/clips/:key → el video
router.get('/:region/:gameId/clips/:key', readLimiter, async (req, res) => {
  try {
    const region = normRegion(req.params.region); const gameId = Number(req.params.gameId);
    const [[row]] = await pool.query<any[]>('SELECT mime, size, data FROM tournament_clips WHERE game_region = ? AND game_id = ? AND clip_key = ?', [region, gameId, String(req.params.key)]);
    if (!row) return res.status(404).json({ ok: false, error: 'sin clip' });
    // El <video> del navegador pide rangos (Range: bytes=…): sin 206 Chrome no carga el clip.
    const data: Buffer = row.data; const total = data.length;
    res.setHeader('Content-Type', row.mime || 'video/mp4');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    // El sitio (atakgg.*) carga el <video> desde este origen (atakback.*): helmet manda
    // CORP same-origin por defecto y el navegador bloquea el medio.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range) {
      let start = range[1] ? Number(range[1]) : 0;
      let end = range[2] ? Number(range[2]) : total - 1;
      if (!range[1] && range[2]) { start = Math.max(0, total - Number(range[2])); end = total - 1; }
      if (start >= total || end >= total || start > end) { res.setHeader('Content-Range', `bytes */${total}`); return res.status(416).end(); }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return res.end(data.subarray(start, end + 1));
    }
    res.setHeader('Content-Length', String(total));
    res.end(data);
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/replays/:region/:gameId/meta ─────────────────────────────────────
router.get('/:region/:gameId/meta', readLimiter, async (req, res) => {
  try {
    const [[row]] = await pool.query<any[]>(
      'SELECT tournament_id, match_id, game_id, game_region, patch, game_length_ms, size, created_at FROM tournament_replays WHERE game_region = ? AND game_id = ?',
      [normRegion(req.params.region), Number(req.params.gameId)]);
    if (!row) return res.status(404).json({ ok: false, error: 'sin replay' });
    res.json({ ok: true, replay: { tournamentId: row.tournament_id, matchId: row.match_id, gameId: Number(row.game_id), region: row.game_region, patch: row.patch, gameLengthMs: row.game_length_ms, size: row.size, createdAt: row.created_at, url: publicUrl(req, row.game_region, Number(row.game_id)) } });
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── GET /api/replays/:region/:gameId  → descarga el .rofl ─────────────────────
router.get('/:region/:gameId', readLimiter, async (req, res) => {
  try {
    const region = normRegion(req.params.region);
    const gameId = Number(req.params.gameId);
    const [[row]] = await pool.query<any[]>('SELECT size, data, patch FROM tournament_replays WHERE game_region = ? AND game_id = ?', [region, gameId]);
    if (!row) return res.status(404).json({ ok: false, error: 'sin replay' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', String(row.size));
    res.setHeader('Content-Disposition', `attachment; filename="${region}-${gameId}.rofl"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (row.patch) res.setHeader('X-Patch', row.patch);
    res.end(row.data);
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
