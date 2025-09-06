// src/routes/players.ts
import { Router } from "express";
import { pool } from "../db.js";
import { splitRiotId, Platform } from "../utils/regions.js";
import { z } from "zod";
import {
  getAccountByRiotId,
  getSummonerByPUUID,
  getSummonerByName,
} from "../services/riot.js";

const r = Router();

/* ---------- 1) Registro: Account-V1 ---------- */
const registerSchema = z.object({
  riotId: z.string().min(3, "Usa formato 'Nombre#Tag'"),
});

r.post("/", async (req, res, next) => {
  try {
    const { riotId } = registerSchema.parse(req.body);
   const [gn, tl] = splitRiotId(riotId);
if (!gn || !tl) {
  return res.status(400).json({ ok:false, msg:"Usa formato 'Nombre#Tag'." });
}
const account = await getAccountByRiotId(gn, tl);
    if (!account?.puuid) return res.status(502).json({ ok:false, msg:"Account sin PUUID." });

    await pool.execute(
  `INSERT INTO players (game_name, tag_line, puuid, last_refresh)
   VALUES (:gn,:tl,:puuid,NOW())
   ON DUPLICATE KEY UPDATE puuid=VALUES(puuid), last_refresh=NOW()`,
  { gn, tl, puuid: account.puuid }
);

    res.json({ ok:true, mode:"account-only", account });
  } catch (e) { next(e); }
});

/* ---------- 2) Resolver Summoner (LoL) ---------- */
const resolveSchema = z.object({
  riotId: z.string().min(3),
  // opcionales para ayudar a resolver:
  prefer: z.enum(["la1","la2","na1","br1","oc1","euw1","eun1","tr1","ru","jp1","kr"]).optional(),
  summonerName: z.string().optional(), // si el nombre de LoL no coincide con gameName
});

r.post("/resolve-lol", async (req, res, next) => {
  try {
    const { riotId, prefer, summonerName } = resolveSchema.parse(req.body);
    const [gn, tl] = splitRiotId(riotId);
    const account = await getAccountByRiotId(gn, tl); // americas
    const puuid = (account?.puuid || "").trim();
    if (!puuid) return res.status(502).json({ ok:false, msg:"Account sin PUUID." });

    // orden de prueba: AMERICAS primero, luego EU/ASIA comunes
    const probe: Platform[] = Array.from(new Set<Platform>([
      "la1","la2","na1","br1","oc1","euw1","eun1","tr1","ru","jp1","kr",
    ]));

    let hit: { pf: Platform, s: any, via: "puuid" | "name" } | null = null;

    // 1) por PUUID
    for (const pf of probe) {
      const s: any = await getSummonerByPUUID(pf, puuid);
      if (s?.id) { hit = { pf, s, via: "puuid" }; break; }
    }

    // 2) fallback por nombre SOLO en el preferido (si lo pasas)
    if (!hit && prefer) {
      const nameToTry = (summonerName ?? account.gameName).trim();
      const s2: any = await getSummonerByName(prefer, nameToTry);
      if (s2?.id) hit = { pf: prefer, s: s2, via: "name" };
    }

    if (!hit) {
      return res.status(404).json({
        ok:false,
        msg:"Riot Account válida pero no se encontró Summoner en los shards probados. Indica un shard preferido o abre LoL al menos una vez.",
        account,
        probesTried: probe,
      });
    }

    // guardar shard + summoner_id
    await pool.execute(
  `UPDATE players
   SET platform=:pf, summoner_id=:sid, last_refresh=NOW()
   WHERE game_name=:gn AND tag_line=:tl`,
  { gn, tl, pf: hit.pf, sid: hit.s.id }
);  

    res.json({ ok:true, matched: hit.pf, foundVia: hit.via, summoner: hit.s, account });
  } catch (e) { next(e); }
});

export default r;
