// src/routes/auth.ts
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../db.js"; // <-- tu pool MySQL
import { getSummonerByPUUID, getAccountByPUUID } from "../services/riot.js";

const r = Router();

type DbUser = {
  id: number;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: 'user' | 'admin';
  provider: 'local' | 'google' | 'riot';
  provider_id: string | null;
  password_hash: string | null;
};

const WEB_ORIGIN = process.env.WEB_ORIGIN || process.env.CLIENT_URL || "http://localhost:8080";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

// Helpers
function signToken(u: { id: number; email: string; role: string }) {
  return jwt.sign({ sub: String(u.id), email: u.email, role: u.role }, JWT_SECRET, { expiresIn: "7d" });
}
function b64urlEncode(obj: any) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function getGoogleClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!
  );
}

// ===== GOOGLE OAUTH =====
r.get("/google", (_req, res) => {
  const client = getGoogleClient();
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["openid", "email", "profile"],
  });
  res.redirect(url);
});

r.get("/google/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    if (!code) return res.status(400).send("Missing code");

    const client = getGoogleClient();
    const { tokens } = await client.getToken(code);
    const idToken = tokens.id_token;
    if (!idToken) return res.status(400).send("Missing id_token");

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) return res.status(400).send("Invalid token payload");

    const email = payload.email.toLowerCase();
    const name = payload.name || "";
    const avatar = payload.picture || null;
    const provider_id = payload.sub;

    const conn = await pool.getConnection();
    let user: DbUser | undefined;

    try {
      await conn.beginTransaction();

      // ¿Existe?
      const [rows] = await conn.query<any[]>(
        "SELECT * FROM users WHERE email = ? LIMIT 1",
        [email]
      );

      if (rows.length === 0) {
        // Insert
        const [result]: any = await conn.query(
          `INSERT INTO users (email, name, avatar_url, role, provider, provider_id, password_hash)
           VALUES (?, ?, ?, 'user', 'google', ?, NULL)`,
          [email, name, avatar, provider_id]
        );
        const insertedId = result.insertId;
        const [rows2] = await conn.query<any[]>("SELECT * FROM users WHERE id = ? LIMIT 1", [insertedId]);
        user = rows2[0] as DbUser;
      } else {
        // Update ligero
        const u = rows[0] as DbUser;
        await conn.query(
          `UPDATE users
             SET provider='google',
                 provider_id = COALESCE(?, provider_id),
                 name = IFNULL(name, ?),
                 avatar_url = COALESCE(?, avatar_url)
           WHERE id = ?`,
          [provider_id, name || u.name, avatar, u.id]
        );
        const [rows2] = await conn.query<any[]>("SELECT * FROM users WHERE id = ? LIMIT 1", [u.id]);
        user = rows2[0] as DbUser;
      }

      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    // Emitir tu JWT y redirigir con payload para el front
    const token = signToken({ id: user!.id, email: user!.email, role: user!.role });
    const safeUser = {
      id: user!.id,
      email: user!.email,
      name: user!.name,
      avatar_url: user!.avatar_url,
      role: user!.role,
    };
    const payloadForClient = b64urlEncode({ token, user: safeUser });

    res.redirect(`${WEB_ORIGIN}/dashboard?payload=${payloadForClient}`);
  } catch (e) {
    console.error("[AUTH] google callback error", e);
    res.redirect(`${WEB_ORIGIN}/login?error=google`);
  }
});

// ===== RIOT SIGN-ON (RSO) =====
// OAuth2 Authorization Code flow against Riot's auth server.
// Requires RSO_CLIENT_ID, RSO_CLIENT_SECRET and RSO_REDIRECT_URI in .env, where
// RSO_REDIRECT_URI must EXACTLY match the URI registered with your RSO product.
const RSO_AUTH_BASE = process.env.RSO_AUTH_BASE || "https://auth.riotgames.com";
const RSO_ACCOUNT_BASE = `https://${process.env.RSO_ACCOUNT_REGION || "americas"}.api.riotgames.com`;

