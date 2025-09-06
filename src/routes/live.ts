import { Router } from "express";
import { getLiveGame } from "../services/riot.js";
const r = Router();

r.get("/:summonerId", async (req, res, next) => {
  try {
    const platform = (req.query.platform as "la2"|"las") || "lan";
    const data = await getLiveGame(platform, req.params.summonerId);
    res.json({ ok:true, data });
  } catch (e) { next(e); }
});

export default r;
