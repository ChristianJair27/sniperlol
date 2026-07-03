import { Router } from 'express';
import axios from 'axios';
import NodeCache from 'node-cache';

const router = Router();

// Cache: 5 minutos TTL
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Configurable so prod can point at a hosted LLM (Ollama or any OpenAI-/Ollama-compatible
// endpoint). Defaults to a local Ollama for dev.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat';
const MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';

// Helper para generar key de cache
const getCacheKey = (type: string, data: any) => `${type}:${JSON.stringify(data)}`;

// Ruta: etiquetas globales del jugador
router.post('/ai-insights', async (req, res) => {
  console.log('Solicitud IA global recibida:', req.body);

  const { riotId, region, stats } = req.body;

  if (!stats || !riotId) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  const cacheKey = getCacheKey('insights', { riotId, stats });
  const cached = cache.get<string>(cacheKey);
  if (cached) {
    console.log('Respuesta desde cache');
    return res.json({ insights: cached });
  }

  const topChamps = stats.mostPlayed || 'No disponible';

  const prompt = `Eres ATAK Coach, analista LoL directo y con humor negro. Genera EXCLUSIVAMENTE un array JSON de 5 strings (etiquetas clave). Usa jerga LoL (inting, feeding, smurf, etc.). Ejemplo exacto:

["Int Master", "CS Bot", "Ward Hater", "All-in Addict", "Smurf Fail"]

Perfil:
- Riot ID: ${riotId}
- Región: ${region}
- Rank: ${stats.rank || 'Sin clasificar'}
- Winrate: ${stats.winRate || 'N/A'}%
- KDA: ${stats.kda || 'N/A'}
- Campeones: ${topChamps}
- Partidas: ${stats.totalGames || 'N/A'}

Responde SOLO con el array JSON de strings. NO uses objetos, NO añadas texto extra, NO uses markdown.`;

  try {
    const response = await axios.post(OLLAMA_URL, {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }, {
      timeout: 300000,
    });

    let aiText = '["Análisis no disponible"]';
    try {
      const rawContent = response.data.message?.content?.trim() || '';
      const parsed = JSON.parse(rawContent);

      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        aiText = JSON.stringify(parsed);
      } else {
        console.warn('IA devolvió formato inválido:', parsed);
        aiText = '["Formato inesperado de IA"]';
      }
    } catch (parseError) {
      console.error('Error parseando respuesta IA:', parseError);
      aiText = '["Error en análisis IA"]';
    }

    cache.set(cacheKey, aiText);
    console.log('IA global cacheada');
    res.json({ insights: aiText });
  } catch (error: any) {
    console.error('Error Ollama global:', error.message);
    res.status(500).json({ error: 'Error conectando con IA' });
  }
});

// Ruta: etiquetas por partida
router.post('/ai-match-tags', async (req, res) => {
  const { matchData } = req.body;

  if (!matchData || !matchData.matchId) {
    return res.status(400).json({ error: 'Faltan datos de partida' });
  }

  const cacheKey = getCacheKey('match', matchData.matchId);
  const cached = cache.get<string>(cacheKey);
  if (cached) {
    return res.json({ tags: cached });
  }

  const prompt = `Eres ATAK Coach, directo con humor negro. Genera EXCLUSIVAMENTE un array JSON de 3 strings (etiquetas clave para esta partida). Ejemplo exacto:

["Feeding Early", "Carry Late", "Ward God"]

Partida: Win: ${matchData.win ? 'Sí' : 'No'}, KDA: ${matchData.kda}, CS/min: ${matchData.cs || 'N/A'}, Role: ${matchData.role || 'N/A'}.

Responde SOLO con el array JSON de strings. NO uses objetos, NO añadas texto extra, NO uses markdown.`;

  try {
    const response = await axios.post(OLLAMA_URL, {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }, {
      timeout: 180000,
    });

    let tags = '["Análisis no disponible"]';
    try {
      const rawContent = response.data.message?.content?.trim() || '';
      const parsed = JSON.parse(rawContent);

      if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
        tags = JSON.stringify(parsed);
      } else {
        console.warn('IA partida devolvió formato inválido:', parsed);
        tags = '["Formato inesperado"]';
      }
    } catch (parseError) {
      console.error('Error parseando respuesta IA partida:', parseError);
      tags = '["Error en análisis"]';
    }

    cache.set(cacheKey, tags);
    res.json({ tags });
  } catch (error: any) {
    console.error('Error IA partida:', error.message);
    res.status(500).json({ error: 'Error en análisis de partida' });
  }
});

// BONUS: Ruta build/runas (mantenida con validación extra)
router.post('/ai-build', async (req, res) => {
  const { riotId, stats } = req.body;

  if (!stats) return res.status(400).json({ error: 'Faltan stats' });

  const prompt = `Eres ATAK Coach. Genera una build/runas optimizada para el main champion de este jugador. Responde EXCLUSIVAMENTE con JSON válido:

{
  "items": ["Item 1", "Item 2", "Item 3", "Boots", "Item 5", "Item 6"],
  "runes": {
    "primary": "Árbol principal",
    "keystone": "Runa principal",
    "secondary": "Árbol secundario"
  },
  "tip": "Consejo corto"
}

Perfil: Winrate ${stats.winRate}%, Main: ${stats.mostPlayed || 'N/A'}`;

  try {
    const response = await axios.post(OLLAMA_URL, {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }, { timeout: 300000 });

    let build = { items: [], runes: {}, tip: "No disponible" };
    try {
      const rawContent = response.data.message.content.trim();
      build = JSON.parse(rawContent);
      // Validación básica
      if (!Array.isArray(build.items) || typeof build.runes !== 'object') {
        build = { items: [], runes: {}, tip: "Formato inválido" };
      }
    } catch {}

    res.json({ build });
  } catch (error) {
    console.error('Error generando build:', error);
    res.status(500).json({ error: 'Error generando build' });
  }
});

