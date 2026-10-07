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

const router = Router();
const MAX_BYTES = 80 * 1024 * 1024;
const MIN_BYTES = 64 * 1024;

const uploadLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
const readLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false });

async function initTables() {
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

// ── POST /api/replays/:region/:gameId  (cuerpo = .rofl crudo) ─────────────────
router.post('/:region/:gameId', uploadLimiter, raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
  try {
    const region = normRegion(req.params.region);
    const gameId = Number(req.params.gameId);
    if (!gameId) return res.status(400).json({ ok: false, error: 'gameId inválido' });
    const game = (await tournamentGames()).find((g) => g.gameId === gameId && g.region === region);
    if (!game) return res.status(404).json({ ok: false, error: 'esa partida no es de ningún torneo de ATAK.GG' });
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
    if (row.patch) res.setHeader('X-Patch', row.patch);
    res.end(row.data);
  } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

export default router;
