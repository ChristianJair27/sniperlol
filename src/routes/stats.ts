// src/routes/stats.ts
import { Router } from "express";
import axios from "axios";
import { platformToRegional, PROBE_AMERICAS } from "../utils/regions.js";

import {
  getSummonerByPUUID,
  getChampionMasteriesByPUUID,
  getLeagueEntriesBySummonerId,
  getAccountByPUUID,
  getMatchIdsByPUUID,
  getMatchById,
  getLiveGame,
} from "../services/riot.js";

const r = Router();

// Log simple para verificar que el router se alcanza
r.use((req, _res, next) => {
  console.log("[STATS]", req.method, req.path);
  next();
});

/**
 * GET /api/stats/resolve?region=la1&gameName=Kister&tagLine=NGC
 * -> { puuid, gameName, tagLine }
 */
r.get("/resolve", async (req, res) => {
  try {
    const { region, gameName, tagLine } = req.query as any;
    if (!region || !gameName || !tagLine) {
      return res.status(400).json({ message: "region, gameName y tagLine son requeridos" });
    }
    const regional = platformToRegional(region);
    const { data } = await axios.get(
      `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      { headers: { "X-Riot-Token": process.env.RIOT_API_KEY! } }
    );
    return res.json({
      puuid: data.puuid,
      gameName: data.gameName,
      tagLine: data.tagLine,
    });
  } catch (e: any) {
    console.error("RESOLVE ERR →", e?.response?.status, e?.response?.data);
    return res.status(e?.response?.status || 500).json({
      message: e?.response?.data?.status?.message || e?.message || "resolve failed",
    });
  }
});

/**
 * GET /api/stats/summary/:platform/:puuid
 * -> { summoner, rank, masteryTop, platformUsed }
 */
r.get("/summary/:platform/:puuid", async (req, res) => {
  const { platform, puuid } = req.params as { platform: string; puuid: string };

  const tryPlatforms = [platform, ...PROBE_AMERICAS.filter((p) => p !== platform)];
  const warnings: string[] = [];
  let pfUsed: string | null = null;

  // A) summoner-v4 (por PUUID) → name, level, id
  let summoner: { name: string; level: number; id: string; profileIconId?: number } | null = null;
  for (const pf of tryPlatforms) {
    try {
      const s = await getSummonerByPUUID(pf, puuid);
      if (s) {
        summoner = { name: s.name, level: s.summonerLevel, id: s.id, profileIconId: s.profileIconId };
        pfUsed = pf;
        break;
      }
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 403) return res.status(403).json({ message: "Forbidden (Riot 403)" });
      if (code !== 404) return res.status(code || 500).json(e?.response?.data || { message: "summoner failed" });
    }
  }
  if (!summoner) {
    try {
      const acc = await getAccountByPUUID(puuid, { platformHint: platform });
      summoner = { name: acc?.gameName ?? "—", level: 0, id: "", profileIconId: undefined };
      warnings.push("No se pudo obtener summoner-v4; usando nombre de account-v1.");
    } catch {
      summoner = { name: "—", level: 0, id: "" };
      warnings.push("No se pudo obtener nombre/level del invocador.");
    }
  }

  // B) league-v4 (rank) si tenemos summonerId
  let rank: { queue: string; tier: string; rank: string; lp: number }[] = [];
  if (summoner.id && pfUsed) {
    try {
      const le = await getLeagueEntriesBySummonerId(pfUsed, summoner.id);
      rank = (le || []).map((q) => ({
        queue: q.queueType,
        tier: q.tier,
        rank: q.rank,
        lp: q.leaguePoints,
      }));
    } catch (e: any) {
      if (e?.response?.status === 403) warnings.push("League-v4 devolvió 403. Ocultando rank.");
      else warnings.push("No se pudo traer league-v4.");
    }
  }

  // C) champion-mastery-v4 (por PUUID) → top 5
  let masteryTop: { championId: number; championName: string; level: number; points: number }[] = [];
  const platformsForMastery = pfUsed ? [pfUsed, ...tryPlatforms.filter((p) => p !== pfUsed)] : tryPlatforms;
  for (const pf of platformsForMastery) {
    try {
      const list = await getChampionMasteriesByPUUID(pf, puuid);
      masteryTop = list.slice(0, 5).map((m) => ({
        championId: m.championId,
        championName: String(m.championId),
        level: m.championLevel,
        points: m.championPoints,
      }));
      pfUsed = pfUsed || pf;
      break;
    } catch (e: any) {
      const code = e?.response?.status;
      if (code === 403) {
        warnings.push("Mastery-v4 devolvió 403.");
        break;
      }
      if (code !== 404) {
        warnings.push("Error trayendo masteries.");
        break;
      }
    }
  }

  return res.json({
    summoner,
    rank,
    masteryTop,
    platformUsed: pfUsed ?? platform,
    _warnings: warnings.length ? warnings : undefined,
  });
});

/**
 * GET /api/stats/recent/:platform/:puuid?count=10&queues=420,440
 * -> { champions: [...] } // agregado por campeón
 */
r.get("/recent/:platform/:puuid", async (req, res) => {
  try {
    const { platform, puuid } = req.params as { platform: string; puuid: string };
    const { count = "10", queues } = req.query as { count?: string; queues?: string };

    const regional = platformToRegional(platform);
    const headers = { "X-Riot-Token": process.env.RIOT_API_KEY! };

    // ids de partidas
    const idsRes = await axios.get<string[]>(
      `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`,
      { headers, params: { start: 0, count: Number(count) } }
    );
    const ids = idsRes.data || [];

    // filtro de colas opcional
    const onlyQueues = queues
      ? new Set(
          String(queues)
            .split(",")
            .map((q) => Number(q.trim()))
            .filter(Boolean)
        )
      : undefined;

    type Row = {
      championId: number;
      championName: string;
      games: number;
      wins: number;
      losses: number;
      k: number;
      d: number;
      a: number;
    };
    const agg = new Map<number, Row>();

    for (const id of ids) {
      const { data: match } = await axios.get(
        `https://${regional}.api.riotgames.com/lol/match/v5/matches/${id}`,
        { headers }
      );
      const info = match?.info;
      if (!info) continue;
      if (onlyQueues && !onlyQueues.has(info.queueId)) continue;

      const p = info.participants.find((x: any) => x.puuid === puuid);
      if (!p) continue;

      const key = p.championId as number;
      const row =
        agg.get(key) ||
        ({
          championId: key,
          championName: String(p.championName || key),
          games: 0,
          wins: 0,
          losses: 0,
          k: 0,
          d: 0,
          a: 0,
        } as Row);

      row.games += 1;
      p.win ? (row.wins += 1) : (row.losses += 1);
      row.k += p.kills;
      row.d += p.deaths || 0;
      row.a += p.assists;

      agg.set(key, row);
    }

    const champions = Array.from(agg.values())
      .map((r) => ({
        championId: r.championId,
        championName: r.championName,
        games: r.games,
        wins: r.wins,
        losses: r.losses,
        winRate: r.games ? Math.round((r.wins / r.games) * 100) : 0,
        kda: r.d === 0 ? (r.k + r.a).toFixed(2) : ((r.k + r.a) / r.d).toFixed(2),
        avgKills: (r.k / r.games).toFixed(1),
        avgDeaths: (r.d / r.games).toFixed(1),
        avgAssists: (r.a / r.games).toFixed(1),
      }))
      .sort((a, b) => b.games - a.games);

    return res.json({ champions });
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({
      message: e?.response?.data?.status?.message || e?.message || "recent failed",
    });
  }
});

