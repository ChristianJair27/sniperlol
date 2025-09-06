import { Router } from "express";
import { z } from "zod";
import { splitRiotId, normalizePlatform } from "../utils/regions.js";
import { getAccountByRiotId, getChampionMasteriesByPUUID } from "../services/riot.js";

const r = Router();

const qSchema = z.object({
  // puedes pasar riotId=Nombre#Tag o puuid directamente
  riotId: z.string().optional(),
  puuid: z.string().optional(),
  platform: z.string().default("la1"),              // la1 por defecto
  top: z.coerce.number().min(1).max(50).default(20) // cuántos mostrar
});

r.get("/mastery", async (req, res, next) => {
  try {
    const { riotId, puuid: puuidRaw, platform, top } = qSchema.parse(req.query);
    const pf = normalizePlatform(platform) || "la1";

    // 1) resolver PUUID
    let puuid = (puuidRaw || "").trim();
    if (!puuid) {
      if (!riotId) return res.status(400).json({ ok:false, msg:"Envía riotId o puuid" });
      const [gn, tl] = splitRiotId(riotId);
      if (!gn || !tl) return res.status(400).json({ ok:false, msg:"Usa 'Nombre#Tag'." });
      const account = await getAccountByRiotId(gn, tl, { platformHint: pf });
      puuid = account.puuid;
    }

    // 2) pedir maestrías
    const all = await getChampionMasteriesByPUUID(pf, puuid);
    const items = [...all].sort((a, b) => b.championPoints - a.championPoints).slice(0, top);

    res.json({ ok:true, platform: pf, puuid, count: all.length, top, items });
  } catch (e) { next(e); }
});

export default r;
