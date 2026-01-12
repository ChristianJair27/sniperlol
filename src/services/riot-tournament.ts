// src/services/riot-tournament.ts
import { riot } from './riot.js';

const TOURNAMENT_BASE = 'https://americas.api.riotgames.com';

export async function createProvider() {
  try {
    const response = await riot.post(`${TOURNAMENT_BASE}/lol/tournament-stub/v5/providers`, {
      region: "LAN",  // o "LAS" si tu cuenta es de Sur
      url: "https://localhost:4000/tournament-callback"
    });
    
    // Riot a veces devuelve solo el ID como número, o vacío en stub
    const providerId = response.data?.id || response.data || Date.now();  // fallback seguro
    console.log('Provider creado con éxito. ID estimado:', providerId);
    return { id: providerId };
  } catch (err: any) {
    console.error('Error creando provider:', err.response?.data || err.message);
    throw new Error(`No se creó provider: ${err.response?.data?.message || 'Respuesta inesperada'}`);
  }
}

export async function createTournament(providerId: number, name: string) {
  try {
    const { data } = await riot.post(`${TOURNAMENT_BASE}/lol/tournament-stub/v5/tournaments`, {
      name,
      providerId,
    });
    console.log('Torneo creado:', data);
    return data;
  } catch (err: any) {
    console.error('Error creando torneo:', err.response?.data);
    throw err;
  }
}

export async function generateCodes(tournamentId: number, count: number = 32) {
  try {
    const { data } = await riot.post(`${TOURNAMENT_BASE}/lol/tournament-stub/v5/codes`, {
      tournamentId,
      count,
      teamSize: 5,
    });
    console.log(`${data.length} códigos generados`);
    return data;
  } catch (err: any) {
    console.error('Error generando códigos:', err.response?.data);
    throw err;
  }
}