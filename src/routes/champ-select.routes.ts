// src/routes/champ-select.routes.ts
// GET /api/champ-select?champion=Jinx[&puuid=...&region=la1]
// Returns rune/item/tip recommendations using Data Dragon (auto-updates each patch).
// Champions WITHOUT a curated build get a real, champion-specific, AI-generated build
// (Ollama llama3.1:8b) whose rune/item NAMES are resolved to Data Dragon IDs, cached
// per champion+patch so the result is stable and deterministic (never random).
import { Router } from 'express';
import axios from 'axios';
import { getMatchIdsByPUUID, getMatchById } from '../services/riot.js';

const router = Router();

// ─── Ollama config (same pattern as ai.routes.ts) ────────────────────────────
const OLLAMA_URL = 'http://localhost:11434/api/chat';
const MODEL = 'llama3.1:8b';

// ─── Patch-aware DDragon cache (1 hour) ──────────────────────────────────────
let patchCache: { version: string; exp: number } | null = null;
const dataCache = new Map<string, { data: any; exp: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 h

async function getLatestPatch(): Promise<string> {
  if (patchCache && patchCache.exp > Date.now()) return patchCache.version;
  const { data } = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json', { timeout: 5000 });
  const version = data[0] as string;
  patchCache = { version, exp: Date.now() + CACHE_TTL };
  return version;
}

async function ddFetch<T>(path: string): Promise<T> {
  const cached = dataCache.get(path);
  if (cached && cached.exp > Date.now()) return cached.data as T;
  const { data } = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${path}`, { timeout: 8000 });
  dataCache.set(path, { data, exp: Date.now() + CACHE_TTL });
  return data as T;
}

// ─── Champion name normaliser (handles spaces, apostrophes) ──────────────────
function normaliseChampKey(name: string): string {
  return name.replace(/['\s.]/g, '').replace(/^./, c => c.toUpperCase());
}

// ─── Static champion-specific build overrides (curated = authoritative) ───────
// keyed by lower-case champion name
const CHAMPION_BUILDS: Record<string, ChampionBuild> = {
  jinx:    { runes: [8008, 9111, 9104, 8014, 8299, 8304, 5005, 5008, 5003], items: [3508, 3031, 3094, 3036, 3033, 3072], boots: 3006, starter: [1055, 2003] },
  caitlyn: { runes: [8008, 9111, 9104, 8014, 8299, 8304, 5005, 5008, 5003], items: [3095, 3031, 3094, 3046, 3036, 3033], boots: 3006, starter: [1055, 2003] },
  ezreal:  { runes: [8010, 9111, 9104, 8299, 8106, 8304, 5005, 5008, 5003], items: [3508, 3095, 3036, 3033, 3072, 3094], boots: 3020, starter: [1055, 2003] },
  vayne:   { runes: [8021, 9111, 9104, 8014, 8299, 8304, 5005, 5008, 5003], items: [3031, 6610, 3036, 3033, 3094, 3072], boots: 3006, starter: [1055, 2003] },
  ahri:    { runes: [8112, 8126, 8138, 8135, 8410, 8304, 5008, 5008, 5003], items: [3165, 4645, 3089, 3135, 3102, 3157], boots: 3020, starter: [1056, 2003] },
  zed:     { runes: [8112, 8126, 8138, 8135, 8347, 8236, 5005, 5008, 5003], items: [6694, 3147, 3142, 3071, 6333, 3026], boots: 3047, starter: [1055, 2003] },
  yasuo:   { runes: [8021, 9111, 9104, 8014, 8299, 8304, 5005, 5008, 5003], items: [3031, 6610, 3046, 3036, 3033, 3094], boots: 3006, starter: [1055, 2003] },
  lux:     { runes: [8229, 8226, 8210, 8237, 8410, 8304, 5008, 5008, 5003], items: [3165, 4645, 3089, 3135, 3157, 3041], boots: 3020, starter: [1056, 2003] },
  thresh:  { runes: [8369, 8306, 8275, 8232, 8135, 8135, 5005, 5002, 5003], items: [3050, 3109, 3107, 3190, 3853, 3011], boots: 3111, starter: [3858, 2003] },
  leona:   { runes: [8439, 8306, 8275, 8232, 8410, 8304, 5005, 5002, 5003], items: [3109, 3107, 3050, 3190, 3853, 4001], boots: 3111, starter: [3858, 2003] },
  darius:  { runes: [8010, 9111, 9104, 8014, 8242, 8135, 5005, 5008, 5003], items: [3078, 6632, 3071, 3065, 3075, 4401], boots: 3047, starter: [1055, 2003] },
  garen:   { runes: [8010, 9111, 9104, 8014, 8242, 8135, 5005, 5008, 5003], items: [3078, 6632, 3065, 3143, 3075, 4401], boots: 3047, starter: [1055, 2003] },
  katarina:{ runes: [8112, 8126, 8138, 8135, 8347, 8236, 5008, 5008, 5002], items: [3152, 4645, 3135, 3089, 3157, 3165], boots: 3020, starter: [1056, 2003] },
  khazix:  { runes: [8112, 8126, 8138, 8135, 8347, 8347, 5005, 5008, 5002], items: [6694, 3147, 3142, 3071, 6333, 3026], boots: 3047, starter: [1055, 2003] },
  lee:     { runes: [8214, 8226, 8234, 8237, 8410, 8304, 5005, 5008, 5003], items: [6692, 3153, 3071, 3033, 3036, 6333], boots: 3158, starter: [1055, 2003] },
  kaisa:   { runes: [8008, 9111, 9104, 8014, 8299, 8304, 5005, 5008, 5003], items: [3153, 6610, 3094, 3046, 3036, 3033], boots: 3006, starter: [1055, 2003] },
};

interface ChampionBuild {
  runes: number[];  // [keystone, row1, row2, row3, secondary1, secondary2, shard1, shard2, shard3]
  items: number[];  // core items
  boots: number;
  starter: number[];
}

// ─── Build champion tips (curated; AI fills the rest) ─────────────────────────
const CHAMPION_TIPS: Record<string, string[]> = {
  jinx:    ["Jinx pega muy fuerte con Pescadito (Q en lanzacohetes) en línea. Cambia a Tracatrá cuando el enemigo se acerque.", "Tu Súper Mega Cohete de la Muerte puede robar asesinatos por todo el mapa: vigila el minimapa."],
  caitlyn: ["Coloca trampas a rango de tus autoataques y patea hacia atrás. Los disparos de cabeza son tu ventana de daño.", "Usa la E (Red de 90 Calibres) para reposicionarte, no solo como escape."],
  ezreal:  ["Acierta la Q (Disparo Místico) para resetear la Mutación Arcana. Acierta muchas Q temprano para acumular daño.", "Usa el parpadeo de forma agresiva en línea: Ezreal gana los cambios cortos."],
  ahri:    ["Asalto Espiritual te da tres dashes: guarda uno para emergencias. El encanto es tu enganche, no solo poke.", "Combo: E luego Q, W y R para cerrar distancia y reventar al objetivo antes de que reaccione."],
  zed:     ["Sombra Viviente te deja duplicar todas tus habilidades. La Q desde ambos clones hace muchísimo poke.", "La Marca de la Muerte es mejor cuando el objetivo está por debajo del 50% de vida. Usa la R para esquivar definitivas peligrosas."],
  yasuo:   ["Acumula la Q dos veces para el tornado, luego usa la E a través de un súbdito para golpear el tornado aéreo.", "Último Aliento (R) necesita dos o más enemigos en el aire: busca combos con tu equipo."],
  lux:     ["Atar a un segundo objetivo con la Q es más fácil de lo que parece: apunta al costado de los súbditos.", "Tu pasiva (Iluminación) te permite reventar: Q, E, AA, R, AA para máximo daño."],
  thresh:  ["Engancha a objetivos a mitad de su dash o parpadeo: es más difícil de esquivar.", "El Farol (W) puede salvar a tus tiradores: lánzalo cuando los atrapen."],
  darius:  ["Acumula cinco cargas de Hemorragia en tu objetivo antes de pulsar la R para máximo daño verdadero.", "Guarda tu tirón (E) para cuando los enemigos intenten huir, no como apertura."],
  default: ["Concéntrate en los súbditos al inicio para construir tus objetos con eficiencia.", "Rastrea al jungla enemigo con el minimapa para evitar ganks.", "Comunícate con tu equipo mediante pings en vez del chat."],
};

// ─── Rune slot-level mapping (keystone is row 0) ─────────────────────────────
function getRunePathId(keystoneId: number): number {
  // Precision: 8000-8099, Domination: 8100-8199, Sorcery: 8200-8299, Inspiration: 8300-8399, Resolve: 8400-8499
  if (keystoneId >= 8000 && keystoneId < 8100) return 8000;
  if (keystoneId >= 8100 && keystoneId < 8200) return 8100;
  if (keystoneId >= 8200 && keystoneId < 8300) return 8200;
  if (keystoneId >= 8300 && keystoneId < 8400) return 8300;
  if (keystoneId >= 8400 && keystoneId < 8500) return 8400;
  return 8000;
}

// ─── AI build cache (per champion+patch, long TTL → deterministic) ────────────
interface ResolvedBuild {
  runes: number[];  // same 9-slot shape as ChampionBuild.runes
  items: number[];
  boots: number;
  starter: number[];
  tips: string[];
}
const AI_TTL = 12 * 60 * 60 * 1000; // 12 h
const aiBuildCache = new Map<string, { data: ResolvedBuild; exp: number }>();
// Per-key in-flight promise so concurrent hovers don't spawn duplicate Ollama calls.
const aiBuildInflight = new Map<string, Promise<ResolvedBuild | null>>();

// Personalization cache (puuid+champion → summary), 30 min.
const personalCache = new Map<string, { data: PersonalSummary | null; exp: number }>();
const PERSONAL_TTL = 30 * 60 * 1000;

interface PersonalSummary {
  games: number;
  wins: number;
  winRate: number;
  avgKda: string;
  avgCs: string;
}

// ─── Helpers to resolve AI names → DDragon IDs ───────────────────────────────
function norm(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildRuneNameIndex(runeDataArr: any[]): {
  runeByName: Map<string, { id: number; pathId: number; slotIndex: number }>;
  pathByName: Map<string, number>;
} {
  const runeByName = new Map<string, { id: number; pathId: number; slotIndex: number }>();
  const pathByName = new Map<string, number>();
  for (const path of runeDataArr) {
    pathByName.set(norm(path.name), path.id);
    pathByName.set(norm(path.key), path.id);
    path.slots.forEach((slot: any, slotIndex: number) => {
      for (const rune of slot.runes) {
        runeByName.set(norm(rune.name), { id: rune.id, pathId: path.id, slotIndex });
        runeByName.set(norm(rune.key), { id: rune.id, pathId: path.id, slotIndex });
      }
    });
  }
  return { runeByName, pathByName };
}

// Default rune ids per path (keystone + 3 rows + 2 secondary picks) used to fill
// gaps when the AI returns invalid/translated rune-row names. Keeps the page valid.
function pathDefaultRows(runeDataArr: any[], pathId: number): number[] {
  const path = runeDataArr.find((p: any) => p.id === pathId);
  if (!path) return [];
  // slots[0] = keystones, slots[1..3] = rune rows
  return path.slots.slice(1).map((slot: any) => slot.runes[0]?.id).filter(Boolean);
}

function buildItemNameIndex(itemData: any): Map<string, number> {
  const map = new Map<string, number>();
  for (const [id, item] of Object.entries<any>(itemData.data)) {
    // Skip items not purchasable on Summoner's Rift / not available in store
    if (item?.gold?.purchasable === false) continue;
    if (item?.maps && item.maps['11'] === false) continue;
    const key = norm(item.name);
    // Prefer the first (lowest id) for duplicate names
    if (!map.has(key)) map.set(key, Number(id));
  }
  return map;
}

function resolveItemName(name: string, idx: Map<string, number>): number | null {
  if (!name) return null;
  const n = norm(name);
  if (idx.has(n)) return idx.get(n)!;
  // loose contains match (handles "Ionian Boots" vs "Ionian Boots of Lucidity" etc.)
  for (const [k, v] of idx) {
    if (k.includes(n) || n.includes(k)) return v;
  }
  return null;
}

function resolveRuneName(name: string, idx: Map<string, { id: number; pathId: number; slotIndex: number }>) {
  if (!name) return null;
  const n = norm(name);
  if (idx.has(n)) return idx.get(n)!;
  for (const [k, v] of idx) {
    if (k.includes(n) || n.includes(k)) return v;
  }
  return null;
}

// ─── Call Ollama and resolve names → IDs (cached per champion+patch) ──────────
async function getAiBuild(
  champion: string,
  role: string,
  patch: string,
  runeDataArr: any[],
  itemData: any,
): Promise<ResolvedBuild | null> {
  const cacheKey = `${norm(champion)}::${patch}`;
  const cached = aiBuildCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data;

  const inflight = aiBuildInflight.get(cacheKey);
  if (inflight) return inflight;

  const work = (async (): Promise<ResolvedBuild | null> => {
    const prompt = `You are an expert League of Legends coach. For the champion "${champion}" playing as "${role}", give the optimal current-meta build.
Respond with ONLY valid JSON (no markdown, no extra text) in this EXACT shape:
{
  "keystone": "keystone rune name",
  "primaryRunes": ["primary rune", "primary rune"],
  "secondaryPath": "secondary tree name",
  "secondaryRunes": ["rune", "rune"],
  "shards": ["Adaptive Force", "Adaptive Force", "Health"],
  "coreItems": ["item1", "item2", "item3", "item4", "item5"],
  "boots": "boots name",
  "starterItems": ["starter item"],
  "tips": ["consejo corto en espanol", "consejo corto en espanol"]
}
CRITICAL: Every rune and item MUST use the EXACT official ENGLISH in-game name. DO NOT translate them to Spanish.
- keystone examples: "Conqueror", "Electrocute", "Press the Attack", "Lethal Tempo", "Grasp of the Undying", "Aery", "Phase Rush", "Dark Harvest", "Hail of Blades".
- secondaryPath is one of: "Precision", "Domination", "Sorcery", "Resolve", "Inspiration".
- item examples: "Trinity Force", "Eclipse", "Goredrinker", "Black Cleaver", "Sterak's Gage", "Plated Steelcaps", "Doran's Blade", "Berserker's Greaves".
ONLY the "tips" array must be written in Spanish (short, specific to ${champion}). Everything else stays in English.`;

    let parsed: any = null;
    try {
      const response = await axios.post(OLLAMA_URL, {
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        format: 'json',
      }, { timeout: 120000 });
      const raw = response.data.message?.content?.trim() || '';
      parsed = JSON.parse(raw);
    } catch (err: any) {
      console.warn('[champ-select] Ollama unavailable/invalid for', champion, '-', err?.code ?? err?.message);
      return null;
    }

    const { runeByName, pathByName } = buildRuneNameIndex(runeDataArr);
    const itemIdx = buildItemNameIndex(itemData);

    // Resolve keystone
    const ks = resolveRuneName(String(parsed.keystone ?? ''), runeByName);
    if (!ks) return null; // no valid keystone → caller falls back

    const primaryPathId = ks.pathId;
    const primaryRunes: number[] = [];
    for (const r of (Array.isArray(parsed.primaryRunes) ? parsed.primaryRunes : [])) {
      const hit = resolveRuneName(String(r), runeByName);
      if (hit && hit.pathId === primaryPathId && hit.id !== ks.id && !primaryRunes.includes(hit.id)) {
        primaryRunes.push(hit.id);
      }
    }

    // Secondary path + runes (must differ from primary path)
    let secondaryPathId = pathByName.get(norm(String(parsed.secondaryPath ?? ''))) ?? 0;
    if (secondaryPathId === primaryPathId) secondaryPathId = 0; // can't share the primary tree
    const secondaryRunes: number[] = [];
    for (const r of (Array.isArray(parsed.secondaryRunes) ? parsed.secondaryRunes : [])) {
      const hit = resolveRuneName(String(r), runeByName);
      if (hit && hit.pathId !== primaryPathId && (!secondaryPathId || hit.pathId === secondaryPathId) && !secondaryRunes.includes(hit.id)) {
        if (!secondaryPathId) secondaryPathId = hit.pathId;
        if (hit.pathId === secondaryPathId) secondaryRunes.push(hit.id);
      }
    }

    // Items
    const core: number[] = [];
    for (const it of (Array.isArray(parsed.coreItems) ? parsed.coreItems : [])) {
      const id = resolveItemName(String(it), itemIdx);
      if (id && !core.includes(id)) core.push(id);
    }
    const boots = resolveItemName(String(parsed.boots ?? ''), itemIdx);
    const starter: number[] = [];
    for (const it of (Array.isArray(parsed.starterItems) ? parsed.starterItems : [])) {
      const id = resolveItemName(String(it), itemIdx);
      if (id && !starter.includes(id)) starter.push(id);
    }

    // Validity gate: need keystone + enough core items, else fall back.
    if (core.length < 2) return null;

    // Shards: map to standard shard ids (5008 adaptive, 5005 atk spd, 5002 armor, 5003 mr, 5001 hp)
    const shardMap: Record<string, number> = {
      adaptiveforce: 5008, attackspeed: 5005, abilityhaste: 5007,
      armor: 5002, magicresist: 5003, magicresistance: 5003, health: 5001, scalinghealth: 5001,
    };
    const shards: number[] = [];
    for (const s of (Array.isArray(parsed.shards) ? parsed.shards : [])) {
      const id = shardMap[norm(String(s))];
      if (id) shards.push(id);
    }
    while (shards.length < 3) shards.push([5008, 5008, 5001][shards.length] ?? 5001);

    // Fill any missing primary rune rows deterministically from the keystone's path
    // (the AI often translates/invents row names that don't resolve). This guarantees
    // 3 valid, distinct primary runes on the correct tree instead of blank slots.
    const primaryDefaults = pathDefaultRows(runeDataArr, primaryPathId);
    for (const id of primaryDefaults) {
      if (primaryRunes.length >= 3) break;
      if (!primaryRunes.includes(id)) primaryRunes.push(id);
    }

    // Ensure a secondary path; default to Resolve (or Sorcery for mages) if missing.
    if (!secondaryPathId) {
      secondaryPathId = primaryPathId === 8400 ? 8000 : 8400;
    }
    const secondaryDefaults = pathDefaultRows(runeDataArr, secondaryPathId);
    for (const id of secondaryDefaults) {
      if (secondaryRunes.length >= 2) break;
      if (!secondaryRunes.includes(id)) secondaryRunes.push(id);
    }

    const runes = [
      ks.id,
      primaryRunes[0], primaryRunes[1], primaryRunes[2],
      secondaryRunes[0], secondaryRunes[1],
      shards[0], shards[1], shards[2],
    ];

    const tips = (Array.isArray(parsed.tips) ? parsed.tips : [])
      .map((t: any) => String(t).trim())
      .filter(Boolean)
      .slice(0, 3);

    const resolved: ResolvedBuild = {
      runes,
      items: core.slice(0, 6),
      boots: boots ?? 3020,
      starter: starter.length ? starter.slice(0, 2) : [1055, 2003],
      tips,
    };
    aiBuildCache.set(cacheKey, { data: resolved, exp: Date.now() + AI_TTL });
    return resolved;
  })().finally(() => aiBuildInflight.delete(cacheKey));

  aiBuildInflight.set(cacheKey, work);
  return work;
}

// ─── Optional real-data personalization on this champion ─────────────────────
async function getPersonalSummary(
  region: string,
  puuid: string,
  championName: string,
): Promise<PersonalSummary | null> {
  const key = `${region}::${puuid}::${norm(championName)}`;
  const cached = personalCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.data;

  let summary: PersonalSummary | null = null;
  try {
    const ids = (await getMatchIdsByPUUID(region, puuid, 10, 0)) || [];
    let games = 0, wins = 0, k = 0, d = 0, a = 0, cs = 0;
    for (const id of ids) {
      const match = await getMatchById(region, id);
      const p = (match as any)?.info?.participants?.find((x: any) => x.puuid === puuid);
      if (!p) continue;
      if (norm(p.championName) !== norm(championName)) continue;
      games++;
      if (p.win) wins++;
      k += p.kills || 0; d += p.deaths || 0; a += p.assists || 0;
      cs += (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0);
    }
    if (games > 0) {
      summary = {
        games,
        wins,
        winRate: Math.round((wins / games) * 100),
        avgKda: (d === 0 ? (k + a) : (k + a) / d).toFixed(2),
        avgCs: (cs / games).toFixed(0),
      };
    }
  } catch (err: any) {
    console.warn('[champ-select] personalization skipped:', err?.message);
    summary = null;
  }

  personalCache.set(key, { data: summary, exp: Date.now() + PERSONAL_TTL });
  return summary;
}

async function getPersonalTip(champion: string, role: string, p: PersonalSummary): Promise<string | null> {
  const prompt = `Eres un coach de League of Legends. Analiza estos datos REALES del jugador con ${champion} (${role}) en sus últimas partidas:
- Partidas: ${p.games}, Victorias: ${p.wins} (${p.winRate}% winrate)
- KDA promedio: ${p.avgKda}
- CS promedio por partida: ${p.avgCs}
Da UN consejo personalizado y accionable (máx 140 caracteres, en español) basado en estos datos. Solo el texto del consejo, sin comillas ni explicaciones.`;
  try {
    const response = await axios.post(OLLAMA_URL, {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }, { timeout: 60000 });
    const tip = (response.data.message?.content?.trim() || '').replace(/^["']|["']$/g, '').slice(0, 180);
    return tip || null;
  } catch (err: any) {
    console.warn('[champ-select] personal tip skipped:', err?.code ?? err?.message);
    return null;
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const rawName = (req.query.champion as string ?? '').trim();
  if (!rawName) return res.status(400).json({ ok: false, msg: 'champion param required' });
  const puuid = (req.query.puuid as string ?? '').trim();
  const region = (req.query.region as string ?? '').trim();

  try {
    const patch = await getLatestPatch();
    const champKey = normaliseChampKey(rawName);
    const buildKey = rawName.toLowerCase().replace(/\s/g, '');

    // Fetch champion data from Data Dragon
    let champData: any = null;
    try {
      const cd = await ddFetch<any>(`${patch}/data/en_US/champion/${champKey}.json`);
      champData = cd.data[champKey];
    } catch {
      // Champion key normalisation may differ (e.g. Nunu & Willump = NunuWillump)
      try {
        const allChamps = await ddFetch<any>(`${patch}/data/en_US/champion.json`);
        const found = Object.values<any>(allChamps.data).find(
          (c: any) => c.name.toLowerCase() === rawName.toLowerCase()
        );
        if (found) {
          const cd2 = await ddFetch<any>(`${patch}/data/en_US/champion/${found.id}.json`);
          champData = cd2.data[found.id];
        }
      } catch {}
    }

    // Fetch item data for names/icons
    const itemData = await ddFetch<any>(`${patch}/data/en_US/item.json`);
    function itemInfo(id: number) {
      const item = itemData.data[String(id)];
      if (!item) return { id, name: 'Unknown', icon: '' };
      return {
        id,
        name: item.name,
        icon: `https://ddragon.leagueoflegends.com/cdn/${patch}/img/item/${id}.png`,
        description: item.plaintext ?? '',
      };
    }

    // Fetch rune data
    const runeDataArr = await ddFetch<any[]>(`${patch}/data/en_US/runesReforged.json`);
    function findRune(id: number) {
      for (const path of runeDataArr) {
        for (const slot of path.slots) {
          const rune = slot.runes.find((r: any) => r.id === id);
          if (rune) return { id: rune.id, name: rune.name, icon: `https://ddragon.leagueoflegends.com/cdn/img/${rune.icon}`, path: path.name };
        }
      }
      return { id, name: 'Unknown', icon: '', path: 'Unknown' };
    }
    function findRunePath(id: number) {
      const path = runeDataArr.find((p: any) => p.id === id);
      if (!path) return { id, name: 'Unknown', icon: '' };
      return { id: path.id, name: path.name, icon: `https://ddragon.leagueoflegends.com/cdn/img/${path.icon}` };
    }

    const role = champData?.tags?.[0] ?? 'Fighter';
    const displayName = champData?.name ?? rawName;

    // ── Decide build source: curated > AI > DDragon recommended/default ──────────
    const override = CHAMPION_BUILDS[buildKey];
    let runeIds: number[];
    let itemIds: number[];
    let bootsId: number;
    let starterIds: number[];
    let tips: string[];
    let source: 'curated' | 'ai' | 'fallback';

    if (override) {
      runeIds = override.runes;
      itemIds = override.items;
      bootsId = override.boots;
      starterIds = override.starter;
      tips = CHAMPION_TIPS[buildKey] ?? CHAMPION_TIPS.default;
      source = 'curated';
    } else {
      // Try AI (cached per champion+patch → deterministic, never random)
      const ai = await getAiBuild(displayName, role, patch, runeDataArr, itemData).catch(() => null);
      if (ai && ai.runes[0]) {
        runeIds = ai.runes;
        itemIds = ai.items;
        bootsId = ai.boots;
        starterIds = ai.starter;
        tips = ai.tips.length ? ai.tips : CHAMPION_TIPS.default;
        source = 'ai';
      } else {
        // Graceful fallback: DDragon recommended build + sensible default rune page
        const recItems = champData?.recommended?.[0]?.blocks
          ?.flatMap((b: any) => b.items?.map((i: any) => Number(i.id)) ?? [])
          ?.filter((id: number) => itemData.data[String(id)]) ?? [];
        runeIds = [8005, 9111, 9104, 8014, 8009, 8017, 5005, 5008, 5001];
        itemIds = recItems.length >= 2 ? recItems.slice(0, 6) : [3078, 3071, 3047, 3053, 3065, 3742];
        bootsId = 3047;
        starterIds = [1055, 2003];
        tips = CHAMPION_TIPS.default;
        source = 'fallback';
      }
    }

    // ── Optional real-data personalization ──────────────────────────────────────
    if (puuid && region) {
      const personal = await getPersonalSummary(region, puuid, displayName).catch(() => null);
      if (personal) {
        const personalTip = await getPersonalTip(displayName, role, personal);
        if (personalTip) tips = [personalTip, ...tips].slice(0, 4);
      }
    }

    const primaryPathId = getRunePathId(runeIds[0]);
    const secondaryPathId = getRunePathId(runeIds[4]);

    res.json({
      ok: true,
      champion: displayName,
      patch,
      role,
      winRate: null, // real winRate not computed here; overlay tolerates null (no fake Math.random)
      source,        // 'curated' | 'ai' | 'fallback' (diagnostic)
      portrait: champData ? `https://ddragon.leagueoflegends.com/cdn/${patch}/img/champion/${champData.id}.png` : '',
      runes: {
        primaryPath: findRunePath(primaryPathId),
        secondaryPath: findRunePath(secondaryPathId),
        keystone: findRune(runeIds[0]),
        primary: [findRune(runeIds[1]), findRune(runeIds[2]), findRune(runeIds[3])].filter(r => r.id),
        secondary: [findRune(runeIds[4]), findRune(runeIds[5])].filter(r => r.id),
        shards: runeIds.slice(6),
      },
      items: {
        starter: starterIds.map(itemInfo),
        core: itemIds.map(itemInfo),
        boots: itemInfo(bootsId),
      },
      tips,
    });
  } catch (err: any) {
    console.error('[champ-select]', err?.message);
    res.status(500).json({ ok: false, msg: err?.message });
  }
});

export default router;
