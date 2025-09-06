// src/server.ts
import "dotenv/config";
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

const app = express();
app.use(express.json());

// CORS: acepta lista separada por coma o refleja el origen
const corsOrigin: cors.CorsOptions["origin"] =
  process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",").map(s => s.trim())
    : true;

app.use(cors({ origin: corsOrigin }));
app.use(helmet());
app.use(morgan("dev"));

app.use("/api/debug", debugRoutes);
app.use(express.static("public"));


app.use("/api/players", playersOverview);

app.use("/api/debug", masteryDebug);

app.use("/api/players", recent);

app.use("/auth", auth);   


app.use("/api/stats", stats);
console.log('CORS_ORIGIN:', corsOrigin);


app.get("/api/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use("/api/players", players);
app.use("/api/live", live);

// Manejo de errores tipado
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err?.response?.data ?? err);
  const status = err?.response?.status ?? err?.status ?? 500;
  res.status(status).json({ ok: false, msg: err?.message || "Server error" });
});

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => console.log(`sniperlol API on :${PORT}`));
console.log("RIOT_KEY:", process.env.RIOT_API_KEY?.slice(-6));