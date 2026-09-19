// Background + on-demand sync: gameIds from tournament codes, Match-V5 stats, auto-results.
import { pool } from '../db.js';
import { getGamesByCode } from './riot-tournament.service.js';
import { getMatchById, getAccountByRiotId, getMatchIdsByPUUID, getLeagueEntriesByPuuid, getAccountByPUUID } from './riot.js';
import { notifyDiscordSeriesDone, notifyDiscordChampion } from './discord.service.js';

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
  /** Matches de playoffs (suizo multi-fase): avanzan como eliminación. */
  stage?: 'playoffs';
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
  discordWebhookUrl?: string;
  /** Suizo → playoffs: top N clasifican (0 = suizo puro). */
  playoffsSize?: number;
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
    discordWebhookUrl: row.discord_webhook_url || undefined,
    playoffsSize: Number(row.playoffs_size) || 0,
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

type CodeGame = {
  gameId: number; platform: string;
  /** PUUIDs de ganadores/perdedores según Riot (games/by-code). El callback
   *  HTTP solo trae summonerName, pero este endpoint sí trae puuid. */
  winPuuids?: string[]; losePuuids?: string[];
  startTime?: number;
};

/** Series Bo3/Bo5: TODOS los juegos registrados con el código del enfrentamiento,
 *  en orden cronológico. */
export async function detectAllGamesByCode(
  code: string, fallbackRegion: string
): Promise<CodeGame[]> {
  try {
    const games = await getGamesByCode(code);
    const puuidsOf = (arr: any) => (Array.isArray(arr) ? arr : [])
      .map((p: any) => (typeof p === 'string' ? p : p?.puuid))
      .filter(Boolean) as string[];
    return (games || []).map((g: any) => ({
      gameId: Number(g.gameId),
      platform: riotRegionToPlatform(g.region || fallbackRegion),
      winPuuids: puuidsOf(g.winningTeam),
      losePuuids: puuidsOf(g.losingTeam),
      startTime: Number(g.startTime) || undefined,
    }))
      .filter(g => Number.isFinite(g.gameId) && g.gameId > 0)
      .sort((a, b) => (a.startTime ?? a.gameId) - (b.startTime ?? b.gameId) || a.gameId - b.gameId);
  } catch {
    return [];
  }
}