// GET /api/stats/matches/:regional/:puuid/ids?count=5&start=0
r.get("/matches/:regional/:puuid/ids", async (req, res) => {
  try {
    const { regional, puuid } = req.params as { regional: string; puuid: string };
    const { count = "5", start = "0" } = req.query as any;
    console.log("[STATS] matches/ids →", { regional, puuid: puuid?.slice(0, 8), count, start });

    const ids = await getMatchIdsByPUUID(regional, puuid, Number(count), Number(start));
    console.log("[STATS] matches/ids OK →", ids.length);
    return res.json(ids);
  } catch (e: any) {
    console.warn("[STATS] matches/ids ERR →", e?.response?.status, e?.message);
    return res.status(e?.response?.status || 500).json({ message: e?.message || "match ids failed" });
  }
});

// GET /api/stats/matches/:regional/:matchId?puuid=<puuid>
r.get("/matches/:regional/:matchId", async (req, res) => {
  try {
    const { regional, matchId } = req.params as { regional: string; matchId: string };
    const { puuid } = req.query as { puuid?: string };

    const match = await getMatchById(regional, matchId);
    if (!match) return res.status(404).json({ message: "Match not found" });
    if (!puuid) return res.json(match); // fallback: devuelvo todo

    const info = match.info;
    const p = info?.participants?.find((x: any) => x.puuid === puuid);
    if (!p) return res.status(404).json({ message: "Participant not found" });

    const out = {
      matchId,
      championId: p.championId,
      championName: p.championName,
      win: !!p.win,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      kda: p.deaths === 0 ? p.kills + p.assists : (p.kills + p.assists) / p.deaths,
      cs: (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0),
      gameDuration: (info?.gameDuration ?? 0) * 1000,
      gameMode: info?.gameMode ?? info?.queueId,
      gameStartTimestamp: info?.gameStartTimestamp,
      items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].filter((x: any) => typeof x === "number"),
      summonerSpells: [p.summoner1Id, p.summoner2Id],
      perks: p.perks,
      role: p.role,
      lane: p.lane,
    };

    return res.json(out);
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({ message: e?.message || "match detail failed" });
  }
});

