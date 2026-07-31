// src/routes/public-api.routes.ts — API pública v1 (solo lectura)
//
// Superficie estable y documentada para consumidores externos (p.ej. la página
// oficial de la LCQ). Ver PUBLIC_API.md en la raíz del repo.
//
//   GET /api/public/v1/tournaments                       → lista de torneos
//   GET /api/public/v1/tournaments/:id                   → detalle + standings
//   GET /api/public/v1/tournaments/:id/standings         → solo standings
//   GET /api/public/v1/tournaments/:id/bracket           → bracket saneado (sin códigos/puuids)
//   GET /api/public/v1/tournaments/:id/matches           → partidos del bracket con estado
//   GET /api/public/v1/tournaments/:id/matches/:matchId/stats → stats por partido (Riot)
//   GET /api/public/v1/tournaments/:id/stats             → stats agregadas del torneo
//
// Reglas:
//  - Solo GET. CORS abierto (origin *), sin credenciales.
//  - Nunca expone códigos de lobby ni PUUIDs (bracket saneado como 'public').
//  - Caché en memoria (CACHE_MS) para proteger MySQL/Riot en picos del evento.
//  - Los datos de partidos terminados provienen de la caché en DB, que el
//    background sync (cada 60s) y la UI mantienen fresca.
import { Router } from 'express';
import cors from 'cors';
import { pool } from '../db.js';
import {
  getT, getRegs, sanitizeBracket, getStoredMatchStats, computeGlobalStats,
} from './tournaments.routes.js';

const router = Router();

// CORS propio: la allowlist global no aplica aquí — cualquier web puede leer.
router.use(cors({ origin: '*', methods: ['GET'], credentials: false }));

// ── Micro-caché en memoria ────────────────────────────────────────────────────
const CACHE_MS = 15_000;
const cache = new Map<string, { data: any; exp: number }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.data as T;
  const data = await fn();
  cache.set(key, { data, exp: Date.now() + CACHE_MS });
  return data;
}

// ── Shapes públicos ──────────────────────────────────────────────────────────
function publicTournament(t: any, teamsRegistered?: number) {
  return {
    id: t.id,
    name: t.name,
    phase: t.phase,                     // registration | checkin | active | complete
    startDate: t.startDate,
    format: t.format,
    region: t.region ?? 'la1',
    prize: t.prize,
    teamsRegistered: teamsRegistered ?? t.participants ?? 0,
    teamsMax: t.maxParticipants,
    description: t.description ?? '',
    logoUrl: t.logoUrl ?? null,
    bannerUrl: t.bannerUrl ?? null,
    fearless: !!t.fearless,
    registrationUrl: t.registrationUrl ?? null,
    rulesUrl: t.rulesUrl ?? null,
  };
}

function publicMatch(m: any) {
  return {
    id: m.id,
    round: m.round,
    matchNumber: m.matchNumber,
    team1: m.team1,
    team2: m.team2,
    winner: m.winner || null,
    status: m.matchStatus,              // pending | ready | active | complete
    score1: m.score1 ?? null,
    score2: m.score2 ?? null,
    gameId: m.gameId ?? null,
    gameRegion: m.gameRegion ?? null,
  };
}

// ── Endpoints ────────────────────────────────────────────────────────────────

