import { Router } from "express";
import { z } from "zod";
import { splitRiotId, platformToRegional, Platform } from "../utils/regions.js";
import { getAccountByRiotId, getMatchIdsByPUUID, getMatchById } from "../services/riot.js";

const r = Router();

/**
 * Ejemplos:
 *  /api/players/recent-champions?riotId=Kister%23NGC&count=20&prefer=la1&queues=420,440
 *  /api/players/recent-champions?puuid=<PUUID>&count=30&prefer=euw1
 */
const q = z.object({
  riotId: z.string().optional(),
  puuid: z.string().optional(),
  // cuántas partidas analizar (ids que pedimos a match-v5)
  count: z.coerce.number().min(1).max(50).optional().default(10),
  // plataforma sugerida para deducir cluster regional (americas/europe/asia)
  prefer: z
    .enum(["la1","la2","na1","br1","oc1","euw1","eun1","tr1","ru","jp1","kr"])
    .optional()
    .default("la1"),
  // filtrar por colas (ej. 420 solo/duo, 440 flex, 450 ARAM) -> CSV
  queues: z.string().optional(), // "420,440"
});

r.get("/recent-champions", async (req, res, next) => {
  try {
    const { riotId, puuid: puuidQ, count, prefer, queues } = q.parse(req.query);
    const preferPf = (prefer as Platform) || "la1";

    // 1) resolver PUUID
    let puuid = (puuidQ || "").trim();
    if (!puuid) {
      if (!riotId) return res.status(400).json({ ok:false, msg:"Envía riotId o puuid." });
      const [gn, tl] = splitRiotId(riotId);
      if (!gn || !tl) return res.status(400).json({ ok:false, msg:"Usa 'Nombre#Tag'." });
      const acc = await getAccountByRiotId(gn, tl, { platformHint: preferPf });
      puuid = acc.puuid;
    }

    // 2) pedir IDs de partidas (cluster regional deducido desde prefer)
    //    Puedes agregar ?queue=... en la llamada a Riot; aquí soportamos CSV.
    let ids: string[] = [];
    const qs = queues?.split(",").map(s => s.trim()).filter(Boolean) ?? [];
    if (qs.length) {
      // si mandan varias colas, pedimos por cada una y unimos (limit total ≈ count)
      const chunk = Math.max(1, Math.floor(count / qs.length));
      for (const qid of qs) {
        const part = await getMatchIdsByPUUID(preferPf, puuid, chunk, 0 /*start*/);
        ids.push(...part);
      }
      ids = Array.from(new Set(ids)).slice(0, count);
    } else {
      ids = await getMatchIdsByPUUID(preferPf, puuid, count, 0);
    }

    if (!ids.length) {
      return res.json({ ok:true, puuid, recent: [], frequent: [], matches: 0 });
    }

    // 3) cargar partidas y agregar por campeón
    const mList = await Promise.all(ids.map(id => getMatchById(preferPf, id)));
    const used: Record<string, {
      championId: number;
      championName: string;
      games: number;
      wins: number;
      // última vez jugado (ms) para ordenar por recencia
      lastPlayed: number;
    }> = {};

    for (const m of mList) {
      if (!m) continue;
      const info = m.info;
      const me = info.participants.find((p: any) => p.puuid === puuid);
      if (!me) continue;
      const champId = Number(me.championId);
      const key = String(champId);
      const when = info.gameEndTimestamp ?? info.gameCreation ?? 0;

      if (!used[key]) {
        used[key] = {
          championId: champId,
          championName: me.championName || `#${champId}`,
          games: 0,
          wins: 0,
          lastPlayed: 0,
        };
      }
      used[key].games += 1;
      used[key].wins += me.win ? 1 : 0;
      used[key].lastPlayed = Math.max(used[key].lastPlayed, when);
    }

    const arr = Object.values(used);
    const recent = [...arr].sort((a,b) => b.lastPlayed - a.lastPlayed);       // por recencia
    const frequent = [...arr].sort((a,b) => b.games - a.games);               // por frecuencia

    res.json({
      ok: true,
      puuid,
      regionCluster: platformToRegional(preferPf),
      matches: mList.filter(Boolean).length,
      recent: recent.map(x => ({
        championId: x.championId,
        championName: x.championName,
        lastPlayed: x.lastPlayed,
        games: x.games,
        winrate: Number((x.wins / x.games * 100).toFixed(1)),
      })),
      frequent: frequent.map(x => ({
        championId: x.championId,
        championName: x.championName,
        games: x.games,
        winrate: Number((x.wins / x.games * 100).toFixed(1)),
        lastPlayed: x.lastPlayed,
      })),
    });
  } catch (e) { next(e); }
});

export default r;
