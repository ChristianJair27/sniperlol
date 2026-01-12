// src/services/riot-tournament.service.ts
import axios from 'axios';

const RIOT_API_KEY = process.env.RIOT_API_KEY;
if (!RIOT_API_KEY) throw new Error('RIOT_API_KEY no definida en .env');

// Usa 'americas' para LAN/LAS/NA/BR/OC
// Usa 'europe' para EUW/EUNE/TR/RU
// Usa 'asia' para KR/JP
const BASE_URL = 'https://americas.api.riotgames.com';  // ← CAMBIA SI ES NECESARIO

const riotAxios = axios.create({
  headers: {
    'X-Riot-Token': RIOT_API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
});

// Crear provider – Riot requiere body vacío {}
export const createProvider = async () => {
  try {
    const response = await riotAxios.post(`${BASE_URL}/lol/tournament-stub/v5/providers`, {});
    console.log('Provider creado con éxito:', response.data);
    return response.data; // { id: number }
  } catch (err: any) {
    console.error('Error detallado al crear provider:');
    console.error('Status:', err.response?.status);
    console.error('Data:', err.response?.data);
    console.error('Headers:', err.response?.headers);
    throw new Error(`No se creó provider: ${err.response?.data?.message || err.message}`);
  }
};

// Crear torneo
export const createTournament = async (providerId: number, name: string) => {
  try {
    const response = await riotAxios.post(`${BASE_URL}/lol/tournament-stub/v5/tournaments`, {
      name,
      providerId,
    });
    console.log('Torneo creado:', response.data);
    return response.data; // { id: number }
  } catch (err: any) {
    console.error('Error creando torneo', err.response?.data);
  }
};

// Generar códigos para un torneo
export const generateCodes = async (tournamentId: number, count: number = 32) => {
  try {
    const response = await riotAxios.post(`${BASE_URL}/lol/tournament-stub/v5/codes`, {
      tournamentId,
      count,
      teamSize: 5,
      // Opcional: metadata, mapType, pickType, spectatorType
    });
    console.log('Códigos generados:', response.data);
    return response.data; // Array de códigos
  } catch (err: any) {
    console.error('Error generando códigos', err.response?.data);
  }
};

// Obtener lobby events por código (útil para check-in)
export const getLobbyEvents = async (tournamentCode: string) => {
  try {
    const response = await riotAxios.get(`${BASE_URL}/lol/tournament-stub/v5/lobby-events/by-code/${tournamentCode}`);
    return response.data;
  } catch (err: any) {
    console.error('Error lobby events', err.response?.data);
  }
};