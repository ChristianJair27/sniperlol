// src/services/opgg.ts — OP.GG MCP proxy client
// Calls https://mcp-api.op.gg/mcp (no API key required, free public endpoint)
import axios from 'axios';

const MCP_URL = 'https://mcp-api.op.gg/mcp';
const CACHE_TTL = 30 * 60 * 1000; // 30 min

const cache = new Map<string, { data: any; exp: number }>();

// ── Text-format parser ────────────────────────────────────────────────────────
// OP.GG MCP returns a custom text format:
//   class ClassName: field1,field2,...
//   ClassName(val1, val2, ...)
// We parse it into plain JS objects.
function parseOPGGText(text: string): any {
  const lines = text.trim().split('\n');
  const schemas: Record<string, string[]> = {};
  let dataLine = '';

  for (const line of lines) {
    const m = line.match(/^class (\w+): (.+)$/);
    if (m) {
      schemas[m[1]] = m[2].split(',').map(s => s.trim());
    } else if (line.trim() && !line.startsWith('class ')) {
      dataLine = line.trim();
    }
  }

  if (!dataLine) return null;

  let pos = 0;

  function skipWs() { while (pos < dataLine.length && dataLine[pos] === ' ') pos++; }

  function parseVal(): any {
    skipWs();
    if (pos >= dataLine.length) return null;
    const ch = dataLine[pos];

    if (ch === '"') {
      pos++;
      let s = '';
      while (pos < dataLine.length) {
        const c = dataLine[pos];
        if (c === '\\') {
          pos++;
          const esc = dataLine[pos++];
          s += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc; // handles \/ → /
          continue;
        }
        if (c === '"') { pos++; break; }
        s += c; pos++;
      }
      return s;
    }

    if (ch === '[') {
      pos++;
      const arr: any[] = [];
      skipWs();
      while (pos < dataLine.length && dataLine[pos] !== ']') {
        arr.push(parseVal());
        skipWs();
        if (dataLine[pos] === ',') pos++;
        skipWs();
      }
      if (dataLine[pos] === ']') pos++;
      return arr;
    }

    const rest = dataLine.slice(pos);
    if (rest.startsWith('null'))  { pos += 4; return null; }
    if (rest.startsWith('true'))  { pos += 4; return true; }
    if (rest.startsWith('false')) { pos += 5; return false; }

    // Token: identifier or number
    let token = '';
    while (pos < dataLine.length && !/[,\[\]()\s]/.test(dataLine[pos])) {
      token += dataLine[pos++];
    }

    skipWs();
    if (dataLine[pos] === '(' && schemas[token]) {
      pos++;
      const fields = schemas[token];
      const obj: Record<string, any> = {};
      skipWs();
      for (let i = 0; i < fields.length; i++) {
        skipWs();
        if (pos >= dataLine.length || dataLine[pos] === ')') break;
        if (i > 0) { if (dataLine[pos] === ',') pos++; skipWs(); }
        if (dataLine[pos] === ')') break;
        obj[fields[i]] = parseVal();
      }
      skipWs();
      if (dataLine[pos] === ')') pos++;
      return obj;
    }

    // Unknown class — skip its args
    if (dataLine[pos] === '(') {
      let depth = 0;
      while (pos < dataLine.length) {
        if (dataLine[pos] === '(') depth++;
        else if (dataLine[pos] === ')') { depth--; pos++; if (depth === 0) break; continue; }
        pos++;
      }
      return { _type: token };
    }

    const num = parseFloat(token);
    return (!isNaN(num) && token !== '') ? num : token;
  }

  try { return parseVal(); } catch { return null; }
}

// ── MCP tool call ─────────────────────────────────────────────────────────────
async function callTool(name: string, args: Record<string, any>): Promise<any> {
  const { data: json } = await axios.post(MCP_URL, {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: { name, arguments: args }
  }, { timeout: 15000 });

  if (json.error) throw new Error(String(json.error.message ?? json.error));
  const text: string = json.result?.content?.[0]?.text ?? '';
  if (!text) return null;
  // Log first 800 chars of raw text so we can see the class schema definitions
  if (name === 'lol_get_summoner_profile') {
    console.log('[opgg-raw] first 800 chars:\n', text.slice(0, 800));
  }
  return parseOPGGText(text);
}

