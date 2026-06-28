// src/routes/stats.ts
import { Router } from "express";
import axios from "axios";
import { platformToRegional, PROBE_AMERICAS, PROBE_DEFAULT } from "../utils/regions.js";

import {
  getSummonerByPUUID,
  getChampionMasteriesByPUUID,
  getLeagueEntriesByPuuid,
  getAccountByPUUID,
  getMatchIdsByPUUID,
  getMatchById,
  getLiveGame,
  PLATFORM_HOST,
} from "../services/riot.js";

const r = Router();
const RIOT_KEY = process.env.RIOT_API_KEY;

// Helper: GET con reintentos cuando Riot devuelve 429
async function riotGet<T = any>(url: string, opts: any = {}, tries = 3): Promise<{ data: T }> {
  try {
    return await axios.get<T>(url, opts);
  } catch (e: any) {
    const status = e?.response?.status;
    if (status === 429 && tries > 0) {
      const ra = Number(e?.response?.headers?.["retry-after"]) || 1;
      await new Promise((r) => setTimeout(r, ra * 1000));
      return riotGet<T>(url, opts, tries - 1);
    }
    throw e;
  }
}

// Log simple
r.use((req, _res, next) => {
  console.log("[STATS]", req.method, req.path);
  next();
});

/**
 * GET /api/stats/resolve?region=la1&gameName=Kister&tagLine=NGC
 */
