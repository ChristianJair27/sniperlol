import { Router } from "express";
import { requireAuth } from "../middlewares/requireAuth.js";
import { pool } from "../db.js";
import axios from "axios";
import { platformToRegional } from "../utils/regions.js";

const r = Router();

/** POST /api/players/link */
r.post("/link", requireAuth, async (req, res, next) => {
  try {
    let { riotId, platform, gameName, tagLine } = req.body || {};
    if (riotId && (!gameName || !tagLine)) {
      const parts = String(riotId).trim().split("#");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return res.status(400).json({ ok: false, msg: "Formato Riot ID inválido. Usa GameName#TAG" });
      }
      gameName = parts[0].trim();
      tagLine = parts[1].trim();
    }
    if (!platform || !gameName || !tagLine) {
      return res.status(400).json({ ok: false, msg: "platform, gameName y tagLine son requeridos" });
    }

    const apiBase = process.env.SELF_API_URL || `http://localhost:${process.env.PORT || 4000}`;

    // tu /api/stats/resolve requiere gameName y tagLine
    const resp = await axios.get(`${apiBase}/api/stats/resolve`, {
      params: { region: platform, gameName, tagLine },
    });

    const data = resp.data || {};
    if (!data?.puuid) return res.status(404).json({ ok: false, msg: "No se pudo resolver el Riot ID" });

    const { puuid, profileIconId } = data;
    const userId = (req as any).auth.userId;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows]: any = await conn.query(
        "SELECT id FROM user_riot_accounts WHERE user_id=? LIMIT 1",
        [userId]
      );

      if (rows.length) {
        await conn.query(
          `UPDATE user_riot_accounts
             SET platform=?, puuid=?, game_name=?, tag_line=?, profile_icon=?, updated_at=NOW()
           WHERE user_id=?`,
          [platform, puuid, gameName, tagLine, profileIconId || null, userId]
        );
      } else {
        await conn.query(
          `INSERT INTO user_riot_accounts (user_id, platform, puuid, game_name, tag_line, profile_icon)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, platform, puuid, gameName, tagLine, profileIconId || null]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback(); throw e;
    } finally {
      conn.release();
    }

    res.json({ ok: true, puuid, platform, gameName, tagLine, profileIconId });
  } catch (e: any) {
    const msg = e?.response?.data?.msg || e?.response?.data?.message || e.message || "Error interno";
    res.status(e?.response?.status || 500).json({ ok: false, msg });
  }
});

/** GET /api/players/me/overview */
r.get("/me/overview", requireAuth, async (req, res, next) => {
  try {
    const userId = (req as any).auth.userId;

    const [rows]: any = await pool.query(
      `SELECT platform, puuid, game_name, tag_line, profile_icon
       FROM user_riot_accounts WHERE user_id=? LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.json({ ok: true, linked: false });

    const { platform, puuid, game_name, tag_line, profile_icon } = rows[0];
    const apiBase = process.env.SELF_API_URL || `http://localhost:${process.env.PORT || 4000}`;
    const regional = platformToRegional(platform);

    // 1) Pide summary y recent (champions agregados)
    const [summaryRes, recentRes] = await Promise.all([
      axios.get(`${apiBase}/api/stats/summary/${platform}/${puuid}`),
      axios.get(`${apiBase}/api/stats/recent/${platform}/${puuid}`),
    ]);

    const summary = summaryRes.data || {};
    const championsAgg: Array<{ championName: string; games: number; wins: number }> =
      Array.isArray(recentRes.data?.champions) ? recentRes.data.champions : [];

    // 2) KPIs desde champions agregados
    const totalMatches = championsAgg.reduce((acc, c) => acc + (c.games || 0), 0);
    const wins = championsAgg.reduce((acc, c) => acc + (c.wins || 0), 0);
    const winRate = totalMatches ? Math.round((wins / totalMatches) * 100) : 0;

    // 3) Rank desde el arreglo de summary.rank
    //    Busca SoloQ ("RANKED_SOLO_5x5"); si no, toma el primero.
  const rankArr: Array<{ queue: string; tier?: string; rank?: string; lp?: number }> =
  Array.isArray(summary?.rank) ? summary.rank : [];

// intenta SoloQ primero
const solo = rankArr.find(r => /solo/i.test(r.queue)) || rankArr.find(r => /ranked/i.test(r.queue)) || rankArr[0] || null;

let currentRank: string | null = null;
let lp: number | null = null;

if (solo && (solo.tier || solo.rank)) {
  const tier = (solo.tier ?? "").toString();   // GOLD / PLATINUM ...
  const div  = (solo.rank ?? "").toString();   // I / II / III ...
  const text = `${tier} ${div}`.trim();
  currentRank = text.length ? text : null;
  lp = typeof solo.lp === "number" ? solo.lp : null;
}

    // 4) Campeón favorito: el de más games del agregado
    const favoriteChampion =
      championsAgg.length
        ? [...championsAgg].sort((a, b) => (b.games || 0) - (a.games || 0))[0]?.championName || null
        : null;

    // 5) Construir "recientes" (máx 5) usando tus endpoints /matches
    //    ids → detalles por match con tu extractor
    let recent: Array<{ win: boolean | null; queueName: string | null; championName: string | null; duration: number | null }> = [];
    try {
      const idsRes = await axios.get<string[]>(
        `${apiBase}/api/stats/matches/${regional}/${puuid}/ids`,
        { params: { count: 5, start: 0 } }
      );
      const ids: string[] = idsRes.data || [];

      const details = await Promise.allSettled(
        ids.map(id => axios.get(
          `${apiBase}/api/stats/matches/${regional}/${id}`,
          { params: { puuid } }
        ))
      );
      recent = details
        .filter(d => d.status === "fulfilled")
        .map((d: any) => d.value.data)
        .map((m: any) => ({
          win: m?.win ?? null,
          queueName: m?.gameMode ?? null,
          championName: m?.championName ?? null,
          duration: typeof m?.gameDuration === "number" ? Math.floor(m.gameDuration / 1000) : null,
        }));
    } catch {
      // si falla, dejamos recent vacío
      recent = [];
    }

    return res.json({
      ok: true,
      linked: true,
      profile: { gameName: game_name, tagLine: tag_line, profileIcon: profile_icon, platform, puuid },
      stats: {
        totalMatches,
        winRate,
        currentRank,
        lp,
        favoriteChampion,
        tournamentsJoined: 0,
        socialPosts: 0,
      },
      recent,
    });
  } catch (e) {
    next(e);
  }
});
export default r;
