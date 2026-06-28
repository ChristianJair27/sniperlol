// src/services/riot-tournament.service.ts
import axios from 'axios';

const RIOT_API_KEY = process.env.RIOT_API_KEY;
if (!RIOT_API_KEY) throw new Error('RIOT_API_KEY no definida en .env');

// ─── Real vs Stub ────────────────────────────────────────────────────────────
// STUB_MODE=true  → usa /lol/tournament-stub/v5  (dev, no requiere producción)
// STUB_MODE=false → usa /lol/tournament/v5       (producción, API aprobada)
const STUB_MODE = process.env.RIOT_STUB_MODE === 'true';
const API_PATH = STUB_MODE ? 'tournament-stub' : 'tournament';

// americas = LAN/LAS/NA/BR/OC | europe = EUW/EUNE/TR/RU | asia = KR/JP
const BASE_URL = 'https://americas.api.riotgames.com';

console.log(`[RiotTournament] Modo: ${STUB_MODE ? 'STUB (desarrollo)' : 'REAL (producción)'}`);

const riotAxios = axios.create({
  baseURL: BASE_URL,
  headers: {
    'X-Riot-Token': RIOT_API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  timeout: 10000,
});

// ─── Provider ────────────────────────────────────────────────────────────────
// Un provider se crea una vez y se reutiliza para todos los torneos
export const createProvider = async (): Promise<{ id: number }> => {
  const base =
    process.env.TOURNAMENT_CALLBACK_URL ||
    'https://atak.gg/api/tournaments/tournament-callback';
  // Riot does not sign callbacks, so embed a shared secret in the registered URL.
  // The callback handler rejects any POST whose ?key= doesn't match.
  const secret = process.env.TOURNAMENT_CALLBACK_SECRET;
  const callbackUrl = secret
    ? `${base}${base.includes('?') ? '&' : '?'}key=${encodeURIComponent(secret)}`
    : base;

  try {
    const { data } = await riotAxios.post(`/lol/${API_PATH}/v5/providers`, {
      region: process.env.RIOT_REGION || 'LAN',
      url: callbackUrl,
    });
    // Riot devuelve el ID directamente como número
    const id = typeof data === 'number' ? data : (data?.id ?? data);
    console.log('[Provider] Creado. ID:', id);
    return { id };
  } catch (err: any) {
    console.error('[Provider] Error:', err.response?.status, err.response?.data);
    throw new Error(
      `createProvider falló: ${err.response?.data?.message || err.message}`
    );
  }
};

// ─── Tournament ───────────────────────────────────────────────────────────────
export const createTournament = async (
  providerId: number,
  name: string
): Promise<{ id: number }> => {
  try {
    const { data } = await riotAxios.post(`/lol/${API_PATH}/v5/tournaments`, {
      name,
      providerId,
    });
    const id = typeof data === 'number' ? data : (data?.id ?? data);
    console.log('[Tournament] Creado. ID:', id);
    return { id };
  } catch (err: any) {
    console.error('[Tournament] Error:', err.response?.status, err.response?.data);
    throw new Error(
      `createTournament falló: ${err.response?.data?.message || err.message}`
    );
  }
};

// ─── Codes ────────────────────────────────────────────────────────────────────
// pickType: BLIND_PICK | DRAFT_MODE | ALL_RANDOM | TOURNAMENT_DRAFT
// mapType:  SUMMONERS_RIFT | TWISTED_TREELINE | HOWLING_ABYSS
// spectatorType: NONE | LOBBYONLY | ALL
export const generateCodes = async (
  tournamentId: number,
  count: number = 1,
  options: {
    pickType?: string;
    mapType?: string;
    spectatorType?: string;
    teamSize?: number;
    metadata?: string;
    // Riot Tournament-V5: restricts the code to these PUUIDs (allowlist).
    // Omit/empty → anyone with the code can join.
    allowedParticipants?: string[];
  } = {}
): Promise<string[]> => {
  const {
    pickType = 'TOURNAMENT_DRAFT',
    mapType = 'SUMMONERS_RIFT',
    spectatorType = 'ALL',
    teamSize = 5,
    metadata = '',
    allowedParticipants,
  } = options;

  const body: Record<string, any> = { teamSize, pickType, mapType, spectatorType, metadata };
  // Only send the allowlist when we actually have enough participants; Riot
  // rejects a code whose allowlist is shorter than teamSize*2.
  if (allowedParticipants && allowedParticipants.length >= teamSize * 2) {
    body.allowedParticipants = allowedParticipants;
    body.enoughPlayers = true;
  }

  try {
    const { data } = await riotAxios.post(
      `/lol/${API_PATH}/v5/codes?count=${count}&tournamentId=${tournamentId}`,
      body
    );
    const codes = Array.isArray(data) ? data : [];
    console.log(`[Codes] ${codes.length} código(s) generado(s) para torneo ${tournamentId}`);
    return codes;
  } catch (err: any) {
    console.error('[Codes] Error:', err.response?.status, err.response?.data);
    throw new Error(
      `generateCodes falló: ${err.response?.data?.message || err.message}`
    );
  }
};

// ─── Lobby Events ─────────────────────────────────────────────────────────────
// Devuelve los eventos del lobby (quién se unió, cuándo, etc.)
export const getLobbyEvents = async (tournamentCode: string) => {
  try {
    const { data } = await riotAxios.get(
      `/lol/${API_PATH}/v5/lobby-events/by-code/${encodeURIComponent(tournamentCode)}`
    );
    return data;
  } catch (err: any) {
    console.error('[LobbyEvents] Error:', err.response?.status, err.response?.data);
    throw new Error(
      `getLobbyEvents falló: ${err.response?.data?.message || err.message}`
    );
  }
};

// ─── Code Info ────────────────────────────────────────────────────────────────
// Obtiene la información de un código (equipos, modo, etc.)
export const getCodeInfo = async (tournamentCode: string) => {
  try {
    const { data } = await riotAxios.get(
      `/lol/${API_PATH}/v5/codes/${encodeURIComponent(tournamentCode)}`
    );
    return data;
  } catch (err: any) {
    console.error('[CodeInfo] Error:', err.response?.status, err.response?.data);
    throw new Error(
      `getCodeInfo falló: ${err.response?.data?.message || err.message}`
    );
  }
};

// ─── Games by Code ────────────────────────────────────────────────────────────
// Devuelve las partidas jugadas con un código de torneo específico.
// Responde un array de { region, code, gameId } — puede estar vacío si la
// partida aún no terminó o el código no fue usado.
export const getGamesByCode = async (
  tournamentCode: string
): Promise<Array<{ region: string; code: string; gameId: number }>> => {
  try {
    const { data } = await riotAxios.get(
      `/lol/${API_PATH}/v5/games/by-code/${encodeURIComponent(tournamentCode)}`
    );
    return Array.isArray(data) ? data : [];
  } catch (err: any) {
    // 404 = código válido pero aún sin partida registrada
    if (err.response?.status === 404) return [];
    console.error('[GamesByCode] Error:', err.response?.status, err.response?.data);
    throw new Error(
      `getGamesByCode falló: ${err.response?.data?.message || err.message}`
    );
  }
};