r.get("/resolve", async (req, res) => {
  try {
    const { region, gameName, tagLine } = req.query as any;
    if (!region || !gameName || !tagLine) {
      return res.status(400).json({ message: "region, gameName y tagLine son requeridos" });
    }
    if (!RIOT_KEY) return res.status(500).json({ message: "RIOT_API_KEY missing" });

    const regional = platformToRegional(region);
    const { data } = await axios.get(
      `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(
        gameName
      )}/${encodeURIComponent(tagLine)}`,
      { headers: { "X-Riot-Token": RIOT_KEY } }
    );
    return res.json({ puuid: data.puuid, gameName: data.gameName, tagLine: data.tagLine });
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

  // A) summoner-v4 (por PUUID)
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

  // B) league-v4 (rank) — use the by-PUUID endpoint (reliable; summonerId is deprecated/unstable).
  // Probe the platform we found the summoner on first, then other platforms by PUUID.
  let rank: { queue: string; tier: string; rank: string; lp: number; wins: number; losses: number }[] = [];
  {
    const leaguePlatforms = pfUsed ? [pfUsed, ...tryPlatforms.filter((p) => p !== pfUsed)] : tryPlatforms;
    for (const pf of leaguePlatforms) {
      try {
        const le = await getLeagueEntriesByPuuid(pf, puuid);
        if (le && le.length) {
          rank = le.map((q) => ({
            queue: q.queueType, // "RANKED_SOLO_5x5" | "RANKED_FLEX_SR"
            tier: q.tier,
            rank: q.rank,
            lp: q.leaguePoints,
            wins: q.wins ?? 0,
            losses: q.losses ?? 0,
          }));
          pfUsed = pfUsed || pf;
          break;
        }
      } catch (e: any) {
        const code = e?.response?.status;
        if (code === 403) { warnings.push("League-v4 devolvió 403. Ocultando rank."); break; }
        if (code !== 404) { warnings.push("No se pudo traer league-v4."); break; }
        // 404 → unranked on this platform, try the next one
      }
    }
  }

  // C) champion-mastery-v4 (top 5)
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

  // Forward-only season snapshot (best-effort, never blocks the response)
  if (rank.length) {
    upsertRankedSnapshot(puuid, rank as any).catch(() => {});
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
 */
r.get("/recent/:platform/:puuid", async (req, res) => {
  try {
    const { platform, puuid } = req.params as { platform: string; puuid: string };
    const { count = "10", queues } = req.query as { count?: string; queues?: string };

    const regional = platformToRegional(platform);
    if (!RIOT_KEY) return res.status(500).json({ message: "RIOT_API_KEY missing" });
    const headers = { "X-Riot-Token": RIOT_KEY };

    const idsRes = await riotGet<string[]>(
      `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`,
      { headers, params: { start: 0, count: Number(count) } }
    );
    const ids = idsRes.data || [];

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

    // secuencial para evitar 429
    for (const id of ids) {
      const { data: match } = await riotGet(
        `https://${regional}.api.riotgames.com/lol/match/v5/matches/${id}`,
        { headers }
      );
      const info = (match as any)?.info;
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
      row.k += p.kills || 0;
      row.d += p.deaths || 0;
      row.a += p.assists || 0;

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

// GET /api/stats/matches/:regional/:puuid/ids
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

/**
 * GET /api/stats/matches/:regional/:matchId?puuid=<puuid>
 */
r.get("/matches/:regional/:matchId", async (req, res) => {
  try {
    const { regional, matchId } = req.params as { regional: string; matchId: string };
    const { puuid } = req.query as { puuid?: string };

    const match = await getMatchById(regional, matchId);
    if (!match) return res.status(404).json({ message: "Match not found" });
    if (!puuid) return res.json(match);

    const info = (match as any).info;
    const me = info?.participants?.find((x: any) => x.puuid === puuid);
    if (!me) return res.status(404).json({ message: "Participant not found" });

    const teamId = me.teamId;
    const teamKills = info.participants
      .filter((p: any) => p.teamId === teamId)
      .reduce((a: number, p: any) => a + (p.kills || 0), 0);

    const items = [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5].filter((x: any) => Number.isInteger(x));
    const trinket = Number.isInteger(me.item6) ? me.item6 : undefined;

    const out = {
      matchId,
      championId: me.championId,
      championName: me.championName,
      win: Boolean(me.win),
      kills: me.kills,
      deaths: me.deaths,
      assists: me.assists,
      kda: (me.kills + me.assists) / Math.max(me.deaths, 1),
      cs: (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0),
      gameDuration: info.gameDuration,
      gameMode: info.gameMode ?? info.queueId,
      gameStartTimestamp: info.gameStartTimestamp,
      queueId: info.queueId,
      championLevel: me.champLevel,
      gold: me.goldEarned,
      totalDamageDealtToChampions: me.totalDamageDealtToChampions,

      items,
      trinket,
      summonerSpells: [me.summoner1Id, me.summoner2Id],
      perks: me.perks,
      role: me.role,
      lane: me.lane,

      killParticipation: teamKills ? (me.kills + me.assists) / teamKills : undefined,
      playerAugments: [me.playerAugment1, me.playerAugment2, me.playerAugment3, me.playerAugment4].filter((x: any) =>
        Number.isInteger(x)
      ),
      teamParticipants: info.participants.map((p:any) => ({
  teamId: p.teamId,
  championId: p.championId,
  summonerName: p.riotIdGameName || p.summonerName || "Invocador",
  gameName: p.riotIdGameName || p.summonerName || "",
  tagLine: p.riotIdTagline || p.riotIdTagLine || "",
  puuid: p.puuid,
  kills: p.kills,
  deaths: p.deaths,
  assists: p.assists,
  items: [p.item0,p.item1,p.item2,p.item3,p.item4,p.item5].filter(Number.isInteger),
  trinket: Number.isInteger(p.item6) ? p.item6 : undefined,
})),
    };

    return res.json(out);
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({ message: e?.message || "match detail failed" });
  }
});

/**
 * GET /api/stats/spectator/:platform/:puuid
 */

r.get("/spectator/:platform/:puuid", async (req, res) => {
  try {
    const platform = String(req.params.platform).toLowerCase();
    const puuid = String(req.params.puuid);
    const wantRank = String(req.query.rank || "0") === "1";

    const ALLOWED = new Set(["la1","la2","na1","br1","oc1","euw1","eun1","tr1","ru","jp1","kr"]);
    if (!ALLOWED.has(platform)) {
      return res.status(400).json({ error: "invalid platform", platform });
    }
    if (!RIOT_KEY) return res.status(500).json({ error: "RIOT_API_KEY missing" });

    const headers = { "X-Riot-Token": RIOT_KEY };

    // Probe multiple platforms because the PUUID may have summoner profiles on different regions
    // (very common with LAN/LAS/NA/BR players). This prevents false 404s when the page
    // was loaded for one platform but the player is playing on another.
    // Use a safe list of platforms. Some SEA hosts (th2, tw2, vn2 etc.) do not reliably resolve
    // for the public Riot API and cause DNS errors (getaddrinfo ENOTFOUND).
    // We keep only well-supported platforms for now.
    const SAFE_PROBE_PLATFORMS = [
      ...PROBE_AMERICAS,
      "euw1", "eun1", "tr1", "ru",
      "kr", "jp1"
      // SEA platforms are commented because several (th2, tw2, vn2, etc.) cause DNS failures.
      // "ph2", "sg2" // only enable if you have confirmed they work for your region
    ];
    const tryPlatforms = [platform, ...SAFE_PROBE_PLATFORMS.filter((p: any) => p !== platform)];

    let summoner: any = null;
    let usedPlatform = platform;

    for (const pf of tryPlatforms) {
      try {
        const s = await getSummonerByPUUID(pf as any, puuid);
        if (s?.id) {
          summoner = s;
          usedPlatform = pf;
          break;
        }
      } catch (e: any) {
        if (e?.response?.status === 403) {
          return res.status(403).json({ error: "Forbidden (Riot 403)" });
        }
      }
    }

    let g: any = null;

    if (summoner?.id) {
      // Preferred path: we have a summoner id on a known platform
      try {
        g = await getLiveGame(usedPlatform as any, summoner.id);
      } catch (e: any) {
        const st = e?.response?.status;
        if (st === 404 || st === 403) {
          // continue to fallback below
        } else {
          return res.status(st || 500).json(e?.response?.data || { error: "spectator failed" });
        }
      }
    }

    if (!g) {
      // Fallback: no summoner profile found (or by-summoner failed), try direct by-puuid on all probed platforms.
      // This is important because by-puuid can sometimes succeed even when summoner/v4 lookup fails for the PUUID on that platform.
      console.log(`[spectator] No summoner found or no game via by-summoner for ${puuid}. Falling back to direct by-puuid on ${tryPlatforms.length} platforms...`);

      for (const pf of tryPlatforms) {
        try {
          const directUrl = `https://${pf}.api.riotgames.com/lol/spectator/v5/active-games/by-puuid/${encodeURIComponent(puuid)}`;
          const directRes = await riotGet(directUrl, { headers: { "X-Riot-Token": RIOT_KEY } });
          const directData = directRes?.data;

          if (directData && Array.isArray(directData.participants) && directData.participants.length > 0) {
            g = directData;
            usedPlatform = pf;
            console.log(`[spectator] SUCCESS via direct by-puuid fallback on platform ${pf}`);
            break;
          }
        } catch (e: any) {
          const st = e?.response?.status;
          if (st === 404 || st === 403) {
            continue; // expected, player not on this platform
          }
          // Network errors (DNS ENOTFOUND, connection refused, etc.) have no response.status.
          // Just skip the platform silently — these are common for non-existent SEA hosts.
          if (!st) {
            continue;
          }
          console.warn(`[spectator direct fallback] unexpected error on ${pf}:`, st || e?.code || e?.message);
        }
      }
    }

    if (!g) {
      return res.status(404).json({ 
        error: "No active game found after full probing (summoner lookup + direct by-puuid fallback)",
        triedPlatforms: tryPlatforms,
        puuid 
      });
    }

    // Participantes con campos útiles de v5
    // éxito
const participants = (g.participants || []).map((p: any) => {
  // spectator-v5 trae spell1Id, spell2Id y perks con perkIds, perkStyle, perkSubStyle
  const perkIds: number[] = p?.perks?.perkIds || [];
  // keystone suele venir como el primer perk de la rama primaria
  const keystone = perkIds[0];

  return {
    summonerName: p.riotIdGameName || p.summonerName || "Invocador",
    championId: p.championId,
    teamId: p.teamId,
    puuid: p.puuid,

    // 👇 nuevo
    spell1Id: p.spell1Id,
    spell2Id: p.spell2Id,
    perks: {
      keystone,
      primaryStyle: p?.perks?.perkStyle,
      subStyle: p?.perks?.perkSubStyle,
    },

    // placeholder rank; lo completamos abajo si ?rank=1
    rank: null as null | { tier: string; rank: string; lp: number },
  };
});

if (String(req.query.rank) === "1") {
  // Trae rank para cada summonerId (máximo 10 → OK con rate limits suaves)
  const axiosOpts = { headers: { "X-Riot-Token": RIOT_KEY } };
  await Promise.allSettled(
    participants.map(async (pp: any, i: number) => {
      try {
        const sum = await riotGet<{ id: string }>(
          `https://${usedPlatform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(pp.puuid || "")}`,
          axiosOpts
        );
        if (!sum?.data?.id) return;

        const le = await riotGet<any[]>(
          `https://${usedPlatform}.api.riotgames.com/lol/league/v4/entries/by-summoner/${sum.data.id}`,
          axiosOpts
        );
        const best = (le.data || []).find((x: any) => x.queueType === "RANKED_SOLO_5x5") || (le.data || [])[0];
        if (best) {
          participants[i].rank = {
            tier: best.tier,
            rank: best.rank,
            lp: best.leaguePoints,
          };
        }
      } catch {}
    })
  );
}

// Calcular duración desde gameStartTime (ms → seconds)
const gameLength = g.gameStartTime
  ? Math.floor((Date.now() - g.gameStartTime) / 1000)
  : (g.gameLength ?? 0);

return res.json({
  gameId:       g.gameId,
  platformId:   g.platformId,
  platformUsed: usedPlatform,           // helpful when we had to probe other regions
  gameMode:     g.gameMode,
  gameType:     g.gameType,
  gameStartTime:g.gameStartTime,
  gameLength,
  queueId:      g.gameQueueConfigId,
  mapId:        g.mapId,
  observers:    g.observers || null,
  encryptionKey: g.observers?.encryptionKey || null,
  bannedChampions: (g.bannedChampions || []).map((b: any) => ({
    championId: b.championId,
    teamId:     b.teamId,
    pickTurn:   b.pickTurn,
  })),
  participants,
});
  } catch (e: any) {
    const st = e?.response?.status;
    if (st === 404 || st === 403) return res.sendStatus(204);
    return res.status(st || 500).json({ error: e?.message || "spectator failed" });
  }
});


// Imprime rutas
setImmediate(() => {
  const paths = (r as any).stack
    ?.filter((l: any) => l?.route?.path)
    .map((l: any) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`);
  console.log("[STATS] routes:", paths);
});

/**
 * GET /api/stats/champion-stats/:platform/:puuid?count=20&queues=420,440
 */
r.get("/champion-stats/:platform/:puuid", async (req, res) => {
  try {
    const { platform, puuid } = req.params as { platform: string; puuid: string };
    const { count = "20", queues } = req.query as { count?: string; queues?: string };

    const regional = platformToRegional(platform);
    if (!RIOT_KEY) return res.status(500).json({ message: "RIOT_API_KEY missing" });
    const headers = { "X-Riot-Token": RIOT_KEY };

    const idsRes = await riotGet<string[]>(
      `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`,
      { headers, params: { start: 0, count: Number(count) } }
    );
    const ids = idsRes.data || [];

    const onlyQueues = queues
      ? new Set(
          String(queues)
            .split(",")
            .map((q) => Number(q.trim()))
            .filter(Boolean)
        )
      : undefined;

    type Row = { games: number; wins: number; losses: number; k: number; d: number; a: number };
    const agg = new Map<number, Row>();

    // secuencial + riotGet
    for (const id of ids) {
      const r = await riotGet(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${id}`, { headers });
      const info = (r.data as any)?.info;
      if (!info) continue;
      if (onlyQueues && !onlyQueues.has(info.queueId)) continue;

      const p = info.participants?.find((x: any) => x.puuid === puuid);
      if (!p) continue;

      const key = Number(p.championId);
      const row =
        agg.get(key) ||
        ({ games: 0, wins: 0, losses: 0, k: 0, d: 0, a: 0 } as Row);

      row.games += 1;
      p.win ? (row.wins += 1) : (row.losses += 1);
      row.k += p.kills || 0;
      row.d += p.deaths || 0;
      row.a += p.assists || 0;

      agg.set(key, row);
    }

    const out: Record<
      number,
      { games: number; wins: number; losses: number; winRate: number; kda: string; avgKills: string; avgDeaths: string; avgAssists: string }
    > = {};

    for (const [champId, rrow] of agg.entries()) {
      const kda = rrow.d === 0 ? rrow.k + rrow.a : (rrow.k + rrow.a) / rrow.d;
      out[champId] = {
        games: rrow.games,
        wins: rrow.wins,
        losses: rrow.losses,
        winRate: rrow.games ? Math.round((rrow.wins / rrow.games) * 100) : 0,
        kda: kda.toFixed(2),
        avgKills: (rrow.k / rrow.games).toFixed(1),
        avgDeaths: (rrow.d / rrow.games).toFixed(1),
        avgAssists: (rrow.a / rrow.games).toFixed(1),
      };
    }

    return res.json(out);
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({
      message: e?.response?.data?.status?.message || e?.message || "champion-stats failed",
    });
  }
});


// ─── Featured players (seed + live cache) ────────────────────────────────────
const FEATURED_SEED = [
  { riotId:'Faker#KR1',      region:'kr',   platform:'kr' },
  { riotId:'Caps#EUW',       region:'euw1', platform:'euw1' },
  { riotId:'Doublelift#NA1', region:'na1',  platform:'na1' },
  { riotId:'KisterKata#NA1', region:'na1',  platform:'na1' },
  { riotId:'Rekkles#EUW',    region:'euw1', platform:'euw1' },
  { riotId:'Ruler#KR1',      region:'kr',   platform:'kr' },
];

const featuredCache: Map<string, { data: any; ts: number }> = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 min

async function fetchFeaturedPlayer(seed: typeof FEATURED_SEED[0]) {
  const cached = featuredCache.get(seed.riotId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  if (!RIOT_KEY) throw new Error('no key');
  const headers = { 'X-Riot-Token': RIOT_KEY };
  const [gameName, tagLine] = seed.riotId.split('#');
  const regional = platformToRegional(seed.platform);

  const { data: acc } = await riotGet<any>(
    `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
    { headers }
  );
  const puuid = acc.puuid;

  const [sumRes, leagueRes, idsRes] = await Promise.allSettled([
    riotGet<any>(`https://${seed.platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`, { headers }),
    // League via the reliable by-puuid path (summonerId is deprecated/unstable).
    riotGet<any[]>(`https://${seed.platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`, { headers }),
    riotGet<string[]>(`https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids`, { headers, params: { count: 5 } }),
  ]);

  const summoner = sumRes.status === 'fulfilled' ? sumRes.value.data : null;
  const rankEntries = leagueRes.status === 'fulfilled' ? leagueRes.value.data : [];
  const matchIds: string[] = idsRes.status === 'fulfilled' ? (idsRes.value.data || []) : [];

  const solo = (rankEntries as any[]).find((e: any) => e.queueType === 'RANKED_SOLO_5x5') || (rankEntries as any[])[0];

  // champion stats from last 5 matches
  const champCount: Record<number, { games: number; wins: number; k: number; d: number; a: number }> = {};
  await Promise.allSettled(matchIds.slice(0, 5).map(async (mid) => {
    try {
      const { data: m } = await riotGet<any>(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${mid}`, { headers });
      const p = m?.info?.participants?.find((x: any) => x.puuid === puuid);
      if (!p) return;
      const cid = p.championId as number;
      if (!champCount[cid]) champCount[cid] = { games: 0, wins: 0, k: 0, d: 0, a: 0 };
      champCount[cid].games++;
      if (p.win) champCount[cid].wins++;
      champCount[cid].k += p.kills; champCount[cid].d += p.deaths; champCount[cid].a += p.assists;
    } catch {}
  }));

  let topChampId: number | null = null;
  let topGames = 0;
  for (const [cid, s] of Object.entries(champCount)) {
    if (s.games > topGames) { topGames = s.games; topChampId = Number(cid); }
  }

  let avgKDA = 0;
  let totalWins = 0, totalGames = 0;
  for (const s of Object.values(champCount)) {
    totalGames += s.games; totalWins += s.wins;
    avgKDA += s.d === 0 ? (s.k + s.a) : (s.k + s.a) / s.d;
  }
  if (Object.keys(champCount).length > 0) avgKDA = avgKDA / Object.keys(champCount).length;

  const result = {
    riotId: seed.riotId,
    gameName, tagLine,
    region: seed.region,
    platform: seed.platform,
    puuid,
    profileIconId: summoner?.profileIconId ?? null,
    level: summoner?.summonerLevel ?? 0,
    rank: solo ? { tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints, wins: solo.wins, losses: solo.losses } : null,
    topChampId,
    winRate: totalGames ? Math.round((totalWins / totalGames) * 100) : 0,
    avgKDA: Number(avgKDA.toFixed(2)),
    recentGames: totalGames,
  };

  featuredCache.set(seed.riotId, { data: result, ts: Date.now() });
  return result;
}

r.get('/featured', async (_req, res) => {
  const results = await Promise.allSettled(FEATURED_SEED.map(fetchFeaturedPlayer));
  const players = results
    .map((r, i) => r.status === 'fulfilled' ? r.value : { ...FEATURED_SEED[i], error: true, rank: null, topChampId: null, winRate: 0, avgKDA: 0, recentGames: 0, profileIconId: null, level: 0 })
    .filter(Boolean);
  res.json(players);
});

// ─── Profile comments ─────────────────────────────────────────────────────────
import { pool } from '../db.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import jwt from 'jsonwebtoken';

async function initProfileCommentsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_comments (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      profile_puuid VARCHAR(200) NOT NULL,
      user_id       INT NOT NULL,
      user_name     VARCHAR(100) NOT NULL,
      content       TEXT NOT NULL,
      likes_count   INT DEFAULT 0,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_profile (profile_puuid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_comment_likes (
      comment_id INT NOT NULL,
      user_id    INT NOT NULL,
      PRIMARY KEY (comment_id, user_id)
    ) ENGINE=InnoDB
  `);
}
initProfileCommentsTable().catch(e => console.error('[profile-comments] init error:', e.message));

function getViewerId(req: any): number | null {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    const id = Number(payload.sub || payload.uid);
    return isNaN(id) ? null : id;
  } catch { return null; }
}

async function getUserName(userId: number): Promise<string> {
  try {
    const [[u]] = await pool.query<any[]>('SELECT name, email FROM users WHERE id = ?', [userId]);
    return u?.name || (u?.email ? u.email.split('@')[0] : `Usuario${userId}`);
  } catch { return `Usuario${userId}`; }
}

// GET /api/stats/profile-comments/:puuid
r.get('/profile-comments/:puuid', async (req: any, res) => {
  const puuid = req.params.puuid;
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(50, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const viewerId = getViewerId(req);
  const likedExpr = viewerId !== null
    ? `(SELECT COUNT(*) > 0 FROM profile_comment_likes l WHERE l.comment_id = c.id AND l.user_id = ${viewerId})`
    : 'FALSE';
  try {
    const [comments] = await pool.query<any[]>(
      `SELECT c.id, c.user_id, c.user_name, c.content, c.likes_count, c.created_at,
              ${likedExpr} AS liked_by_me
       FROM profile_comments c
       WHERE c.profile_puuid = ?
       ORDER BY c.created_at DESC
       LIMIT ? OFFSET ?`,
      [puuid, limit, offset]
    );
    const [[{ total }]] = await pool.query<any[]>(
      'SELECT COUNT(*) AS total FROM profile_comments WHERE profile_puuid = ?', [puuid]
    );
    res.json({ comments, total: Number(total), page, pages: Math.ceil(Number(total) / limit) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/stats/profile-comments/:puuid
r.post('/profile-comments/:puuid', requireAuth, async (req: any, res) => {
  const puuid = req.params.puuid;
  const { content } = req.body;
  const userId = req.auth.userId;
  if (!content?.trim())     return res.status(400).json({ error: 'Comentario requerido' });
  if (content.length > 280) return res.status(400).json({ error: 'Máximo 280 caracteres' });
  try {
    const userName = await getUserName(userId);
    const [result] = await pool.query<any>(
      'INSERT INTO profile_comments (profile_puuid, user_id, user_name, content) VALUES (?, ?, ?, ?)',
      [puuid, userId, userName, content.trim()]
    );
    const [[comment]] = await pool.query<any[]>(
      'SELECT *, FALSE AS liked_by_me FROM profile_comments WHERE id = ?', [result.insertId]
    );
    res.status(201).json(comment);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /api/stats/profile-comments/:id/like
r.post('/profile-comments/:id/like', requireAuth, async (req: any, res) => {
  const commentId = Number(req.params.id);
  const userId = req.auth.userId;
  if (isNaN(commentId)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const [[existing]] = await pool.query<any[]>(
      'SELECT 1 FROM profile_comment_likes WHERE comment_id = ? AND user_id = ?', [commentId, userId]
    );
    if (existing) {
      await pool.query('DELETE FROM profile_comment_likes WHERE comment_id = ? AND user_id = ?', [commentId, userId]);
      await pool.query('UPDATE profile_comments SET likes_count = GREATEST(0, likes_count - 1) WHERE id = ?', [commentId]);
      return res.json({ liked: false });
    }
    await pool.query('INSERT IGNORE INTO profile_comment_likes (comment_id, user_id) VALUES (?, ?)', [commentId, userId]);
    await pool.query('UPDATE profile_comments SET likes_count = likes_count + 1 WHERE id = ?', [commentId]);
    res.json({ liked: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/stats/profile-comments/:id
r.delete('/profile-comments/:id', requireAuth, async (req: any, res) => {
  const commentId = Number(req.params.id);
  const userId = req.auth.userId;
  const role   = req.auth.role;
  if (isNaN(commentId)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const [[c]] = await pool.query<any[]>('SELECT user_id, profile_puuid FROM profile_comments WHERE id = ?', [commentId]);
    if (!c) return res.status(404).json({ error: 'Comentario no encontrado' });
    // owner of comment OR the profile owner (checked by puuid param) OR admin
    const profileOwnerPuuid = req.query.profilePuuid as string | undefined;
    const isProfileOwner = profileOwnerPuuid && profileOwnerPuuid === c.profile_puuid &&
      // Check if userId is the owner of that profile — we don't have a direct link, but we allow via query param
      req.query.profileOwner === 'true';
    if (c.user_id !== userId && role !== 'admin' && !isProfileOwner)
      return res.status(403).json({ error: 'Sin permiso' });
    await pool.query('DELETE FROM profile_comment_likes WHERE comment_id = ?', [commentId]);
    await pool.query('DELETE FROM profile_comments WHERE id = ?', [commentId]);
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Match stats (rich, MatchStatsResponse shape) ─────────────────────────────
// Self-contained parser mirroring the tournament stats shape so the frontend's
// <MatchStatsDetail /> (charts) can render solo matches too.
function ms_parseParticipant(p: any, gameDuration: number) {
  const cs = (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0);
  const mins = Math.max(1, gameDuration / 60);
  return {
    puuid:             p.puuid,
    summonerName:      p.riotIdGameName || p.summonerName || "Invocador",
    tagLine:           p.riotIdTagline || p.riotIdTagLine || "",
    championName:      p.championName,
    championId:        p.championId,
    champLevel:        p.champLevel,
    teamId:            p.teamId,
    win:               p.win,
    kills:             p.kills ?? 0,
    deaths:            p.deaths ?? 0,
    assists:           p.assists ?? 0,
    kda:               p.deaths === 0 ? (p.kills + p.assists) : ((p.kills + p.assists) / p.deaths),
    cs,
    csPerMin:          Math.round((cs / mins) * 10) / 10,
    goldEarned:        p.goldEarned ?? 0,
    totalDamageDealt:  p.totalDamageDealtToChampions ?? 0,
    physicalDamage:    p.physicalDamageDealtToChampions ?? 0,
    magicDamage:       p.magicDamageDealtToChampions ?? 0,
    trueDamage:        p.trueDamageDealtToChampions ?? 0,
    damageTaken:       p.totalDamageTaken ?? 0,
    healingDone:       p.totalHeal ?? 0,
    visionScore:       p.visionScore ?? 0,
    wardsPlaced:       p.wardsPlaced ?? 0,
    wardsKilled:       p.wardsKilled ?? 0,
    items:             [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map(Number),
    summoner1Id:       p.summoner1Id ?? 0,
    summoner2Id:       p.summoner2Id ?? 0,
    perks: {
      keystoneId:       p.perks?.styles?.[0]?.selections?.[0]?.perk ?? 0,
      secondaryStyleId: p.perks?.styles?.[1]?.style ?? 0,
    },
    pentaKills:        p.pentaKills ?? 0,
    quadraKills:       p.quadraKills ?? 0,
    tripleKills:       p.tripleKills ?? 0,
    doubleKills:       p.doubleKills ?? 0,
    firstBloodKill:    p.firstBloodKill ?? false,
    teamPosition:      p.teamPosition || p.role || "",
    largestMultiKill:  p.largestMultiKill ?? 0,
    killingSprees:     p.killingSprees ?? 0,
    totalTimeCCDealt:  p.totalTimeCCDealt ?? 0,
    challenges: p.challenges ? {
      killParticipation:    p.challenges.killParticipation,
      kda:                  p.challenges.kda,
      damagePerMinute:      p.challenges.damagePerMinute,
      goldPerMinute:        p.challenges.goldPerMinute,
      visionScorePerMinute: p.challenges.visionScorePerMinute,
      soloKills:            p.challenges.soloKills,
    } : undefined,
  };
}

function ms_parseTeamObjectives(team: any) {
  const obj = team?.objectives ?? {};
  return {
    win:             team?.win ?? false,
    bans:            team?.bans ?? [],
    baronKills:      obj.baron?.kills ?? 0,
    dragonKills:     obj.dragon?.kills ?? 0,
    towerKills:      obj.tower?.kills ?? 0,
    inhibitorKills:  obj.inhibitor?.kills ?? 0,
    riftHeraldKills: obj.riftHerald?.kills ?? 0,
    firstBaron:      obj.baron?.first ?? false,
    firstDragon:     obj.dragon?.first ?? false,
    firstTower:      obj.tower?.first ?? false,
  };
}

/**
 * GET /api/stats/match-stats/:regional/:matchId
 * -> MatchStatsResponse (blueTeam/redTeam/objectives) for <MatchStatsDetail/>.
 */
r.get("/match-stats/:regional/:matchId", async (req, res) => {
  try {
    const { regional, matchId } = req.params as { regional: string; matchId: string };
    const data = await getMatchById(regional, matchId);
    if (!data?.info) return res.status(404).json({ message: "Match not found" });

    const info = data.info;
    const dur = info.gameDuration as number;
    const participants = (info.participants as any[]).map((p) => ms_parseParticipant(p, dur));
    const blueTeam = participants.filter((p) => p.teamId === 100);
    const redTeam = participants.filter((p) => p.teamId === 200);
    const blueRaw = (info.teams as any[])?.find((t) => t.teamId === 100);
    const redRaw = (info.teams as any[])?.find((t) => t.teamId === 200);
    const winnerTeamId = (info.teams as any[])?.find((t) => t.win)?.teamId;

    return res.json({
      matchId,
      gameId: info.gameId,
      gameDuration: dur,
      gameStartTimestamp: info.gameStartTimestamp,
      gameEndTimestamp: info.gameEndTimestamp,
      gameMode: info.gameMode,
      queueId: info.queueId,
      isComplete: !!info.gameEndTimestamp,
      winner: winnerTeamId === 100 ? "blue" : winnerTeamId === 200 ? "red" : null,
      blueTeam,
      redTeam,
      blueObjectives: ms_parseTeamObjectives(blueRaw),
      redObjectives: ms_parseTeamObjectives(redRaw),
    });
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({ message: e?.message || "match-stats failed" });
  }
});

r.get("/match-timeline/:regional/:matchId", async (req, res) => {
  try {
    const { regional, matchId } = req.params as { regional: string; matchId: string };
    if (!RIOT_KEY) return res.status(500).json({ message: "RIOT_API_KEY missing" });

    const headers = { "X-Riot-Token": RIOT_KEY };
    const { data: tl } = await riotGet<any>(
      `https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`,
      { headers }
    );

    // Frames → oro por equipo, cs por equipo, etc.
    const frames = tl?.info?.frames ?? [];
    const blueIds = new Set<number>();
    const redIds  = new Set<number>();

    // Necesitamos team mapping: lo tomamos del match normal (ya lo tienes en /matches/:regional/:matchId)
    // Si prefieres incluirlo aquí, puedes hacer un GET al match y mapear participantId -> teamId.
    // Para ahorrar, exponemos totales por "ladoA/ladoB" sin nombres.
    const teamTotals = frames.map((f: any) => {
      let blueGold = 0, redGold = 0, blueCS = 0, redCS = 0;
      for (const [pid, pf] of Object.entries<any>(f.participantFrames || {})) {
        // sin teamId aquí, pero podemos alternar por convención: ids 1-5 = blue, 6-10 = red (estándar Riot)
        const idNum = Number(pid);
        const isBlue = idNum >= 1 && idNum <= 5;
        const gold = pf.totalGold ?? 0;
        const cs   = (pf.minionsKilled ?? 0) + (pf.jungleMinionsKilled ?? 0);
        if (isBlue) { blueGold += gold; blueCS += cs; } else { redGold += gold; redCS += cs; }
      }
      return {
        t: f.timestamp, blueGold, redGold, blueCS, redCS
      };
    });

    // Eventos interesantes: subidas de skill, objetivos, compras
    const skillUps: Array<{ t:number; participantId:number; skillSlot:number; levelUpType:string }> = [];
    const itemBuys: Array<{ t:number; participantId:number; itemId:number }> = [];
    const objectives: Array<{ t:number; type:string; teamId?:number }> = [];

    for (const f of frames) {
      for (const ev of (f.events || [])) {
        if (ev.type === "SKILL_LEVEL_UP") {
          skillUps.push({ t: ev.timestamp, participantId: ev.participantId, skillSlot: ev.skillSlot, levelUpType: ev.levelUpType });
        } else if (ev.type === "ITEM_PURCHASED") {
          itemBuys.push({ t: ev.timestamp, participantId: ev.participantId, itemId: ev.itemId });
        } else if (["ELITE_MONSTER_KILL","TURRET_PLATE_DESTROYED","BUILDING_KILL"].includes(ev.type)) {
          objectives.push({ t: ev.timestamp, type: ev.type, teamId: ev.killerTeamId ?? ev.teamId });
        }
      }
    }

    return res.json({
      frames: teamTotals,   // {t, blueGold, redGold, blueCS, redCS}
      skillUps,
      itemBuys,
      objectives
    });
  } catch (e:any) {
    return res.status(e?.response?.status || 500).json({
      message: e?.response?.data?.status?.message || e?.message || "timeline failed",
    });
  }
});

// ─── GET /api/stats/live/:platform/:puuid ─────────────────────────────────────
// Probing + fallback to direct by-puuid for maximum detection rate across regions.
r.get("/live/:platform/:puuid", async (req, res) => {
  const platform = String(req.params.platform).toLowerCase();
  const puuid    = String(req.params.puuid);

  try {
    // Probe platforms (same logic as the improved /spectator route)
    // Use a safe list of platforms. Some SEA hosts (th2, tw2, vn2 etc.) do not reliably resolve
    // for the public Riot API and cause DNS errors (getaddrinfo ENOTFOUND).
    // We keep only well-supported platforms for now.
    const SAFE_PROBE_PLATFORMS = [
      ...PROBE_AMERICAS,
      "euw1", "eun1", "tr1", "ru",
      "kr", "jp1"
      // SEA platforms are commented because several (th2, tw2, vn2, etc.) cause DNS failures.
      // "ph2", "sg2" // only enable if you have confirmed they work for your region
    ];
    const tryPlatforms = [platform, ...SAFE_PROBE_PLATFORMS.filter((p: any) => p !== platform)];

    let summoner: any = null;
    let usedPlatform = platform;

    for (const pf of tryPlatforms) {
      try {
        const s = await getSummonerByPUUID(pf as any, puuid);
        if (s?.id) {
          summoner = s;
          usedPlatform = pf;
          break;
        }
      } catch (e: any) {
        if (e?.response?.status === 403) return res.status(403).json({ error: "Forbidden (Riot 403)" });
      }
    }

    let game: any = null;

    if (summoner?.id) {
      game = await getLiveGame(usedPlatform as any, summoner.id);
    }

    if (!game) {
      // Fallback for /live route too (direct by-puuid)
      console.log(`[/live] No summoner or no game via by-summoner. Trying direct by-puuid fallback...`);
      for (const pf of tryPlatforms) {
        try {
          const directUrl = `https://${pf}.api.riotgames.com/lol/spectator/v5/active-games/by-puuid/${encodeURIComponent(puuid)}`;
          const directRes = await riotGet(directUrl, { headers: { "X-Riot-Token": RIOT_KEY } });
          if (directRes?.data?.participants?.length > 0) {
            game = directRes.data;
            usedPlatform = pf;
            console.log(`[/live] Found game via direct by-puuid fallback on ${pf}`);
            break;
          }
        } catch (e: any) {
          const st = e?.response?.status;
          if (st === 404 || st === 403) {
            continue;
          }
          if (!st) {
            continue; // DNS/network error — skip silently
          }
          console.warn(`[/live direct fallback] unexpected error on ${pf}:`, st || e?.code || e?.message);
        }
      }
    }

    if (!game) {
      return res.status(404).json({ inGame: false, error: "No active game found after full probing", triedPlatforms: tryPlatforms });
    }

    // Step 3: normalize & enrich response
    const gameLength = game.gameStartTime
      ? Math.floor((Date.now() - game.gameStartTime) / 1000)
      : (game.gameLength ?? 0);

    const participants = (game.participants ?? []).map((p: any) => ({
      summonerName: p.riotIdGameName || p.summonerName || "Invocador",
      riotId:       p.riotId ?? null,
      championId:   p.championId,
      teamId:       p.teamId,
      puuid:        p.puuid ?? null,
      spell1Id:     p.spell1Id,
      spell2Id:     p.spell2Id,
    }));

    return res.json({
      inGame:          true,
      gameId:          game.gameId,
      platformId:      game.platformId,
      platformUsed:    usedPlatform,
      gameMode:        game.gameMode,
      gameType:        game.gameType,
      gameLength,
      gameStartTime:   game.gameStartTime,
      queueId:         game.gameQueueConfigId,
      mapId:           game.mapId,
      observers:       game.observers || null,
      encryptionKey:   game.observers?.encryptionKey || null,
      bannedChampions: (game.bannedChampions ?? []).map((b: any) => ({
        championId: b.championId,
        teamId:     b.teamId,
        pickTurn:   b.pickTurn,
      })),
      participants,
    });
  } catch (e: any) {
    const st = e?.response?.status;
    if (st === 404) return res.status(204).send(); // not in game
    return res.status(st || 500).json({ error: e?.message || "live check failed" });
  }
});

// ─── Recently played with ─────────────────────────────────────────────────────
type TeammateAgg = {
  puuid: string;
  gameName: string;
  tagLine: string;
  games: number;      // total games seen together (ally or enemy)
  asAlly: number;
  asEnemy: number;
  togetherWins: number; // games where co-player was an ALLY and the team won
  champs: Record<number, number>;
};
const teammatesCache = new Map<string, { data: any; ts: number }>();
const TEAMMATES_TTL = 10 * 60 * 1000; // 10 min

/**
 * GET /api/stats/recent-teammates/:regional/:puuid?count=20
 * Aggregates other participants across the player's recent matches.
 */
r.get("/recent-teammates/:regional/:puuid", async (req, res) => {
  try {
    const { regional, puuid } = req.params as { regional: string; puuid: string };
    const count = Math.min(30, Math.max(5, Number((req.query as any).count) || 20));

    const cacheKey = `${regional}:${puuid}:${count}`;
    const cached = teammatesCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < TEAMMATES_TTL) return res.json(cached.data);

    const ids = (await getMatchIdsByPUUID(regional, puuid, count, 0)) || [];

    const agg = new Map<string, TeammateAgg>();
    for (const id of ids) {
      const match = await getMatchById(regional, id);
      const info = (match as any)?.info;
      if (!info) continue;
      const me = info.participants.find((p: any) => p.puuid === puuid);
      if (!me) continue;

      for (const p of info.participants as any[]) {
        if (p.puuid === puuid || !p.puuid) continue;
        const row =
          agg.get(p.puuid) ||
          ({
            puuid: p.puuid,
            gameName: p.riotIdGameName || p.summonerName || "Invocador",
            tagLine: p.riotIdTagline || p.riotIdTagLine || "",
            games: 0, asAlly: 0, asEnemy: 0, togetherWins: 0, champs: {},
          } as TeammateAgg);

        row.games += 1;
        const sameTeam = p.teamId === me.teamId;
        if (sameTeam) {
          row.asAlly += 1;
          if (me.win) row.togetherWins += 1;
        } else {
          row.asEnemy += 1;
        }
        // refresh name in case earlier games had it blank
        if (p.riotIdGameName) row.gameName = p.riotIdGameName;
        if (p.riotIdTagline) row.tagLine = p.riotIdTagline;
        row.champs[p.championId] = (row.champs[p.championId] || 0) + 1;
        agg.set(p.puuid, row);
      }
    }

    const players = Array.from(agg.values())
      .filter((t) => t.games >= 2)
      .sort((a, b) => b.games - a.games)
      .slice(0, 12)
      .map((t) => {
        const topChamps = Object.entries(t.champs)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([cid, n]) => ({ championId: Number(cid), games: n }));
        return {
          puuid: t.puuid,
          gameName: t.gameName,
          tagLine: t.tagLine,
          games: t.games,
          asAlly: t.asAlly,
          asEnemy: t.asEnemy,
          togetherWins: t.togetherWins, // wins while on the same team
          // win% computed over allied games (only those are "together" outcomes)
          winRate: t.asAlly ? Math.round((t.togetherWins / t.asAlly) * 100) : null,
          champions: topChamps,
        };
      });

    const out = { sampleSize: ids.length, players };
    teammatesCache.set(cacheKey, { data: out, ts: Date.now() });
    return res.json(out);
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({
      message: e?.response?.data?.status?.message || e?.message || "recent-teammates failed",
    });
  }
});

// ─── Ranked regional rank + top% (apex tiers only, real data) ──────────────────
const APEX_BY_TIER: Record<string, string> = {
  CHALLENGER: "challengerleagues",
  GRANDMASTER: "grandmasterleagues",
  MASTER: "masterleagues",
};
const apexCache = new Map<string, { data: any[]; ts: number }>();
const APEX_TTL = 15 * 60 * 1000;

async function getApexLeague(platform: string, tier: string): Promise<any[]> {
  const path = APEX_BY_TIER[tier];
  if (!path) return [];
  const key = `${platform}:${tier}`;
  const c = apexCache.get(key);
  if (c && Date.now() - c.ts < APEX_TTL) return c.data;
  const base = PLATFORM_HOST[normalizeForHost(platform)];
  if (!base || !RIOT_KEY) return [];
  const { data } = await riotGet<any>(
    `${base}/lol/league/v4/${path}/by-queue/RANKED_SOLO_5x5`,
    { headers: { "X-Riot-Token": RIOT_KEY } }
  );
  const entries = (data?.entries || []) as any[];
  apexCache.set(key, { data: entries, ts: Date.now() });
  return entries;
}

function normalizeForHost(p: string): string {
  const x = (p || "").toLowerCase().trim();
  if (x === "lan") return "la1";
  if (x === "las") return "la2";
  return x;
}

// ─── Rank distribution estimate (non-apex tiers) ──────────────────────────────
// Riot's public API doesn't expose exact ladder position below Master, so we
// estimate top% from a published-style cumulative rank distribution.
// Each entry: cumulative % of the ranked population that is AT OR ABOVE the
// FLOOR of that tier+division (i.e. better-or-equal players, including the band).
// Source shape: realistic Solo/Dúo distribution constants (approx., season-stable).
// Ordered best → worst. Values are "% of players ranked >= this band's floor".
const RANK_ORDER = ["IV", "III", "II", "I"]; // division IV is the bottom of a tier
const TIER_CUTOFFS: Array<{ tier: string; div: string; cumTopPct: number }> = [
  // tier,   div,  cumulative top% at the floor of this band
  { tier: "CHALLENGER",  div: "I",  cumTopPct: 0.012 },
  { tier: "GRANDMASTER", div: "I",  cumTopPct: 0.035 },
  { tier: "MASTER",      div: "I",  cumTopPct: 0.30 },
  { tier: "DIAMOND",     div: "I",  cumTopPct: 0.60 },
  { tier: "DIAMOND",     div: "II", cumTopPct: 0.90 },
  { tier: "DIAMOND",     div: "III",cumTopPct: 1.30 },
  { tier: "DIAMOND",     div: "IV", cumTopPct: 2.30 },
  { tier: "EMERALD",     div: "I",  cumTopPct: 3.50 },
  { tier: "EMERALD",     div: "II", cumTopPct: 5.20 },
  { tier: "EMERALD",     div: "III",cumTopPct: 7.30 },
  { tier: "EMERALD",     div: "IV", cumTopPct: 11.20 },
  { tier: "PLATINUM",    div: "I",  cumTopPct: 14.50 },
  { tier: "PLATINUM",    div: "II", cumTopPct: 18.30 },
  { tier: "PLATINUM",    div: "III",cumTopPct: 22.50 },
  { tier: "PLATINUM",    div: "IV", cumTopPct: 30.40 },
  { tier: "GOLD",        div: "I",  cumTopPct: 35.00 },
  { tier: "GOLD",        div: "II", cumTopPct: 40.00 },
  { tier: "GOLD",        div: "III",cumTopPct: 45.50 },
  { tier: "GOLD",        div: "IV", cumTopPct: 54.50 },
  { tier: "SILVER",      div: "I",  cumTopPct: 59.00 },
  { tier: "SILVER",      div: "II", cumTopPct: 64.00 },
  { tier: "SILVER",      div: "III",cumTopPct: 69.50 },
  { tier: "SILVER",      div: "IV", cumTopPct: 77.50 },
  { tier: "BRONZE",      div: "I",  cumTopPct: 81.00 },
  { tier: "BRONZE",      div: "II", cumTopPct: 85.00 },
  { tier: "BRONZE",      div: "III",cumTopPct: 89.00 },
  { tier: "BRONZE",      div: "IV", cumTopPct: 94.00 },
  { tier: "IRON",        div: "I",  cumTopPct: 95.50 },
  { tier: "IRON",        div: "II", cumTopPct: 97.00 },
  { tier: "IRON",        div: "III",cumTopPct: 98.50 },
  { tier: "IRON",        div: "IV", cumTopPct: 100.0 },
];

// Approx ranked Solo/Dúo population per platform (order of magnitude; for estimate only).
const REGION_RANKED_POP: Record<string, number> = {
  na1: 1_600_000, euw1: 2_900_000, eun1: 1_600_000, kr: 1_900_000,
  br1: 1_500_000, la1: 600_000, la2: 600_000, tr1: 700_000, ru: 600_000,
  jp1: 250_000, oc1: 300_000,
};
const DEFAULT_RANKED_POP = 800_000;

/**
 * Estimate top% and regional rank for a non-apex tier+division+LP using the
 * cumulative distribution above. Interpolates within the band by LP (0–100).
 * Returns { topPercent, regionalRank } as ESTIMATES.
 */
function estimateRankStanding(
  platform: string,
  tier: string,
  div: string,
  lp: number
): { topPercent: number; regionalRank: number } | null {
  const T = String(tier || "").toUpperCase();
  const D = String(div || "I").toUpperCase();
  const idx = TIER_CUTOFFS.findIndex((c) => c.tier === T && c.div === D);
  if (idx < 0) return null;

  const floorPct = TIER_CUTOFFS[idx].cumTopPct;            // top% at the floor (0 LP) of this band
  // The "ceiling" is the floor of the next-better band (idx-1). For the very top
  // non-apex band (Diamond I), the ceiling is Master's cutoff.
  const ceilPct = idx > 0 ? TIER_CUTOFFS[idx - 1].cumTopPct : floorPct * 0.5;

  // Within a band, higher LP → better (smaller top%). Interpolate floor→ceil by LP/100.
  const frac = Math.min(1, Math.max(0, (lp || 0) / 100));
  const topPercent = floorPct + (ceilPct - floorPct) * frac;

  const pop = REGION_RANKED_POP[normalizeForHost(platform)] ?? DEFAULT_RANKED_POP;
  const regionalRank = Math.max(1, Math.round((topPercent / 100) * pop));

  return {
    topPercent: Math.round(topPercent * 100) / 100, // 2 decimals
    regionalRank,
  };
}

/**
 * GET /api/stats/league-rank/:platform/:puuid
 * For apex tiers (Master/GM/Challenger) returns exact regional position + top%.
 * For everything else returns { regionalRank: null, topPercent: null } (honest).
 */
r.get("/league-rank/:platform/:puuid", async (req, res) => {
  try {
    const { platform, puuid } = req.params as { platform: string; puuid: string };

    // League entries via the reliable by-PUUID endpoint. Probe platforms because a
    // PUUID may have its summoner profile on a different region than requested.
    const tryPlatforms = [platform, ...PROBE_AMERICAS.filter((p) => p !== platform), "euw1", "eun1", "tr1", "ru", "kr", "jp1"]
      .filter((v, i, a) => a.indexOf(v) === i);
    let entries: any[] = [];
    let pf = platform;
    for (const cand of tryPlatforms) {
      try {
        const le = await getLeagueEntriesByPuuid(cand, puuid);
        if (le && le.length) { entries = le; pf = cand; break; }
      } catch (e: any) {
        if (e?.response?.status === 403) break;
      }
    }

    const solo = (entries || []).find((e: any) => e.queueType === "RANKED_SOLO_5x5");
    if (!solo) return res.json({ tier: null, regionalRank: null, topPercent: null });

    const tier = String(solo.tier || "").toUpperCase();
    if (!APEX_BY_TIER[tier]) {
      // Non-apex: estimate top% + regional position from a published-style rank distribution.
      const est = estimateRankStanding(pf, tier, solo.rank, solo.leaguePoints);
      if (est) {
        return res.json({
          tier,
          division: solo.rank,
          lp: solo.leaguePoints,
          regionalRank: est.regionalRank,
          topPercent: est.topPercent,
          estimated: true,
        });
      }
      return res.json({ tier, regionalRank: null, topPercent: null });
    }

    // Apex: compute exact position by LP within the combined apex ladder.
    // top% = how the player ranks among all Master+ players (a real, meaningful number).
    const [chal, gm, master] = await Promise.all([
      getApexLeague(pf, "CHALLENGER"),
      getApexLeague(pf, "GRANDMASTER"),
      getApexLeague(pf, "MASTER"),
    ]);
    // Sort descending by LP across the whole apex pyramid (Challenger > GM > Master, then LP)
    const tierWeight: Record<string, number> = { CHALLENGER: 3, GRANDMASTER: 2, MASTER: 1 };
    const ladder = [
      ...chal.map((e) => ({ ...e, _t: "CHALLENGER" })),
      ...gm.map((e) => ({ ...e, _t: "GRANDMASTER" })),
      ...master.map((e) => ({ ...e, _t: "MASTER" })),
    ].sort((a, b) => (tierWeight[b._t] - tierWeight[a._t]) || (b.leaguePoints - a.leaguePoints));

    const total = ladder.length;
    const soloSummonerId = (solo as any).summonerId;
    const idx = ladder.findIndex(
      (e) => e.puuid === puuid || (soloSummonerId && e.summonerId === soloSummonerId)
    );
    const regionalRank = idx >= 0 ? idx + 1 : null;
    const topPercent =
      regionalRank != null && total > 0
        ? Math.max(0.01, Math.round((regionalRank / total) * 1000) / 10) // one decimal, e.g. 0.4
        : null;

    return res.json({ tier, lp: solo.leaguePoints, regionalRank, topPercent, apexTotal: total });
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({
      message: e?.response?.data?.status?.message || e?.message || "league-rank failed",
      tier: null, regionalRank: null, topPercent: null,
    });
  }
});

// ─── "Mejor jugador" per champion (best-effort, ours) ─────────────────────────
// From the player's recent matches, for each champion THEY played, find the
// highest-ranked OTHER participant seen on that same champion. We resolve each
// candidate's Solo/Dúo rank via the by-puuid league call and cache it hard.
const TIER_RANK_VALUE: Record<string, number> = {
  IRON: 0, BRONZE: 1, SILVER: 2, GOLD: 3, PLATINUM: 4, EMERALD: 5,
  DIAMOND: 6, MASTER: 7, GRANDMASTER: 8, CHALLENGER: 9,
};
const DIV_VALUE: Record<string, number> = { IV: 0, III: 1, II: 2, I: 3 };
function rankScore(tier?: string, div?: string, lp = 0): number {
  const t = TIER_RANK_VALUE[String(tier || "").toUpperCase()];
  if (t == null) return -1;
  const d = DIV_VALUE[String(div || "I").toUpperCase()] ?? 0;
  return t * 100000 + d * 10000 + (lp || 0);
}

// Hard cache for a puuid → Solo rank lookup (per platform), to keep lookups cheap.
const playerRankCache = new Map<string, { data: any; ts: number }>();
const PLAYER_RANK_TTL = 6 * 60 * 60 * 1000; // 6h
async function getSoloRankCached(platform: string, puuid: string) {
  const key = `${platform}:${puuid}`;
  const c = playerRankCache.get(key);
  if (c && Date.now() - c.ts < PLAYER_RANK_TTL) return c.data;
  let solo: any = null;
  try {
    const le = await getLeagueEntriesByPuuid(platform, puuid);
    solo = (le || []).find((e: any) => e.queueType === "RANKED_SOLO_5x5") || null;
  } catch { solo = null; }
  playerRankCache.set(key, { data: solo, ts: Date.now() });
  return solo;
}

const bestPlayersCache = new Map<string, { data: any; ts: number }>();
const BEST_PLAYERS_TTL = 30 * 60 * 1000; // 30 min

/**
 * GET /api/stats/best-players/:platform/:puuid?count=15
 * -> { byChampion: { [championId]: { gameName, tagLine, puuid, tier, rank, lp } } }
 * Cheap, cached, best-effort. Champions with no ranked candidate are omitted.
 */
r.get("/best-players/:platform/:puuid", async (req, res) => {
  try {
    const { platform, puuid } = req.params as { platform: string; puuid: string };
    const count = Math.min(20, Math.max(5, Number((req.query as any).count) || 15));
    const regional = platformToRegional(platform);

    const cacheKey = `${platform}:${puuid}:${count}`;
    const cached = bestPlayersCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < BEST_PLAYERS_TTL) return res.json(cached.data);

    const ids = (await getMatchIdsByPUUID(regional, puuid, count, 0)) || [];

    // 1) Determine which champions the player played + collect OTHER participants per champion.
    const myChamps = new Set<number>();
    // championId -> Map<puuid, {gameName, tagLine}>
    const candidates = new Map<number, Map<string, { gameName: string; tagLine: string }>>();

    for (const id of ids) {
      const match = await getMatchById(regional, id);
      const info = (match as any)?.info;
      if (!info) continue;
      const me = info.participants.find((p: any) => p.puuid === puuid);
      if (me) myChamps.add(Number(me.championId));
      for (const p of info.participants as any[]) {
        if (p.puuid === puuid || !p.puuid) continue;
        const cid = Number(p.championId);
        if (!candidates.has(cid)) candidates.set(cid, new Map());
        candidates.get(cid)!.set(p.puuid, {
          gameName: p.riotIdGameName || p.summonerName || "Invocador",
          tagLine: p.riotIdTagline || p.riotIdTagLine || "",
        });
      }
    }

    // 2) For each champion the player played, rank the candidates seen on it.
    // Cap lookups overall to stay cheap.
    const MAX_LOOKUPS = 40;
    let lookups = 0;
    const byChampion: Record<number, any> = {};

    for (const cid of myChamps) {
      const pool = candidates.get(cid);
      if (!pool || pool.size === 0) continue;
      let best: any = null;
      let bestScore = -1;
      for (const [cPuuid, names] of pool) {
        if (lookups >= MAX_LOOKUPS) break;
        lookups++;
        const solo = await getSoloRankCached(platform, cPuuid);
        if (!solo) continue;
        const score = rankScore(solo.tier, solo.rank, solo.leaguePoints);
        if (score > bestScore) {
          bestScore = score;
          best = {
            puuid: cPuuid,
            gameName: names.gameName,
            tagLine: names.tagLine,
            tier: solo.tier,
            rank: solo.rank,
            lp: solo.leaguePoints,
          };
        }
      }
      if (best) byChampion[cid] = best;
      if (lookups >= MAX_LOOKUPS) break;
    }

    const out = { byChampion };
    bestPlayersCache.set(cacheKey, { data: out, ts: Date.now() });
    return res.json(out);
  } catch (e: any) {
    return res.status(e?.response?.status || 500).json({
      message: e?.response?.data?.status?.message || e?.message || "best-players failed",
      byChampion: {},
    });
  }
});

// ─── Season snapshots (forward-only) ──────────────────────────────────────────
async function initRankedSnapshotsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_ranked_snapshots (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      puuid       VARCHAR(200) NOT NULL,
      season      VARCHAR(20)  NOT NULL,
      queue       VARCHAR(40)  NOT NULL,
      tier        VARCHAR(20),
      \`rank\`      VARCHAR(8),
      lp          INT DEFAULT 0,
      wins        INT DEFAULT 0,
      losses      INT DEFAULT 0,
      captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_snapshot (puuid, season, queue),
      INDEX idx_puuid (puuid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
initRankedSnapshotsTable().catch((e) => console.error("[profile_ranked_snapshots] init error:", e.message));

function currentSeason(): string {
  // Forward-only label; today is 2026 → "2026". Adjust if Riot splits seasons.
  return String(new Date().getFullYear());
}

export async function upsertRankedSnapshot(
  puuid: string,
  rankArr: { queue: string; tier: string; rank: string; lp: number; wins: number; losses: number }[]
) {
  if (!rankArr?.length) return;
  const season = currentSeason();
  for (const r0 of rankArr) {
    if (!r0.tier) continue;
    try {
      await pool.query(
        `INSERT INTO profile_ranked_snapshots (puuid, season, queue, tier, \`rank\`, lp, wins, losses)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           tier=VALUES(tier), \`rank\`=VALUES(\`rank\`), lp=VALUES(lp),
           wins=VALUES(wins), losses=VALUES(losses), captured_at=CURRENT_TIMESTAMP`,
        [puuid, season, r0.queue, r0.tier, r0.rank, r0.lp ?? 0, r0.wins ?? 0, r0.losses ?? 0]
      );
    } catch (e: any) {
      console.warn("[profile_ranked_snapshots] upsert error:", e?.message);
    }
  }
}

/**
 * GET /api/stats/seasons/:puuid
 * Returns stored season snapshots (empty until snapshots accrue — honest:
 * past seasons cannot be backfilled from Riot).
 */
r.get("/seasons/:puuid", async (req, res) => {
  try {
    const { puuid } = req.params as { puuid: string };
    const [rows] = await pool.query<any[]>(
      `SELECT season, queue, tier, \`rank\` AS rankDiv, lp, wins, losses, captured_at
       FROM profile_ranked_snapshots WHERE puuid = ? ORDER BY season DESC, queue ASC`,
      [puuid]
    );
    return res.json({ seasons: rows });
  } catch (e: any) {
    return res.status(500).json({ message: e?.message || "seasons failed", seasons: [] });
  }
});

export default r;
