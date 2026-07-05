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
// ── Shared tag helpers (structured, scannable, data-grounded) ─────────────────
type AiTag = { label: string; kind: 'pos' | 'warn' | 'gold' | 'dim' };
const TAG_KINDS = ['pos', 'warn', 'gold', 'dim'];
const num = (v: any) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Parse Ollama's JSON output (format:json) into validated AiTags, tolerating a few shapes.
function parseAiTags(raw: string): AiTag[] {
  try {
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed.tags || parsed.labels || []);
    return arr
      .map((t: any) => (typeof t === 'string' ? { label: t, kind: 'dim' } : { label: t?.label, kind: t?.kind }))
      .filter((t: AiTag) => t.label)
      .map((t: AiTag) => ({ label: String(t.label).slice(0, 22), kind: TAG_KINDS.includes(t.kind) ? t.kind : 'dim' }));
  } catch { return []; }
}
// Merge fact tags (reliable, from data) + AI flavor tags, dedupe by label, cap.
function mergeTags(facts: AiTag[], flavor: AiTag[], max = 5): AiTag[] {
  const out: AiTag[] = []; const seen = new Set<string>();
  for (const t of [...facts, ...flavor]) {
    const k = t.label.toLowerCase();
    if (seen.has(k)) continue; seen.add(k); out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

router.post('/ai-insights', async (req, res) => {
  const { riotId, region, stats } = req.body;
  if (!stats || !riotId) return res.status(400).json({ error: 'Faltan datos requeridos' });

  const cacheKey = getCacheKey('insights2', { riotId, stats });
  const cached = cache.get<AiTag[]>(cacheKey);
  if (cached) return res.json({ tags: cached, insights: JSON.stringify(cached.map(t => t.label)) });

  const wr = num(stats.winRate), kda = num(stats.kda), games = num(stats.totalGames);
  // Deterministic base tags — always correct, computed straight from the numbers.
  const facts: AiTag[] = [];
  if (wr >= 60) facts.push({ label: 'En racha', kind: 'pos' });
  else if (wr > 0 && wr < 45) facts.push({ label: 'Mala racha', kind: 'warn' });
  if (kda >= 4) facts.push({ label: 'KDA alto', kind: 'pos' });
  else if (kda > 0 && kda < 1.8) facts.push({ label: 'Muere seguido', kind: 'warn' });
  if (wr >= 60 && games > 0 && games < 40) facts.push({ label: 'Posible smurf', kind: 'gold' });
  if (stats.rank && /challenger|grandmaster|master|diamond|diamante/i.test(stats.rank)) facts.push({ label: 'Elo alto', kind: 'gold' });
  if (games >= 200) facts.push({ label: 'Veterano', kind: 'dim' });
  else if (games > 0 && games < 30) facts.push({ label: 'Cuenta nueva', kind: 'dim' });

  const prompt = `Perfil de LoL (usa SOLO estos datos, no inventes):
Rank ${stats.rank || 'Sin clasificar'} · Winrate ${wr}% · KDA ${kda} · Mains: ${stats.mostPlayed || 'N/A'} · ${games} partidas.
Devuelve JSON {"tags":[...]}: 2 o 3 etiquetas MUY cortas (1-3 palabras, español, jerga LoL) que describan a este jugador según esos números. Cada tag {"label":"...","kind":"pos|warn|gold|dim"} (pos=bueno, warn=malo, gold=destaca, dim=neutro). Solo JSON.`;

  // Respond INSTANTLY with the reliable data-driven tags (never blocks on the LLM,
  // which can be slow/cold and would time out the client). Enrich with AI flavor in
  // the background so the NEXT load (served from cache) also shows the LLM tag.
  res.json({ tags: facts, insights: JSON.stringify(facts.map(t => t.label)) });
  axios.post(OLLAMA_URL, {
    model: MODEL,
    messages: [
      { role: 'system', content: 'Respondes SIEMPRE con JSON {"tags":[{"label","kind"}]}. Etiquetas brevísimas basadas en los datos dados. Nunca párrafos.' },
      { role: 'user', content: prompt },
    ],
    stream: false, format: 'json', options: { temperature: 0.5 },
  }, { timeout: 60000 })
    .then(r => {
      const flavor = parseAiTags(r.data.message?.content?.trim() || '');
      cache.set(cacheKey, mergeTags(facts, flavor, 5), 600);
    })
    .catch(e => console.error('insights flavor bg:', e.code ?? e.message));
});

// Ruta: etiquetas por partida
router.post('/ai-match-tags', async (req, res) => {
  const { matchData } = req.body;

  if (!matchData || !matchData.matchId) {
    return res.status(400).json({ error: 'Faltan datos de partida' });
  }

  const cacheKey = getCacheKey('match2', matchData.matchId);
  const cached = cache.get<AiTag[]>(cacheKey);
  if (cached) return res.json({ tags: cached });

  const kda = num(matchData.kda), cs = num(matchData.cs);
  const k = num(matchData.kills), d = num(matchData.deaths), a = num(matchData.assists);
  // Deterministic base tags from the match numbers.
  const facts: AiTag[] = [];
  facts.push(matchData.win ? { label: 'Victoria', kind: 'pos' } : { label: 'Derrota', kind: 'warn' });
  if (kda >= 5 || (d === 0 && (k + a) >= 5)) facts.push({ label: 'Dominó', kind: 'pos' });
  else if (kda >= 3) facts.push({ label: 'Buen KDA', kind: 'pos' });
  else if (kda > 0 && kda < 1) facts.push({ label: 'Partida difícil', kind: 'warn' });
  if (d >= 8) facts.push({ label: 'Murió mucho', kind: 'warn' });
  if (cs >= 8.5) facts.push({ label: 'Farmeó bien', kind: 'gold' });
  else if (cs > 0 && cs < 4.5) facts.push({ label: 'Poco CS', kind: 'dim' });
  if (k >= 10) facts.push({ label: 'Carreó', kind: 'gold' });

  const prompt = `Partida de LoL (usa SOLO estos datos): ${matchData.win ? 'Victoria' : 'Derrota'}, ${matchData.championName || matchData.role || ''} KDA ${matchData.kills ?? '?'}/${matchData.deaths ?? '?'}/${matchData.assists ?? '?'} (${kda}), ${cs} CS/min.
Devuelve JSON {"tags":[...]}: 2 etiquetas MUY cortas (1-3 palabras, español) sobre el desempeño en ESTA partida. Cada {"label":"...","kind":"pos|warn|gold|dim"}. Solo JSON.`;

  // Respond instantly with data-driven tags; enrich with AI flavor in the background.
  res.json({ tags: facts });
  axios.post(OLLAMA_URL, {
    model: MODEL,
    messages: [
      { role: 'system', content: 'Respondes SIEMPRE con JSON {"tags":[{"label","kind"}]}. Etiquetas brevísimas de la partida. Nunca párrafos.' },
      { role: 'user', content: prompt },
    ],
    stream: false, format: 'json', options: { temperature: 0.5 },
  }, { timeout: 60000 })
    .then(r => {
      const flavor = parseAiTags(r.data.message?.content?.trim() || '');
      cache.set(cacheKey, mergeTags(facts, flavor, 4), 3600);
    })
    .catch(e => console.error('match-tags flavor bg:', e.code ?? e.message));
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