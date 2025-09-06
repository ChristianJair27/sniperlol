import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { splitRiotId, Platform, PROBE_AMERICAS, PROBE_DEFAULT } from "../utils/regions.js";
import {
  getAccountByRiotId,
  getSummonerByPUUID,
  getChampionMasteries,
  getMatchIdsByPUUID,
  getMatchById,
  getSummonerByName,
} from "../services/riot.js";

const r = Router();

const qSchema = z.object({
  riotId: z.string().min(3),
  count: z.coerce.number().min(1).max(20).optional().default(10),
  prefer: z.enum(["la1","la2","na1","br1","oc1","euw1","eun1","tr1","ru","jp1","kr"]).optional(),
});

async function resolveSummoner(puuid: string, prefer?: Platform) {
  // antes usábamos solo AMERICAS; aquí probamos TODOS por defecto
  const probe: Platform[] = [...PROBE_DEFAULT];
  if (prefer && !probe.includes(prefer)) probe.unshift(prefer);

  for (const pf of probe) {
    const s: any = await getSummonerByPUUID(pf, puuid);
    if (s?.id) return { platform: pf, summoner: s };
  }
  return null;
}

r.get("/overview", async (req, res, next) => {
  try {
    const { riotId, count, prefer } = qSchema.parse(req.query);
    const [gn, tl] = splitRiotId(riotId);
    if (!gn || !tl) return res.status(400).json({ ok:false, msg:"Usa 'Nombre#Tag'." });

    // 1) account -> puuid
    const account = await getAccountByRiotId(gn, tl);
    const puuid = (account?.puuid || "").trim();
    if (!puuid) return res.status(502).json({ ok:false, msg:"Account sin PUUID." });

    // 2) intenta resolver summoner
    let resolved = await resolveSummoner(puuid, prefer as Platform | undefined);
    if (!resolved && prefer) {
      // Fallback por nombre SOLO en prefer
      const s2: any = await getSummonerByName(prefer, account.gameName);
      if (s2?.id) resolved = { platform: prefer as Platform, summoner: s2 };
    }
    if (!resolved) {
      return res.status(404).json({
        ok:false,
        msg:"No se encontró Summoner en los shards probados (aún no ha creado perfil de LoL o está en otro shard).",
        account,
      });
    }

    const { platform, summoner } = resolved;

    // 3) Champion mastery (top 5)
    const mastery = await getChampionMasteries(platform, summoner.id);
    const masteryTop = mastery
      .sort((a, b) => b.championPoints - a.championPoints)
      .slice(0, 5);

    // 4) Últimas N partidas
    const matchIds = await getMatchIdsByPUUID(platform, puuid, count, 0);
    const matchesRaw = await Promise.all(matchIds.map(id => getMatchById(platform, id)));
    const matches = matchesRaw.filter(Boolean) as any[];

    // 5) Resumen de stats
    let wins = 0, kills = 0, deaths = 0, assists = 0, cs = 0, durMin = 0;
    const laneCount: Record<string, number> = {};
    const champPerf: Record<string, { games: number; wins: number }> = {};
    const oppPerf: Record<string, { games: number; wins: number }> = {};

    for (const m of matches) {
      const info = m.info;
      const me = info.participants.find((p: any) => p.puuid === puuid);
      if (!me) continue;

      wins += me.win ? 1 : 0;
      kills += me.kills;
      deaths += me.deaths;
      assists += me.assists;
      cs += (me.totalMinionsKilled ?? 0) + (me.neutralMinionsKilled ?? 0);
      durMin += (info.gameDuration ?? 0) / 60;
      const lane = (me.teamPosition || me.lane || "UNKNOWN").toUpperCase();
      laneCount[lane] = (laneCount[lane] || 0) + 1;

      const cKey = String(me.championId);
      champPerf[cKey] = champPerf[cKey] || { games: 0, wins: 0 };
      champPerf[cKey].games += 1;
      champPerf[cKey].wins += me.win ? 1 : 0;

      // oponente de línea aprox: mismo rol en el team contrario
      const opp = info.participants.find(
        (p: any) => p.teamId !== me.teamId && (p.teamPosition || p.lane) === (me.teamPosition || me.lane)
      ) || info.participants.find((p: any) => p.teamId !== me.teamId);
      if (opp) {
        const oKey = String(opp.championId);
        oppPerf[oKey] = oppPerf[oKey] || { games: 0, wins: 0 };
        oppPerf[oKey].games += 1;
        oppPerf[oKey].wins += me.win ? 1 : 0; // win es “vs ese campeón”
      }
    }

    const games = matches.length || 1;
    const kda = deaths ? (kills + assists) / deaths : kills + assists;
    const csPerMin = cs / (durMin || 1);
    const winrate = (wins / games) * 100;

    const recentChamps = Object.entries(champPerf)
      .map(([championId, v]) => ({ championId: Number(championId), games: v.games, winrate: (v.wins / v.games) * 100 }))
      .sort((a, b) => b.games - a.games)
      .slice(0, 8);

    const vsOpponents = Object.entries(oppPerf)
      .map(([championId, v]) => ({ championId: Number(championId), games: v.games, myWinrate: (v.wins / v.games) * 100 }))
      .sort((a, b) => b.games - a.games)
      .slice(0, 8);

    res.json({
      ok: true,
      account,
      platform,
      summoner: {
        id: summoner.id,
        name: summoner.name,
        level: summoner.summonerLevel,
      },
      masteryTop,             // top 5 de maestría
      matches: { ids: matchIds },
      summary: {
        games,
        wins,
        winrate: Number(winrate.toFixed(1)),
        kda: Number(kda.toFixed(2)),
        csPerMin: Number(csPerMin.toFixed(2)),
        lanes: laneCount,
        recentChamps,
        vsOpponents,
      },
    });
  } catch (e) { next(e); }
});

export default r;