// ── Champion name converter: "Miss Fortune" → "MISS_FORTUNE" ──────────────────
export function toOPGGChampName(name: string): string {
  return name
    .toUpperCase()
    .replace(/['&.]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/, '');
}

// ── Position mapper: LCDA / DDragon role → OP.GG position ────────────────────
const POS_MAP: Record<string, string> = {
  TOP: 'top', JUNGLE: 'jungle', MIDDLE: 'mid',
  BOTTOM: 'adc', UTILITY: 'support',
  MID: 'mid', ADC: 'adc', SUPPORT: 'support',
  Fighter: 'top', Mage: 'mid', Marksman: 'adc',
  Tank: 'top', Assassin: 'mid', Support: 'support',
};

// ── Region normaliser: "NA1" → "NA", "EUW1" → "EUW" ─────────────────────────
export function normaliseRegion(platform: string): string {
  const r: Record<string, string> = {
    NA1: 'NA', EUW1: 'EUW', EUNE1: 'EUNE', KR: 'KR', BR1: 'BR',
    LA1: 'LAN', LA2: 'LAS', OC1: 'OCE', JP1: 'JP', RU: 'RU', TR1: 'TR', SG2: 'SG',
  };
  return r[platform.toUpperCase()] ?? platform.toUpperCase().replace(/\d+$/, '');
}

// ── Champion build (runes, items, skills) ─────────────────────────────────────
export interface OPGGBuild {
  rune_ids: number[];       // [keystone, prim1, prim2, prim3, sec1, sec2, shard1, shard2, shard3]
  primary_rune_names: string[];
  secondary_rune_names: string[];
  primary_path_id: number;
  secondary_path_id: number;
  core_item_ids: number[];
  core_item_names: string[];
  boots_id: number;
  boots_name: string;
  starter_ids: number[];
  starter_names: string[];
  skill_order: string[];    // e.g. ["Q","W","E","Q","Q","R",...]
  win_rate: number | null;  // 0-1
  pick_rate: number | null;
  ban_rate: number | null;
  tier: number | null;
  rank: number | null;
}

export async function getChampionBuild(
  championName: string,
  position: string,
): Promise<OPGGBuild | null> {
  const opggPos  = POS_MAP[position] ?? 'all';
  const opggChamp = toOPGGChampName(championName);
  const cacheKey = `build:${opggChamp}:${opggPos}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data as OPGGBuild;

  try {
    const result = await callTool('lol_get_champion_analysis', {
      game_mode: 'ranked',
      champion: opggChamp,
      position: opggPos,
      desired_output_fields: [
        'data.runes',
        'data.core_items',
        'data.boots',
        'data.starter_items',
        'data.skills',
        'data.summary.average_stats',
      ],
    });

    const d = result?.data;
    if (!d?.runes?.primary_rune_ids?.length) return null;

    const runes = d.runes;
    const stat_mods: number[] = Array.isArray(runes.stat_mod_ids) ? runes.stat_mod_ids : [];
    const rune_ids = [
      ...(runes.primary_rune_ids  as number[]),   // [keystone, row1, row2, row3]
      ...(runes.secondary_rune_ids as number[]),  // [sec1, sec2]
      ...stat_mods.slice(0, 3),                   // [shard1, shard2, shard3]
    ];
    // Pad to 9 slots with fallbacks
    while (rune_ids.length < 9) rune_ids.push(5001);

    const avg = d.summary?.average_stats;
    const build: OPGGBuild = {
      rune_ids,
      primary_rune_names: runes.primary_rune_names ?? [],
      secondary_rune_names: runes.secondary_rune_names ?? [],
      primary_path_id: runes.primary_page_id ?? 8000,
      secondary_path_id: runes.secondary_page_id ?? 8300,
      core_item_ids: d.core_items?.ids ?? [],
      core_item_names: d.core_items?.ids_names ?? [],
      boots_id: d.boots?.ids?.[0] ?? 3006,
      boots_name: d.boots?.ids_names?.[0] ?? '',
      starter_ids: d.starter_items?.ids ?? [],
      starter_names: d.starter_items?.ids_names ?? [],
      skill_order: d.skills?.order ?? [],
      win_rate: avg?.win_rate ?? null,
      pick_rate: avg?.pick_rate ?? null,
      ban_rate: avg?.ban_rate ?? null,
      tier: avg?.tier ?? null,
      rank: avg?.rank ?? null,
    };

    cache.set(cacheKey, { data: build, exp: Date.now() + CACHE_TTL });
    return build;
  } catch (err: any) {
    console.warn('[opgg] champion build failed:', err?.message);
    return null;
  }
}

// ── Lane meta (tier list) ─────────────────────────────────────────────────────
// Uses ONE call to lol_list_lane_meta_champions which returns real OP.GG tiers +
// win/pick/ban rates for every position at once.
export interface LaneMetaChamp {
  name: string;      // OP.GG champion display name, e.g. "Miss Fortune"
  winRate: number;   // 0-1 fraction
  pickRate: number;  // 0-1 fraction
  banRate: number;   // 0-1 fraction
  tier: number;      // 1 = best
  rank: number;      // 1 = best
  kda: number;
}

// Incoming position (LCU / role) → positions map key
const LANE_KEY: Record<string, string> = {
  MIDDLE: 'mid', MID: 'mid',
  TOP: 'top',
  JUNGLE: 'jungle', JG: 'jungle',
  BOTTOM: 'adc', BOT: 'adc', ADC: 'adc',
  UTILITY: 'support', SUPPORT: 'support', SUP: 'support',
};
// positions key → OP.GG lane argument
const KEY_LANE: Record<string, string> = {
  mid: 'MIDDLE', top: 'TOP', jungle: 'JUNGLE', adc: 'BOTTOM', support: 'UTILITY',
};

export async function getLaneMeta(position: string): Promise<LaneMetaChamp[]> {
  const key = LANE_KEY[(position ?? '').toUpperCase()] ?? 'mid';
  const cacheKey = `laneMeta:${key}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data as LaneMetaChamp[];

  try {
    const lane = KEY_LANE[key] ?? 'MIDDLE';
    // NOTE: the tool returns ALL positions regardless of the lane argument.
    const parsed = await callTool('lol_list_lane_meta_champions', { lane });
    const positions = parsed?.data?.positions ?? {};

    let arr: any[] = Array.isArray(positions[key]) ? positions[key] : [];
    if (!arr.length) {
      // Fallback: use the first non-empty positions array we can find.
      for (const k of Object.keys(positions)) {
        if (Array.isArray(positions[k]) && positions[k].length) { arr = positions[k]; break; }
      }
    }

    const meta: LaneMetaChamp[] = arr.slice(0, 15).map((e: any) => ({
      name: String(e?.champion ?? ''),
      winRate: typeof e?.win_rate === 'number' ? e.win_rate : 0,
      pickRate: typeof e?.pick_rate === 'number' ? e.pick_rate : 0,
      banRate: typeof e?.ban_rate === 'number' ? e.ban_rate : 0,
      tier: typeof e?.tier === 'number' ? e.tier : 5,
      rank: typeof e?.rank === 'number' ? e.rank : 99,
      kda: typeof e?.kda === 'number' ? e.kda : 0,
    })).filter(m => m.name);

    cache.set(cacheKey, { data: meta, exp: Date.now() + CACHE_TTL });
    return meta;
  } catch (err: any) {
    console.warn('[opgg] lane meta failed:', err?.message);
    return [];
  }
}

// ── DDragon champion name → numeric championId resolver ───────────────────────
// The overlay's cdPortrait() builds a communitydragon champion-icons URL from the
// NUMERIC championId (DDragon `.key`, e.g. Miss Fortune = 21), so we resolve to that.
interface DDragonMaps { byName: Record<string, number>; byKeyId: Record<string, number>; }

function normName(s: string): string { return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

// OP.GG display-name quirks → DDragon key id (`.id`), normalised.
const OPGG_NAME_ALIAS: Record<string, string> = {
  wukong: 'monkeyking',
  nunuwillump: 'nunu',
  renataglasc: 'renata',
};

async function getDDragonMaps(): Promise<DDragonMaps | null> {
  const cacheKey = 'ddragon:champmap';
  const cached = cache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data as DDragonMaps;

  try {
    const { data: versions } = await axios.get(
      'https://ddragon.leagueoflegends.com/api/versions.json', { timeout: 15000 });
    const version = Array.isArray(versions) && versions.length ? versions[0] : '15.1.1';
    const { data: champJson } = await axios.get(
      `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`,
      { timeout: 15000 });

    const byName: Record<string, number> = {};
    const byKeyId: Record<string, number> = {};
    const entries = champJson?.data ?? {};
    for (const k of Object.keys(entries)) {
      const c = entries[k];
      const numId = parseInt(c?.key, 10);
      if (isNaN(numId)) continue;
      byName[normName(c?.name)] = numId; // display name, e.g. "Miss Fortune"
      byKeyId[normName(c?.id)] = numId;   // key string, e.g. "MissFortune"
    }
    const maps: DDragonMaps = { byName, byKeyId };
    cache.set(cacheKey, { data: maps, exp: Date.now() + CACHE_TTL });
    return maps;
  } catch (err: any) {
    console.warn('[opgg] ddragon champion map failed:', err?.message);
    return null;
  }
}

export async function resolveChampionId(name: string): Promise<number | null> {
  if (!name) return null;
  const maps = await getDDragonMaps();
  if (!maps) return null;
  const n = normName(name);
  const alias = OPGG_NAME_ALIAS[n];
  if (alias && maps.byKeyId[alias] != null) return maps.byKeyId[alias];
  if (maps.byName[n] != null) return maps.byName[n];
  if (maps.byKeyId[n] != null) return maps.byKeyId[n];
  return null;
}

// ── ARAM augments (real pick-rate + performance per champion) ─────────────────
export interface AramAugment {
  id: number;
  name: string;
  desc: string;
  tier: number;         // OP.GG tier (3+ returned; higher = stronger)
  performance: number;  // ~100 = average; higher is better on this champ
  pickRate: number;     // 0-1 (share of games this augment is taken on the champ)
}

export async function getAramAugments(championName: string): Promise<AramAugment[]> {
  const champId = await resolveChampionId(championName);
  if (!champId) return [];
  const cacheKey = `aramaug:${champId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data as AramAugment[];
  try {
    const result = await callTool('lol_list_aram_augments', { champion_id: champId });
    const augs = result?.data?.augments;
    if (!Array.isArray(augs)) return [];
    const out: AramAugment[] = augs
      .map((a: any) => ({
        id: Number(a.id),
        name: String(a.name ?? ''),
        desc: String(a.desc ?? '').replace(/<[^>]+>/g, ''), // strip rich-text tags
        tier: Number(a.tier) || 0,
        performance: Number(a.performance) || 0,
        pickRate: Number(a.popular) || 0,
      }))
      .filter((a: AramAugment) => a.id && a.name);
    out.sort((a, b) => b.pickRate - a.pickRate); // most-picked first
    cache.set(cacheKey, { data: out, exp: Date.now() + CACHE_TTL });
    return out;
  } catch (e: any) {
    console.error('[opgg] getAramAugments failed:', e?.message);
    return [];
  }
}

// ── Arena augment metadata (CommunityDragon: name/icon/rarity/desc) ────────────
// OP.GG has no Arena augment stats, but CommunityDragon has the full metadata so
// we can render the offered/picked Arena augments cleanly (real icons + rarity).
export interface ArenaAugmentMeta {
  id: number;
  name: string;
  desc: string;
  rarity: number;   // 0=silver, 1=gold, 2=prismatic (higher can appear for special anvils)
  icon: string;     // absolute CommunityDragon icon URL
}
const CDRAGON_ARENA = 'https://raw.communitydragon.org/latest/cdragon/arena/en_us.json';
const CDRAGON_GAME  = 'https://raw.communitydragon.org/latest/game/';

export async function getArenaAugmentMeta(): Promise<Record<number, ArenaAugmentMeta>> {
  const cacheKey = 'arenaAugMeta';
  const cached = cache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data as Record<number, ArenaAugmentMeta>;
  try {
    const { data } = await axios.get(CDRAGON_ARENA, { timeout: 15000 });
    const list: any[] = Array.isArray(data?.augments) ? data.augments : [];
    const map: Record<number, ArenaAugmentMeta> = {};
    for (const a of list) {
      const id = Number(a.id);
      if (!id) continue;
      const iconPath = (a.iconLarge || a.iconSmall || '').toLowerCase();
      map[id] = {
        id,
        name: String(a.name ?? ''),
        desc: String(a.desc ?? '').replace(/<[^>]+>/g, ''),
        rarity: Number(a.rarity) || 0,
        icon: iconPath ? CDRAGON_GAME + iconPath : '',
      };
    }
    cache.set(cacheKey, { data: map, exp: Date.now() + 6 * 60 * 60 * 1000 }); // 6h
    return map;
  } catch (e: any) {
    console.error('[opgg] getArenaAugmentMeta failed:', e?.message);
    return {};
  }
}

// ── Summoner full profile ─────────────────────────────────────────────────────
export interface OPGGChampStat {
  champion_name: string;
  play: number;
  win: number;
  lose: number;
  kill: number;        // CAREER TOTAL — divide by play to get per-game average
  death: number;
  assist: number;
  op_score: number;
  server_rank: number | null;
}

export interface OPGGFullProfile {
  rank: OPGGRank;
  champion_stats: OPGGChampStat[];
  level: number | null;
  profile_image_url: string | null;
  is_hot_streak: boolean;
  is_veteran: boolean;
  is_fresh_blood: boolean;
}

export async function getSummonerFullProfile(
  gameName: string,
  tagLine: string,
  region: string,
): Promise<OPGGFullProfile | null> {
  const cacheKey = `full:${normaliseRegion(region)}:${gameName.toLowerCase()}:${tagLine.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data as OPGGFullProfile;

  try {
    const result = await callTool('lol_get_summoner_profile', {
      game_name: gameName,
      tag_line: tagLine,
      region: normaliseRegion(region),
      desired_output_fields: [
        'data.summoner.level',
        'data.summoner.profile_image_url',
        'data.summoner.league_stats',
        'data.summoner.ladder_rank',
        'data.summoner.most_champions.champion_stats',
        'data.summoner.most_champions',
        'data.summoner.ranked_most_champions',
        'data.summoner.ranked_most_champions.my_champion_stats',
        'data.summoner.ranked_most_champions.my_champion_stats.rank',
        'data.summoner.ranked_most_champions.my_champion_stats.champion_name',
      ],
    });

    const summoner = result?.data?.summoner;
    if (!summoner) return null;

    // Debug: log ranked_most_champions structure to see what OP.GG returns
    if (summoner.ranked_most_champions) {
      console.log('[opgg] ranked_most_champions keys:', Object.keys(summoner.ranked_most_champions ?? {}));
      const sample = (summoner.ranked_most_champions?.my_champion_stats ?? summoner.ranked_most_champions?.champion_stats ?? [])?.[0];
      if (sample) console.log('[opgg] ranked_most_champions[0] keys:', Object.keys(sample));
    }

    const solo = (summoner.league_stats as any[])?.find(
      (s: any) => s.game_type === 'SOLORANKED'
    );
    const tier = solo?.tier_info;
    const w = solo?.win ?? 0;
    const l = solo?.lose ?? 0;

    const rank: OPGGRank = {
      tier: tier?.tier ?? null,
      division: tier?.division ?? null,
      lp: tier?.lp ?? null,
      wins: w,
      losses: l,
      win_rate: w + l > 0 ? Math.round((w / (w + l)) * 100) : null,
      tier_image_url: tier?.tier_image_url ?? null,
      ladder_rank: summoner.ladder_rank?.rank ?? null,
      ladder_total: summoner.ladder_rank?.total ?? null,
    };

    // Build per-champion server rank from ranked_most_champions if available.
    // OP.GG MCP may return the list under different field names depending on schema version.
    const rmc = summoner.ranked_most_champions;
    const rankedChamps: any[] =
      rmc?.my_champion_stats ?? rmc?.champion_stats ?? (Array.isArray(rmc) ? rmc : []);
    const rankByChamp: Record<string, number> = {};
    for (const rc of rankedChamps) {
      // Field may be 'rank', 'server_rank', or 'ranking'
      const pos = rc.rank ?? rc.server_rank ?? rc.ranking ?? null;
      if (rc.champion_name && pos != null) rankByChamp[rc.champion_name] = pos;
    }

    const rawChampStats: any[] = summoner.most_champions?.champion_stats ?? [];
    const champion_stats: OPGGChampStat[] = rawChampStats.map((cs: any) => ({
      champion_name: cs.champion_name ?? '',
      play: cs.play ?? 0,
      win: cs.win ?? 0,
      lose: cs.lose ?? 0,
      kill: cs.kill ?? 0,
      death: cs.death ?? 0,
      assist: cs.assist ?? 0,
      op_score: cs.op_score ?? 0,
      server_rank: rankByChamp[cs.champion_name ?? ''] ?? null,
    }));

    const profile: OPGGFullProfile = {
      rank,
      champion_stats,
      level: summoner.level ?? null,
      profile_image_url: summoner.profile_image_url ?? null,
      is_hot_streak: solo?.is_hot_streak ?? false,
      is_veteran: solo?.is_veteran ?? false,
      is_fresh_blood: solo?.is_fresh_blood ?? false,
    };

    cache.set(cacheKey, { data: profile, exp: Date.now() + CACHE_TTL });
    return profile;
  } catch (err: any) {
    console.warn('[opgg] summoner full profile failed:', err?.message);
    return null;
  }
}

// ── Summoner rank ──────────────────────────────────────────────────────────────
export interface OPGGRank {
  tier: string | null;
  division: number | null;
  lp: number | null;
  wins: number;
  losses: number;
  win_rate: number | null;   // 0-100
  tier_image_url: string | null;
  ladder_rank: number | null;
  ladder_total: number | null;
}

export async function getSummonerRank(
  gameName: string,
  tagLine: string,
  region: string,
): Promise<OPGGRank | null> {
  const cacheKey = `rank:${normaliseRegion(region)}:${gameName.toLowerCase()}:${tagLine.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return cached.data as OPGGRank;

  try {
    const result = await callTool('lol_get_summoner_profile', {
      game_name: gameName,
      tag_line: tagLine,
      region: normaliseRegion(region),
      desired_output_fields: [
        'data.summoner.league_stats',
        'data.summoner.ladder_rank',
      ],
    });

    const summoner = result?.data?.summoner;
    if (!summoner) return null;

    const solo = (summoner.league_stats as any[])?.find(
      (s: any) => s.game_type === 'SOLORANKED'
    );
    const tier = solo?.tier_info;
    const w = solo?.win ?? 0;
    const l = solo?.lose ?? 0;

    const rank: OPGGRank = {
      tier: tier?.tier ?? null,
      division: tier?.division ?? null,
      lp: tier?.lp ?? null,
      wins: w,
      losses: l,
      win_rate: w + l > 0 ? Math.round((w / (w + l)) * 100) : null,
      tier_image_url: tier?.tier_image_url ?? null,
      ladder_rank: summoner.ladder_rank?.rank ?? null,
      ladder_total: summoner.ladder_rank?.total ?? null,
    };

    cache.set(cacheKey, { data: rank, exp: Date.now() + CACHE_TTL });
    return rank;
  } catch (err: any) {
    console.warn('[opgg] summoner rank failed:', err?.message);
    return null;
  }
}
