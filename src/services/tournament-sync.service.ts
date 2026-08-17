// Background + on-demand sync: gameIds from tournament codes, Match-V5 stats, auto-results.
import { pool } from '../db.js';
import { getGamesByCode } from './riot-tournament.service.js';
import { getMatchById, getAccountByRiotId, getMatchIdsByPUUID } from './riot.js';

type BracketMatch = {
  id: string; round: number; matchNumber: number;
  team1: string | null; team2: string | null;
  winner: string | null; code: string | null;
  matchStatus: string;
  score1?: number; score2?: number;
  gameId?: number; gameRegion?: string;
  team1Puuids?: string[]; team2Puuids?: string[];
  codeActivatedAt?: number;
  games?: Array<{ gameId: number; gameRegion?: string; winner?: string | null; ambiguous?: boolean }>;
  seriesTo?: number;
  scheduledAt?: string | null;
  forfeit?: boolean;
  /** Algún juego del código quedó sin ganador atribuible (lados mezclados). */
  needsManualResult?: boolean;
};

type TournamentData = {
  id: string; name: string; phase: string;
  participants: number; maxParticipants: number;
  prize: string; startDate: string; format: string; description: string;
  riotTournamentId?: number;
  codePool: string[];
  bracket?: BracketMatch[];
  standings?: Array<{ position: number; team: string; wins: number; losses: number; points: number }>;
  checkinDeadline?: string;
  createdBy?: number;
  region?: string;
  logoUrl?: string;
  bannerUrl?: string;
  bracketType?: string;
  seriesTo?: number;
  finalSeriesTo?: number;
  /** Suizo: rondas planeadas → habilita avance automático + cierre. */
  swissRounds?: number;
  /** Formato custom: tamaño de equipo (1-5) y mapa (SR/ARAM/ARENA). */
  teamSize?: number;
  gameMap?: string;
  pickType?: string;
  /** Ladder Arena: fin de ventana + estado de puntuación. */
  endDate?: string;
  ladder?: {
    processed: string[];
    teams: Record<string, { games: Array<{ matchId: string; placement: number; at: number }>; points: number }>;
  };
};

