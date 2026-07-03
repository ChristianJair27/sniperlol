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
