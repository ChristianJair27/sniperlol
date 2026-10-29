// src/routes/pickems.routes.ts — Pick'Ems de playoffs (estilo Pick'Em de LoL Esports).
// Cada usuario con cuenta de ATAK.GG predice el ganador (y opcionalmente el marcador)
// de cada serie de los playoffs y elige un campeón. Se puede predecir el bracket
// entero por adelantado: para las series cuyos equipos aún no se conocen, las opciones
// salen de los propios picks de las series que la alimentan. Cada serie se cierra
// cuando empieza (primer juego, champ select o partida en el live feed, horario
// oficial o cierre manual del organizador) y el campeón cuando empieza la primera.
// Puntos por ronda, duplicando hacia la final (10/20/40/80) + mitad extra por
// marcador exacto + 100 por el campeón.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { optionalAuth } from '../middlewares/optionalAuth.js';
import { getT, generatePlayoffs, effectivePlayoffsSize } from './tournaments.routes.js';

const router = Router();
const CHAMPION = 'champion';
const LIVE_LOCK_MS = 10 * 60_000;     // una partida/champ select en el live feed de hace < 10 min cierra la serie
const CHAMPION_POINTS = 100;

async function initPickemTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pickem_picks (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id VARCHAR(64) NOT NULL,
      user_id       INT NOT NULL,
      match_id      VARCHAR(32) NOT NULL,
      team          VARCHAR(128) NOT NULL,
      score         VARCHAR(8) NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_pick (tournament_id, user_id, match_id),
      KEY idx_match (tournament_id, match_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pickem_config (
      tournament_id VARCHAR(64) PRIMARY KEY,
      enabled       TINYINT(1) NOT NULL DEFAULT 1,
      locks         LONGTEXT NULL,
      updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // La LQC es el primer torneo con Pick'Ems.
  await pool.query(`INSERT IGNORE INTO pickem_config (tournament_id, enabled, locks) VALUES ('lqc-2026', 1, '{}')`);
}
initPickemTables().catch((e) => console.error('[pickems] init error:', e.message));

type Cfg = { enabled: boolean; locks: Record<string, string> };
async function getCfg(tid: string): Promise<Cfg | null> {
  const [[row]] = await pool.query<any[]>('SELECT enabled, locks FROM pickem_config WHERE tournament_id = ?', [tid]);
  if (!row) return null;
  let locks: Record<string, string> = {};
  try { locks = JSON.parse(row.locks || '{}') || {}; } catch { /* vacío */ }
  return { enabled: !!row.enabled, locks };
}
async function saveLocks(tid: string, locks: Record<string, string>) {
  await pool.query('UPDATE pickem_config SET locks = ? WHERE tournament_id = ?', [JSON.stringify(locks), tid]);
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const isBye = (s: unknown) => norm(s) === 'bye';

type PM = {
  id: string; round: number; matchNumber: number;
  team1: string | null; team2: string | null; winner: string | null;
  score1: number; score2: number; seriesTo: number; status: string;
  scheduledAt: string | null; gamesPlayed: number; bye: boolean;
};

/** Series de playoffs del torneo; si aún no existen, la proyección con la tabla actual. */
export function playoffMatches(t: any): { matches: PM[]; projected: boolean } {
  let raw: any[] = (t.bracket || []).filter((m: any) => m.stage === 'playoffs');
  let projected = false;
  if (!raw.length) {
    const size = effectivePlayoffsSize(t);
    if (size < 2) return { matches: [], projected: false };
    const seeds = [...(t.standings || [])].sort((a: any, b: any) => (a.position ?? 99) - (b.position ?? 99)).slice(0, size).map((s: any) => s.team);
    const start = (Math.max(0, ...(t.bracket || []).map((m: any) => Number(m.round) || 0))) + 1;
    raw = generatePlayoffs(seeds, start, t.seriesTo || 1, t.finalSeriesTo || t.seriesTo || 1);
    projected = true;
  }
  const matches = raw.map((m: any) => ({
    id: String(m.id), round: Number(m.round), matchNumber: Number(m.matchNumber),
    team1: m.team1 ?? null, team2: m.team2 ?? null, winner: m.winner ?? null,
    score1: Number(m.score1) || 0, score2: Number(m.score2) || 0,
    seriesTo: Number(m.seriesTo) || 1, status: String(m.matchStatus || 'pending'),
    scheduledAt: m.scheduledAt ?? null, gamesPlayed: Array.isArray(m.games) ? m.games.length : 0,
    bye: isBye(m.team1) || isBye(m.team2),
  })).sort((a, b) => a.round - b.round || a.matchNumber - b.matchNumber);
  return { matches, projected };
}

const byId = (ms: PM[]) => new Map(ms.map((m) => [m.id, m]));
const feedersOf = (m: PM, map: Map<string, PM>) =>
  [map.get(`r${m.round - 1}m${m.matchNumber * 2 - 1}`), map.get(`r${m.round - 1}m${m.matchNumber * 2}`)].filter(Boolean) as PM[];

/** Equipos que pueden llegar a una serie (todos los de su sub-bracket). */
export function reachable(m: PM, map: Map<string, PM>): Set<string> {
  const out = new Set<string>();
  const walk = (x: PM) => {
    const f = feedersOf(x, map);
    if (!f.length) { for (const s of [x.team1, x.team2]) if (s && !isBye(s)) out.add(s); return; }
    f.forEach(walk);
  };
  walk(m);
  return out;
}

/** Series con picks: todas menos los pases directos (BYE). */
const pickable = (ms: PM[]) => ms.filter((m) => !m.bye);

/** Equipos de la serie en vivo en el live feed o el champ select (cierre automático). */
async function liveTeams(): Promise<Array<[string, string]>> {
  const since = Date.now() - LIVE_LOCK_MS;
  const [rows] = await pool.query<any[]>('SELECT at, snapshot, champselect, cs_at FROM live_feed_channels WHERE at > ? OR cs_at > ?', [since, since]);
  const out: Array<[string, string]> = [];
  for (const r of rows) {
    for (const [raw, at] of [[r.snapshot, r.at], [r.champselect, r.cs_at]] as const) {
      if (!raw || Number(at) < since) continue;
      try { const s = typeof raw === 'string' ? JSON.parse(raw) : raw; if (s?.team1 && s?.team2) out.push([norm(s.team1), norm(s.team2)]); } catch { /* */ }
    }
  }
  return out;
}

/** Estado de cierre de cada serie. Los cierres por live feed se guardan para que no se reabran. */
async function computeLocks(tid: string, ms: PM[], cfg: Cfg, projected: boolean) {
  const now = Date.now();
  const live = projected ? [] : await liveTeams();
  const locked = new Map<string, string>();       // matchId → motivo
  let dirty = false;
  for (const m of pickable(ms)) {
    const manual = cfg.locks[m.id] || cfg.locks[`r${m.round}`];
    if (projected) locked.set(m.id, 'projected');
    else if (m.status === 'complete' || m.winner) locked.set(m.id, 'complete');
    else if (m.gamesPlayed > 0 || m.score1 + m.score2 > 0) locked.set(m.id, 'started');
    else if (manual && Date.parse(manual) <= now) locked.set(m.id, 'manual');
    else if (m.scheduledAt && Date.parse(m.scheduledAt) <= now) locked.set(m.id, 'scheduled');
    else if (m.team1 && m.team2 && live.some(([a, b]) => (a === norm(m.team1) && b === norm(m.team2)) || (a === norm(m.team2) && b === norm(m.team1)))) {
      locked.set(m.id, 'live');
      if (!cfg.locks[m.id]) { cfg.locks[m.id] = new Date(now).toISOString(); dirty = true; }
    }
  }
  if (dirty) await saveLocks(tid, cfg.locks).catch(() => {});
  const firstRound = Math.min(...pickable(ms).map((m) => m.round));
  const championLocked = projected || pickable(ms).some((m) => m.round === firstRound && locked.has(m.id))
    || (!!cfg.locks[CHAMPION] && Date.parse(cfg.locks[CHAMPION]) <= now);
  return { locked, championLocked };
}

/** Puntos por ronda: 10 en la primera, el doble en cada siguiente; marcador exacto suma la mitad. */
export function pointsFor(m: PM, ms: PM[]) {
  const first = Math.min(...pickable(ms).map((x) => x.round));
  const base = 10 * Math.pow(2, m.round - first);
  return { win: base, exact: base / 2 };
}

export function roundLabel(round: number, ms: PM[]): string {
  const last = Math.max(...ms.map((m) => m.round));
  const left = last - round;
  if (left === 0) return 'Gran final';
  if (left === 1) return 'Semifinales';
  if (left === 2) return 'Cuartos de final';
  // Con BYEs (Top 12 en un cuadro de 16) la primera ronda no son "octavos": juegan solo los seeds bajos.
  if (left === 3) return ms.some((m) => m.round === round && m.bye) ? 'Primera ronda' : 'Octavos de final';
  return `Ronda ${round}`;
}

const scoreOf = (m: PM) => {
  if (!m.winner) return null;
  const w = norm(m.winner) === norm(m.team1) ? m.score1 : m.score2;
  const l = norm(m.winner) === norm(m.team1) ? m.score2 : m.score1;
  return `${w}-${l}`;
};
const validScores = (seriesTo: number) => (seriesTo > 1 ? Array.from({ length: seriesTo }, (_, k) => `${seriesTo}-${k}`) : []);

type Pick = { match_id: string; team: string; score: string | null; user_id: number; updated_at?: Date };

/** Puntuación de un usuario contra los resultados reales. */
export function scoreUser(picks: Pick[], ms: PM[]) {
  const map = byId(ms);
  let points = 0, correct = 0, exact = 0, decided = 0, champion: boolean | null = null;
  const final = ms.find((m) => m.round === Math.max(...ms.map((x) => x.round)));
  for (const p of picks) {
    if (p.match_id === CHAMPION) {
      if (final?.winner) { champion = norm(final.winner) === norm(p.team); if (champion) points += CHAMPION_POINTS; }
      continue;
    }
    const m = map.get(p.match_id);
    if (!m || m.bye || !m.winner) continue;
    decided++;
    if (norm(m.winner) !== norm(p.team)) continue;
    const pts = pointsFor(m, ms);
    points += pts.win; correct++;
    if (p.score && p.score === scoreOf(m)) { points += pts.exact; exact++; }
  }
  return { points, correct, exact, decided, champion };
}

/** Nombre público: Riot ID vinculado; si no, nombre de Riot; si no, nombre + inicial (nunca el correo). */
async function displayNames(userIds: number[]) {
  const out = new Map<number, { name: string; avatar: string | null }>();
  if (!userIds.length) return out;
  const [rows] = await pool.query<any[]>(
    `SELECT u.id, u.name, u.avatar_url, u.provider, r.game_name, r.tag_line
       FROM users u LEFT JOIN user_riot_accounts r ON r.user_id = u.id
      WHERE u.id IN (?)`, [userIds]);
  for (const r of rows) {
    let name = r.game_name ? `${r.game_name}#${r.tag_line}` : '';
    if (!name && r.provider === 'riot' && r.name) name = String(r.name);
    if (!name && r.name) { const parts = String(r.name).trim().split(/\s+/); name = parts[0] + (parts[1] ? ` ${parts[1][0]}.` : ''); }
    out.set(Number(r.id), { name: name || `Jugador ${r.id}`, avatar: r.avatar_url || null });
  }
  return out;
}

async function loadBoard(tid: string) {
  const t: any = await getT(tid);
  if (!t) return null;
  const cfg = await getCfg(tid);
  const { matches, projected } = playoffMatches(t);
  return { t, cfg, matches, projected };
}

// ── GET /api/pickems/:tid — bracket de playoffs con cierres, puntos y (con sesión) mis picks ──
router.get('/:tid', optionalAuth, async (req, res) => {
  try {
    const tid = String(req.params.tid);
    const b = await loadBoard(tid);
    if (!b) return res.status(404).json({ error: 'not_found' });
    if (!b.cfg?.enabled) return res.json({ enabled: false });
    const { t, cfg, matches, projected } = b;
    if (!matches.length) return res.json({ enabled: true, status: 'no_playoffs', tournament: { id: t.id, name: t.name } });
    const { locked, championLocked } = await computeLocks(tid, matches, cfg, projected);
    const map = byId(matches);
    const me = (req as any).auth as { userId: number } | undefined;

    // Distribución de la comunidad: solo de series cerradas (antes influiría en los picks).
    const [dist] = await pool.query<any[]>('SELECT match_id, team, COUNT(*) n FROM pickem_picks WHERE tournament_id = ? GROUP BY match_id, team', [tid]);
    const [[{ players }]] = await pool.query<any[]>('SELECT COUNT(DISTINCT user_id) players FROM pickem_picks WHERE tournament_id = ?', [tid]);
    const distOf = (id: string) => {
      const rows = dist.filter((d: any) => d.match_id === id);
      const total = rows.reduce((a: number, d: any) => a + Number(d.n), 0);
      return total ? rows.map((d: any) => ({ team: d.team, pct: Math.round((Number(d.n) / total) * 100), n: Number(d.n) })) : [];
    };

    const rounds = [...new Set(matches.map((m) => m.round))].map((round) => {
      const ms = matches.filter((m) => m.round === round);
      const real = pickable(ms);
      return {
        round, label: roundLabel(round, matches),
        points: real.length ? pointsFor(real[0], matches) : pointsFor(ms[0], matches),
        lockAt: cfg.locks[`r${round}`] || null,
        matches: ms.map((m) => ({
          id: m.id, round: m.round, matchNumber: m.matchNumber,
          team1: m.team1, team2: m.team2, winner: m.winner, score1: m.score1, score2: m.score2,
          seriesTo: m.seriesTo, status: m.status, scheduledAt: m.scheduledAt, bye: m.bye,
          feeders: feedersOf(m, map).map((f) => f.id),
          locked: m.bye || locked.has(m.id), lockReason: locked.get(m.id) || (m.bye ? 'bye' : null),
          scores: validScores(m.seriesTo),
          community: !m.bye && locked.has(m.id) && !projected ? distOf(m.id) : [],
        })),
      };
    });
    const teams = [...reachable(matches.find((m) => m.round === Math.max(...matches.map((x) => x.round)))!, map)];

    let mine: any = null;
    if (me) {
      const [rows] = await pool.query<any[]>('SELECT match_id, team, score, user_id FROM pickem_picks WHERE tournament_id = ? AND user_id = ?', [tid, me.userId]);
      mine = { userId: me.userId, picks: Object.fromEntries(rows.map((r: any) => [r.match_id, { team: r.team, score: r.score }])), ...scoreUser(rows, matches) };
    }
    const champCommunity = championLocked && !projected ? distOf(CHAMPION) : [];
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      enabled: true, status: projected ? 'projected' : 'open',
      tournament: { id: t.id, name: t.name, logoUrl: t.logoUrl ?? null },
      rounds, teams, players: Number(players) || 0,
      champion: { locked: championLocked, points: CHAMPION_POINTS, winner: matches[matches.length - 1]?.winner ?? null, community: champCommunity },
      mine,
    });
  } catch (e: any) {
    console.error('[pickems] board error:', e.message);
    return res.status(500).json({ error: 'board_failed' });
  }
});

const pickLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Demasiados cambios seguidos. Espera un momento.' } });

// ── PUT /api/pickems/:tid/picks — guarda picks { picks: [{ matchId, team, score? }] } (matchId 'champion' = campeón) ──
router.put('/:tid/picks', requireAuth, pickLimiter, async (req, res) => {
  try {
    const tid = String(req.params.tid);
    const userId = (req as any).auth.userId as number;
    const b = await loadBoard(tid);
    if (!b || !b.cfg?.enabled) return res.status(404).json({ error: 'Este torneo no tiene Pick\'Ems.' });
    const { cfg, matches, projected } = b;
    if (projected || !matches.length) return res.status(409).json({ error: 'Los Pick\'Ems se abren cuando se generen los playoffs.' });
    const { locked, championLocked } = await computeLocks(tid, matches, cfg, projected);
    const map = byId(matches);
    const final = matches[matches.length - 1];
    const allTeams = reachable(final, map);
    const list = Array.isArray(req.body?.picks) ? req.body.picks.slice(0, 64) : [];
    const saved: string[] = [], rejected: Array<{ matchId: string; reason: string }> = [];
    for (const p of list) {
      const matchId = String(p?.matchId || '').slice(0, 32);
      const team = String(p?.team || '').trim();
      if (matchId === CHAMPION) {
        if (championLocked) { rejected.push({ matchId, reason: 'cerrado' }); continue; }
        const real = [...allTeams].find((x) => norm(x) === norm(team));
        if (!real) { rejected.push({ matchId, reason: 'equipo inválido' }); continue; }
        await pool.query(
          `INSERT INTO pickem_picks (tournament_id, user_id, match_id, team, score) VALUES (?, ?, ?, ?, NULL)
           ON DUPLICATE KEY UPDATE team = VALUES(team), score = NULL`, [tid, userId, CHAMPION, real]);
        saved.push(matchId); continue;
      }
      const m = map.get(matchId);
      if (!m || m.bye) { rejected.push({ matchId, reason: 'serie inválida' }); continue; }
      if (locked.has(m.id)) { rejected.push({ matchId, reason: 'cerrada' }); continue; }
      if (p?.team == null || team === '') {   // borrar el pick
        await pool.query('DELETE FROM pickem_picks WHERE tournament_id = ? AND user_id = ? AND match_id = ?', [tid, userId, m.id]);
        saved.push(matchId); continue;
      }
      const options = m.team1 && m.team2 && !isBye(m.team1) && !isBye(m.team2) ? new Set([m.team1, m.team2]) : reachable(m, map);
      const real = [...options].find((x) => norm(x) === norm(team));
      if (!real) { rejected.push({ matchId, reason: 'ese equipo no puede llegar a esta serie' }); continue; }
      const score = p?.score ? String(p.score) : null;
      if (score && !validScores(m.seriesTo).includes(score)) { rejected.push({ matchId, reason: 'marcador inválido' }); continue; }
      await pool.query(
        `INSERT INTO pickem_picks (tournament_id, user_id, match_id, team, score) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE team = VALUES(team), score = VALUES(score)`, [tid, userId, m.id, real, score]);
      saved.push(matchId);
    }
    lbCache.delete(tid);
    return res.json({ ok: true, saved, rejected });
  } catch (e: any) {
    console.error('[pickems] save error:', e.message);
    return res.status(500).json({ error: 'No se pudieron guardar los picks.' });
  }
});

// ── GET /api/pickems/:tid/leaderboard — clasificación (caché 30 s) ──
const lbCache = new Map<string, { at: number; rows: any[] }>();
router.get('/:tid/leaderboard', optionalAuth, async (req, res) => {
  try {
    const tid = String(req.params.tid);
    let entry = lbCache.get(tid);
    if (!entry || Date.now() - entry.at > 30_000) {
      const b = await loadBoard(tid);
      if (!b || !b.cfg?.enabled) return res.status(404).json({ error: 'not_found' });
      const [rows] = await pool.query<any[]>('SELECT user_id, match_id, team, score, updated_at FROM pickem_picks WHERE tournament_id = ?', [tid]);
      const byUser = new Map<number, Pick[]>();
      for (const r of rows) { const k = Number(r.user_id); if (!byUser.has(k)) byUser.set(k, []); byUser.get(k)!.push(r); }
      const names = await displayNames([...byUser.keys()]);
      const scored = [...byUser.entries()].map(([userId, ps]) => {
        const last = Math.max(...ps.map((p) => new Date(p.updated_at as any).getTime() || 0));
        return { userId, name: `Jugador ${userId}`, avatar: null, ...names.get(userId), picks: ps.filter((p) => p.match_id !== CHAMPION).length, ...scoreUser(ps, b.matches), last };
      });
      // Desempate: más aciertos exactos, luego quien terminó sus picks antes.
      scored.sort((a, b2) => b2.points - a.points || b2.exact - a.exact || b2.correct - a.correct || a.last - b2.last);
      let rank = 0, prev = '';
      const ranked = scored.map((s, i) => { const key = `${s.points}|${s.exact}|${s.correct}`; if (key !== prev) { rank = i + 1; prev = key; } const { last: _l, ...rest } = s; return { rank, ...rest }; });
      entry = { at: Date.now(), rows: ranked };
      lbCache.set(tid, entry);
    }
    const me = (req as any).auth as { userId: number } | undefined;
    const mine = me ? entry.rows.find((r) => r.userId === me.userId) || null : null;
    return res.json({ total: entry.rows.length, top: entry.rows.slice(0, 100), me: mine });
  } catch (e: any) {
    console.error('[pickems] leaderboard error:', e.message);
    return res.status(500).json({ error: 'leaderboard_failed' });
  }
});

// ── GET /api/pickems/:tid/user/:userId — picks públicos de alguien (solo de series ya cerradas) ──
router.get('/:tid/user/:userId', async (req, res) => {
  try {
    const tid = String(req.params.tid); const userId = Number(req.params.userId);
    const b = await loadBoard(tid);
    if (!b || !b.cfg?.enabled || !Number.isFinite(userId)) return res.status(404).json({ error: 'not_found' });
    const { locked, championLocked } = await computeLocks(tid, b.matches, b.cfg, b.projected);
    const [rows] = await pool.query<any[]>('SELECT match_id, team, score, user_id FROM pickem_picks WHERE tournament_id = ? AND user_id = ?', [tid, userId]);
    const visible = rows.filter((r: any) => (r.match_id === CHAMPION ? championLocked : locked.has(r.match_id)));
    const names = await displayNames([userId]);
    return res.json({ userId, ...names.get(userId), hidden: rows.length - visible.length, picks: Object.fromEntries(visible.map((r: any) => [r.match_id, { team: r.team, score: r.score }])), ...scoreUser(rows, b.matches) });
  } catch (e: any) {
    console.error('[pickems] user error:', e.message);
    return res.status(500).json({ error: 'user_failed' });
  }
});

// ── POST /api/pickems/:tid/lock — organizador/admin: { key: 'r11' | 'r11m2' | 'champion', at: ISO | null } ──
router.post('/:tid/lock', requireAuth, async (req, res) => {
  try {
    const tid = String(req.params.tid);
    const auth = (req as any).auth as { userId: number; role: string };
    const t: any = await getT(tid);
    if (!t) return res.status(404).json({ error: 'not_found' });
    if (auth.role !== 'admin' && Number(t.createdBy) !== auth.userId) return res.status(403).json({ error: 'Solo el organizador.' });
    const cfg = (await getCfg(tid)) || { enabled: true, locks: {} };
    const key = String(req.body?.key || '');
    if (!/^(r\d{1,2}(m\d{1,2})?|champion)$/.test(key)) return res.status(400).json({ error: 'key: r<ronda>, r<ronda>m<serie> o champion' });
    const at = req.body?.at == null ? null : new Date(String(req.body.at));
    if (at && isNaN(at.getTime())) return res.status(400).json({ error: 'at inválido' });
    if (at) cfg.locks[key] = at.toISOString(); else delete cfg.locks[key];
    await pool.query(
      `INSERT INTO pickem_config (tournament_id, enabled, locks) VALUES (?, 1, ?) ON DUPLICATE KEY UPDATE locks = VALUES(locks)`,
      [tid, JSON.stringify(cfg.locks)]);
    return res.json({ ok: true, locks: cfg.locks });
  } catch (e: any) {
    console.error('[pickems] lock error:', e.message);
    return res.status(500).json({ error: 'lock_failed' });
  }
});

export default router;