// GET /api/stats/spectator/:platform/:puuid  (con fallback de plataforma)
r.get("/spectator/:platform/:puuid", async (req, res) => {
  try {
    const { platform, puuid } = req.params as { platform: string; puuid: string };
    const tryPlatforms = [platform, ...PROBE_AMERICAS.filter(p => p !== platform)];

    let sum: any = null;
    let pfUsed: string | null = null;

    for (const pf of tryPlatforms) {
      try {
        sum = await getSummonerByPUUID(pf, puuid);
        if (sum?.id) { pfUsed = pf; break; }
      } catch (e: any) {
        if (e?.response?.status !== 404) throw e; // 404 => probar otra plataforma
      }
    }
    if (!sum?.id) return res.status(404).json({ message: "Summoner not found in probed platforms" });

    const live = await getLiveGame(pfUsed!, sum.id).catch((e: any) => {
      if (e?.response?.status === 404) return null; // NO está en partida
      throw e;
    });

    if (!live) return res.status(204).send();

    const out = {
      gameMode: live.gameMode,
      gameStartTime: live.gameStartTime,
      participants: (live.participants || []).map((p: any) => ({
        summonerName: p.summonerName,
        championId: p.championId,
        teamId: p.teamId,
      })),
    };
    return res.json(out);
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({ message: e?.message || "spectator failed" });
  }
});

// GET /api/stats/champion-stats/:platform/:puuid?count=20
r.get("/champion-stats/:platform/:puuid", async (req, res) => {
  try {
    const { platform, puuid } = req.params as { platform: string; puuid: string };
    const { count = "20" } = req.query as any;

    const ids = await getMatchIdsByPUUID(platform, puuid, Number(count), 0);
    const agg = new Map<number, { games: number; wins: number; k: number; d: number; a: number }>();

    for (const id of ids) {
      const m = await getMatchById(platform, id);
      const p = m?.info?.participants?.find((x: any) => x.puuid === puuid);
      if (!p) continue;

      const row = agg.get(p.championId) ?? { games: 0, wins: 0, k: 0, d: 0, a: 0 };
      row.games++;
      if (p.win) row.wins++;
      row.k += p.kills;
      row.d += p.deaths || 0;
      row.a += p.assists;
      agg.set(p.championId, row);
    }

    const out: Record<string, any> = {};
    for (const [champId, r] of agg.entries()) {
      const kda = r.d === 0 ? (r.k + r.a).toFixed(2) : ((r.k + r.a) / r.d).toFixed(2);
      out[String(champId)] = {
        games: r.games,
        wins: r.wins,
        losses: r.games - r.wins,
        winRate: Math.round((r.wins / r.games) * 100),
        kda,
      };
    }
    return res.json(out);
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({ message: e?.message || "champion-stats failed" });
  }
});

// Imprime las rutas una vez montadas
setImmediate(() => {
  const paths = (r as any).stack
    ?.filter((l: any) => l?.route?.path)
    .map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  console.log("[STATS] routes:", paths);
});

export default r;