function parseJson(v: unknown) {
  if (!v) return undefined;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

function riotRegionToPlatform(region: string): string {
  const m: Record<string, string> = {
    LAN: 'la1', LA1: 'la1', LA2: 'la2', LAS: 'la2', NA1: 'na1', NA: 'na1', BR1: 'br1', BR: 'br1',
    EUW1: 'euw1', EUW: 'euw1', EUN1: 'eun1', EUNE: 'eun1', KR: 'kr', JP1: 'jp1', OC1: 'oc1', RU: 'ru', TR1: 'tr1',
  };
  return m[region.toUpperCase()] || 'la1';
}

function riotMatchId(gameId: number, platform: string) {
  return `${platform.toUpperCase()}_${gameId}`;
}

async function getT(id: string): Promise<TournamentData | null> {
  const [[row]] = await pool.query<any[]>('SELECT * FROM tournaments WHERE id = ?', [id]);
  if (!row) return null;
  return {
    id: row.id, name: row.name, phase: row.phase,
    participants: row.participants, maxParticipants: row.max_participants,
    prize: row.prize, startDate: row.start_date, format: row.format,
    description: row.description || '',
    riotTournamentId: row.riot_tournament_id || undefined,
    codePool: parseJson(row.code_pool) || [],
    bracket: parseJson(row.bracket) || undefined,
    standings: parseJson(row.standings) || undefined,
    checkinDeadline: row.checkin_deadline || undefined,
    createdBy: row.created_by || undefined,
    region: row.region || 'la1',
    logoUrl: row.logo_url || undefined,
    bannerUrl: row.banner_url || undefined,
    bracketType: row.bracket_type || 'single_elim',
    seriesTo: Number(row.series_to) || 1,
    finalSeriesTo: Number(row.final_series_to) || Number(row.series_to) || 1,
    swissRounds: row.swiss_rounds ? Number(row.swiss_rounds) : undefined,
    teamSize: Math.min(5, Math.max(1, Number(row.team_size) || 5)),
    gameMap: row.game_map || 'SR',
    pickType: row.pick_type || undefined,
    endDate: row.end_date || undefined,
    ladder: parseJson(row.ladder) || undefined,
  };
}

async function saveT(t: TournamentData) {
  await pool.query(
    `UPDATE tournaments SET
       phase=?, participants=?, max_participants=?, prize=?, start_date=?,
       format=?, description=?, riot_tournament_id=?,
       code_pool=?, bracket=?, standings=?, checkin_deadline=?,
       region=?, logo_url=?, banner_url=?, end_date=?, ladder=?
     WHERE id=?`,
    [
      t.phase, t.participants, t.maxParticipants, t.prize, t.startDate,
      t.format, t.description, t.riotTournamentId ?? null,
      JSON.stringify(t.codePool),
      t.bracket ? JSON.stringify(t.bracket) : null,
      t.standings ? JSON.stringify(t.standings) : null,
      t.checkinDeadline ?? null,
      t.region ?? 'la1',
      t.logoUrl ?? null,
      t.bannerUrl ?? null,
      t.endDate ?? null,
      t.ladder ? JSON.stringify(t.ladder) : null,
      t.id,
    ]
  );
}

export async function tryDetectGameId(
  code: string, fallbackRegion: string
): Promise<{ gameId: number; platform: string } | null> {
  try {
    const games = await getGamesByCode(code);
    if (!games.length) return null;
    const latest = games[games.length - 1];
    const platform = riotRegionToPlatform(latest.region || fallbackRegion);
    return { gameId: Number(latest.gameId), platform };
  } catch {
    return null;
  }
}

/** Series Bo3/Bo5: TODOS los juegos registrados con el código del enfrentamiento. */
export async function detectAllGamesByCode(
  code: string, fallbackRegion: string
): Promise<Array<{ gameId: number; platform: string }>> {
  try {
    const games = await getGamesByCode(code);
    return (games || []).map((g: any) => ({
      gameId: Number(g.gameId),
      platform: riotRegionToPlatform(g.region || fallbackRegion),
    })).filter(g => Number.isFinite(g.gameId) && g.gameId > 0);
  } catch {
    return [];
  }
}

function parseParticipant(p: any, gameDuration: number) {
  const cs = (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0);
  const mins = Math.max(1, gameDuration / 60);
  return {
    summonerName: p.riotIdGameName || p.summonerName || 'Invocador',
    tagLine: p.riotIdTagline || p.riotIdTagLine || '',
    championName: p.championName,
    champLevel: p.champLevel,
    teamId: p.teamId,
    win: p.win,
    kills: p.kills ?? 0,
    deaths: p.deaths ?? 0,
    assists: p.assists ?? 0,
    kda: p.deaths === 0 ? (p.kills + p.assists) : ((p.kills + p.assists) / p.deaths),
    cs,
    csPerMin: Math.round((cs / mins) * 10) / 10,
    goldEarned: p.goldEarned ?? 0,
    totalDamageDealt: p.totalDamageDealtToChampions ?? 0,
    physicalDamage: p.physicalDamageDealtToChampions ?? 0,
    magicDamage: p.magicDamageDealtToChampions ?? 0,
    trueDamage: p.trueDamageDealtToChampions ?? 0,
    damageTaken: p.totalDamageTaken ?? 0,
    healingDone: p.totalHeal ?? 0,
    visionScore: p.visionScore ?? 0,
    wardsPlaced: p.wardsPlaced ?? 0,
    wardsKilled: p.wardsKilled ?? 0,
    items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map(Number),
    summoner1Id: p.summoner1Id ?? 0,
    summoner2Id: p.summoner2Id ?? 0,
    perks: {
      keystoneId: p.perks?.styles?.[0]?.selections?.[0]?.perk ?? 0,
      secondaryStyleId: p.perks?.styles?.[1]?.style ?? 0,
    },
    pentaKills: p.pentaKills ?? 0,
    quadraKills: p.quadraKills ?? 0,
    tripleKills: p.tripleKills ?? 0,
    doubleKills: p.doubleKills ?? 0,
    firstBloodKill: p.firstBloodKill ?? false,
    teamPosition: p.teamPosition || p.role || '',
    largestMultiKill: p.largestMultiKill ?? 0,
    killingSprees: p.killingSprees ?? 0,
    totalTimeCCDealt: p.totalTimeCCDealt ?? 0,
    challenges: p.challenges ? {
      killParticipation: p.challenges.killParticipation,
      kda: p.challenges.kda,
      damagePerMinute: p.challenges.damagePerMinute,
      goldPerMinute: p.challenges.goldPerMinute,
      visionScorePerMinute: p.challenges.visionScorePerMinute,
      soloKills: p.challenges.soloKills,
      pentaKills: p.challenges.multikills,
    } : undefined,
  };
}

function parseTeamObjectives(team: any) {
  const obj = team?.objectives ?? {};
  return {
    win: team?.win ?? false,
    bans: team?.bans ?? [],
    baronKills: obj.baron?.kills ?? 0,
    dragonKills: obj.dragon?.kills ?? 0,
    towerKills: obj.tower?.kills ?? 0,
    inhibitorKills: obj.inhibitor?.kills ?? 0,
    riftHeraldKills: obj.riftHerald?.kills ?? 0,
    firstBaron: obj.baron?.first ?? false,
    firstDragon: obj.dragon?.first ?? false,
    firstTower: obj.tower?.first ?? false,
  };
}

function buildMatchStatsResponse(data: any, riotMatchIdStr: string, isComplete: boolean) {
  const info = data.info;
  const dur = info.gameDuration as number;
  const participants: any[] = info.participants.map((p: any) => parseParticipant(p, dur));
  const blueTeamRaw = (info.teams as any[]).find((t: any) => t.teamId === 100);
  const redTeamRaw = (info.teams as any[]).find((t: any) => t.teamId === 200);
  const winnerTeamId = (info.teams as any[]).find((t: any) => t.win)?.teamId;
  return {
    matchId: riotMatchIdStr,
    gameDuration: dur,
    gameStartTimestamp: info.gameStartTimestamp,
    gameEndTimestamp: info.gameEndTimestamp,
    gameMode: info.gameMode,
    isComplete,
    winner: winnerTeamId === 100 ? 'blue' : winnerTeamId === 200 ? 'red' : null,
    blueTeam: participants.filter((p: any) => p.teamId === 100),
    redTeam: participants.filter((p: any) => p.teamId === 200),
    blueObjectives: parseTeamObjectives(blueTeamRaw),
    redObjectives: parseTeamObjectives(redTeamRaw),
  };
}

async function saveMatchStats(
  tournamentId: string, bracketMatchId: string, riotMatchIdStr: string,
  gameId: number, parsedData: object, gameDuration: number, gameEndTs?: number
) {
  await pool.query(
    `INSERT INTO tournament_match_stats
       (tournament_id, bracket_match_id, riot_match_id, game_id, parsed_data, game_duration, game_end_ts)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       parsed_data=VALUES(parsed_data), game_duration=VALUES(game_duration), game_end_ts=VALUES(game_end_ts)`,
    [tournamentId, bracketMatchId, riotMatchIdStr, gameId, JSON.stringify(parsedData), gameDuration, gameEndTs ?? null]
  );
}

async function fetchMatchData(gameId: number, primaryPlatform: string) {
  const tryPlatforms = primaryPlatform === 'la1' ? ['la1', 'la2', primaryPlatform]
    : primaryPlatform === 'la2' ? ['la2', 'la1']
    : [primaryPlatform];
  const extra = ['na1', 'br1'].filter(p => !tryPlatforms.includes(p));

  for (const pf of [...tryPlatforms, ...extra]) {
    const data = await getMatchById(pf, riotMatchId(gameId, pf));
    if (data) return { data, platform: pf };
  }
  return null;
}

/** Resolve winner from Match-V5 participants when callback PUUID matching failed. */
export async function resolveWinnerFromMatch(
  t: TournamentData,
  match: BracketMatch,
  matchData: any
): Promise<string | null> {
  if (!match.team1 || !match.team2) return null;

  const platform = match.gameRegion || t.region || 'la1';
  let t1Puuids = match.team1Puuids ?? [];
  let t2Puuids = match.team2Puuids ?? [];

  // Re-resolve from roster if allowlists were empty at code-gen time
  if (!t1Puuids.length || !t2Puuids.length) {
    const [regRows] = await pool.query<any[]>(
      'SELECT team_name, captain_riot_id, players FROM tournament_registrations WHERE tournament_id = ?',
      [t.id]
    );
    for (const row of regRows) {
      const players = parseJson(row.players) || [];
      const ids = [row.captain_riot_id, ...players.map((p: any) => p.riotId)].filter(Boolean);
      const puuids: string[] = [];
      for (const rid of ids) {
        const stored = players.find((p: any) => p.riotId === rid);
        if (stored?.puuid) { puuids.push(stored.puuid); continue; }
        const [gn, tl] = String(rid).split('#');
        if (!gn || !tl) continue;
        try {
          const acc = await getAccountByRiotId(gn.trim(), tl.trim(), { platformHint: platform });
          if (acc?.puuid) puuids.push(acc.puuid);
        } catch { /* skip */ }
      }
      if (row.team_name === match.team1) t1Puuids = [...new Set([...t1Puuids, ...puuids])];
      if (row.team_name === match.team2) t2Puuids = [...new Set([...t2Puuids, ...puuids])];
    }
  }

  const participants: any[] = matchData.info?.participants ?? [];
  const partPuuids: string[] = [];
  for (const p of participants) {
    if (p.puuid) { partPuuids.push(p.puuid); continue; }
    const gn = p.riotIdGameName || p.summonerName;
    const tl = p.riotIdTagline || p.riotIdTagLine || '';
    if (!gn) continue;
    try {
      const acc = await getAccountByRiotId(gn.trim(), tl.trim(), { platformHint: platform });
      if (acc?.puuid) partPuuids.push(acc.puuid);
    } catch { /* skip */ }
  }

  // Umbral por mayoría del equipo: 3 en 5v5, 2 en 3v3/4v4, 1 en 1v1/2v2.
  // Con el fijo de 3 de antes, un 1v1 jamás podría atribuirse solo.
  const need = Math.max(1, Math.ceil((Number(t.teamSize) || 5) / 2));
  const t1hits = partPuuids.filter(p => t1Puuids.includes(p)).length;
  const t2hits = partPuuids.filter(p => t2Puuids.includes(p)).length;
  if (t1hits > t2hits && t1hits >= need) return match.team1;
  if (t2hits > t1hits && t2hits >= need) return match.team2;

  // Fallback: winning team side from match data + majority of known PUUIDs on that side
  const winnerSide = (matchData.info?.teams as any[])?.find((tm: any) => tm.win)?.teamId;
  if (!winnerSide) return null;
  const winningPartPuuids = participants
    .filter((p: any) => p.teamId === winnerSide)
    .map((p: any) => p.puuid)
    .filter(Boolean) as string[];
  const w1 = winningPartPuuids.filter(p => t1Puuids.includes(p)).length;
  const w2 = winningPartPuuids.filter(p => t2Puuids.includes(p)).length;
  if (w1 > w2) return match.team1;
  if (w2 > w1) return match.team2;
  return null;
}

// Tournament codes create CUSTOM games. Riot los reporta con gameType
// 'CUSTOM_GAME' y queueId variable según el mapa (0 en SR clásico, 3220 en
// customs de ARAM — verificado en vivo 2026-08). Filtramos por gameType para
// que un ranked/normal/arena de un jugador jamás se confunda con el torneo,
// sin rechazar customs legítimas de otros mapas.
function isCustomGame(info: any): boolean {
  return info?.gameType === 'CUSTOM_GAME' || Number(info?.queueId) === 0;
}

function normalizeRiotId(riotId: string) {
  return riotId.trim().toLowerCase();
}

async function resolveRiotIdToPuuid(
  rid: string, players: any[], platform: string
): Promise<string | null> {
  const norm = normalizeRiotId(String(rid));
  const stored = players.find((p: any) => normalizeRiotId(p.riotId || '') === norm);
  if (stored?.puuid) return stored.puuid;
  const [gn, tl] = String(rid).split('#');
  if (!gn || !tl) return null;
  try {
    const acc = await getAccountByRiotId(gn.trim(), tl.trim(), { platformHint: platform });
    return acc?.puuid ?? null;
  } catch { return null; }
}

/** Per-team PUUID sets + each side's captain PUUID, from registrations + code allowlist. */
async function collectTeamPuuids(
  tournamentId: string, match: BracketMatch, platform: string
): Promise<{ team1Puuids: Set<string>; team2Puuids: Set<string>; captain1: string | null; captain2: string | null }> {
  const [rows] = await pool.query<any[]>(
    'SELECT team_name, captain_riot_id, players FROM tournament_registrations WHERE tournament_id = ?',
    [tournamentId]
  );

  const team1Puuids = new Set<string>();
  const team2Puuids = new Set<string>();
  let captain1: string | null = null;
  let captain2: string | null = null;

  for (const row of rows) {
    const isT1 = row.team_name === match.team1;
    const isT2 = row.team_name === match.team2;
    if (!isT1 && !isT2) continue;
    const target = isT1 ? team1Puuids : team2Puuids;
    const players = parseJson(row.players) || [];

    const capPuuid = await resolveRiotIdToPuuid(row.captain_riot_id, players, platform);
    if (capPuuid) {
      target.add(capPuuid);
      if (isT1) captain1 = capPuuid; else captain2 = capPuuid;
    }
    for (const p of players) {
      if (!p?.riotId) continue;
      const puuid = await resolveRiotIdToPuuid(p.riotId, players, platform);
      if (puuid) target.add(puuid);
    }
  }

  // Merge the allowlist captured at code-gen time (more reliable when free-text registration is messy).
  (match.team1Puuids || []).forEach(p => team1Puuids.add(p));
  (match.team2Puuids || []).forEach(p => team2Puuids.add(p));
  return { team1Puuids, team2Puuids, captain1, captain2 };
}

/**
 * LAST-RESORT recovery: only when the Riot tournament code returned no game and no
 * callback arrived. Strict filters (custom queue, after code activation, BOTH captains
 * on OPPOSITE teams, enough roster overlap per side) and returns null on ANY ambiguity
 * so an admin links it manually instead of guessing wrong.
 */
export async function recoverGameFromRoster(
  t: TournamentData, match: BracketMatch, excludeGameIds?: Set<number>
): Promise<{ gameId: number; platform: string } | null> {
  if (!match.team1 || !match.team2 || match.team2 === 'BYE' || match.team1 === 'BYE') return null;
  const platform = match.gameRegion || t.region || 'la1';

  const { team1Puuids, team2Puuids, captain1, captain2 } = await collectTeamPuuids(t.id, match, platform);
  // Need a real identity on BOTH sides, including both captains, to attribute safely.
  if (team1Puuids.size === 0 || team2Puuids.size === 0) return null;
  if (!captain1 || !captain2) return null;

  const rosterPuuids = new Set<string>([...team1Puuids, ...team2Puuids]);

  // Hard lower time bound: the code had to exist before the game started.
  const lowerBound = match.codeActivatedAt
    ? match.codeActivatedAt - 5 * 60_000
    : (t.startDate ? new Date(t.startDate).getTime() - 60 * 60_000 : 0);

  const matchVotes = new Map<string, number>();
  for (const puuid of rosterPuuids) {
    const ids = await getMatchIdsByPUUID(platform, puuid, 20, 0);
    for (const mid of ids || []) matchVotes.set(mid, (matchVotes.get(mid) || 0) + 1);
  }

  const candidates = [...matchVotes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  type Scored = { gameId: number; platform: string; overlap: number };
  const valid: Scored[] = [];

  for (const [riotMid] of candidates) {
    const parts = riotMid.split('_');
    const gameId = Number(parts[parts.length - 1]);
    if (excludeGameIds?.has(gameId)) continue; // juego ya registrado en la serie
    const pf = parts[0].toLowerCase();
    const data = await getMatchById(pf, riotMid);
    const info = data?.info;
    if (!info?.gameEndTimestamp) continue;

    // 1) Must be a tournament/custom game.
    if (!isCustomGame(info)) continue;
    // 1b) Si Match-V5 trae el tournamentCode y NO es el de este match, es la
    //     partida de OTRO enfrentamiento — nunca atribuirla aquí.
    if (info.tournamentCode && match.code && info.tournamentCode !== match.code) continue;
    // 2) Must have started after the code was activated.
    if (lowerBound && info.gameStartTimestamp && info.gameStartTimestamp < lowerBound) continue;

    const teamByPuuid = new Map<string, number>();
    for (const p of info.participants || []) if (p.puuid) teamByPuuid.set(p.puuid, p.teamId);

    // 3) Both captains present AND on opposite teams.
    const cap1Team = teamByPuuid.get(captain1);
    const cap2Team = teamByPuuid.get(captain2);
    if (cap1Team === undefined || cap2Team === undefined || cap1Team === cap2Team) continue;

    // 4) Each registered side maps to its captain's team with enough overlap.
    const t1OnSide = [...team1Puuids].filter(p => teamByPuuid.get(p) === cap1Team).length;
    const t2OnSide = [...team2Puuids].filter(p => teamByPuuid.get(p) === cap2Team).length;
    const need1 = Math.min(2, team1Puuids.size);
    const need2 = Math.min(2, team2Puuids.size);
    if (t1OnSide < need1 || t2OnSide < need2) continue;

    const overlap = [...rosterPuuids].filter(p => teamByPuuid.has(p)).length;
    valid.push({ gameId, platform: pf, overlap });
  }

  if (!valid.length) return null;
  valid.sort((a, b) => b.overlap - a.overlap);

  // 5) Never auto-link on ambiguity — two distinct games that both pass → manual link.
  if (valid.length > 1 && valid[1].gameId !== valid[0].gameId && valid[1].overlap >= valid[0].overlap - 1) {
    console.warn(`[recoverGameFromRoster] ${match.id} ambiguo (${valid.map(v => v.gameId).join(', ')}) — requiere link manual`);
    return null;
  }

  console.log(`[recoverGameFromRoster] ${match.id} → ${valid[0].gameId} (custom, captanes opuestos, overlap ${valid[0].overlap})`);
  return { gameId: valid[0].gameId, platform: valid[0].platform };
}

export type SyncDetail = {
  matchId: string;
  gameIdDetected?: number;
  gameIdRecovered?: number;
  statsCached?: boolean;
  winnerResolved?: string;
  error?: string;
};

// ── Arena ladder ─────────────────────────────────────────────────────────────
// Arena no tiene lobbies custom (los códigos de torneo solo soportan SR/ARAM),
// así que el modo torneo de Arena es un LADDER: las duplas registradas juegan
// Arena normal/ranked durante la ventana del evento y aquí se puntúan sus
// placements leyendo el historial de Match-V5. Cuentan las mejores
// ARENA_BEST_OF partidas de cada dupla — grindear no gana, colocarse sí.
const ARENA_QUEUES = new Set([1700, 1710, 1720]);
const ARENA_POINTS = [10, 7, 6, 5, 4, 3, 2, 1]; // 1º..8º
const ARENA_BEST_OF = 5;

async function syncArenaLadder(t: TournamentData): Promise<{ synced: number; details: SyncDetail[] }> {
  if (t.phase !== 'active') return { synced: 0, details: [] };
  const startMs = Date.parse(t.startDate);
  const endMs = t.endDate ? Date.parse(t.endDate) : startMs + 3 * 3600_000;
  const platform = t.region || 'la1';
  const ladder = t.ladder || { processed: [], teams: {} };
  const processed = new Set(ladder.processed);
  let changed = false;
  let scored = 0;

  const [regs] = await pool.query<any[]>(
    'SELECT team_name, captain_riot_id, players FROM tournament_registrations WHERE tournament_id = ?',
    [t.id]
  );

  for (const reg of regs) {
    const teamName = reg.team_name as string;
    if (!ladder.teams[teamName]) { ladder.teams[teamName] = { games: [], points: 0 }; changed = true; }
    const players = parseJson(reg.players) || [];
    const duoPuuids: string[] = [];
    for (const rid of [reg.captain_riot_id, ...players.map((p: any) => p.riotId)].filter(Boolean)) {
      const puuid = await resolveRiotIdToPuuid(rid, players, platform);
      if (puuid && !duoPuuids.includes(puuid)) duoPuuids.push(puuid);
      if (duoPuuids.length >= 2) break;
    }
    if (!duoPuuids.length) continue;

    // El historial de un solo miembro basta: la dupla juega junta por regla.
    const ids = await getMatchIdsByPUUID(platform, duoPuuids[0], 15, 0);
    for (const mid of ids || []) {
      if (processed.has(mid)) continue;
      const pf = mid.split('_')[0].toLowerCase();
      const data = await getMatchById(pf, mid);
      const info = data?.info;
      if (!info?.gameEndTimestamp) continue;
      if (!ARENA_QUEUES.has(Number(info.queueId))) { processed.add(mid); changed = true; continue; }
      if (!info.gameStartTimestamp || info.gameStartTimestamp < startMs || info.gameStartTimestamp > endMs) {
        processed.add(mid); changed = true; continue;
      }

      // Ambos miembros presentes y en el MISMO subteam — si no, no puntúa.
      const parts = (info.participants || []).filter((p: any) => duoPuuids.includes(p.puuid));
      const sameSubteam = parts.length >= Math.min(2, duoPuuids.length)
        && new Set(parts.map((p: any) => p.playerSubteamId ?? p.subteamPlacement)).size >= 1
        && (duoPuuids.length < 2 || parts[0].playerSubteamId === parts[1].playerSubteamId);
      const placement = Number(parts[0]?.subteamPlacement ?? parts[0]?.placement) || 0;
      processed.add(mid); changed = true;
      if (!sameSubteam || placement < 1 || placement > 8) continue;

      ladder.teams[teamName].games.push({ matchId: mid, placement, at: info.gameEndTimestamp });
      scored++;
      console.log(`[arena-ladder] ${t.id}: ${teamName} → ${placement}º en ${mid}`);
    }

    // Puntos = suma de las mejores ARENA_BEST_OF partidas.
    const best = [...ladder.teams[teamName].games]
      .sort((a, b) => a.placement - b.placement)
      .slice(0, ARENA_BEST_OF);
    const pts = best.reduce((s, g) => s + (ARENA_POINTS[g.placement - 1] || 0), 0);
    if (ladder.teams[teamName].points !== pts) { ladder.teams[teamName].points = pts; changed = true; }
  }

  // Standings desde el ladder: puntos → mejor placement promedio como desempate.
  const rows = Object.entries(ladder.teams)
    .map(([team, s]) => ({
      team, points: s.points,
      wins: s.games.filter(g => g.placement === 1).length,
      losses: s.games.filter(g => g.placement > 1).length,
      avg: s.games.length ? s.games.reduce((a, g) => a + g.placement, 0) / s.games.length : 9,
    }))
    .sort((a, b) => b.points - a.points || a.avg - b.avg)
    .map((r, i) => ({ position: i + 1, team: r.team, wins: r.wins, losses: r.losses, points: r.points }));
  if (JSON.stringify(rows) !== JSON.stringify(t.standings)) { t.standings = rows; changed = true; }

  if (Date.now() > endMs) {
    t.phase = 'complete';
    changed = true;
    console.log(`[arena-ladder] ${t.id}: ventana cerrada → campeón: ${rows[0]?.team ?? '—'}`);
  }

  if (changed) {
    ladder.processed = [...processed].slice(-500);
    t.ladder = ladder;
    await saveT(t);
  }
  return { synced: scored, details: [] };
}

export async function syncTournamentFull(tournamentId: string): Promise<{ synced: number; details: SyncDetail[] }> {
  const t = await getT(tournamentId);
  if (!t) return { synced: 0, details: [] };
  if (t.gameMap === 'ARENA') return syncArenaLadder(t);
  if (!t.bracket) return { synced: 0, details: [] };

  const details: SyncDetail[] = [];
  let changed = false;

  for (let i = 0; i < t.bracket.length; i++) {
    const m = t.bracket[i];
    const detail: SyncDetail = { matchId: m.id };

    try {
      const seriesTo = m.seriesTo || 1;
      const known = new Set<number>((m.games || []).map(g => g.gameId));
      if (m.gameId) known.add(m.gameId); // compat Bo1 previo a series

      // 1. Detectar TODOS los juegos del código (series pueden tener varios)
      const found: Array<{ gameId: number; platform: string }> = [];
      if (m.code) found.push(...await detectAllGamesByCode(m.code, t.region || 'la1'));

      // 1b. Recovery por historial del roster si el código no arrojó nada nuevo
      const newFromCode = found.filter(g => !known.has(g.gameId));
      if (!newFromCode.length && m.matchStatus !== 'complete') {
        const recovered = await recoverGameFromRoster(t, m, known);
        if (recovered && !known.has(recovered.gameId)) {
          found.push(recovered);
          detail.gameIdRecovered = recovered.gameId;
          console.log(`[tournament-sync] recovered gameId ${recovered.gameId} for ${m.id} via roster`);
        }
      }

      // 2. Procesar cada juego nuevo: stats por juego + ganador del juego
      for (const g of found) {
        if (known.has(g.gameId)) continue;
        const fetched = await fetchMatchData(g.gameId, g.platform || t.region || 'la1');
        if (!fetched) continue;
        const info = fetched.data.info;
        if (!info.gameEndTimestamp) continue; // juego aún en curso
        known.add(g.gameId);

        const riotMid = riotMatchId(g.gameId, fetched.platform);
        const parsed = buildMatchStatsResponse(fetched.data, riotMid, true);
        await saveMatchStats(t.id, m.id, riotMid, g.gameId, parsed, info.gameDuration, info.gameEndTimestamp);
        detail.statsCached = true;
        changed = true;

        const gameWinner = await resolveWinnerFromMatch(t, m, fetched.data);
        t.bracket[i].games = [...(t.bracket[i].games || []), {
          gameId: g.gameId, gameRegion: fetched.platform, winner: gameWinner,
          // Juego real del enfrentamiento pero sin ganador atribuible (lados
          // mezclados vs los rosters) → marcar para reporte manual visible.
          ...(gameWinner ? {} : { ambiguous: true }),
        }];
        if (!gameWinner) {
          t.bracket[i].needsManualResult = true;
          console.warn(`[tournament-sync] ${t.id}/${m.id}: juego ${g.gameId} sin ganador atribuible (¿lados mezclados?) — requiere reporte manual`);
        }
        t.bracket[i].gameId = g.gameId;           // último juego (compat con vista de stats)
        t.bracket[i].gameRegion = fetched.platform;
        detail.gameIdDetected = g.gameId;
      }

      // 3. Marcador de la serie y cierre al llegar a seriesTo
      const match = t.bracket[i];
      if (match.matchStatus !== 'complete' && t.phase === 'active' && (match.games?.length || 0) > 0) {
        const s1 = match.games!.filter(g => g.winner === match.team1).length;
        const s2 = match.games!.filter(g => g.winner === match.team2).length;
        if (match.score1 !== s1 || match.score2 !== s2) {
          t.bracket[i].score1 = s1; t.bracket[i].score2 = s2; changed = true;
        }
        const seriesWinner = s1 >= seriesTo ? match.team1 : s2 >= seriesTo ? match.team2 : null;
        if (seriesWinner) {
          await applyResultInPlace(t, i, seriesWinner);
          detail.winnerResolved = seriesWinner;
          changed = true;
        }
      }
    } catch (e: any) {
      detail.error = e.message;
    }
    details.push(detail);
  }

  // ── Códigos automáticos para la ronda vigente ────────────────────────────
  // En eliminación directa el ganador avanza por el sync sin código (solo el
  // callback asignaba), y en liga las jornadas 2+ nacen sin código. Aquí:
  // ronda vigente = la mínima con partidos pendientes; todo partido 'ready'
  // con ambos equipos y sin código recibe el suyo → cualquier formato avanza
  // ronda a ronda sin tocar nada, igual que el suizo con piloto automático.
  if (t.phase === 'active' && t.gameMap !== 'ARENA' && t.bracket.length) {
    try {
      const pending = t.bracket.filter(m => m.matchStatus !== 'complete' && m.team1 !== 'BYE' && m.team2 !== 'BYE');
      if (pending.length) {
        const curRound = Math.min(...pending.map(m => m.round));
        for (let i = 0; i < t.bracket.length; i++) {
          const m = t.bracket[i];
          if (m.round === curRound && m.matchStatus === 'ready'
              && m.team1 && m.team2 && m.team1 !== 'BYE' && m.team2 !== 'BYE' && !m.code) {
            const routes = await import('../routes/tournaments.routes.js');
            await routes.assignCodeToMatch(t as any, i);
            changed = true;
            console.log(`[tournament-sync] ${t.id}: código automático para ${m.id} (ronda ${curRound})`);
          }
        }
      }
    } catch (e: any) {
      console.error(`[tournament-sync] auto-códigos ${t.id} falló:`, e.message);
    }
  }

  // ── Avance automático suizo (opt-in: solo si el organizador fijó rondas) ──
  // Al completarse todos los partidos de la ronda vigente: genera la siguiente
  // con códigos, o cierra el torneo si era la última planeada. El organizador
  // conserva el control manual (next-round / complete) en todo momento.
  if (t.bracketType === 'swiss' && t.phase === 'active' && t.swissRounds && t.bracket.length) {
    try {
      const maxRound = Math.max(...t.bracket.map(m => m.round));
      const roundDone = t.bracket
        .filter(m => m.round === maxRound)
        .every(m => m.matchStatus === 'complete');

      if (roundDone) {
        if (maxRound >= t.swissRounds) {
          t.phase = 'complete';
          changed = true;
          console.log(
            `[tournament-sync] ${t.id}: ronda final ${maxRound}/${t.swissRounds} completa → torneo cerrado. ` +
            `Campeón: ${t.standings?.[0]?.team ?? '—'}`
          );
        } else {
          // Import dinámico: evita el ciclo routes ↔ service en el top-level.
          const routes = await import('../routes/tournaments.routes.js');
          const newMatches = routes.pairSwissRound(t as any, maxRound + 1);
          if (newMatches.length) {
            t.bracket = [...t.bracket, ...(newMatches as any)];
            for (let i = 0; i < t.bracket.length; i++) {
              const m = t.bracket[i];
              if (m.round === maxRound + 1 && m.matchStatus === 'ready' && !m.code) {
                try {
                  await routes.assignCodeToMatch(t as any, i);
                } catch (e: any) {
                  console.error(`[tournament-sync] código para ${m.id} falló:`, e.message);
                }
              }
            }
            changed = true;
            console.log(
              `[tournament-sync] ${t.id}: ronda ${maxRound} completa → ronda ${maxRound + 1} generada ` +
              `(${newMatches.length} partidos, auto)`
            );
          }
        }
      }
    } catch (e: any) {
      console.error(`[tournament-sync] auto-advance ${t.id} falló:`, e.message);
    }
  }

  if (changed) await saveT(t);
  const synced = details.filter(d => d.gameIdDetected || d.gameIdRecovered || d.statsCached || d.winnerResolved).length;
  return { synced, details };
}

async function applyResultInPlace(t: TournamentData, mi: number, winner: string) {
  const match = t.bracket![mi];
  const loser = winner === match.team1 ? match.team2 : match.team1;
  t.bracket![mi] = { ...match, winner, matchStatus: 'complete' };
  const bt = t.bracketType || 'single_elim';

  // Avance de ganador: solo eliminación directa (RR/suizo no tienen árbol)
  if (bt === 'single_elim') {
    const nextId = `r${match.round + 1}m${Math.ceil(match.matchNumber / 2)}`;
    const ni = t.bracket!.findIndex(m => m.id === nextId);
    if (ni !== -1) {
      if (match.matchNumber % 2 === 1) t.bracket![ni].team1 = winner;
      else t.bracket![ni].team2 = winner;
      if (t.bracket![ni].team1 && t.bracket![ni].team2) {
        t.bracket![ni].matchStatus = 'ready';
      }
    }
  }

  if (t.standings) {
    t.standings = t.standings
      .map(s => s.team === winner ? { ...s, wins: s.wins + 1, points: s.points + 3 }
        : s.team === loser ? { ...s, losses: s.losses + 1 } : s)
      .sort((a, b) => b.points - a.points)
      .map((s, idx) => ({ ...s, position: idx + 1 }));
  }

  if (bt === 'round_robin') {
    if (t.bracket!.every(m => m.matchStatus === 'complete')) t.phase = 'complete';
  } else if (bt === 'swiss') {
    // el organizador cierra con /complete tras la última ronda
  } else {
    const maxRound = Math.max(...t.bracket!.map(m => m.round));
    if (t.bracket!.find(m => m.round === maxRound)?.matchStatus === 'complete') {
      t.phase = 'complete';
    }
  }
}

const SYNC_INTERVAL_MS = 60_000;
let syncRunning = false;

export function startTournamentBackgroundSync() {
  const tick = async () => {
    if (syncRunning) return;
    syncRunning = true;
    try {
      const [rows] = await pool.query<any[]>(
        "SELECT id FROM tournaments WHERE phase IN ('active', 'complete')"
      );
      for (const row of rows) {
        try {
          const result = await syncTournamentFull(row.id);
          if (result.synced > 0) {
            console.log(`[tournament-sync] ${row.id}: synced ${result.synced} match(es)`);
          }
        } catch (e: any) {
          console.error(`[tournament-sync] ${row.id} error:`, e.message);
        }
      }
    } catch (e: any) {
      console.error('[tournament-sync] loop error:', e.message);
    } finally {
      syncRunning = false;
    }
  };

  setTimeout(tick, 15_000);
  setInterval(tick, SYNC_INTERVAL_MS);
  console.log('[tournament-sync] background sync started (every 60s)');
}