// Validar Riot ID (para formularios externos: el sitio LQC es estático y no
// puede llamar a Riot con key). Cache fuerte para no quemar rate limit.
router.get('/validate-riot-id', async (req, res) => {
  const riotId = String(req.query.riotId || '').trim();
  const m = riotId.match(/^(.{3,16})#(.{2,5})$/);
  if (!m) return res.json({ ok: true, data: { valid: false, reason: 'format', hint: 'Formato: Nombre#TAG' } });
  try {
    const data = await cached(`rid:${riotId.toLowerCase()}`, async () => {
      const { getAccountByRiotId } = await import('../services/riot.js');
      try {
        const acc: any = await getAccountByRiotId(m[1].trim(), m[2].trim(), { platformHint: 'la1' });
        return acc?.puuid
          ? { valid: true, gameName: acc.gameName, tagLine: acc.tagLine }
          : { valid: false, reason: 'not_found' };
      } catch (e: any) {
        if (e?.response?.status === 404 || /404/.test(e?.message || '')) return { valid: false, reason: 'not_found' };
        throw e;
      }
    });
    res.json({ ok: true, data });
  } catch (err: any) {
    // Riot caído/rate limit: no bloquear el formulario — que decida el consumidor
    res.status(200).json({ ok: true, data: { valid: null, reason: 'unavailable' } });
  }
});

// Lista de torneos
router.get('/tournaments', async (_req, res) => {
  try {
    const data = await cached('list', async () => {
      const [rows] = await pool.query<any[]>(
        'SELECT * FROM tournaments WHERE COALESCE(hidden,0)=0 ORDER BY created_at DESC'
      );
      const out = [];
      for (const row of rows) {
        const t = await getT(row.id);
        if (t) out.push(publicTournament(t));
      }
      return out;
    });
    res.json({ ok: true, data });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

// Detalle + standings
router.get('/tournaments/:id', async (req, res) => {
  try {
    const data = await cached(`t:${req.params.id}`, async () => {
      const t = await getT(req.params.id);
      if (!t) return null;
      const regs = await getRegs(t.id);
      return {
        ...publicTournament(t, regs.length),
        standings: t.standings ?? [],
        teams: regs.map(r => ({ name: r.teamName, checkedIn: !!r.checkedIn })),
      };
    });
    if (!data) return res.status(404).json({ ok: false, error: 'Torneo no encontrado' });
    res.json({ ok: true, data });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

// Solo standings
router.get('/tournaments/:id/standings', async (req, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: 'Torneo no encontrado' });
    res.json({ ok: true, data: t.standings ?? [] });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

// Bracket saneado (nunca expone códigos de lobby ni PUUIDs)
router.get('/tournaments/:id/bracket', async (req, res) => {
  try {
    const data = await cached(`b:${req.params.id}`, async () => {
      const t = await getT(req.params.id);
      if (!t) return null;
      const rounds = sanitizeBracket(t.bracket ?? [], 'public') ?? [];
      return { phase: t.phase, matches: rounds.map(publicMatch) };
    });
    if (!data) return res.status(404).json({ ok: false, error: 'Torneo no encontrado' });
    res.json({ ok: true, data });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

// Partidos (alias plano del bracket, cómodo para tablas/calendarios)
router.get('/tournaments/:id/matches', async (req, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: 'Torneo no encontrado' });
    const matches = (sanitizeBracket(t.bracket ?? [], 'public') ?? []).map(publicMatch);
    const { status } = req.query;
    res.json({ ok: true, data: status ? matches.filter(m => m.status === status) : matches });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

// Stats por partido — sirve la versión persistida en DB (partidas terminadas).
// Mientras la partida no termine responde 202 con status 'pending' para que el
// consumidor haga polling sin tratarlo como error.
router.get('/tournaments/:id/matches/:matchId/stats', async (req, res) => {
  const { id, matchId } = req.params;
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ ok: false, error: 'Torneo no encontrado' });
    const match = (t.bracket ?? []).find(m => m.id === matchId);
    if (!match) return res.status(404).json({ ok: false, error: 'Partido no encontrado' });

    const stored = await cached(`ms:${id}:${matchId}`, () => getStoredMatchStats(id, matchId));
    if (stored) return res.json({ ok: true, data: stored });

    return res.status(202).json({
      ok: true,
      data: null,
      status: match.matchStatus === 'active' ? 'in_progress' : 'pending',
      hint: 'La partida aún no termina o no se ha sincronizado. Reintenta en 60s.',
    });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

// Stats agregadas del torneo (por jugador)
router.get('/tournaments/:id/stats', async (req, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: 'Torneo no encontrado' });
    const data = await cached(`gs:${req.params.id}`, () => computeGlobalStats(req.params.id));
    res.json({ ok: true, data });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

export default router;
