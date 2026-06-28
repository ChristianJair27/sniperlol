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
  };
}

async function saveT(t: TournamentData) {
  await pool.query(
    `UPDATE tournaments SET
       phase=?, participants=?, max_participants=?, prize=?, start_date=?,
       format=?, description=?, riot_tournament_id=?,
       code_pool=?, bracket=?, standings=?, checkin_deadline=?,
       region=?, logo_url=?, banner_url=?
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

  const t1hits = partPuuids.filter(p => t1Puuids.includes(p)).length;
  const t2hits = partPuuids.filter(p => t2Puuids.includes(p)).length;
  if (t1hits > t2hits && t1hits >= 3) return match.team1;
  if (t2hits > t1hits && t2hits >= 3) return match.team2;

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

// Tournament codes create CUSTOM games, which Riot reports as queueId 0. We refuse
// to attribute anything else (Ranked Flex 440, Arena/CHERRY 1700/1710, ARAM 450,
// normals 400/430/420, etc.) so a player's scrim or arena game can never be mistaken
// for the tournament match.
const TOURNAMENT_CODE_QUEUE_ID = 0;

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
  t: TournamentData, match: BracketMatch
): Promise<{ gameId: number; platform: string } | null> {
  if (!match.team1 || !match.team2) return null;
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
    const pf = parts[0].toLowerCase();
    const data = await getMatchById(pf, riotMid);
    const info = data?.info;
    if (!info?.gameEndTimestamp) continue;

    // 1) Must be a tournament/custom game.
    if (info.queueId !== TOURNAMENT_CODE_QUEUE_ID) continue;
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

export async function syncTournamentFull(tournamentId: string): Promise<{ synced: number; details: SyncDetail[] }> {
  const t = await getT(tournamentId);
  if (!t?.bracket) return { synced: 0, details: [] };

  const details: SyncDetail[] = [];
  let changed = false;

  for (let i = 0; i < t.bracket.length; i++) {
    const m = t.bracket[i];
    const detail: SyncDetail = { matchId: m.id };

    try {
      // 1. Detect gameId from tournament code
      if (!m.gameId && m.code) {
        const detected = await tryDetectGameId(m.code, t.region || 'la1');
        if (detected) {
          t.bracket[i].gameId = detected.gameId;
          t.bracket[i].gameRegion = detected.platform;
          detail.gameIdDetected = detected.gameId;
          changed = true;
        }
      }

      // 1b. Recover from roster match history if code lookup failed
      if (!t.bracket[i].gameId) {
        const recovered = await recoverGameFromRoster(t, t.bracket[i]);
        if (recovered) {
          t.bracket[i].gameId = recovered.gameId;
          t.bracket[i].gameRegion = recovered.platform;
          detail.gameIdRecovered = recovered.gameId;
          changed = true;
          console.log(`[tournament-sync] recovered gameId ${recovered.gameId} for ${m.id} via roster`);
        }
      }

      const match = t.bracket[i];
      if (!match.gameId) {
        details.push(detail);
        continue;
      }

      // 2. Fetch + cache stats
      const fetched = await fetchMatchData(match.gameId, match.gameRegion || t.region || 'la1');
      if (fetched) {
        const info = fetched.data.info;
        const isComplete = !!info.gameEndTimestamp;
        const riotMid = riotMatchId(match.gameId, fetched.platform);
        const parsed = buildMatchStatsResponse(fetched.data, riotMid, isComplete);
        if (isComplete) {
          await saveMatchStats(t.id, match.id, riotMid, match.gameId, parsed, info.gameDuration, info.gameEndTimestamp);
          detail.statsCached = true;
          changed = true;

          // 3. Auto-resolve winner if match still open
          if (match.matchStatus !== 'complete' && t.phase === 'active') {
            const winner = await resolveWinnerFromMatch(t, match, fetched.data);
            if (winner) {
              await applyResultInPlace(t, i, winner);
              detail.winnerResolved = winner;
              changed = true;
            }
          }
        }
      }
    } catch (e: any) {
      detail.error = e.message;
    }
    details.push(detail);
  }

  if (changed) await saveT(t);
  const synced = details.filter(d => d.gameIdDetected || d.gameIdRecovered || d.statsCached || d.winnerResolved).length;
  return { synced, details };
}

async function applyResultInPlace(t: TournamentData, mi: number, winner: string) {
  const match = t.bracket![mi];
  const loser = winner === match.team1 ? match.team2 : match.team1;
  t.bracket![mi] = { ...match, winner, matchStatus: 'complete' };

  const nextId = `r${match.round + 1}m${Math.ceil(match.matchNumber / 2)}`;
  const ni = t.bracket!.findIndex(m => m.id === nextId);
  if (ni !== -1) {
    if (match.matchNumber % 2 === 1) t.bracket![ni].team1 = winner;
    else t.bracket![ni].team2 = winner;
    if (t.bracket![ni].team1 && t.bracket![ni].team2) {
      t.bracket![ni].matchStatus = 'ready';
    }
  }

  if (t.standings) {
    t.standings = t.standings
      .map(s => s.team === winner ? { ...s, wins: s.wins + 1, points: s.points + 3 }
        : s.team === loser ? { ...s, losses: s.losses + 1 } : s)
      .sort((a, b) => b.points - a.points)
      .map((s, idx) => ({ ...s, position: idx + 1 }));
  }

  const maxRound = Math.max(...t.bracket!.map(m => m.round));
  if (t.bracket!.find(m => m.round === maxRound)?.matchStatus === 'complete') {
    t.phase = 'complete';
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