// src/routes/auth.ts
import { Router } from "express";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import crypto from "crypto";

const r = Router();

type User = {
  id: string;
  email: string;
  name?: string;
  picture?: string;
  provider?: "google" | "local";
  googleId?: string;
  passwordHash?: string; // local
};

// DEV: almacenamiento en memoria para pruebas
const usersById = new Map<string, User>();
const usersByEmail = new Map<string, string>(); // email -> userId

const WEB_ORIGIN = process.env.WEB_ORIGIN || "http://localhost:8080";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const COOKIE_NAME = "auth_token";

// --- helpers ---
function signToken(u: User) {
  return jwt.sign({ uid: u.id, email: u.email }, JWT_SECRET, { expiresIn: "7d" });
}

function setAuthCookie(res: any, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,            // en producción con HTTPS => true
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function getGoogleClient() {
  return new OAuth2Client(
    process.env.GOOGLE_CLIENT_ID!,
    process.env.GOOGLE_CLIENT_SECRET!,
    process.env.GOOGLE_REDIRECT_URI!
  );
}

// --- GOOGLE OAUTH ---
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

    // Verificar ID Token (contiene email, sub, etc.)
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) return res.status(400).send("Invalid token payload");

    const email = payload.email.toLowerCase();
    const googleId = payload.sub;

    // buscar/crear usuario
    let uid = usersByEmail.get(email);
    let user: User | undefined = uid ? usersById.get(uid) : undefined;

    if (!user) {
      user = {
        id: crypto.randomUUID(),
        email,
        name: payload.name,
        picture: payload.picture || undefined,
        provider: "google",
        googleId,
      };
      usersById.set(user.id, user);
      usersByEmail.set(user.email, user.id);
    } else {
      // actualizar datos básicos
      user.name = user.name || payload.name || user.name;
      user.picture = user.picture || payload.picture || user.picture;
      user.googleId = user.googleId || googleId;
      user.provider = user.provider || "google";
    }

    const token = signToken(user);
    setAuthCookie(res, token);

    // redirige al front
    res.redirect(`${WEB_ORIGIN}/`);
  } catch (e) {
    console.error("[AUTH] google callback error", e);
    res.redirect(`${WEB_ORIGIN}/login?error=google`);
  }
});

// --- RUTAS LOCAL EMAIL+PASSWORD (opcional, para quitar el 404 de /auth/register) ---
function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(pw, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

r.post("/register", (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, msg: "email y password requeridos" });

  const norm = String(email).toLowerCase();
  if (usersByEmail.has(norm)) return res.status(409).json({ ok: false, msg: "email ya registrado" });

  const u: User = {
    id: crypto.randomUUID(),
    email: norm,
    name,
    provider: "local",
    passwordHash: hashPassword(password),
  };
  usersById.set(u.id, u);
  usersByEmail.set(norm, u.id);

  const token = signToken(u);
  setAuthCookie(res, token);
  res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name } });
});

r.post("/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ ok: false, msg: "email y password requeridos" });

  const norm = String(email).toLowerCase();
  const uid = usersByEmail.get(norm);
  const u = uid ? usersById.get(uid) : undefined;
  if (!u || u.provider !== "local" || !u.passwordHash || !verifyPassword(password, u.passwordHash)) {
    return res.status(401).json({ ok: false, msg: "credenciales inválidas" });
  }

  const token = signToken(u);
  setAuthCookie(res, token);
  res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name } });
});

// --- sesión ---
r.get("/me", (req, res) => {
  try {
    const raw = req.cookies?.[COOKIE_NAME];
    if (!raw) return res.json({ ok: true, user: null });

    const payload = jwt.verify(raw, JWT_SECRET) as any;
    const u = usersById.get(payload.uid);
    if (!u) return res.json({ ok: true, user: null });

    res.json({ ok: true, user: { id: u.id, email: u.email, name: u.name, picture: u.picture } });
  } catch {
    res.json({ ok: true, user: null });
  }
});

r.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: "lax", secure: false });
  res.json({ ok: true });
});

export default r;