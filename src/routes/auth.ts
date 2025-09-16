// src/routes/auth.ts
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { pool } from "../db.js"; // <-- tu pool MySQL

const r = Router();

type DbUser = {
  id: number;
  email: string;
  name: string | null;
  avatar_url: string | null;
  role: 'user' | 'admin';
  provider: 'local' | 'google';
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