function rsoConfigured() {
  return !!(process.env.RSO_CLIENT_ID && process.env.RSO_CLIENT_SECRET && process.env.RSO_REDIRECT_URI);
}

// RSO da puuid/gameName/tagLine pero NO la plataforma (la1, na1, …). La detectamos
// probando summoner-v4 by-puuid en las plataformas de la región RSO; la primera que
// devuelve summoner (no-404) es la del jugador. Devolvemos también el profileIcon.
const REGION_PLATFORMS: Record<string, string[]> = {
  americas: ["la1", "la2", "na1", "br1", "oc1"],
  europe:   ["euw1", "eun1", "tr1", "ru"],
  asia:     ["jp1", "kr", "ph2", "sg2", "th2", "tw2", "vn2"],
};
async function detectRiotPlatform(puuid: string): Promise<{ platform: string; profileIconId: number | null }> {
  const region = (process.env.RSO_ACCOUNT_REGION || "americas").toLowerCase();
  const platforms = REGION_PLATFORMS[region] || REGION_PLATFORMS.americas;
  for (const p of platforms) {
    try {
      const s: any = await getSummonerByPUUID(p, puuid);
      if (s) return { platform: p, profileIconId: s.profileIconId ?? null };
    } catch { /* probar siguiente plataforma */ }
  }
  return { platform: platforms[0], profileIconId: null }; // fallback razonable
}

// Step 1 — send the user to Riot to authorize
r.get("/riot", (_req, res) => {
  if (!rsoConfigured()) {
    return res.status(503).send("RSO no configurado: falta RSO_CLIENT_ID / RSO_CLIENT_SECRET / RSO_REDIRECT_URI en .env");
  }
  const state = crypto.randomBytes(16).toString("hex");
  // El callback vuelve desde auth.riotgames.com (cross-site) hacia atakback. Con
  // SameSite=Lax el navegador NO reenvía la cookie en ese redirect cross-site entre
  // subdominios, así que el `state` llegaba vacío y fallaba siempre (rso_state).
  // None+Secure la envía en todo contexto (requiere HTTPS, que prod tiene). En local
  // (http) usamos Lax porque None sin Secure es rechazada por el navegador.
  const isProd = process.env.NODE_ENV === "production";
  res.cookie("rso_state", state, {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    maxAge: 10 * 60 * 1000,
  });
  const params = new URLSearchParams({
    redirect_uri: process.env.RSO_REDIRECT_URI!,
    client_id: process.env.RSO_CLIENT_ID!,
    response_type: "code",
    scope: "openid",
    state,
  });
  res.redirect(`${RSO_AUTH_BASE}/authorize?${params.toString()}`);
});

