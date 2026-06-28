// src/routes/live.ts — Enhanced live spectator + SSE stream
import { Router } from 'express';
import { getLiveGame, getSummonerByPUUID } from '../services/riot.js';
import { normalizePlatform } from '../utils/regions.js';

const r = Router();

// 90s in-memory cache to avoid hammering Riot API
const _cache = new Map<string, { data: any; exp: number }>();
const cGet = (k: string): any | undefined => { const e = _cache.get(k); return e && e.exp > Date.now() ? e.data : undefined; };
const cSet = (k: string, v: any, ms: number) => _cache.set(k, { data: v, exp: Date.now() + ms });

function plat(raw: string): string { return normalizePlatform(raw) as string || 'la1'; }

function enrichGame(raw: any) {
  if (!raw) return null;
  return {
    gameId:            raw.gameId,
    platformId:        raw.platformId,
    gameMode:          raw.gameMode,
    gameType:          raw.gameType,
    gameQueueConfigId: raw.gameQueueConfigId,
    gameLength:        raw.gameLength ?? 0,
    mapId:             raw.mapId,
    observers:         raw.observers || null,
    encryptionKey:     raw.observers?.encryptionKey || null,
    bannedChampions: (raw.bannedChampions ?? []).map((b: any) => ({
      championId: b.championId, teamId: b.teamId, pickTurn: b.pickTurn,
    })),
    participants: (raw.participants ?? []).map((p: any) => ({
      summonerName: p.riotId?.split('#')[0] ?? p.summonerName ?? 'Unknown',
      riotId:   p.riotId   ?? null,
      championId: p.championId,
      spell1Id:   p.spell1Id,
      spell2Id:   p.spell2Id,
      teamId:     p.teamId,
    })),
  };
}

// ── GET /api/live/:summonerId?platform= ──────────────────────────────────────
r.get('/:summonerId', async (req, res, next) => {
  try {
    const platform = plat((req.query.platform as string) || 'la1');
    const sid = String(req.params.summonerId);
    const ck  = `live:${platform}:${sid}`;
    let data  = cGet(ck);
    if (!data) { data = await getLiveGame(platform as any, sid); cSet(ck, data, 60_000); }
    if (!data) return res.status(404).json({ ok: false, inGame: false });
    res.json({ ok: true, inGame: true, data: enrichGame(data) });
  } catch (e) { next(e); }
});

// ── GET /api/live/by-puuid/:platform/:puuid ──────────────────────────────────
r.get('/by-puuid/:platform/:puuid', async (req, res, next) => {
  try {
    const platform = plat(req.params.platform);
    const puuid    = String(req.params.puuid);
    const sidCk    = `sid:${platform}:${puuid}`;
    let sid: string | null = cGet(sidCk) ?? null;
    if (!sid) {
      const summoner = await getSummonerByPUUID(platform as any, puuid);
      sid = summoner?.id ?? null;
      if (sid) cSet(sidCk, sid, 600_000);
    }
    if (!sid) return res.status(404).json({ ok: false, error: 'Summoner not found' });

    const liveCk = `live:${platform}:${sid}`;
    let data = cGet(liveCk);
    if (!data) { data = await getLiveGame(platform as any, sid); cSet(liveCk, data, 60_000); }
    if (!data) return res.status(404).json({ ok: false, inGame: false });
    res.json({ ok: true, inGame: true, summonerId: sid, data: enrichGame(data) });
  } catch (e) { next(e); }
});

// ── GET /api/live/stream/:summonerId?platform= (SSE) ────────────────────────
r.get('/stream/:summonerId', async (req, res) => {
  const platform = plat((req.query.platform as string) || 'la1');
  const sid      = String(req.params.summonerId);

  res.setHeader('Content-Type',     'text/event-stream');
  res.setHeader('Cache-Control',    'no-cache');
  res.setHeader('Connection',       'keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  const push = (obj: object) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); (res as any).flush?.(); } catch {} };

  const tick = async () => {
    try {
      const data = await getLiveGame(platform as any, sid);
      push(data ? { ok: true, inGame: true, data: enrichGame(data) } : { ok: false, inGame: false });
    } catch (e: any) { push({ ok: false, error: e.message }); }
  };

  await tick();
  const iv = setInterval(tick, 15_000);
  req.on('close', () => clearInterval(iv));
});

export default r;
