// src/server.ts
import "./loadEnv.js";

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import debugRoutes from "./routes/debug.js";
import players from "./routes/players.js";
import live from "./routes/live.js";
import playersOverview from "./routes/players.overview.js";
import masteryDebug from "./routes/mastery.js";
import recent from "./routes/recent.js";
import stats from "./routes/stats.js";
import auth from "./routes/auth.js";
import cookieParser from "cookie-parser";
import playersLink from "./routes/players.link.js";
import staticRoutes from './routes/static.js';

import aiRoutes from './routes/ai.routes.js';

import tournamentsRouter from './routes/tournaments.routes.js';
import socialRouter from './routes/social.routes.js';
import champSelectRouter from './routes/champ-select.routes.js';
import lcuProxyRouter from './routes/lcu-proxy.routes.js';

// ===== CORS =====
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const corsOptions: cors.CorsOptions = {
  origin(origin, cb) {
    // Permite herramientas sin Origin (curl/Postman) y same-origin
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    // Allow all localhost for development (companion on 5174, web on 8080, etc.)
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    // Permite Electron o webview protocols
    if (origin.startsWith("app://") || origin.startsWith("file://") || origin.startsWith("vscode-webview://") || origin.startsWith("overwolf-extension://") || origin.startsWith("https://www.overwolf.com/")) {
      return cb(null, true);
    }
    console.warn(`[CORS Blocked] Origin: ${origin}`);
    return cb(null, false);
  },
  credentials: true, // <- necesario si el front manda cookies/credenciales
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
};

const app = express();
app.use(cors(corsOptions));
app.use(express.json());
// Responder preflight explícitamente (algunos proxies lo requieren)

// =================

app.use(helmet());
app.use(morgan("dev"));

app.use("/api/debug", debugRoutes);
app.use(express.static("public"));

app.use("/api/players", playersOverview);
app.use("/api/debug", masteryDebug); // (quizá quieras /api/mastery)
app.use("/api/players", recent);

app.use("/auth", auth);
app.use("/api/stats", stats);

app.use("/api/players", playersLink);


app.use('/api/static', staticRoutes);

console.log("CORS_ORIGIN allowlist:", allowedOrigins);

app.use(cookieParser());

app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use("/api/players", players);
app.use("/api/live", live);






app.use('/api', aiRoutes);

app.use('/api/tournaments', tournamentsRouter);
app.use('/api/social', socialRouter);
app.use('/api/champ-select', champSelectRouter);
app.use('/api/lcu-proxy', lcuProxyRouter);



// Manejo de errores tipado
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err?.response?.data ?? err);
  const status = err?.response?.status ?? err?.status ?? 500;
  res.status(status).json({ ok: false, msg: err?.message || "Server error" });
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => console.log(`sniperlol API on :${PORT}`));

// Evita loggear la API key completa en consola
if (process.env.RIOT_API_KEY) {
  console.log("RIOT_KEY suffix:", process.env.RIOT_API_KEY.slice(-6));
}