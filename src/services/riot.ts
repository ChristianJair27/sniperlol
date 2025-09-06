// src/services/riot.ts
import axios, { AxiosError } from "axios";
import type { Platform } from "../utils/regions.js";
import Bottleneck from "bottleneck";




const limiterMatchIds = new Bottleneck({
  maxConcurrent: 1,
  minTime: 400,   // ~2.5 req/s (seguro)
});

const limiterMatchById = new Bottleneck({
  maxConcurrent: 1,
  minTime: 1200,  // ~0.8 req/s (muy seguro para dev keys)
});

/* === CACHÉ sencillo para match by id (5 min) === */
const matchCache = new Map<string, { data: any; exp: number }>();
function getCachedMatch(id: string) {
  const e = matchCache.get(id);
  if (e && e.exp > Date.now()) return e.data;
  if (e) matchCache.delete(id);
  return null;
}
function setCachedMatch(id: string, data: any, ttlMs = 5 * 60 * 1000) {
  matchCache.set(id, { data, exp: Date.now() + ttlMs });
}

// ===== Match-V5: IDs por PUUID =====
export async function getMatchIdsByPUUID(platform: Platform | string, puuid: string, count = 10, start = 0) {
  const regional = platformToRegional(platform as string);
  const base = REGIONAL_HOST[regional];
  const url = `${base}/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?start=${start}&count=${count}`;
  try {
    const { data } = await limiterMatchIds.schedule(() => riot.get(url));
    return data as string[];
  } catch (e: any) {
    if (e?.response?.status === 404) return [];
    rethrowNice(e, `${regional} match-v5 ids by-puuid`);
  }
}