// Nueva ruta: AI Live Coach para partida en vivo (usando datos limitados del Spectator API + estimaciones)
router.post('/ai-live-coach', async (req, res) => {
  const { liveGame, playerRiotId, playerRecentStats } = req.body;

  if (!liveGame || !liveGame.participants) {
    return res.status(400).json({ error: 'Faltan datos de la partida en vivo' });
  }

  const cacheKey = getCacheKey('live-coach', { 
    gameId: liveGame.gameId, 
    length: liveGame.gameLength,
    player: playerRiotId 
  });
  const cached = cache.get<{ tags: any[]; advice: string }>(cacheKey);
  if (cached) {
    return res.json(cached);
  }

  const fmtPlayer = (p: any) => `${p.championName || p.summonerName}(${p.kills}/${p.deaths}/${p.assists} ${p.cs}cs)`
  const blue = liveGame.participants.filter((p: any) => p.teamId === 100).map(fmtPlayer).join(', ');
  const red  = liveGame.participants.filter((p: any) => p.teamId === 200).map(fmtPlayer).join(', ');

  const prompt = `Eres ATAK AI Coach de LoL, viendo una partida en vivo (minuto ${Math.floor((liveGame.gameLength || 0) / 60)}).
Composición — Azul: ${blue}. Rojo: ${red}.
Jugador objetivo (${playerRiotId || 'desconocido'}): ${playerRecentStats ? JSON.stringify(playerRecentStats).slice(0, 400) : 'sin datos'}.

Devuelve SOLO un JSON: {"tags":[ ... ]} con 3 o 4 consejos MUY cortos (2 a 4 palabras cada uno, en español), accionables para un overlay que se lee de un vistazo. Cada tag = {"label":"texto corto","kind":"pos|gold|warn|dim"}:
- "warn": amenaza/peligro (ej. "Foco a Renekton", "Cuidado gank top")
- "gold": objetivo/build (ej. "Roba dragón", "Compra Zhonya")
- "pos": oportunidad/bueno (ej. "Empuja mid", "Toma iniciativa")
- "dim": info neutra (ej. "Nashor a las 20:00")
Nada de frases largas. Solo el JSON.`;

  try {
    const response = await axios.post(OLLAMA_URL, {
      model: MODEL,
      messages: [
        { role: 'system', content: 'Respondes SIEMPRE con JSON válido {"tags":[{"label","kind"}]}. Consejos brevísimos, nunca párrafos.' },
        { role: 'user', content: prompt },
      ],
      stream: false,
      format: 'json',
      options: { temperature: 0.5 },
    }, { timeout: 120000 });

    const raw = response.data.message?.content?.trim() || '{}';
    const KINDS = ['pos', 'gold', 'warn', 'dim'];
    let tags: Array<{ label: string; kind: string }> = [];
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : (parsed.tags || []);
      tags = arr
        .filter((t: any) => t && (t.label || typeof t === 'string'))
        .slice(0, 4)
        .map((t: any) => ({
          label: String(t.label ?? t).slice(0, 32),
          kind: KINDS.includes(t.kind) ? t.kind : 'gold',
        }));
    } catch { /* fall through to empty */ }

    const advice = tags.map((t) => t.label).join(' · ');  // fullText fallback/tooltip
    const payload = { tags, advice };
    cache.set(cacheKey, payload, 60);
    res.json(payload);
  } catch (error: any) {
    console.error('Error IA live coach:', error.code ?? error.message);
    res.json({ tags: [], advice: null, unavailable: true });
  }
});

// Arena augment tip — short actionable hint for the current champion
router.post('/ai-augment-tip', async (req, res) => {
  const { champion, currentAugments } = req.body;
  if (!champion) return res.status(400).json({ error: 'Missing champion' });

  const haveList = Array.isArray(currentAugments) && currentAugments.length > 0
    ? currentAugments.join(', ')
    : 'none yet';

  const prompt = `Campeón: ${champion}. Augments ya tomados: ${haveList}.
Recomienda QUÉ TIPO/categoría de augment priorizar en el siguiente pick para este campeón (ej: "AP + Penetración mágica", "Velocidad de ataque on-hit", "Letalidad", "Vida/Tanque", "Haste + escudos"). UNA sola frase corta (máx 110 caracteres), directa y específica. Solo el texto del consejo, sin preámbulo.`;

  try {
    const response = await axios.post(OLLAMA_URL, {
      model: MODEL,
      messages: [
        { role: 'system', content: 'Eres ATAK, coach experto de LoL Arena. SIEMPRE das una recomendación concreta y breve en español. Nunca te niegas ni pides más contexto.' },
        { role: 'user', content: prompt },
      ],
      stream: false,
      options: { temperature: 0.4 },
    }, { timeout: 60000 });

    const tip = (response.data.message?.content?.trim() || '').slice(0, 160);
    res.json({ tip });
  } catch (error: any) {
    console.error('Error IA augment tip:', error.code ?? error.message);
    res.json({ tip: null, unavailable: true });
  }
});

export default router;