// Step 2 — Riot redirects back with ?code; exchange it for tokens, resolve the
// player's PUUID + Riot ID, upsert the user, then hand a JWT to the frontend.
r.get("/riot/callback", async (req, res) => {
  try {
    if (!rsoConfigured()) return res.status(503).send("RSO no configurado");

    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const cookieState = (req as any).cookies?.rso_state;
    if (!code) return res.redirect(`${WEB_ORIGIN}/login?error=rso`);
    if (!state || !cookieState || state !== cookieState) {
      return res.redirect(`${WEB_ORIGIN}/login?error=rso_state`);
    }
    res.clearCookie("rso_state");

    // Exchange authorization code for tokens (confidential client → Basic auth)
    const basic = Buffer.from(`${process.env.RSO_CLIENT_ID}:${process.env.RSO_CLIENT_SECRET}`).toString("base64");
    const tokenRes = await fetch(`${RSO_AUTH_BASE}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.RSO_REDIRECT_URI!,
      }).toString(),
    });
    if (!tokenRes.ok) {
      console.error("[RSO] token exchange failed:", tokenRes.status, await tokenRes.text().catch(() => ""));
      return res.redirect(`${WEB_ORIGIN}/login?error=rso_token`);
    }
    const tokenJson: any = await tokenRes.json();
    const accessToken: string = tokenJson.access_token;
    const idToken: string | undefined = tokenJson.id_token;

    // PUUID from the id_token's `sub` claim (token came directly from Riot over TLS)
    let puuid = "";
    if (idToken) {
      try {
        const part = idToken.split(".")[1];
        const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
        puuid = payload.sub || "";
      } catch { /* ignore */ }
    }

    // Riot ID (gameName#tagLine) via Account-V1 /me using the RSO access token
    let gameName = "", tagLine = "";
    try {
      const meRes = await fetch(`${RSO_ACCOUNT_BASE}/riot/account/v1/accounts/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (meRes.ok) {
        const me: any = await meRes.json();
        puuid = me.puuid || puuid;
        gameName = me.gameName || "";
        tagLine = me.tagLine || "";
      }
    } catch { /* fall back to id_token puuid */ }

    // Si /me no devolvió el Riot ID, resolverlo por puuid con la dev key para no
    // guardar la cuenta vinculada sin nombre.
    if (puuid && (!gameName || !tagLine)) {
      try {
        const acc: any = await getAccountByPUUID(puuid);
        if (acc) { gameName = acc.gameName || gameName; tagLine = acc.tagLine || tagLine; }
      } catch { /* seguimos con lo que haya */ }
    }

    if (!puuid) return res.redirect(`${WEB_ORIGIN}/login?error=rso_nopuuid`);

    const riotId = gameName && tagLine ? `${gameName}#${tagLine}` : "";
    const displayName = riotId || `Riot ${puuid.slice(0, 6)}`;
    // RSO doesn't provide an email — synthesize a stable placeholder for the NOT NULL/UNIQUE column.
    const placeholderEmail = `riot_${puuid.slice(0, 24).toLowerCase()}@rso.atak.gg`;

    const conn = await pool.getConnection();
    let user: DbUser | undefined;
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query<any[]>(
        "SELECT * FROM users WHERE provider='riot' AND provider_id=? LIMIT 1",
        [puuid]
      );
      if (rows.length === 0) {
        const [result]: any = await conn.query(
          `INSERT INTO users (email, name, avatar_url, role, provider, provider_id, password_hash)
           VALUES (?, ?, NULL, 'user', 'riot', ?, NULL)`,
          [placeholderEmail, displayName, puuid]
        );
        const [rows2] = await conn.query<any[]>("SELECT * FROM users WHERE id = ? LIMIT 1", [result.insertId]);
        user = rows2[0] as DbUser;
      } else {
        const u = rows[0] as DbUser;
        await conn.query(`UPDATE users SET name = COALESCE(?, name) WHERE id = ?`, [displayName, u.id]);
        const [rows2] = await conn.query<any[]>("SELECT * FROM users WHERE id = ? LIMIT 1", [u.id]);
        user = rows2[0] as DbUser;
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    // ── Auto-vincular la cuenta de LoL ────────────────────────────────────────
    // El login con Riot YA prueba ownership, así que poblamos user_riot_accounts
    // sin pedir vinculación manual (antes el dashboard mandaba a "Vincular cuenta").
    // Si el puuid ya estaba vinculado a OTRO usuario, se lo quitamos: el acceso por
    // Riot es del dueño real de la cuenta (take-ownership).
    if (gameName && tagLine) {
      try {
        const { platform, profileIconId } = await detectRiotPlatform(puuid);
        const conn2 = await pool.getConnection();
        try {
          await conn2.beginTransaction();
          // take-ownership: liberar el puuid de cualquier otro usuario
          await conn2.query(
            "DELETE FROM user_riot_accounts WHERE puuid = ? AND user_id <> ?",
            [puuid, user!.id]
          );
          const [ex]: any = await conn2.query(
            "SELECT id FROM user_riot_accounts WHERE user_id = ? LIMIT 1",
            [user!.id]
          );
          if (ex.length) {
            await conn2.query(
              `UPDATE user_riot_accounts
                 SET platform=?, puuid=?, game_name=?, tag_line=?, profile_icon=?, updated_at=NOW()
               WHERE user_id=?`,
              [platform, puuid, gameName, tagLine, profileIconId, user!.id]
            );
          } else {
            await conn2.query(
              `INSERT INTO user_riot_accounts (user_id, platform, puuid, game_name, tag_line, profile_icon)
               VALUES (?, ?, ?, ?, ?, ?)`,
              [user!.id, platform, puuid, gameName, tagLine, profileIconId]
            );
          }
          await conn2.commit();
        } catch (e) {
          await conn2.rollback(); throw e;
        } finally {
          conn2.release();
        }
      } catch (e) {
        // No bloqueamos el login si el auto-link falla; el usuario podrá vincular manual.
        console.error("[RSO] auto-link failed:", (e as any)?.message);
      }
    }

    const token = signToken({ id: user!.id, email: user!.email, role: user!.role });
    const safeUser = {
      id: user!.id, email: user!.email, name: user!.name,
      avatar_url: user!.avatar_url, role: user!.role,
      riotId, puuid,
    };
    res.redirect(`${WEB_ORIGIN}/dashboard?payload=${b64urlEncode({ token, user: safeUser })}`);
  } catch (e) {
    console.error("[AUTH] rso callback error", e);
    res.redirect(`${WEB_ORIGIN}/login?error=rso`);
  }
});

// ===== LOCAL (si quieres conservarlo) =====
import cryptoNode from "crypto";
function hashPassword(pw: string) {
  const salt = cryptoNode.randomBytes(16).toString("hex");
  const hash = cryptoNode.scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const check = cryptoNode.scryptSync(pw, salt, 64).toString("hex");
  return cryptoNode.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

r.post("/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ ok: false, msg: "email y password requeridos" });
  }

  const norm = String(email).toLowerCase();
  const conn = await pool.getConnection();
  try {
    // 1) Mira si ya existe y con qué proveedor
    const [rows] = await conn.query<any[]>(
      "SELECT id, provider FROM users WHERE email=? LIMIT 1",
      [norm]
    );

    if (rows.length) {
      const prov = rows[0]?.provider;
      if (prov === "google") {
        return res
          .status(409)
          .json({ ok: false, code: "PROVIDER_GOOGLE", msg: "Ese correo ya está vinculado a Google. Inicia sesión con Google." });
      }
      return res
        .status(409)
        .json({ ok: false, code: "EMAIL_TAKEN", msg: "El correo ya está registrado." });
    }

    // 2) Crear usuario local
    const [ins]: any = await conn.query(
      `INSERT INTO users (email, name, password_hash, role, provider)
       VALUES (?, ?, ?, 'user', 'local')`,
      [norm, name || null, hashPassword(password)]
    );

    const [rows2] = await conn.query<any[]>("SELECT * FROM users WHERE id=?", [ins.insertId]);
    const u = rows2[0] as DbUser;

    const token = signToken({ id: u.id, email: u.email, role: u.role });
    return res
      .status(201)
      .json({
        ok: true,
        token,
        user: { id: u.id, email: u.email, name: u.name, avatar_url: u.avatar_url, role: u.role }
      });

  } catch (e: any) {
    // 3) Si hay índice único y se produce carrera: ER_DUP_ENTRY
    if (e?.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ ok: false, code: "EMAIL_TAKEN", msg: "El correo ya está registrado." });
    }
    console.error("[AUTH] register error:", e);
    return res.status(500).json({ ok: false, msg: "Error registrando usuario" });
  } finally {
    conn.release();
  }
});

r.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, msg: "email y password requeridos" });

  const norm = String(email).toLowerCase();
  const [rows] = await pool.query<any[]>("SELECT * FROM users WHERE email=? LIMIT 1", [norm]);
  const u = rows[0] as DbUser | undefined;
  if (!u || u.provider !== "local" || !u.password_hash || !verifyPassword(password, u.password_hash)) {
    return res.status(401).json({ ok: false, msg: "credenciales inválidas" });
  }
  const token = signToken({ id: u.id, email: u.email, role: u.role });
  res.json({ ok: true, token, user: { id: u.id, email: u.email, name: u.name, avatar_url: u.avatar_url, role: u.role } });
});

export default r;