// ===== Match-V5: detalle por id (con caché + throttling) =====
export async function getMatchById(platform: Platform | string, matchId: string) {
  const cached = getCachedMatch(matchId);
  if (cached) return cached;

  const regional = platformToRegional(platform as string);
  const base = REGIONAL_HOST[regional];
  const url = `${base}/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  try {
    const { data } = await limiterMatchById.schedule(() => riot.get(url));
    setCachedMatch(matchId, data);
    return data as any;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    rethrowNice(e, `${regional} match-v5 match by-id`);
  }
}



// --- Token ---
const RIOT_KEY = (process.env.RIOT_API_KEY || "").trim();
if (!RIOT_KEY) throw new Error("RIOT_API_KEY vacío. Define tu key en .env");

// --- Axios con header X-Riot-Token siempre presente ---
const riot = axios.create({ timeout: 10000 });
riot.interceptors.request.use((cfg) => {
  cfg.headers = cfg.headers ?? {};
  (cfg.headers as any)["X-Riot-Token"] = RIOT_KEY;
  return cfg;
});

// --- Helpers ---
function rethrowNice(e: unknown, ctx: string): never {
  const err = e as AxiosError<any>;
  const sc = err?.response?.status;
  if (sc === 404) { err.message = `Riot 404: recurso no encontrado (${ctx}).`; throw err; }
  if (sc === 401) { err.message = `Riot 401: token ausente o malformado (${ctx}).`; throw err; }
  if (sc === 403) { err.message = `Riot 403: token inválido/expirado o ruta/host incorrectos (${ctx}).`; throw err; }
  if (sc === 429) { err.message = `Riot 429: rate limit alcanzado (${ctx}).`; throw err; }
  err.message = `Riot error ${sc ?? ""} (${ctx}).`;
  throw err;
}

// --- Hosts por plataforma (LoL platform-scoped) ---
export const PLATFORM_HOST: Record<string, string> = {
  // AMERICAS
  la1: "https://la1.api.riotgames.com",
  la2: "https://la2.api.riotgames.com",
  na1: "https://na1.api.riotgames.com",
  br1: "https://br1.api.riotgames.com",
  oc1: "https://oc1.api.riotgames.com",
  // EUROPE
  euw1: "https://euw1.api.riotgames.com",
  eun1: "https://eun1.api.riotgames.com",
  tr1:  "https://tr1.api.riotgames.com",
  ru:   "https://ru.api.riotgames.com",
  // ASIA
  jp1:  "https://jp1.api.riotgames.com",
  kr:   "https://kr.api.riotgames.com",
  // SEA (opcionales)
  ph2: "https://ph2.api.riotgames.com",
  sg2: "https://sg2.api.riotgames.com",
  th2: "https://th2.api.riotgames.com",
  tw2: "https://tw2.api.riotgames.com",
  vn2: "https://vn2.api.riotgames.com",
};

// --- Hosts regionales para Account-V1 ---
type Regional = "americas" | "europe" | "asia";
const REGIONAL_HOST: Record<Regional, string> = {
  americas: "https://americas.api.riotgames.com",
  europe:   "https://europe.api.riotgames.com",
  asia:     "https://asia.api.riotgames.com",
};

// Alias LAN/LAS → la1/la2
function normalizePlatform(p: string) {
  const x = (p || "").toLowerCase().trim();
  if (x === "lan") return "la1";
  if (x === "las") return "la2";
  return x;
}

// platform → regional
function platformToRegional(p?: string): Regional {
  const k = normalizePlatform(p ?? "");
  if (["la1","la2","na1","br1","oc1"].includes(k)) return "americas";
  if (["euw1","eun1","tr1","ru"].includes(k))     return "europe";
  if (["jp1","kr","ph2","sg2","th2","tw2","vn2"].includes(k)) return "asia";
  return "americas"; // default razonable (LAN/LAS/NA/BR/OCE)
}

// ===== Account-V1 (REGIONAL: americas/europe/asia) =====
export async function getAccountByRiotId(
  gameName: string,
  tagLine: string,
  opts?: { platformHint?: string; regionalHint?: Regional }
) {
  const regional = opts?.regionalHint ?? platformToRegional(opts?.platformHint);
  const base = REGIONAL_HOST[regional];
  const url =
    `${base}/riot/account/v1/accounts/by-riot-id/` +
    `${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  try {
    const { data } = await riot.get(url);
    return data as { puuid: string; gameName: string; tagLine: string };
  } catch (e) {
    rethrowNice(e, `account-v1 ${regional} by-riot-id`);
  }
}

export async function getAccountByPUUID(puuid: string, opts?: { platformHint?: string; regionalHint?: Regional }) {
  const regional = opts?.regionalHint ?? platformToRegional(opts?.platformHint);
  const base = REGIONAL_HOST[regional];
  const url = `${base}/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`;
  try {
    const { data } = await riot.get(url);
    return data as { puuid: string; gameName: string; tagLine: string };
  } catch (e) {
    rethrowNice(e, `account-v1 ${regional} by-puuid`);
  }
}

// ===== Summoner-V4 (PLATFORM) =====
export async function getSummonerByPUUID(platform: Platform | string, puuid: string) {
  const key = normalizePlatform(platform as string);
  const base = PLATFORM_HOST[key];
  if (!base) return null;

  const url = `${base}/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
  try {
    const { data } = await riot.get(url);
    return data as any;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    rethrowNice(e, `${key} summoner-v4 by-puuid`);
  }
}

export async function getSummonerByName(platform: Platform | string, name: string) {
  const key = normalizePlatform(platform as string);
  const base = PLATFORM_HOST[key];
  if (!base) return null;

  const url = `${base}/lol/summoner/v4/summoners/by-name/${encodeURIComponent(name)}`;
  try {
    const { data } = await riot.get(url);
    return data as any;
  } catch (e: any) {
    const sc = e?.response?.status;
    if (sc === 404 || sc === 401 || sc === 403 || sc === 429) return null; // no romper el probe
    rethrowNice(e, `${key} summoner-v4 by-name`);
  }
}

// ===== Spectator-V5 (PLATFORM) =====
export async function getLiveGame(platform: Platform | string, summonerId: string) {
  const key = normalizePlatform(platform as string);
  const base = PLATFORM_HOST[key];
  if (!base) return null;

  const url = `${base}/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(summonerId)}`;
  try {
    const { data } = await riot.get(url);
    return data as any;
  } catch (e: any) {
    if (e?.response?.status === 404) return null;
    rethrowNice(e, `${key} spectator-v5 active-games by-summoner`);
  }
}


// --- AL FINAL DE src/services/riot.ts ---


/** Champion Mastery v4: todas las maestrías del summoner */
export async function getChampionMasteries(platform: Platform | string, summonerId: string) {
  const key = normalizePlatform(platform as string);
  const base = PLATFORM_HOST[key];
  if (!base) return [];
  const url = `${base}/lol/champion-mastery/v4/champion-masteries/by-summoner/${encodeURIComponent(summonerId)}`;
  try {
    const { data } = await riot.get(url);
    return data as Array<{
      championId: number;
      championLevel: number;
      championPoints: number;
      lastPlayTime: number;
    }>;
  } catch (e: any) {
    if (e?.response?.status === 404) return [];
    rethrowNice(e, `${key} champion-mastery-v4 by-summoner`);
  }
}




export async function getChampionMasteriesByPUUID(platform: Platform | string, puuid: string) {
  const key = normalizePlatform(platform as string);
  const base = PLATFORM_HOST[key];
  if (!base) return [];

  const url = `${base}/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}`;
  try {
    const { data } = await riot.get(url);
    return data as Array<{
      championId: number;
      championLevel: number;
      championPoints: number;
      lastPlayTime: number;
    }>;
  } catch (e: any) {
    if (e?.response?.status === 404) return []; // sin maestrías (o PUUID sin LoL)
    rethrowNice(e, `${key} champion-mastery-v4 by-puuid`);
  }
}


// ===== League-V4 (PLATFORM): entries by summonerId =====
export async function getLeagueEntriesBySummonerId(platform: Platform | string, summonerId: string) {
  const key = normalizePlatform(platform as string);
  const base = PLATFORM_HOST[key];
  if (!base) return [];
  const url = `${base}/lol/league/v4/entries/by-summoner/${encodeURIComponent(summonerId)}`;
  try {
    const { data } = await riot.get(url);
    return data as Array<{
      queueType: string;
      tier: string;
      rank: string;
      leaguePoints: number;
    }>;
  } catch (e: any) {
    if (e?.response?.status === 404) return [];
    rethrowNice(e, `${key} league-v4 entries by-summoner`);
  }
}