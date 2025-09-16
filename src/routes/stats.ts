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

  // B) league-v4 (rank)
  let rank: { queue: string; tier: string; rank: string; lp: number; wins: number; losses: number }[] = [];
  if (summoner.id && pfUsed) {
    try {
      const le = await getLeagueEntriesBySummonerId(pfUsed, summoner.id);
      rank = (le || []).map((q) => ({
        queue: q.queueType, // "RANKED_SOLO_5x5" | "RANKED_FLEX_SR"
        tier: q.tier,
        rank: q.rank,
        lp: q.leaguePoints,
        wins: (q as any).wins ?? 0,
        losses: (q as any).losses ?? 0,
      }));
    } catch (e: any) {
      if (e?.response?.status === 403) warnings.push("League-v4 devolvió 403. Ocultando rank.");
      else warnings.push("No se pudo traer league-v4.");
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
    const url = `https://${platform}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`;

    let g: any;
    try {
      const r0 = await riotGet(url, { headers });
      g = r0.data;
    } catch (e: any) {
      const st = e?.response?.status;
      if (st === 404 || st === 403) return res.sendStatus(204); // sin partida
      return res.status(st || 500).json(e?.response?.data || { error: "spectator failed" });
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
        // necesitamos el summonerId desde puuid
        const sum = await riotGet<{ id: string }>(
          `https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(pp.puuid || "")}`,
          axiosOpts
        );
        if (!sum?.data?.id) return;

        const le = await riotGet<any[]>(
          `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-summoner/${sum.data.id}`,
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

return res.json({
  gameMode: g.gameMode,
  gameStartTime: g.gameStartTime,
  queueId: g.gameQueueConfigId,
  participants,
});


    // (Opcional) – Rango por jugador (league-v4 requires summonerId)
    let ranksBySumm: Record<string, { tier: string; rank: string; lp: number } | null> = {};
    if (wantRank) {
      // limita concurrencia para evitar 429
      const queue: (() => Promise<void>)[] = [];
      for (const p of participants) {
        if (!p.summonerId) continue;
        queue.push(async () => {
          try {
            const { data: entries } = await riotGet(
              `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-summoner/${p.summonerId}`,
              { headers }
            );
            const solo = (entries as any[]).find(e => e.queueType === "RANKED_SOLO_5x5");
            ranksBySumm[p.summonerId] = solo
              ? { tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints }
              : null;
          } catch {
            ranksBySumm[p.summonerId] = null;
          }
        });
      }
      // Ejecuta de a 3 en paralelo
      const runLimited = async (concurrency = 3) => {
        const running: Promise<void>[] = [];
        for (const job of queue) {
          const p = job();
          running.push(p);
          if (running.length >= concurrency) await Promise.race(running).catch(() => {});
          // limpia los resueltos
          for (let i = running.length - 1; i >= 0; i--) {
            if ((running[i] as any).settled) running.splice(i, 1);
          }
        }
        await Promise.allSettled(running);
      };
      await runLimited(3);
    }

    return res.json({
      gameMode: g.gameMode,
      gameStartTime: g.gameStartTime,
      queueId: g.gameQueueConfigId,
      participants: participants.map((p: any) => ({
        ...p,
        rank: wantRank && p.summonerId ? ranksBySumm[p.summonerId] ?? null : undefined,
      })),
    });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "server error" });
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

export default r;
