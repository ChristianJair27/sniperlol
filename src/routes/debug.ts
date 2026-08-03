// src/routes/debug.ts
import { Router } from "express";
import { z } from "zod";
import { splitRiotId } from "../utils/regions.js";
import {
  getAccountByRiotId,
  getSummonerByPUUID,
  getSummonerByName,
} from "../services/riot.js";
import { requireAuth } from "../middlewares/requireAuth.js";

const r = Router();

// ── Sprint 0: auditoría de config de PROD sin acceso al panel de Coolify ─────
// Solo flags booleanos / valores no sensibles. NUNCA secretos. Admin-only.
r.get("/config", requireAuth, (req: any, res) => {
  if (req.auth?.role !== "admin") return res.status(403).json({ error: "Solo admin" });
  const has = (k: string) => Boolean(process.env[k] && String(process.env[k]).trim());
  res.json({
    node_env: process.env.NODE_ENV || null,
    riot: {
      stub_mode: process.env.RIOT_STUB_MODE === "true",
      region: process.env.RIOT_REGION || null,
      default_platform: process.env.DEFAULT_PLATFORM || null,
      api_key_set: has("RIOT_API_KEY"),
      api_key_suffix: process.env.RIOT_API_KEY ? process.env.RIOT_API_KEY.slice(-4) : null,
      callback_url_set: has("TOURNAMENT_CALLBACK_URL"),
      callback_secret_set: has("TOURNAMENT_CALLBACK_SECRET"),
      max_tournaments_per_month: Number(process.env.RIOT_MAX_TOURNAMENTS_PER_MONTH || 5),
      max_codes_per_tournament: Number(process.env.RIOT_MAX_CODES_PER_TOURNAMENT || 300),
    },
    integrations: {
      lqc_webhook_secret_set: has("LQC_WEBHOOK_SECRET"),
      lqc_tournament_id: process.env.LQC_TOURNAMENT_ID || null,
    },
    auth: {
      rso_configured: has("RSO_CLIENT_ID") && has("RSO_CLIENT_SECRET") && has("RSO_REDIRECT_URI"),
      google_configured: has("GOOGLE_CLIENT_ID") && has("GOOGLE_CLIENT_SECRET"),
      jwt_secret_set: has("JWT_SECRET"),
    },
    mail: { smtp_configured: has("SMTP_HOST") && has("SMTP_USER") },
    db: { mysql_host_set: has("MYSQL_HOST") },
  });
});

/**
 * Ejemplos:
 *   /api/debug/riot?riotId=Kister#NGC
 *   /api/debug/riot?riotId=Kister#NGC&probe=la1,la2,na1,br1,oc1
 *   /api/debug/riot?riotId=Kister#NGC&name=Kister&hint=la1
 *   /api/debug/riot?riotId=Foo#BAR&regional=europe&probe=euw1,eun1
 */
const qSchema = z.object({
  riotId: z.string().min(3),
  probe: z.string().optional(),                 // "la1,la2,na1,br1,oc1"
  name: z.string().optional(),                  // override de summoner name
  hint: z.string().optional(),                  // platform hint (p.ej. "la1") para Account-V1
  regional: z.enum(["americas", "europe", "asia"]).optional(), // fuerza región de Account-V1
});

r.get("/riot", async (req, res, next) => {
  try {
    const { riotId, probe, name, hint, regional } = qSchema.parse(req.query);

    // 1) Parse Riot ID
    const [gn, tl] = splitRiotId(riotId);
    if (!gn || !tl) {
      return res.status(400).json({ ok: false, msg: "Usa formato 'Nombre#Tag'." });
    }

    // 2) Cuenta (Account-V1, host regional según hint/regional)
    const account = await getAccountByRiotId(gn, tl, {
      platformHint: hint,
      regionalHint: regional as any,
    });
    const puuid = (account?.puuid || "").trim();

    // 3) Shards a probar (por defecto: AMERICAS + EU + ASIA comunes)
    const defaultProbe = ["la1","la2","na1","br1","oc1","euw1","eun1","tr1","ru","jp1","kr"];
    const probeList = Array.from(
      new Set( (probe ? probe.split(",").map(s => s.trim().toLowerCase()) : defaultProbe) )
    );

    const tryName = (name ?? account?.gameName ?? gn).trim();

    const checks: any[] = [];
    let found: { platform: string; via: "puuid"|"name"; summoner: any } | null = null;

    // 4) Probing: primero por PUUID, luego por NAME (diagnóstico)
    for (const pf of probeList) {
      // by-puuid
      try {
        const s = await getSummonerByPUUID(pf, puuid);
        if (s?.id) {
          checks.push({ platform: pf, via: "puuid", status: 200, id: s.id, name: s.name, level: s.summonerLevel });
          found = { platform: pf, via: "puuid", summoner: s };
          break;
        } else {
          checks.push({ platform: pf, via: "puuid", status: 404 });
        }
      } catch (e: any) {
        checks.push({ platform: pf, via: "puuid", status: e?.response?.status ?? 500, error: e?.message });
      }

      // by-name (solo si aún no hay hit)
      try {
        const s2 = await getSummonerByName(pf, tryName);
        if (s2?.id) {
          checks.push({ platform: pf, via: "name", status: 200, id: s2.id, name: s2.name, level: s2.summonerLevel });
          found = { platform: pf, via: "name", summoner: s2 };
          break;
        } else {
          checks.push({ platform: pf, via: "name", status: 404 });
        }
      } catch (e: any) {
        checks.push({ platform: pf, via: "name", status: e?.response?.status ?? 500, error: e?.message });
      }
    }

    // 5) Respuesta
    res.json({
      ok: true,
      inputs: { riotId, probe: probeList, nameOverride: name ?? null, hint: hint ?? null, regional: regional ?? null },
      account,
      puuid,
      puuid_len: puuid.length,
      name_tested: tryName,
      probes: checks,
      matched: found ? { platform: found.platform, via: found.via } : null,
      summoner: found?.summoner ?? null,
    });
  } catch (e) {
    next(e);
  }
});

export default r;