function parseParticipant(p: any, gameDuration: number) {
  const cs = (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0);
  const mins = Math.max(1, gameDuration / 60);
  return {
    // El PUUID es la ÚNICA identidad estable: Riot deja cambiar el nombre
    // visible cuando quieras, y sin esto un renombrado parte las estadísticas
    // del jugador en dos (pasó con midelmorales → Resolve en el LQC).
    puuid: p.puuid || '',
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

export function buildMatchStatsResponse(data: any, riotMatchIdStr: string, isComplete: boolean) {
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

export async function saveMatchStats(
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

export async function fetchMatchData(gameId: number, primaryPlatform: string) {
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

/**
 * Atribuye el GANADOR de un juego a team1/team2 comparando los PUUIDs del lado
 * ganador y del lado perdedor contra los rosters (registro + allowlist del
 * código). Solo cuenta jugadores conocidos: suplentes fuera del roster se
 * ignoran. Si hay jugadores de AMBOS equipos en un mismo lado (lados
 * mezclados) devuelve null a propósito → reporte manual.
 *
 * Bug histórico (LQC r1 01-sep-2026): la versión anterior contaba jugadores
 * conocidos de los DIEZ participantes sin mirar quién ganó, así que "ganaba"
 * el equipo con más cuentas bien registradas.
 */
export function attributeGameWinner(
  match: Pick<BracketMatch, 'team1' | 'team2'>,
  winPuuids: string[], losePuuids: string[],
  team1Puuids: Set<string>, team2Puuids: Set<string>
): string | null {
  if (!match.team1 || !match.team2) return null;
  const count = (arr: string[], set: Set<string>) => arr.filter(p => set.has(p)).length;
  const w1 = count(winPuuids, team1Puuids), w2 = count(winPuuids, team2Puuids);
  const l1 = count(losePuuids, team1Puuids), l2 = count(losePuuids, team2Puuids);
  if ((w1 > 0 && w2 > 0) || (l1 > 0 && l2 > 0)) return null; // lados mezclados
  const ev1 = w1 + l2; // evidencia de que ganó team1
  const ev2 = w2 + l1; // evidencia de que ganó team2
  if (ev1 > ev2 && ev1 >= 1) return match.team1;
  if (ev2 > ev1 && ev2 >= 1) return match.team2;
  return null;
}

/** Ganador de un juego a partir de Match-V5 (+ PUUIDs de games/by-code si los hay). */
export async function resolveWinnerFromMatch(
  t: TournamentData,
  match: BracketMatch,
  matchData: any,
  hint?: { winPuuids?: string[]; losePuuids?: string[] }
): Promise<string | null> {
  if (!match.team1 || !match.team2) return null;
  const platform = match.gameRegion || t.region || 'la1';
  const { team1Puuids, team2Puuids } = await collectTeamPuuids(t.id, match, platform);
  if (!team1Puuids.size && !team2Puuids.size) return null;

  const winnerSide = (matchData?.info?.teams as any[])?.find((tm: any) => tm.win)?.teamId;
  const participants: any[] = matchData?.info?.participants ?? [];
  const winPuuids = new Set<string>(hint?.winPuuids ?? []);
  const losePuuids = new Set<string>(hint?.losePuuids ?? []);
  for (const p of participants) {
    if (!p?.puuid) continue;
    const won = typeof p.win === 'boolean' ? p.win : (winnerSide ? p.teamId === winnerSide : null);
    if (won === true) winPuuids.add(p.puuid);
    else if (won === false) losePuuids.add(p.puuid);
  }
  if (!winPuuids.size) return null;
  return attributeGameWinner(match, [...winPuuids], [...losePuuids], team1Puuids, team2Puuids);
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
    if (rows[0]?.team) {
      notifyDiscordChampion(t.discordWebhookUrl, {
        tournamentId: t.id, tournamentName: t.name, champion: rows[0].team,
      });
    }
  }

  if (changed) {
    ladder.processed = [...processed].slice(-500);
    t.ladder = ladder;
    await saveT(t);
  }
  return { synced: scored, details: [] };
}

// Un solo sync por torneo a la vez. saveT escribe la fila completa, así que dos
// syncs concurrentes (tick de fondo + callback de Riot + auto-sync del front)
// se pisaban con copias viejas del bracket. Se encadenan: el que llega espera.
const syncChains = new Map<string, Promise<unknown>>();

export function syncTournamentFull(tournamentId: string): Promise<{ synced: number; details: SyncDetail[] }> {
  const prev = syncChains.get(tournamentId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => syncTournamentFullInner(tournamentId));
  syncChains.set(tournamentId, run);
  run.finally(() => { if (syncChains.get(tournamentId) === run) syncChains.delete(tournamentId); }).catch(() => undefined);
  return run;
}

async function syncTournamentFullInner(tournamentId: string): Promise<{ synced: number; details: SyncDetail[] }> {
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
      // Compat Bo1 previo a series: partido YA cerrado con gameId y sin games[].
      // OJO: en partidos abiertos NO tratar m.gameId como conocido — el callback
      // de Riot lo escribe antes de que este sync vea el juego, y con la versión
      // anterior ese juego quedaba bloqueado para siempre (LQC r1: GO vs Nephyx
      // juego 2, RAKU vs 2 DOPE juego 2, CT&S vs Breakers juego 3).
      if (m.gameId && m.matchStatus === 'complete' && !m.games?.length) known.add(m.gameId);

      // 1. Detectar TODOS los juegos del código (series pueden tener varios)
      const found: CodeGame[] = [];
      // Códigos regenerados (cambio de roster ⇒ nueva allowlist): los viejos
      // siguen siendo válidos en Riot, así que también se consultan.
      for (const c of [m.code, ...((m as any).prevCodes || [])].filter(Boolean) as string[]) {
        for (const g of await detectAllGamesByCode(c, t.region || 'la1')) {
          if (!found.some(f => f.gameId === g.gameId)) found.push(g);
        }
      }
      // 1a. gameId enlazado por callback/admin que el código aún no reporta.
      //     NO viene del código → se valida abajo (custom + tournamentCode) antes
      //     de ingerirlo: el botón "auto-detectar" llegó a enlazar flex rankeds.
      const fromCode = new Set<number>(found.map(g => g.gameId));
      if (m.gameId && !known.has(m.gameId) && !fromCode.has(m.gameId)) {
        found.push({ gameId: m.gameId, platform: m.gameRegion || t.region || 'la1' });
      }

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
        if (!fromCode.has(g.gameId)) {
          // Enlace manual/callback sin respaldo del código: solo customs y, si
          // Match-V5 trae tournamentCode, tiene que ser ESTE código.
          const codeOk = !info.tournamentCode || !m.code || info.tournamentCode === m.code;
          if (!isCustomGame(info) || !codeOk) {
            console.warn(`[tournament-sync] ${t.id}/${m.id}: gameId ${g.gameId} enlazado no es custom de este código (${info.gameType} q=${info.queueId}) — se ignora y se desenlaza`);
            if (t.bracket[i].gameId === g.gameId) {
              const last = t.bracket[i].games?.[t.bracket[i].games!.length - 1];
              t.bracket[i].gameId = last?.gameId; t.bracket[i].gameRegion = last?.gameRegion; changed = true;
            }
            await pool.query('DELETE FROM tournament_match_stats WHERE tournament_id=? AND bracket_match_id=? AND game_id=?', [t.id, m.id, g.gameId]).catch(() => {});
            continue;
          }
        }
        known.add(g.gameId);

        const riotMid = riotMatchId(g.gameId, fetched.platform);
        const parsed = buildMatchStatsResponse(fetched.data, riotMid, true);
        await saveMatchStats(t.id, m.id, riotMid, g.gameId, parsed, info.gameDuration, info.gameEndTimestamp);
        detail.statsCached = true;
        changed = true;

        const gameWinner = await resolveWinnerFromMatch(t, m, fetched.data, g);
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
  // Con playoffs ya generados, el suizo no parea más: el avance lo llevan
  // applyResultInPlace (árbol) + el bloque de auto-códigos.
  const inPlayoffs = t.bracket.some(m => m.stage === 'playoffs');
  if (t.bracketType === 'swiss' && t.phase === 'active' && t.swissRounds && t.bracket.length && !inPlayoffs) {
    try {
      const maxRound = Math.max(...t.bracket.map(m => m.round));
      const roundDone = t.bracket
        .filter(m => m.round === maxRound)
        .every(m => m.matchStatus === 'complete');

      if (roundDone) {
        // Import dinámico: evita el ciclo routes ↔ service en el top-level.
        const routes = await import('../routes/tournaments.routes.js');
        if (maxRound >= t.swissRounds) {
          // Fase suiza completa → ¿playoffs o cierre?
          const psize = routes.effectivePlayoffsSize(t as any);
          if (psize >= 2 && t.standings?.length) {
            const seeds = t.standings.slice(0, psize).map(s => s.team);
            const playoffMatches = routes.generatePlayoffs(
              seeds, maxRound + 1, t.seriesTo || 1, t.finalSeriesTo || t.seriesTo || 1
            );
            t.bracket = [...t.bracket, ...(playoffMatches as any)];
            for (let i = 0; i < t.bracket.length; i++) {
              const m = t.bracket[i];
              if (m.stage === 'playoffs' && m.matchStatus === 'ready' && !m.code) {
                try { await routes.assignCodeToMatch(t as any, i); }
                catch (e: any) { console.error(`[tournament-sync] código playoffs ${m.id} falló:`, e.message); }
              }
            }
            changed = true;
            console.log(
              `[tournament-sync] ${t.id}: fase suiza completa → PLAYOFFS top ${psize} generados ` +
              `(seeds: ${seeds.join(' · ')})`
            );
          } else {
            t.phase = 'complete';
            changed = true;
            console.log(
              `[tournament-sync] ${t.id}: ronda final ${maxRound}/${t.swissRounds} completa → torneo cerrado. ` +
              `Campeón: ${t.standings?.[0]?.team ?? '—'}`
            );
            if (t.standings?.[0]?.team) {
              notifyDiscordChampion(t.discordWebhookUrl, {
                tournamentId: t.id, tournamentName: t.name, champion: t.standings[0].team,
              });
            }
          }
        } else {
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

  // Avance de ganador: eliminación directa Y matches de playoffs del suizo
  // (el bloque de auto-códigos les asigna código al quedar 'ready').
  if (bt === 'single_elim' || match.stage === 'playoffs') {
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
    // Suizo puro: cierra el piloto/organizador. La GRAN FINAL de playoffs
    // sí corona al campeón aquí mismo.
    if (match.stage === 'playoffs') {
      const maxPlayoffRound = Math.max(...t.bracket!.filter(m => m.stage === 'playoffs').map(m => m.round));
      if (match.round === maxPlayoffRound) t.phase = 'complete';
    }
  } else {
    const maxRound = Math.max(...t.bracket!.map(m => m.round));
    if (t.bracket!.find(m => m.round === maxRound)?.matchStatus === 'complete') {
      t.phase = 'complete';
    }
  }

  // Discord: serie detectada automáticamente (+ campeón si cerró el torneo).
  const done = t.bracket![mi];
  notifyDiscordSeriesDone(t.discordWebhookUrl, {
    tournamentId: t.id, tournamentName: t.name,
    winner, loser: loser || '—',
    score1: done.score1 ?? 0, score2: done.score2 ?? 0,
    forfeit: !!done.forfeit,
  });
  if (t.phase === 'complete') {
    const champion = (done.stage === 'playoffs' || bt === 'single_elim')
      ? winner : (t.standings?.[0]?.team ?? winner);
    notifyDiscordChampion(t.discordWebhookUrl, {
      tournamentId: t.id, tournamentName: t.name, champion,
    });
  }
}

// ── Rango de LoL (solo/duo) de los jugadores del torneo ──────────────────────
// Se guarda en seen_summoners (mismo índice que usan los iconos de perfil) con
// un sello de tiempo, y se refresca como mucho cada RANK_TTL_MS por torneo
// desde el tick de fondo. Así ni /global-stats ni la API pública llaman a
// Riot: leen columnas. Secuencial con pausa para respetar el rate limit.
const RANK_TTL_MS = 6 * 60 * 60_000;
const RANK_REFRESH_EVERY_MS = 30 * 60_000;
const lastRankRefresh = new Map<string, number>();

let rankColumnsReady: Promise<void> | null = null;
function ensureRankColumns(): Promise<void> {
  if (rankColumnsReady) return rankColumnsReady;
  rankColumnsReady = (async () => {
    for (const ddl of [
      'ALTER TABLE seen_summoners ADD COLUMN IF NOT EXISTS solo_tier VARCHAR(16) NULL',
      'ALTER TABLE seen_summoners ADD COLUMN IF NOT EXISTS solo_rank VARCHAR(4) NULL',
      'ALTER TABLE seen_summoners ADD COLUMN IF NOT EXISTS solo_lp INT NULL',
      'ALTER TABLE seen_summoners ADD COLUMN IF NOT EXISTS rank_at TIMESTAMP NULL',
    ]) {
      try { await pool.query(ddl); } catch (e: any) { console.warn('[ranks] DDL:', e.message); }
    }
  })();
  return rankColumnsReady;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Refresca el rango solo/duo de todos los inscritos de un torneo cuya entrada
 * falte o tenga más de RANK_TTL_MS. Usa el puuid del roster (ya resuelto en
 * la inscripción); si falta, resuelve el Riot ID una vez.
 */
export async function refreshTournamentRanks(t: TournamentData): Promise<number> {
  await ensureRankColumns();
  const platform = t.region || 'la1';
  const [regs] = await pool.query<any[]>(
    'SELECT team_name, players FROM tournament_registrations WHERE tournament_id = ?', [t.id],
  );
  const roster: Array<{ riotId: string; puuid?: string }> = [];
  for (const r of regs) {
    for (const p of parseJson(r.players) || []) if (p?.riotId) roster.push({ riotId: String(p.riotId), puuid: p.puuid });
  }
  if (!roster.length) return 0;

  const [rows] = await pool.query<any[]>(
    `SELECT puuid, game_name, tag_line, rank_at FROM seen_summoners
     WHERE puuid IN (${roster.map(() => '?').join(',')})`,
    roster.map((r) => r.puuid || ''),
  );
  const fresh = new Set(
    rows.filter((r) => r.rank_at && Date.now() - new Date(r.rank_at).getTime() < RANK_TTL_MS).map((r) => r.puuid),
  );

  let updated = 0;
  for (const p of roster) {
    try {
      let puuid = p.puuid;
      const [gn, tl] = p.riotId.split('#');
      if (!puuid && gn && tl) {
        const acc = await getAccountByRiotId(gn.trim(), tl.trim(), { platformHint: platform });
        puuid = acc?.puuid;
      }
      if (!puuid || fresh.has(puuid)) continue;
      const entries = await getLeagueEntriesByPuuid(platform, puuid);
      const solo = entries.find((e) => e.queueType === 'RANKED_SOLO_5x5') ?? null;
      await pool.query(
        `INSERT INTO seen_summoners (puuid, game_name, tag_line, platform, solo_tier, solo_rank, solo_lp, rank_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE solo_tier = VALUES(solo_tier), solo_rank = VALUES(solo_rank),
           solo_lp = VALUES(solo_lp), rank_at = NOW()`,
        [puuid, (gn || '').slice(0, 64), (tl || '').slice(0, 16), platform.slice(0, 8),
         solo?.tier ?? null, solo?.rank ?? null, solo?.leaguePoints ?? null],
      );
      updated++;
      await sleep(120);
    } catch (e: any) {
      if (e?.response?.status === 429 || /429|rate/i.test(String(e?.message))) {
        console.warn(`[ranks] ${t.id}: 429 de Riot — se reintenta en el siguiente ciclo`);
        break;
      }
    }
  }
  if (updated) console.log(`[ranks] ${t.id}: ${updated} rango(s) actualizados`);
  return updated;
}

/**
 * Renombrados de cuenta Riot. El nombre visible se puede cambiar cuando uno
 * quiera y el roster se queda con el viejo: el equipo muestra un nombre que ya
 * no existe y las partidas nuevas no cruzan con el inscrito. Esto compara el
 * Riot ID guardado con el que Riot da HOY para ese PUUID y, si cambió,
 * actualiza el roster guardando el anterior en `aliases` — que es lo que usa
 * computeGlobalStats para sumar las dos mitades en un solo jugador.
 * Corre en el mismo ciclo que los rangos (TTL de 6 h), sin peticiones extra
 * fuera de esa ventana.
 */
export async function detectRenames(t: TournamentData): Promise<number> {
  const platform = t.region || 'la1';
  const [regs] = await pool.query<any[]>(
    'SELECT id, team_name, captain_riot_id, players FROM tournament_registrations WHERE tournament_id = ?',
    [t.id],
  );
  let renamed = 0;

  for (const r of regs) {
    const players: any[] = parseJson(r.players) || [];
    let touched = false;

    for (const pl of players) {
      if (!pl?.puuid || !pl?.riotId) continue;
      try {
        const acc = await getAccountByPUUID(pl.puuid, { platformHint: platform });
        if (!acc?.gameName) continue;
        const now = `${acc.gameName}#${acc.tagLine}`;
        if (now.toLowerCase() === String(pl.riotId).toLowerCase()) continue;

        const previous = String(pl.riotId);
        pl.aliases = [...new Set([...(pl.aliases ?? []), previous])];
        pl.riotId = now;
        if (pl.name === previous) pl.name = now;
        touched = true;
        renamed++;
        console.log(`[rename] ${t.id}/${r.team_name}: "${previous}" → "${now}" (alias guardado)`);
        await sleep(120);
      } catch { /* una cuenta que no resuelve no debe parar al resto */ }
    }

    if (touched) {
      // El capitán también se renombra si era él.
      let captain = r.captain_riot_id;
      for (const pl of players) {
        if ((pl.aliases ?? []).some((a: string) => a.toLowerCase() === String(captain || '').toLowerCase())) {
          captain = pl.riotId;
        }
      }
      await pool.query(
        'UPDATE tournament_registrations SET players = ?, captain_riot_id = ? WHERE id = ?',
        [JSON.stringify(players), captain, r.id],
      );
    }
  }
  return renamed;
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
          // Rangos de LoL: como mucho cada 30 min por torneo, nunca en el request.
          if (Date.now() - (lastRankRefresh.get(row.id) ?? 0) > RANK_REFRESH_EVERY_MS) {
            lastRankRefresh.set(row.id, Date.now());
            const t = await getT(row.id);
            if (t) {
              refreshTournamentRanks(t).catch((e) => console.error(`[ranks] ${row.id}:`, e.message));
              // Renombrados de cuenta: mismo ciclo, sin peticiones fuera de él.
              detectRenames(t).catch((e) => console.error(`[rename] ${row.id}:`, e.message));
            }
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