// src/routes/tournaments.routes.ts — MySQL-backed tournament system
import { Router } from 'express';
import {
  createProvider, createTournament, generateCodes,
  getLobbyEvents, getCodeInfo, getGamesByCode,
} from '../services/riot-tournament.service.js';
import { requireAuth } from '../middlewares/requireAuth.js';
import { optionalAuth } from '../middlewares/optionalAuth.js';
import { getMatchById, getMatchIdsByPUUID, getAccountByRiotId, getSummonerByPUUID, getLiveGame, getLiveGameByPuuid } from '../services/riot.js';
import { startTournamentBackgroundSync, syncTournamentFull, recoverGameFromRoster } from '../services/tournament-sync.service.js';
import { sendTournamentInvitationEmail, isDeliverableEmail } from '../services/mail.service.js';
import { pool } from '../db.js';

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────
type TournamentPhase = 'registration' | 'checkin' | 'active' | 'complete';
type MatchStatus     = 'pending' | 'ready' | 'active' | 'complete';

interface Standing {
  position: number; team: string; wins: number; losses: number; points: number;
}
interface BracketMatch {
  id: string; round: number; matchNumber: number;
  team1: string | null; team2: string | null;
  winner: string | null; code: string | null;
  matchStatus: MatchStatus;
  score1?: number; score2?: number;
  gameId?: number; gameRegion?: string;
  // Registered players' PUUIDs per team, captured when the code is generated.
  // Used to (a) build the code allowlist and (b) attribute the winning team
  // from the Riot callback's winningTeam puuids.
  team1Puuids?: string[]; team2Puuids?: string[];
  // Epoch ms when this match's tournament code was generated/activated. Used as a
  // hard lower bound so roster-history recovery can never pick a game played
  // BEFORE the code existed (e.g. an old scrim/custom in the captain's history).
  codeActivatedAt?: number;
}
interface RosterPlayer {
  name: string;
  riotId?: string;
  puuid?: string;
  userId?: number;
  inviteEmail?: string;
  inviteStatus?: 'pending' | 'accepted';
}
interface TeamRegistration {
  teamName: string; captainRiotId: string;
  players: RosterPlayer[];
  contact: string; registeredAt: string;
  checkedIn: boolean; checkedInAt?: string;
  registeredBy?: number;
}
interface TournamentInvitation {
  id: number; tournamentId: string; tournamentName: string;
  teamName: string; invitedByUserId: number; invitedByName?: string;
  slotIndex: number; playerName?: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: string;
}
interface TournamentData {
  id: string; name: string; phase: TournamentPhase;
  participants: number; maxParticipants: number;
  prize: string; startDate: string; format: string; description: string;
  standings?: Standing[];
  riotTournamentId?: number;
  bracket?: BracketMatch[];
  checkinDeadline?: string;
  codePool: string[];
  createdBy?: number;
  region?: string;
  logoUrl?: string;
  bannerUrl?: string;
}

// ─── DB init ──────────────────────────────────────────────────────────────────
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id                VARCHAR(200) PRIMARY KEY,
      name              VARCHAR(500) NOT NULL,
      phase             VARCHAR(20)  DEFAULT 'registration',
      participants      INT          DEFAULT 0,
      max_participants  INT          DEFAULT 16,
      prize             VARCHAR(500) DEFAULT 'Por definir',
      start_date        VARCHAR(50)  NOT NULL,
      format            VARCHAR(200) DEFAULT '5v5 Single Elimination',
      description       TEXT,
      riot_tournament_id INT,
      code_pool         JSON,
      bracket           JSON,
      standings         JSON,
      checkin_deadline  VARCHAR(50),
      created_by        INT,
      created_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_registrations (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id    VARCHAR(200) NOT NULL,
      team_name        VARCHAR(500) NOT NULL,
      captain_riot_id  VARCHAR(200) NOT NULL,
      players          JSON         NOT NULL,
      contact          VARCHAR(500),
      checked_in       TINYINT(1)   DEFAULT 0,
      checked_in_at    VARCHAR(50),
      registered_at    TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_team (tournament_id, team_name(100)),
      INDEX idx_tournament (tournament_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_match_stats (
      id                INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id     VARCHAR(200) NOT NULL,
      bracket_match_id  VARCHAR(50)  NOT NULL,
      riot_match_id     VARCHAR(100) NOT NULL,
      game_id           BIGINT       NOT NULL,
      parsed_data       JSON         NOT NULL,
      game_duration     INT,
      game_end_ts       BIGINT,
      fetched_at        TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_bracket_match (tournament_id, bracket_match_id),
      INDEX idx_riot_match (riot_match_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // Key/value settings — persists the Riot provider id across restarts so we
  // don't register a brand-new provider (burning production quota) on every boot.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      k          VARCHAR(100) PRIMARY KEY,
      v          TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tournament_invitations (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      tournament_id       VARCHAR(200) NOT NULL,
      team_name           VARCHAR(500) NOT NULL,
      invited_user_id     INT          NOT NULL,
      invited_by_user_id  INT          NOT NULL,
      slot_index          INT          DEFAULT 0,
      player_name         VARCHAR(200),
      status              VARCHAR(20)  DEFAULT 'pending',
      created_at          TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
      responded_at        VARCHAR(50),
      UNIQUE KEY unique_invite (tournament_id, team_name(100), invited_user_id),
      INDEX idx_invited_user (invited_user_id),
      INDEX idx_tournament_inv (tournament_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // New columns (idempotent)
  for (const col of [
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS region VARCHAR(10) DEFAULT 'la1'`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS logo_url VARCHAR(1000)`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS banner_url VARCHAR(1000)`,
    `ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS logo_url VARCHAR(1000)`,
    `ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS registered_by INT`,
    `ALTER TABLE tournament_registrations ADD COLUMN IF NOT EXISTS captain_user_id INT`,
  ]) { await pool.query(col).catch(() => {}); }
  // Seed only if empty
  const [[{ cnt }]] = await pool.query<any[]>('SELECT COUNT(*) AS cnt FROM tournaments');
  if (Number(cnt) === 0) {
    const seeds = [
      ['lqc-split-primavera-2026','LQC Split Primavera 2026','registration',22,32,
       '$15,000 MXN + Skins + Trofeo','2026-03-15','Liga regular + Playoffs Double Elimination',
       'Torneo oficial de la Liga Queretana. Clasifica a playoffs y compite por el título.',null,null],
      ['copa-atak-2026','Copa ATAK.GG x LQC','registration',0,16,
       'RP, Skins y Coaching profesional','2026-02-20','5v5 Single Elimination',
       'Torneo abierto comunitario con premios para todos los rangos.',null,null],
      ['lqc-otono-2025','LQC Otoño 2025','complete',28,32,
       '$12,000 MXN','2025-09-10','Liga + Playoffs','Campeón: Team Eclipse QRO',null,
       JSON.stringify([
         {position:1,team:'Eclipse QRO',wins:9,losses:0,points:27},
         {position:2,team:'Dragones Querétaro',wins:7,losses:2,points:21},
         {position:3,team:'Corregidora Warriors',wins:6,losses:3,points:18},
         {position:4,team:'ATAK Academy',wins:5,losses:4,points:15},
         {position:5,team:'Santiago Knights',wins:4,losses:5,points:12},
       ])],
    ];
    for (const s of seeds) {
      await pool.query(
        `INSERT IGNORE INTO tournaments (id,name,phase,participants,max_participants,prize,start_date,format,description,riot_tournament_id,standings)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`, s
      );
    }
  }
}
initTables()
  .then(() => startTournamentBackgroundSync())
  .catch(err => console.error('[tournaments] initTables error:', err.message));

// ─── DB helpers ───────────────────────────────────────────────────────────────
function parseJson(v: any) { if (!v) return undefined; return typeof v === 'string' ? JSON.parse(v) : v; }

// ─── App settings (key/value) ───────────────────────────────────────────────
async function getSetting(key: string): Promise<string | null> {
  const [[row]] = await pool.query<any[]>('SELECT v FROM app_settings WHERE k = ?', [key]);
  return row ? row.v : null;
}
async function setSetting(key: string, value: string) {
  await pool.query(
    'INSERT INTO app_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [key, value]
  );
}

// Returns the persisted Riot provider id, creating (and storing) one only the
// first time. Survives restarts, so we never spawn duplicate providers in Riot.
async function getOrCreateProviderId(): Promise<number> {
  const stored = await getSetting('riot_provider_id');
  if (stored) return Number(stored);
  const p = await createProvider();
  await setSetting('riot_provider_id', String(p.id));
  return p.id;
}

function rowToTournament(row: any): TournamentData {
  return {
    id: row.id, name: row.name, phase: row.phase,
    participants: row.participants, maxParticipants: row.max_participants,
    prize: row.prize, startDate: row.start_date, format: row.format,
    description: row.description || '',
    riotTournamentId: row.riot_tournament_id || undefined,
    codePool:   parseJson(row.code_pool)   || [],
    bracket:    parseJson(row.bracket)     || undefined,
    standings:  parseJson(row.standings)   || undefined,
    checkinDeadline: row.checkin_deadline  || undefined,
    createdBy:  row.created_by             || undefined,
    region:     row.region                 || 'la1',
    logoUrl:    row.logo_url               || undefined,
    bannerUrl:  row.banner_url             || undefined,
  };
}

async function getT(id: string): Promise<TournamentData | null> {
  const [[row]] = await pool.query<any[]>('SELECT * FROM tournaments WHERE id = ?', [id]);
  return row ? rowToTournament(row) : null;
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
      t.bracket   ? JSON.stringify(t.bracket)   : null,
      t.standings ? JSON.stringify(t.standings) : null,
      t.checkinDeadline ?? null,
      t.region ?? 'la1',
      t.logoUrl ?? null,
      t.bannerUrl ?? null,
      t.id,
    ]
  );
}

type ViewerAccess = 'owner' | 'participant' | 'public';

function sanitizeBracketMatch(m: BracketMatch, access: ViewerAccess): BracketMatch {
  if (access === 'owner' || access === 'participant') return m;
  // Public: hide lobby codes + internal PUUIDs; keep gameId on completed matches for stats
  return {
    ...m,
    code: null,
    team1Puuids: undefined,
    team2Puuids: undefined,
  };
}

function sanitizeBracket(bracket: BracketMatch[] | undefined, access: ViewerAccess) {
  if (!bracket) return undefined;
  return bracket.map(m => sanitizeBracketMatch(m, access));
}

async function getViewerAccess(
  t: TournamentData,
  auth?: { userId: number; role: string }
): Promise<ViewerAccess> {
  if (!auth) return 'public';
  if (auth.role === 'admin' || auth.userId === t.createdBy) return 'owner';

  const linked = await getLinkedRiotAccount(auth.userId);
  const linkedRiot = linked?.riotId?.toLowerCase();
  const linkedPuuid = linked?.puuid;

  const regs = await getRegs(t.id);
  for (const reg of regs) {
    if (reg.registeredBy === auth.userId) return 'participant';
    if (linkedRiot && reg.captainRiotId?.toLowerCase() === linkedRiot) return 'participant';
    for (const p of reg.players || []) {
      if (p.userId === auth.userId) return 'participant';
      if (linkedPuuid && p.puuid === linkedPuuid) return 'participant';
      if (linkedRiot && p.riotId?.toLowerCase() === linkedRiot) return 'participant';
    }
  }

  const [[acceptedInv]] = await pool.query<any[]>(
    "SELECT id FROM tournament_invitations WHERE tournament_id=? AND invited_user_id=? AND status='accepted' LIMIT 1",
    [t.id, auth.userId]
  );
  if (acceptedInv) return 'participant';

  const [[inv]] = await pool.query<any[]>(
    "SELECT id FROM tournament_invitations WHERE tournament_id=? AND invited_user_id=? AND status='pending' LIMIT 1",
    [t.id, auth.userId]
  );
  if (inv) return 'participant';

  return 'public';
}

function serialize(t: TournamentData, access: ViewerAccess = 'public') {
  const status = (t.phase==='registration'||t.phase==='checkin') ? 'abiertas'
               : t.phase==='active' ? 'progreso' : 'finalizado';
  const isPrivileged = access === 'owner' || access === 'participant';
  return {
    id:t.id, name:t.name, phase:t.phase, status,
    participants:t.participants, maxParticipants:t.maxParticipants,
    prize:t.prize, startDate:t.startDate, format:t.format, description:t.description,
    standings:t.standings,
    riotTournamentId: isPrivileged ? t.riotTournamentId : undefined,
    bracket: sanitizeBracket(t.bracket, access),
    checkinDeadline:t.checkinDeadline,
    codesAvailable: access === 'owner' ? t.codePool.length : undefined,
    createdBy: access === 'owner' ? t.createdBy : undefined,
    region:t.region||'la1', logoUrl:t.logoUrl, bannerUrl:t.bannerUrl,
    viewerAccess: access,
  };
}

async function getRegs(tournamentId: string): Promise<TeamRegistration[]> {
  const [rows] = await pool.query<any[]>(
    'SELECT * FROM tournament_registrations WHERE tournament_id = ? ORDER BY registered_at ASC',
    [tournamentId]
  );
  return rows.map(r => ({
    teamName: r.team_name, captainRiotId: r.captain_riot_id,
    players: parseJson(r.players) || [],
    contact: r.contact || '', registeredAt: r.registered_at,
    checkedIn: !!r.checked_in, checkedInAt: r.checked_in_at || undefined,
    registeredBy: r.registered_by || undefined,
  }));
}

async function getLinkedRiotAccount(userId: number) {
  const [[row]] = await pool.query<any[]>(
    'SELECT platform, puuid, game_name, tag_line FROM user_riot_accounts WHERE user_id = ? LIMIT 1',
    [userId]
  );
  if (!row) return null;
  return {
    platform: row.platform as string,
    puuid: row.puuid as string,
    gameName: row.game_name as string,
    tagLine: row.tag_line as string,
    riotId: `${row.game_name}#${row.tag_line}`,
  };
}

async function resolveRiotIdToPuuid(riotId: string, platform: string): Promise<{ puuid: string; gameName: string; tagLine: string } | null> {
  const [gameName, tagLine] = riotId.split('#');
  if (!gameName || !tagLine) return null;
  try {
    const account = await getAccountByRiotId(gameName.trim(), tagLine.trim(), { platformHint: platform });
    if (!account?.puuid) return null;
    return { puuid: account.puuid, gameName: gameName.trim(), tagLine: tagLine.trim() };
  } catch { return null; }
}

async function findUserByEmail(email: string): Promise<number | null> {
  const [[row]] = await pool.query<any[]>(
    'SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1',
    [email.trim()]
  );
  return row ? Number(row.id) : null;
}

async function findUserByRiotId(riotId: string): Promise<number | null> {
  const [gameName, tagLine] = riotId.split('#');
  if (!gameName || !tagLine) return null;
  const [[row]] = await pool.query<any[]>(
    `SELECT user_id FROM user_riot_accounts
     WHERE LOWER(game_name) = LOWER(?) AND LOWER(tag_line) = LOWER(?) LIMIT 1`,
    [gameName.trim(), tagLine.trim()]
  );
  return row ? Number(row.user_id) : null;
}

async function createInvitation(
  tournamentId: string, teamName: string, invitedUserId: number,
  invitedByUserId: number, slotIndex: number, playerName?: string,
  emailContext?: { tournamentName: string; inviterName: string }
) {
  await pool.query(
    `INSERT INTO tournament_invitations
       (tournament_id, team_name, invited_user_id, invited_by_user_id, slot_index, player_name, status)
     VALUES (?,?,?,?,?,?,'pending')
     ON DUPLICATE KEY UPDATE status='pending', slot_index=VALUES(slot_index), player_name=VALUES(player_name)`,
    [tournamentId, teamName, invitedUserId, invitedByUserId, slotIndex, playerName || null]
  );

  if (emailContext) {
    const [[invitee]] = await pool.query<any[]>(
      'SELECT email, name FROM users WHERE id = ? LIMIT 1',
      [invitedUserId]
    );
    if (invitee?.email && isDeliverableEmail(invitee.email)) {
      sendTournamentInvitationEmail({
        toEmail: invitee.email,
        toName: invitee.name || undefined,
        inviterName: emailContext.inviterName,
        tournamentName: emailContext.tournamentName,
        teamName,
        tournamentId,
        playerSlotName: playerName,
      }).catch(err => console.error('[invite-email]', err.message));
    }
  }
}

function isOwner(req: any, t: TournamentData) {
  return req.auth?.userId === t.createdBy || req.auth?.role === 'admin';
}
function isAdmin(req: any) { return req.auth?.role === 'admin'; }

// ─── Match stats DB helpers ───────────────────────────────────────────────────

async function getStoredMatchStats(tournamentId: string, bracketMatchId: string) {
  const [[row]] = await pool.query<any[]>(
    'SELECT parsed_data, game_end_ts FROM tournament_match_stats WHERE tournament_id=? AND bracket_match_id=?',
    [tournamentId, bracketMatchId]
  );
  if (!row) return null;
  const parsed = typeof row.parsed_data === 'string' ? JSON.parse(row.parsed_data) : row.parsed_data;
  return { ...parsed, isComplete: !!row.game_end_ts };
}

async function saveMatchStats(
  tournamentId: string, bracketMatchId: string, riotMatchId: string,
  gameId: number, parsedData: object, gameDuration: number, gameEndTs?: number
) {
  await pool.query(
    `INSERT INTO tournament_match_stats
       (tournament_id, bracket_match_id, riot_match_id, game_id, parsed_data, game_duration, game_end_ts)
     VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       parsed_data=VALUES(parsed_data), game_duration=VALUES(game_duration), game_end_ts=VALUES(game_end_ts)`,
    [tournamentId, bracketMatchId, riotMatchId, gameId, JSON.stringify(parsedData), gameDuration, gameEndTs ?? null]
  );
}

function parseParticipant(p: any, gameDuration: number) {
  const cs = (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0);
  const mins = Math.max(1, gameDuration / 60);
  return {
    summonerName:      p.riotIdGameName  || p.summonerName  || 'Invocador',
    tagLine:           p.riotIdTagline   || p.riotIdTagLine || '',
    championName:      p.championName,
    champLevel:        p.champLevel,
    teamId:            p.teamId,
    win:               p.win,
    kills:             p.kills           ?? 0,
    deaths:            p.deaths          ?? 0,
    assists:           p.assists         ?? 0,
    kda:               p.deaths === 0 ? (p.kills + p.assists) : ((p.kills + p.assists) / p.deaths),
    cs,
    csPerMin:          Math.round((cs / mins) * 10) / 10,
    goldEarned:        p.goldEarned      ?? 0,
    totalDamageDealt:  p.totalDamageDealtToChampions ?? 0,
    physicalDamage:    p.physicalDamageDealtToChampions ?? 0,
    magicDamage:       p.magicDamageDealtToChampions  ?? 0,
    trueDamage:        p.trueDamageDealtToChampions   ?? 0,
    damageTaken:       p.totalDamageTaken  ?? 0,
    healingDone:       p.totalHeal         ?? 0,
    visionScore:       p.visionScore       ?? 0,
    wardsPlaced:       p.wardsPlaced       ?? 0,
    wardsKilled:       p.wardsKilled       ?? 0,
    items:             [p.item0,p.item1,p.item2,p.item3,p.item4,p.item5,p.item6].map(Number),
    summoner1Id:       p.summoner1Id       ?? 0,
    summoner2Id:       p.summoner2Id       ?? 0,
    perks: {
      keystoneId:        p.perks?.styles?.[0]?.selections?.[0]?.perk ?? 0,
      secondaryStyleId:  p.perks?.styles?.[1]?.style ?? 0,
    },
    pentaKills:        p.pentaKills   ?? 0,
    quadraKills:       p.quadraKills  ?? 0,
    tripleKills:       p.tripleKills  ?? 0,
    doubleKills:       p.doubleKills  ?? 0,
    firstBloodKill:    p.firstBloodKill ?? false,
    teamPosition:      p.teamPosition   || p.role || '',
    largestMultiKill:  p.largestMultiKill ?? 0,
    killingSprees:     p.killingSprees   ?? 0,
    totalTimeCCDealt:  p.totalTimeCCDealt ?? 0,
    challenges: p.challenges ? {
      killParticipation: p.challenges.killParticipation,
      kda:               p.challenges.kda,
      damagePerMinute:   p.challenges.damagePerMinute,
      goldPerMinute:     p.challenges.goldPerMinute,
      visionScorePerMinute: p.challenges.visionScorePerMinute,
      soloKills:         p.challenges.soloKills,
      pentaKills:        p.challenges.multikills,
    } : undefined,
  };
}

function parseTeamObjectives(team: any) {
  const obj = team?.objectives ?? {};
  return {
    win:              team?.win       ?? false,
    bans:             team?.bans      ?? [],
    baronKills:       obj.baron?.kills     ?? 0,
    dragonKills:      obj.dragon?.kills    ?? 0,
    towerKills:       obj.tower?.kills     ?? 0,
    inhibitorKills:   obj.inhibitor?.kills ?? 0,
    riftHeraldKills:  obj.riftHerald?.kills ?? 0,
    firstBaron:       obj.baron?.first     ?? false,
    firstDragon:      obj.dragon?.first    ?? false,
    firstTower:       obj.tower?.first     ?? false,
  };
}

function buildMatchStatsResponse(data: any, riotMatchIdStr: string, isComplete: boolean) {
  const info = data.info;
  const dur  = info.gameDuration as number;
  const participants: any[] = info.participants.map((p: any) => parseParticipant(p, dur));
  const blueTeam = participants.filter((p: any) => p.teamId === 100);
  const redTeam  = participants.filter((p: any) => p.teamId === 200);
  const blueTeamRaw = (info.teams as any[]).find((t: any) => t.teamId === 100);
  const redTeamRaw  = (info.teams as any[]).find((t: any) => t.teamId === 200);
  const winnerTeamId = (info.teams as any[]).find((t: any) => t.win)?.teamId;

  return {
    matchId:            riotMatchIdStr,
    gameDuration:       dur,
    gameStartTimestamp: info.gameStartTimestamp,
    gameEndTimestamp:   info.gameEndTimestamp,
    gameMode:           info.gameMode,
    isComplete,
    winner:             winnerTeamId === 100 ? 'blue' : winnerTeamId === 200 ? 'red' : null,
    blueTeam,
    redTeam,
    blueObjectives: parseTeamObjectives(blueTeamRaw),
    redObjectives:  parseTeamObjectives(redTeamRaw),
  };
}

// ─── Bracket generator ────────────────────────────────────────────────────────
function generateBracket(teams: string[]): BracketMatch[] {
  const n = Math.pow(2, Math.ceil(Math.log2(Math.max(teams.length, 2))));
  const padded = [...teams];
  while (padded.length < n) padded.push('BYE');
  for (let i = padded.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [padded[i], padded[j]] = [padded[j], padded[i]];
  }
  const totalRounds = Math.log2(n);
  const matches: BracketMatch[] = [];
  for (let r = 1; r <= totalRounds; r++) {
    const cnt = n / Math.pow(2, r);
    for (let m = 1; m <= cnt; m++) {
      const t1 = r===1 ? padded[(m-1)*2] : null;
      const t2 = r===1 ? padded[(m-1)*2+1] : null;
      const isBye = t1==='BYE'||t2==='BYE';
      matches.push({ id:`r${r}m${m}`, round:r, matchNumber:m,
        team1:t1, team2:t2, winner:null, code:null,
        matchStatus: (t1&&t2&&!isBye) ? 'ready' : 'pending' });
    }
  }
  matches.filter(m=>m.round===1&&(m.team1==='BYE'||m.team2==='BYE')).forEach(match=>{
    const winner = match.team1!=='BYE' ? match.team1 : match.team2;
    match.winner=winner; match.matchStatus='complete';
    const next = matches.find(m=>m.id===`r2m${Math.ceil(match.matchNumber/2)}`);
    if (next) {
      if (match.matchNumber%2===1) next.team1=winner; else next.team2=winner;
      if (next.team1&&next.team2&&next.team1!=='BYE'&&next.team2!=='BYE') next.matchStatus='ready';
    }
  });
  return matches;
}

function riotRegionToPlatform(region: string): string {
  const m: Record<string,string> = {
    LAN:'la1',LA1:'la1',LA2:'la2',LAS:'la2',NA1:'na1',NA:'na1',BR1:'br1',BR:'br1',
    EUW1:'euw1',EUW:'euw1',EUN1:'eun1',EUNE:'eun1',KR:'kr',JP1:'jp1',OC1:'oc1',RU:'ru',TR1:'tr1',
  };
  return m[region.toUpperCase()] || 'la1';
}
function riotMatchId(gameId: number, platform: string) { return `${platform.toUpperCase()}_${gameId}`; }

// Llama a la API de Riot para obtener el gameId de una partida a partir del código de torneo.
// Devuelve null si aún no hay partida registrada para ese código.
async function tryDetectGameId(
  code: string, fallbackRegion: string
): Promise<{ gameId: number; platform: string } | null> {
  try {
    const games = await getGamesByCode(code);
    if (!games.length) return null;
    // Toma el juego más reciente (último del array)
    const latest = games[games.length - 1];
    const platform = riotRegionToPlatform(latest.region || fallbackRegion);
    return { gameId: Number(latest.gameId), platform };
  } catch {
    return null;
  }
}

// ─── Allowlist / code / result helpers ───────────────────────────────────────

// Resolve the registered players' PUUIDs for one team (captain + roster).
// Best-effort: players with malformed Riot IDs or unresolvable accounts are
// silently skipped. Results are cached 10 min via the shared live cache.
async function resolveTeamPuuids(t: TournamentData, teamName: string | null): Promise<string[]> {
  if (!teamName) return [];
  const regs = await getRegs(t.id);
  const reg = regs.find(r => r.teamName === teamName);
  if (!reg) return [];
  const platform = t.region || 'la1';
  const riotIds = [...new Set(
    [reg.captainRiotId, ...(reg.players || []).map(p => p.riotId)]
      .filter((id): id is string => Boolean(id))
  )];
  const puuids: string[] = [];
  for (const rid of riotIds) {
    const ck = `puuid:${platform}:${rid}`;
    const cached = lcGet(ck);
    if (cached !== undefined) { if (cached) puuids.push(cached as string); continue; }
    const [gameName, tagLine] = rid.split('#');
    if (!gameName || !tagLine) { lcSet(ck, null, 10 * 60_000); continue; }
    try {
      const account = await getAccountByRiotId(gameName.trim(), tagLine.trim(), { platformHint: platform });
      const puuid = account?.puuid ?? null;
      lcSet(ck, puuid, 10 * 60_000);
      if (puuid) puuids.push(puuid);
    } catch { lcSet(ck, null, 60_000); }
  }
  return puuids;
}

// Generate (or fall back to a pooled) tournament code for a specific bracket
// match, restricting it to both teams' registered players (allowlist) and
// embedding {tId, mId} in the code metadata so the Riot callback can resolve
// the result automatically. Mutates t.bracket[mi]; caller is responsible for saveT.
async function assignCodeToMatch(t: TournamentData, mi: number): Promise<string | null> {
  const match = t.bracket![mi];
  if (!match.team1 || !match.team2) return null;

  const [team1Puuids, team2Puuids] = await Promise.all([
    resolveTeamPuuids(t, match.team1),
    resolveTeamPuuids(t, match.team2),
  ]);
  match.team1Puuids = team1Puuids;
  match.team2Puuids = team2Puuids;

  let code: string | null = null;
  if (t.riotTournamentId) {
    try {
      const metadata = JSON.stringify({ tId: t.id, mId: match.id });
      const codes = await generateCodes(t.riotTournamentId, 1, {
        metadata,
        allowedParticipants: [...team1Puuids, ...team2Puuids],
      });
      code = codes[0] || null;
    } catch (e: any) {
      console.error(`[assignCode] Riot code gen falló para ${match.id}:`, e.message);
    }
  }
  // Fallback: a pre-generated pooled code (no allowlist / no metadata).
  if (!code) code = t.codePool.shift() || null;

  match.code = code;
  match.matchStatus = code ? 'active' : 'ready';
  if (code) match.codeActivatedAt = Date.now();
  return code;
}

// Mark a match complete for `winner`, advance the winner to the next round
// (assigning that match a fresh code), update standings and tournament phase.
// Mutates t; caller is responsible for saveT.
async function applyResult(
  t: TournamentData, mi: number, winner: string,
  score1?: number, score2?: number
) {
  const match = t.bracket![mi];
  const loser = winner === match.team1 ? match.team2 : match.team1;
  t.bracket![mi] = {
    ...match, winner, matchStatus: 'complete',
    score1: score1 !== undefined ? score1 : match.score1,
    score2: score2 !== undefined ? score2 : match.score2,
  };

  // Advance winner to next round
  const nextId = `r${match.round + 1}m${Math.ceil(match.matchNumber / 2)}`;
  const ni = t.bracket!.findIndex(m => m.id === nextId);
  if (ni !== -1) {
    if (match.matchNumber % 2 === 1) t.bracket![ni].team1 = winner;
    else                            t.bracket![ni].team2 = winner;
    if (t.bracket![ni].team1 && t.bracket![ni].team2) {
      await assignCodeToMatch(t, ni);
    }
  }

  // Standings
  if (t.standings) {
    t.standings = t.standings
      .map(s => s.team === winner ? { ...s, wins: s.wins + 1, points: s.points + 3 }
              : s.team === loser  ? { ...s, losses: s.losses + 1 } : s)
      .sort((a, b) => b.points - a.points)
      .map((s, i) => ({ ...s, position: i + 1 }));
  }

  // Completion
  const maxRound = Math.max(...t.bracket!.map(m => m.round));
  if (t.bracket!.find(m => m.round === maxRound)?.matchStatus === 'complete') t.phase = 'complete';
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET all — list never includes bracket/codes; detail uses GET /:id
router.get('/', optionalAuth, async (req: any, res) => {
  try {
    const [rows] = await pool.query<any[]>('SELECT * FROM tournaments ORDER BY created_at DESC');
    const out = await Promise.all(rows.map(async (r) => {
      const t = rowToTournament(r);
      const access = await getViewerAccess(t, req.auth);
      const s = serialize(t, access);
      const { bracket: _b, ...listItem } = s;
      return listItem;
    }));
    res.json(out);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST / — create
router.post('/', requireAuth, async (req: any, res) => {
  const { name, prize, startDate, format, description, maxParticipants, checkinDeadline, createRiot } = req.body;
  if (!name || !startDate) return res.status(400).json({ error:'name y startDate requeridos' });

  let riotTournamentId: number|undefined;
  let initialCodes: string[] = [];

  if (createRiot) {
    try {
      const providerId = await getOrCreateProviderId();
      const rt = await createTournament(providerId, name);
      riotTournamentId = rt.id;
      initialCodes = await generateCodes(riotTournamentId, Math.min((maxParticipants||16)*2, 100));
    } catch (err: any) { return res.status(500).json({ error:'Error Riot: '+err.message }); }
  }

  const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
  const id = `${slug}-${Date.now()}`;
  const newT: TournamentData = {
    id, name, phase:'registration', participants:0,
    maxParticipants:maxParticipants||16,
    prize:prize||'Por definir', startDate,
    format:format||'5v5 Single Elimination', description:description||'',
    riotTournamentId, codePool:initialCodes,
    checkinDeadline:checkinDeadline||undefined,
    createdBy:req.auth.userId,
  };

  try {
    await pool.query(
      `INSERT INTO tournaments (id,name,phase,participants,max_participants,prize,start_date,format,description,riot_tournament_id,code_pool,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,name,'registration',0,newT.maxParticipants,newT.prize,startDate,newT.format,
       newT.description,riotTournamentId??null,JSON.stringify(initialCodes),req.auth.userId]
    );
    res.json({ success:true, tournament:serialize(newT) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Riot callback — fired when a game played with a tournament code ends.
// Resolves the match via the code metadata ({tId, mId}) — falling back to a
// shortCode scan — then records the gameId and auto-advances the bracket using
// the winningTeam PUUIDs, so no manual result report is needed.
router.post('/tournament-callback', async (req, res) => {
  // Shared-secret gate — Riot doesn't sign callbacks, so the provider URL carries
  // a ?key= that only we know. Without this, anyone could POST a forged result and
  // advance a bracket. If the secret isn't configured we allow it (back-compat) but warn.
  const secret = process.env.TOURNAMENT_CALLBACK_SECRET;
  if (secret) {
    if ((req.query as any).key !== secret) {
      console.warn('[Callback] rechazado: key inválida o ausente');
      return res.status(403).send('Forbidden');
    }
  } else {
    console.warn('[Callback] TOURNAMENT_CALLBACK_SECRET no configurado — callback sin autenticar (configúralo para PROD)');
  }

  const body = req.body || {};
  const { shortCode, gameId, region } = body;
  const winningTeam = body.winningTeam ?? body.winningTeamPlayers ?? [];
  const metaRaw = body.metaData ?? body.metadata;
  console.log('[Riot Callback]', JSON.stringify(body).slice(0, 600));

  try {
    // 1. Locate tournament + match — prefer embedded metadata, else scan by code.
    let t: TournamentData | null = null;
    let mi = -1;
    if (metaRaw) {
      try {
        const meta = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw;
        if (meta?.tId && meta?.mId) {
          t = await getT(meta.tId);
          if (t?.bracket) mi = t.bracket.findIndex(m => m.id === meta.mId);
        }
      } catch { /* metadata not JSON — fall through to code scan */ }
    }
    if ((!t || mi === -1) && shortCode) {
      const [rows] = await pool.query<any[]>('SELECT id FROM tournaments WHERE bracket IS NOT NULL');
      for (const row of rows) {
        const cand = await getT(row.id);
        const idx = cand?.bracket?.findIndex(m => m.code === shortCode) ?? -1;
        if (idx !== -1) { t = cand; mi = idx; break; }
      }
    }
    if (!t || mi === -1) {
      console.warn('[Callback] no se encontró el partido (code=%s)', shortCode);
      return res.status(200).send('OK');
    }

    const match = t.bracket![mi];
    // 2. Record gameId / region
    if (gameId) {
      match.gameId = Number(gameId);
      match.gameRegion = riotRegionToPlatform(region || t.region || 'LAN');
    }

    // 3. Auto-resolve the winner from the winningTeam PUUIDs.
    if (match.matchStatus !== 'complete' && t.phase === 'active') {
      const winPuuids = (Array.isArray(winningTeam) ? winningTeam : [])
        .map((p: any) => (typeof p === 'string' ? p : p?.puuid))
        .filter(Boolean) as string[];
      const t1 = match.team1Puuids ?? [];
      const t2 = match.team2Puuids ?? [];
      const t1hits = winPuuids.filter(p => t1.includes(p)).length;
      const t2hits = winPuuids.filter(p => t2.includes(p)).length;
      const winner = t1hits > t2hits ? match.team1 : t2hits > t1hits ? match.team2 : null;
      if (winner) {
        await applyResult(t, mi, winner);
        console.log(`[Callback] auto-resultado: "${winner}" gana ${match.id}`);
      } else {
        console.warn('[Callback] no se pudo atribuir ganador para %s (sin coincidencia de PUUIDs)', match.id);
      }
    }

    await saveT(t);
    // Async: detect stats + auto-result if callback winner attribution failed
    syncTournamentFull(t.id).catch(e => console.error('[Callback] sync error:', e.message));
  } catch (err) { console.error('[Callback] error:', err); }
  res.status(200).send('OK');
});

// GET /invitations/me — pending tournament invitations for the logged-in user
router.get('/invitations/me', requireAuth, async (req: any, res) => {
  try {
    const userId = req.auth.userId;
    const [rows] = await pool.query<any[]>(
      `SELECT i.*, t.name AS tournament_name, u.name AS invited_by_name
       FROM tournament_invitations i
       JOIN tournaments t ON t.id = i.tournament_id
       LEFT JOIN users u ON u.id = i.invited_by_user_id
       WHERE i.invited_user_id = ? AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [userId]
    );
    const invitations: TournamentInvitation[] = rows.map(r => ({
      id: r.id,
      tournamentId: r.tournament_id,
      tournamentName: r.tournament_name,
      teamName: r.team_name,
      invitedByUserId: r.invited_by_user_id,
      invitedByName: r.invited_by_name || undefined,
      slotIndex: r.slot_index,
      playerName: r.player_name || undefined,
      status: r.status,
      createdAt: r.created_at,
    }));
    res.json(invitations);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /invitations/:invId/respond — accept or decline (accept uses linked LoL account)
router.post('/invitations/:invId/respond', requireAuth, async (req: any, res) => {
  const { action } = req.body;
  if (action !== 'accept' && action !== 'decline') {
    return res.status(400).json({ error: 'action debe ser accept o decline' });
  }
  try {
    const userId = req.auth.userId;
    const [[inv]] = await pool.query<any[]>(
      'SELECT * FROM tournament_invitations WHERE id = ? AND invited_user_id = ? AND status = ?',
      [req.params.invId, userId, 'pending']
    );
    if (!inv) return res.status(404).json({ error: 'Invitación no encontrada' });

    if (action === 'decline') {
      await pool.query(
        "UPDATE tournament_invitations SET status='declined', responded_at=? WHERE id=?",
        [new Date().toISOString(), inv.id]
      );
      return res.json({ success: true, status: 'declined' });
    }

    const linked = await getLinkedRiotAccount(userId);
    if (!linked) {
      return res.status(400).json({
        error: 'Vincula tu cuenta de LoL en tu perfil antes de aceptar la invitación',
        code: 'RIOT_NOT_LINKED',
      });
    }

    const [[reg]] = await pool.query<any[]>(
      'SELECT * FROM tournament_registrations WHERE tournament_id=? AND team_name=?',
      [inv.tournament_id, inv.team_name]
    );
    if (!reg) return res.status(404).json({ error: 'Equipo no encontrado' });

    const players: RosterPlayer[] = parseJson(reg.players) || [];
    const slot = Number(inv.slot_index);
    if (slot < 0 || slot >= players.length) {
      return res.status(400).json({ error: 'Slot de jugador inválido' });
    }

    const [[userRow]] = await pool.query<any[]>('SELECT name FROM users WHERE id = ?', [userId]);
    players[slot] = {
      name: inv.player_name || userRow?.name || linked.gameName,
      riotId: linked.riotId,
      puuid: linked.puuid,
      userId,
      inviteStatus: 'accepted',
    };

    await pool.query(
      'UPDATE tournament_registrations SET players=? WHERE id=?',
      [JSON.stringify(players), reg.id]
    );
    await pool.query(
      "UPDATE tournament_invitations SET status='accepted', responded_at=? WHERE id=?",
      [new Date().toISOString(), inv.id]
    );

    res.json({
      success: true,
      status: 'accepted',
      riotId: linked.riotId,
      teamName: inv.team_name,
      tournamentId: inv.tournament_id,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /debug-list — list all tournament IDs (for debugging).
// Declared BEFORE GET /:id so the literal path isn't captured as an :id param.
router.get('/debug-list', requireAuth, async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Solo admin' });
  try {
    const [rows] = await pool.query<any[]>(
      'SELECT id, name, phase, riot_tournament_id, region FROM tournaments ORDER BY created_at DESC'
    );
    res.json(rows.map(r => ({
      id: r.id, name: r.name, phase: r.phase,
      riotTournamentId: r.riot_tournament_id, region: r.region,
    })));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /me/dashboard — invitations, teams, admin tournaments for logged-in user
router.get('/me/dashboard', requireAuth, async (req: any, res) => {
  try {
    const userId = req.auth.userId;
    const linked = await getLinkedRiotAccount(userId);
    const linkedRiot = linked?.riotId?.toLowerCase();

    const [invRows] = await pool.query<any[]>(
      `SELECT i.*, t.name AS tournament_name, t.phase, u.name AS invited_by_name
       FROM tournament_invitations i
       JOIN tournaments t ON t.id = i.tournament_id
       LEFT JOIN users u ON u.id = i.invited_by_user_id
       WHERE i.invited_user_id = ? AND i.status = 'pending'
       ORDER BY i.created_at DESC`,
      [userId]
    );

    const [allTournaments] = await pool.query<any[]>('SELECT * FROM tournaments ORDER BY created_at DESC');
    const myTeams: any[] = [];
    const administrating: any[] = [];

    for (const row of allTournaments) {
      const t = rowToTournament(row);
      if (t.createdBy === userId || (req.auth.role === 'admin' && t.createdBy)) {
        administrating.push({
          id: t.id, name: t.name, phase: t.phase,
          participants: t.participants, maxParticipants: t.maxParticipants,
          startDate: t.startDate, codesAvailable: t.codePool.length,
        });
      }

      const regs = await getRegs(t.id);
      for (const reg of regs) {
        let isMember = reg.registeredBy === userId;
        if (!isMember && linkedRiot && reg.captainRiotId?.toLowerCase() === linkedRiot) isMember = true;
        if (!isMember) {
          for (const p of reg.players || []) {
            if (p.userId === userId || (linkedRiot && p.riotId?.toLowerCase() === linkedRiot)) {
              isMember = true; break;
            }
          }
        }
        if (!isMember) continue;

        const myMatch = (t.bracket || []).find(m =>
          (m.team1 === reg.teamName || m.team2 === reg.teamName) &&
          (m.matchStatus === 'active' || m.matchStatus === 'ready')
        );

        myTeams.push({
          tournamentId: t.id,
          tournamentName: t.name,
          phase: t.phase,
          teamName: reg.teamName,
          captainRiotId: reg.captainRiotId,
          players: reg.players,
          checkedIn: reg.checkedIn,
          activeMatchCode: myMatch?.code ?? null,
          activeMatchId: myMatch?.id ?? null,
          isCaptain: reg.registeredBy === userId || reg.captainRiotId?.toLowerCase() === linkedRiot,
        });
      }
    }

    res.json({
      invitations: invRows.map(r => ({
        id: r.id, tournamentId: r.tournament_id, tournamentName: r.tournament_name,
        teamName: r.team_name, phase: r.phase,
        invitedByName: r.invited_by_name, slotIndex: r.slot_index,
        playerName: r.player_name, createdAt: r.created_at,
      })),
      myTeams,
      administrating,
      linkedRiotId: linked?.riotId ?? null,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET by id
router.get('/:id', optionalAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    const access = await getViewerAccess(t, req.auth);
    res.json(serialize(t, access));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Register team — auto-fills captain from linked LoL account; validates Riot IDs; sends invitations
router.post('/:id/register', requireAuth, async (req: any, res) => {
  const { teamName, captainRiotId, players, contact } = req.body;
  if (!teamName || !Array.isArray(players) || players.length < 5) {
    return res.status(400).json({ error: 'Datos incompletos (mínimo 5 jugadores)' });
  }
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (t.phase !== 'registration') return res.status(400).json({ error: 'Inscripciones cerradas' });
    if (t.participants >= t.maxParticipants) return res.status(400).json({ error: 'Torneo lleno' });

    const userId = req.auth.userId;
    const platform = t.region || 'la1';
    const linked = await getLinkedRiotAccount(userId);

    let captainId = captainRiotId?.trim() || '';
    if (!captainId && linked) captainId = linked.riotId;
    if (!captainId) {
      return res.status(400).json({
        error: 'Vincula tu cuenta de LoL en tu perfil o ingresa tu Riot ID como capitán',
        code: 'CAPTAIN_RIOT_REQUIRED',
      });
    }
    if (!/^.+#.{2,}$/.test(captainId)) {
      return res.status(400).json({ error: 'Riot ID del capitán inválido (formato: Nombre#TAG)' });
    }

    const captainResolved = await resolveRiotIdToPuuid(captainId, platform);
    if (!captainResolved) {
      return res.status(400).json({ error: `No se encontró la cuenta Riot "${captainId}" en ${platform.toUpperCase()}` });
    }

    const normalizedPlayers: RosterPlayer[] = [];
    const invitationsSent: string[] = [];
    const [[captainUser]] = await pool.query<any[]>(
      'SELECT name, email FROM users WHERE id = ? LIMIT 1',
      [userId]
    );
    const inviterName = captainUser?.name || captainUser?.email?.split('@')[0] || 'Capitán';

    for (let i = 0; i < players.length; i++) {
      const raw = players[i] || {};
      const name = String(raw.name || '').trim() || `Jugador ${i + 1}`;
      const riotId = String(raw.riotId || '').trim();
      const inviteEmail = String(raw.inviteEmail || '').trim();

      if (inviteEmail) {
        const invitedUserId = await findUserByEmail(inviteEmail);
        if (!invitedUserId) {
          return res.status(400).json({
            error: `No hay cuenta ATAK.GG con el correo ${inviteEmail}. El jugador debe registrarse primero.`,
            slot: i,
          });
        }
        if (invitedUserId === userId) {
          // Self-slot: use linked account
          if (!linked) return res.status(400).json({ error: 'Vincula tu cuenta de LoL para ocupar este slot' });
          normalizedPlayers.push({
            name, riotId: linked.riotId, puuid: linked.puuid, userId, inviteStatus: 'accepted',
          });
          continue;
        }
        normalizedPlayers.push({ name, inviteEmail, inviteStatus: 'pending' });
        await createInvitation(t.id, teamName, invitedUserId, userId, i, name, {
          tournamentName: t.name,
          inviterName,
        });
        invitationsSent.push(inviteEmail);
        continue;
      }

      if (!riotId) {
        return res.status(400).json({ error: `Slot ${i + 1}: ingresa Riot ID o invita por correo`, slot: i });
      }
      if (!/^.+#.{2,}$/.test(riotId)) {
        return res.status(400).json({ error: `Riot ID inválido en slot ${i + 1}: ${riotId}` });
      }

      const resolved = await resolveRiotIdToPuuid(riotId, platform);
      if (!resolved) {
        return res.status(400).json({ error: `Cuenta no encontrada: ${riotId}`, slot: i });
      }

      const matchedUserId = await findUserByRiotId(riotId);
      normalizedPlayers.push({
        name,
        riotId: `${resolved.gameName}#${resolved.tagLine}`,
        puuid: resolved.puuid,
        userId: matchedUserId || undefined,
        inviteStatus: 'accepted',
      });

      // Notify ATAK users when their Riot ID was added manually
      if (matchedUserId && matchedUserId !== userId) {
        await createInvitation(t.id, teamName, matchedUserId, userId, i, name).catch(() => {});
        await pool.query(
          "UPDATE tournament_invitations SET status='accepted', responded_at=? WHERE tournament_id=? AND team_name=? AND invited_user_id=?",
          [new Date().toISOString(), t.id, teamName, matchedUserId]
        );
      }
    }

    await pool.query(
      `INSERT INTO tournament_registrations
         (tournament_id, team_name, captain_riot_id, players, contact, registered_by, captain_user_id)
       VALUES (?,?,?,?,?,?,?)`,
      [
        t.id, teamName,
        `${captainResolved.gameName}#${captainResolved.tagLine}`,
        JSON.stringify(normalizedPlayers),
        contact || '',
        userId,
        userId,
      ]
    );
    await pool.query('UPDATE tournaments SET participants=participants+1 WHERE id=?', [t.id]);

    res.json({
      success: true,
      message: invitationsSent.length
        ? `¡Equipo inscrito! Invitaciones enviadas a ${invitationsSent.length} jugador(es).`
        : '¡Equipo inscrito!',
      teamName,
      currentParticipants: t.participants + 1,
      invitationsSent: invitationsSent.length,
      captainRiotId: `${captainResolved.gameName}#${captainResolved.tagLine}`,
    });
  } catch (err: any) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: 'Ya existe un equipo con ese nombre' });
    res.status(500).json({ error: err.message });
  }
});

// GET registrations
router.get('/:id/registrations', async (req, res) => {
  try { res.json(await getRegs(req.params.id)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Close registration → checkin
router.post('/:id/close-registration', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error:'Solo el creador puede hacer esto' });
    if (t.phase!=='registration') return res.status(400).json({ error:'No está en fase de inscripciones' });
    const regs = await getRegs(req.params.id);
    if (regs.length<2) return res.status(400).json({ error:'Mínimo 2 equipos' });
    t.phase='checkin';
    if (req.body.checkinDeadline) t.checkinDeadline=req.body.checkinDeadline;
    await saveT(t);
    res.json({ success:true, phase:'checkin', teamsRegistered:regs.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Check-in
router.post('/:id/checkin', requireAuth, async (req: any, res) => {
  const { teamName, captainRiotId } = req.body;
  if (!teamName) return res.status(400).json({ error:'teamName requerido' });
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    if (t.phase!=='checkin') return res.status(400).json({ error:'Check-in no activo' });

    const [[reg]] = await pool.query<any[]>(
      'SELECT * FROM tournament_registrations WHERE tournament_id=? AND LOWER(team_name)=LOWER(?)',
      [t.id, teamName]
    );
    if (!reg) return res.status(404).json({ error:'Equipo no encontrado' });
    if (captainRiotId && reg.captain_riot_id!==captainRiotId)
      return res.status(403).json({ error:'Riot ID del capitán no coincide' });
    if (reg.checked_in) return res.status(400).json({ error:'Ya hizo check-in' });

    await pool.query(
      'UPDATE tournament_registrations SET checked_in=1, checked_in_at=? WHERE id=?',
      [new Date().toISOString(), reg.id]
    );
    const [[{ checkedIn }]] = await pool.query<any[]>(
      'SELECT COUNT(*) AS checkedIn FROM tournament_registrations WHERE tournament_id=? AND checked_in=1',
      [t.id]
    );
    const [[{ total }]] = await pool.query<any[]>(
      'SELECT COUNT(*) AS total FROM tournament_registrations WHERE tournament_id=?', [t.id]
    );
    res.json({ success:true, message:'Check-in confirmado', checkedIn:Number(checkedIn), total:Number(total) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Start tournament
router.post('/:id/start', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error:'Solo el creador puede hacer esto' });
    if (t.phase==='active'||t.phase==='complete') return res.status(400).json({ error:'Torneo ya activo o completado' });
    const allRegs = await getRegs(req.params.id);
    const activeRegs = t.phase==='checkin' ? allRegs.filter(r=>r.checkedIn) : allRegs;
    if (activeRegs.length<2) return res.status(400).json({ error:'Mínimo 2 equipos' });

    const teams = activeRegs.map(r=>r.teamName);
    const bracket = generateBracket(teams);
    t.bracket = bracket;
    // Assign an allowlisted, metadata-tagged code to each ready round-1 match.
    for (let i = 0; i < bracket.length; i++) {
      if (bracket[i].round === 1 && bracket[i].matchStatus === 'ready') {
        await assignCodeToMatch(t, i);
      }
    }
    const standings: Standing[] = teams.map((team,i)=>({position:i+1,team,wins:0,losses:0,points:0}));
    t.phase='active'; t.standings=standings; t.participants=teams.length;
    await saveT(t);
    res.json({ success:true, bracket:t.bracket, standings });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET bracket
router.get('/:id/bracket', optionalAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    const access = await getViewerAccess(t, req.auth);
    res.json({ bracket: sanitizeBracket(t.bracket || [], access), phase: t.phase, viewerAccess: access });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Activate match
router.post('/:id/matches/:matchId/activate', requireAuth, async (req: any, res) => {
  const { id, matchId } = req.params;
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error:'Solo el creador puede hacer esto' });
    if (!t.bracket) return res.status(400).json({ error:'Sin bracket' });
    const mi = t.bracket.findIndex(m=>m.id===matchId);
    if (mi===-1) return res.status(404).json({ error:'Partido no encontrado' });
    const match = t.bracket[mi];
    if (match.matchStatus==='active'||match.matchStatus==='complete')
      return res.json({ success:true, code:match.code });
    if (!match.team1||!match.team2) return res.status(400).json({ error:'Faltan equipos' });
    const code = await assignCodeToMatch(t, mi);
    await saveT(t);
    res.json({ success:true, code, matchId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Report result
router.post('/:id/matches/:matchId/result', requireAuth, async (req: any, res) => {
  const { id, matchId } = req.params;
  const { winner, score1, score2 } = req.body;
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error:'Solo el creador puede hacer esto' });
    if (!t.bracket) return res.status(400).json({ error:'Sin bracket' });
    if (t.phase!=='active') return res.status(400).json({ error:'Torneo no activo' });
    const mi = t.bracket.findIndex(m=>m.id===matchId);
    if (mi===-1) return res.status(404).json({ error:'Partido no encontrado' });
    const match = t.bracket[mi];
    if (winner!==match.team1&&winner!==match.team2) return res.status(400).json({ error:'Ganador inválido' });
    if (match.matchStatus==='complete') return res.status(400).json({ error:'Partido ya completado' });

    await applyResult(t, mi, winner, score1, score2);
    await saveT(t);

    // applyResult may flip t.phase to 'complete'; cast past the earlier narrowing.
    const isComplete = (t.phase as TournamentPhase) === 'complete';
    const maxRound = Math.max(...t.bracket.map(m=>m.round));
    res.json({ success:true, bracket:t.bracket, standings:t.standings,
      tournamentComplete:isComplete,
      champion:isComplete?t.bracket.find(m=>m.round===maxRound)?.winner:null });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Link gameId manually
router.post('/:id/matches/:matchId/link-game', requireAuth, async (req: any, res) => {
  const { id, matchId } = req.params;
  const { gameId, region } = req.body;
  if (!gameId) return res.status(400).json({ error:'gameId requerido' });
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error:'Solo el creador' });
    const mi = t.bracket?.findIndex(m=>m.id===matchId)??-1;
    if (mi===-1) return res.status(404).json({ error:'Partido no encontrado' });
    t.bracket![mi].gameId=Number(gameId);
    t.bracket![mi].gameRegion=riotRegionToPlatform(region||'LAN');
    await saveT(t);
    res.json({ success:true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Resolve gameId to platform by trying all Americas platforms directly (no PUUID needed)
async function resolveGamePlatform(gameId: number): Promise<{ platform: string; riotMatchId: string } | null> {
  const platforms = ['la1', 'la2', 'na1', 'br1'];
  for (const pf of platforms) {
    const mid = riotMatchId(gameId, pf);
    const data = await getMatchById(pf, mid);
    if (data) return { platform: pf, riotMatchId: mid };
  }
  return null;
}

// Link gameId directly — probes all platforms to find where the game lives
router.post('/:id/matches/:matchId/link-gameid', requireAuth, async (req: any, res) => {
  const { id, matchId } = req.params;
  const { gameId } = req.body;
  if (!gameId) return res.status(400).json({ error: 'gameId requerido' });
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede hacer esto' });
    if (!t.bracket) return res.status(400).json({ error: 'Sin bracket' });
    const mi = t.bracket.findIndex(m => m.id === matchId);
    if (mi === -1) return res.status(404).json({ error: 'Partido no encontrado' });

    const resolved = await resolveGamePlatform(Number(gameId));
    if (!resolved) return res.status(404).json({ error: `gameId ${gameId} no encontrado en ninguna plataforma Americas` });

    t.bracket[mi].gameId     = Number(gameId);
    t.bracket[mi].gameRegion = resolved.platform;
    await saveT(t);
    res.json({ success: true, gameId: Number(gameId), platform: resolved.platform, riotMatchId: resolved.riotMatchId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Auto-detect gameId from captain's recent match history and link it
router.post('/:id/matches/:matchId/auto-detect-game', requireAuth, async (req: any, res) => {
  const { id, matchId } = req.params;
  try {
    let t = await getT(id) ?? await (async () => {
      const [[row]] = await pool.query<any[]>('SELECT * FROM tournaments WHERE riot_tournament_id = ?', [id]);
      return row ? rowToTournament(row) : null;
    })();
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede hacer esto' });
    if (!t.bracket) return res.status(400).json({ error: 'Sin bracket' });
    const mi = t.bracket.findIndex(m => m.id === matchId);
    if (mi === -1) return res.status(404).json({ error: 'Partido no encontrado', available: t.bracket.map(m => m.id) });

    const match = t.bracket[mi];
    const platform = t.region || 'la1';
    const probePlatforms = SPECTATOR_PROBE_PLATFORMS[platform] ?? [platform];

    // Find captain riot ID
    const regs = await getRegs(t.id);
    const captainRiotId = regs.find(r => r.teamName === match.team1)?.captainRiotId
                       ?? regs.find(r => r.teamName === match.team2)?.captainRiotId;
    if (!captainRiotId) return res.status(400).json({ error: 'No se encontró capitán registrado' });

    const [gameName, tagLine] = captainRiotId.split('#');
    if (!gameName || !tagLine) return res.status(400).json({ error: `Riot ID inválido: ${captainRiotId}` });

    const account = await getAccountByRiotId(gameName.trim(), tagLine.trim(), { platformHint: platform });
    if (!account?.puuid) return res.status(404).json({ error: `No se encontró cuenta para ${captainRiotId}` });

    // Try each platform's match history to find the most recent custom/tournament game
    let foundMatchId: string | null = null;
    let foundPlatform = platform;
    for (const pf of probePlatforms) {
      const ids = await getMatchIdsByPUUID(pf, account.puuid, 5, 0);
      if (ids && ids.length > 0) {
        foundMatchId = ids[0];
        foundPlatform = pf;
        break;
      }
    }

    if (!foundMatchId) return res.status(404).json({ error: 'No se encontraron partidas recientes. Espera unos minutos y reintenta.' });

    // Extract numeric gameId from matchId (e.g. "LA1_1234567890" → 1234567890)
    const parts = foundMatchId.split('_');
    const gameId = Number(parts[parts.length - 1]);

    t.bracket[mi].gameId = gameId;
    t.bracket[mi].gameRegion = foundPlatform;
    await saveT(t);

    res.json({ success: true, matchId, riotMatchId: foundMatchId, gameId, platform: foundPlatform });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Assign code and/or gameId to match (owner-only manual tournament ops)
router.post('/:id/matches/:matchId/set-code', requireAuth, async (req: any, res) => {
  const { id, matchId } = req.params;
  const { code, gameId, region } = req.body;
  if (!code && !gameId) return res.status(400).json({ error: 'Se requiere code o gameId' });
  try {
    const t = await getT(id) ?? await (async () => {
      const [[row]] = await pool.query<any[]>('SELECT * FROM tournaments WHERE riot_tournament_id = ?', [id]);
      return row ? rowToTournament(row) : null;
    })();
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede hacer esto' });
    if (!t.bracket) return res.status(400).json({ error: 'Sin bracket' });
    const mi = t.bracket.findIndex(m => m.id === matchId);
    if (mi === -1) return res.status(404).json({ error: 'Partido no encontrado', available: t.bracket.map(m => m.id) });
    if (code) { t.bracket[mi].code = code; t.bracket[mi].codeActivatedAt = Date.now(); }
    if (gameId) {
      t.bracket[mi].gameId     = Number(gameId);
      t.bracket[mi].gameRegion = region ? riotRegionToPlatform(region) : (t.region || 'la1');
    }
    if (t.bracket[mi].matchStatus === 'pending' || t.bracket[mi].matchStatus === 'ready') {
      t.bracket[mi].matchStatus = 'active';
    }
    await saveT(t);
    for (const [k] of liveCache) { if (k.includes('live')) liveCache.delete(k); }
    res.json({ success: true, matchId, code: t.bracket[mi].code, gameId: t.bracket[mi].gameId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Try lobby events for a code directly (admin-only — hits Riot, no tournament scope)
router.get('/debug-lobby/:code', requireAuth, async (req: any, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Solo admin' });
  try {
    const events = await getLobbyEvents(req.params.code);
    res.json(events);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Admin: clear a wrong gameId link (e.g. a bad roster-recovery) so the match can
// re-detect from the tournament code or be linked manually. Optionally clears the code.
router.post('/:id/matches/:matchId/reset-link', requireAuth, async (req: any, res) => {
  const { id, matchId } = req.params;
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede hacer esto' });
    if (!t.bracket) return res.status(400).json({ error: 'Sin bracket' });
    const mi = t.bracket.findIndex(m => m.id === matchId);
    if (mi === -1) return res.status(404).json({ error: 'Partido no encontrado' });

    const clearCode = req.body?.clearCode === true;
    t.bracket[mi].gameId = undefined;
    t.bracket[mi].gameRegion = undefined;
    if (clearCode) { t.bracket[mi].code = null; t.bracket[mi].codeActivatedAt = undefined; }
    await saveT(t);

    // Drop cached stats + live-cache so the next request re-fetches cleanly.
    await pool.query(
      'DELETE FROM tournament_match_stats WHERE tournament_id = ? AND bracket_match_id = ?',
      [id, matchId]
    ).catch(() => {});
    for (const [k] of liveCache) { if (k.includes('live') || k.includes('codegame')) liveCache.delete(k); }

    res.json({ success: true, matchId, cleared: { gameId: true, code: clearCode } });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Match stats — full MatchDto parsing with DB cache
router.get('/:id/matches/:matchId/stats', async (req, res) => {
  const { id, matchId } = req.params;
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!t.bracket) return res.status(404).json({ error: 'Partido no encontrado' });
    const mi = t.bracket.findIndex(m => m.id === matchId);
    if (mi === -1) return res.status(404).json({ error: 'Partido no encontrado' });

    // Auto-detectar gameId desde el código de torneo si aún no está vinculado
    if (!t.bracket[mi].gameId && t.bracket[mi].code) {
      const detected = await tryDetectGameId(t.bracket[mi].code!, t.region || 'la1');
      if (detected) {
        console.log(`[stats] gameId auto-detectado vía código: ${t.bracket[mi].code} → ${detected.gameId} (${detected.platform})`);
        t.bracket[mi].gameId     = detected.gameId;
        t.bracket[mi].gameRegion = detected.platform;
        await saveT(t).catch(e => console.error('[stats] saveT error:', e.message));
      }
    }

    // Recuperar desde historial de jugadores inscritos si Riot no vinculó el código
    if (!t.bracket[mi].gameId) {
      const recovered = await recoverGameFromRoster(t, t.bracket[mi]);
      if (recovered) {
        console.log(`[stats] gameId recuperado vía roster: ${matchId} → ${recovered.gameId} (${recovered.platform})`);
        t.bracket[mi].gameId     = recovered.gameId;
        t.bracket[mi].gameRegion = recovered.platform;
        await saveT(t).catch(e => console.error('[stats] saveT error:', e.message));
      }
    }

    const match = t.bracket[mi];
    if (!match.gameId) return res.status(404).json({ error: 'No hay gameId. La partida aún no ha sido registrada en Riot o el código no fue usado.' });

    // Serve from DB cache if complete (game already finished + saved)
    const cached = await getStoredMatchStats(id, matchId);
    if (cached?.isComplete) return res.json(cached);

    const primaryPlatform = match.gameRegion || t.region || 'la1';
    const tryPlatforms = primaryPlatform === 'la1' ? ['la1','la2']
                       : primaryPlatform === 'la2' ? ['la2','la1']
                       : [primaryPlatform];

    let data: any = null;
    let usedPlatform = primaryPlatform;
    for (const pf of tryPlatforms) {
      data = await getMatchById(pf, riotMatchId(match.gameId, pf));
      if (data) { usedPlatform = pf; break; }
    }

    // Intenta plataformas adicionales (na1, br1) como último recurso
    if (!data) {
      const extra = ['na1', 'br1'].filter(p => !tryPlatforms.includes(p));
      for (const pf of extra) {
        data = await getMatchById(pf, riotMatchId(match.gameId!, pf));
        if (data) { usedPlatform = pf; break; }
      }
    }

    if (!data) return res.status(404).json({
      error: `Partida ${match.gameId} no encontrada en Riot.`,
      detail: 'Verifica que la partida fue jugada con el código de torneo activo en el lobby. Si fue jugada sin código, linkea el gameId correcto con /link-gameid.',
      triedPlatforms: [...tryPlatforms, 'na1', 'br1'].filter((v, i, a) => a.indexOf(v) === i),
    });

    const info = data.info;
    const isComplete = !!info.gameEndTimestamp;
    const riotMid = riotMatchId(match.gameId, usedPlatform);
    const parsed = buildMatchStatsResponse(data, riotMid, isComplete);

    // Persist to DB once the game is over
    if (isComplete) {
      await saveMatchStats(id, matchId, riotMid, match.gameId, parsed, info.gameDuration, info.gameEndTimestamp)
        .catch(err => console.error('[stats] save error:', err.message));
    }

    res.json(parsed);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Detectar gameId desde el código de torneo del partido (llamada explícita)
router.post('/:id/matches/:matchId/detect-from-code', requireAuth, async (req: any, res) => {
  const { id, matchId } = req.params;
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede hacer esto' });
    if (!t.bracket) return res.status(400).json({ error: 'Sin bracket' });
    const mi = t.bracket.findIndex(m => m.id === matchId);
    if (mi === -1) return res.status(404).json({ error: 'Partido no encontrado' });
    const match = t.bracket[mi];
    if (!match.code) return res.status(400).json({ error: 'El partido no tiene código de torneo asignado' });

    const detected = await tryDetectGameId(match.code, t.region || 'la1');
    if (!detected) {
      return res.status(404).json({
        error: 'La partida aún no está disponible en la API de Riot. Espera a que termine y vuelve a intentarlo.',
        code: match.code,
      });
    }
    t.bracket[mi].gameId     = detected.gameId;
    t.bracket[mi].gameRegion = detected.platform;
    await saveT(t);
    res.json({ success: true, gameId: detected.gameId, platform: detected.platform, matchId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Sincronizar gameIds + stats + resultados automáticos (owner o admin)
router.post('/:id/sync-games', requireAuth, async (req: any, res) => {
  const { id } = req.params;
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t) && !isAdmin(req)) return res.status(403).json({ error: 'Solo el creador puede hacer esto' });
    const result = await syncTournamentFull(id);
    res.json({ success: true, ...result, total: result.details.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:id/auto-sync — público para torneos activos (rate-limited por caché); fuerza sync ligero
router.post('/:id/auto-sync', async (req, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (t.phase !== 'active' && t.phase !== 'complete') {
      return res.json({ synced: 0, details: [], message: 'Torneo no activo' });
    }
    const result = await syncTournamentFull(t.id);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Global stats — aggregated from all completed bracket matches in this tournament
router.get('/:id/global-stats', async (req, res) => {
  const { id } = req.params;
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });

    const [rows] = await pool.query<any[]>(
      `SELECT parsed_data, game_duration FROM tournament_match_stats
       WHERE tournament_id = ? AND game_end_ts IS NOT NULL
       ORDER BY fetched_at ASC`,
      [id]
    );

    if (rows.length === 0) {
      return res.json({ tournamentId: id, matchesCompleted: 0, players: [], lastUpdated: Date.now() });
    }

    type Acc = {
      summonerName: string; tagLine: string;
      gamesPlayed: number; wins: number;
      totalKills: number; totalDeaths: number; totalAssists: number;
      totalGold: number; totalDamage: number; totalVisionScore: number; totalCs: number;
      totalMins: number;
      pentaKills: number; quadraKills: number; tripleKills: number; doubleKills: number;
      champCounts: Map<string, number>;
    };

    const playerMap = new Map<string, Acc>();

    for (const row of rows) {
      const data: any = typeof row.parsed_data === 'string' ? JSON.parse(row.parsed_data) : row.parsed_data;
      const dur  = (row.game_duration as number) || (data.gameDuration as number) || 0;
      const mins = Math.max(1, dur / 60);
      const all: any[] = [...(data.blueTeam ?? []), ...(data.redTeam ?? [])];

      for (const p of all) {
        const key = `${p.summonerName}#${p.tagLine || ''}`;
        if (!playerMap.has(key)) {
          playerMap.set(key, {
            summonerName: p.summonerName, tagLine: p.tagLine || '',
            gamesPlayed: 0, wins: 0,
            totalKills: 0, totalDeaths: 0, totalAssists: 0,
            totalGold: 0, totalDamage: 0, totalVisionScore: 0, totalCs: 0,
            totalMins: 0,
            pentaKills: 0, quadraKills: 0, tripleKills: 0, doubleKills: 0,
            champCounts: new Map(),
          });
        }
        const acc = playerMap.get(key)!;
        acc.gamesPlayed++;
        if (p.win) acc.wins++;
        acc.totalKills      += p.kills          ?? 0;
        acc.totalDeaths     += p.deaths         ?? 0;
        acc.totalAssists    += p.assists        ?? 0;
        acc.totalGold       += p.goldEarned     ?? 0;
        acc.totalDamage     += p.totalDamageDealt ?? 0;
        acc.totalVisionScore += p.visionScore   ?? 0;
        acc.totalCs         += p.cs             ?? 0;
        acc.totalMins       += mins;
        acc.pentaKills      += p.pentaKills  ?? 0;
        acc.quadraKills     += p.quadraKills ?? 0;
        acc.tripleKills     += p.tripleKills ?? 0;
        acc.doubleKills     += p.doubleKills ?? 0;
        acc.champCounts.set(p.championName, (acc.champCounts.get(p.championName) ?? 0) + 1);
      }
    }

    const players = Array.from(playerMap.values()).map(acc => {
      const m = Math.max(1, acc.totalMins);
      const mostPlayedChamp = [...acc.champCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      const avgKda = acc.totalDeaths === 0
        ? acc.totalKills + acc.totalAssists
        : (acc.totalKills + acc.totalAssists) / acc.totalDeaths;
      return {
        summonerName:     acc.summonerName,
        tagLine:          acc.tagLine,
        championPool:     [...acc.champCounts.keys()],
        mostPlayedChamp,
        gamesPlayed:      acc.gamesPlayed,
        wins:             acc.wins,
        losses:           acc.gamesPlayed - acc.wins,
        winrate:          Math.round((acc.wins / acc.gamesPlayed) * 100),
        totalKills:       acc.totalKills,
        totalDeaths:      acc.totalDeaths,
        totalAssists:     acc.totalAssists,
        avgKda:           Math.round(avgKda * 100) / 100,
        totalGold:        acc.totalGold,
        avgGoldPerMin:    Math.round((acc.totalGold / m) * 10) / 10,
        totalDamage:      acc.totalDamage,
        avgDamagePerMin:  Math.round((acc.totalDamage / m) * 10) / 10,
        totalVisionScore: acc.totalVisionScore,
        avgVisionPerMin:  Math.round((acc.totalVisionScore / m) * 100) / 100,
        totalCs:          acc.totalCs,
        avgCsPerMin:      Math.round((acc.totalCs / m) * 10) / 10,
        pentaKills:       acc.pentaKills,
        quadraKills:      acc.quadraKills,
        tripleKills:      acc.tripleKills,
        doubleKills:      acc.doubleKills,
      };
    });

    res.json({ tournamentId: id, matchesCompleted: rows.length, players, lastUpdated: Date.now() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Generate codes
router.post('/:id/generate-codes', requireAuth, async (req: any, res) => {
  const { count=10 } = req.body;
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error:'Solo el creador puede hacer esto' });
    const providerId = await getOrCreateProviderId();
    let riotTournamentId = t.riotTournamentId;
    if (!riotTournamentId) {
      const rt = await createTournament(providerId, t.name);
      riotTournamentId = rt.id; t.riotTournamentId = riotTournamentId;
    }
    const newCodes = await generateCodes(riotTournamentId!, count);
    t.codePool = [...t.codePool, ...newCodes];
    await saveT(t);
    res.json({ success:true, generated:newCodes.length, poolSize:t.codePool.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET codes (owner only)
router.get('/:id/codes', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error:'Solo el creador' });
    res.json({ codePool:t.codePool, poolSize:t.codePool.length, riotTournamentId:t.riotTournamentId });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/lobby-events/:code', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    const access = await getViewerAccess(t, req.auth);
    if (access === 'public') return res.status(403).json({ error: 'Solo jugadores inscritos' });
    res.json(await getLobbyEvents(req.params.code));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/:id/code-info/:code', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    const access = await getViewerAccess(t, req.auth);
    if (access === 'public') return res.status(403).json({ error: 'Solo jugadores inscritos' });
    res.json(await getCodeInfo(req.params.code));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── PATCH /:id — update logo/banner/region (owner only) ─────────────────────
router.patch('/:id', requireAuth, async (req: any, res) => {
  const { logoUrl, bannerUrl, region, name, prize, description } = req.body;
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede editar' });
    if (logoUrl    !== undefined) t.logoUrl    = logoUrl    || undefined;
    if (bannerUrl  !== undefined) t.bannerUrl  = bannerUrl  || undefined;
    if (region     !== undefined) t.region     = region     || 'la1';
    if (name       !== undefined) t.name       = name;
    if (prize      !== undefined) t.prize      = prize;
    if (description !== undefined) t.description = description;
    await saveT(t);
    res.json({ success: true, tournament: serialize(t) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Shared cache for live-match spectator lookups ────────────────────────────
const liveCache = new Map<string, { data: any; exp: number }>();
function lcGet(k: string) { const e = liveCache.get(k); return e && e.exp > Date.now() ? e.data : undefined; }
function lcSet(k: string, v: any, ms: number) { liveCache.set(k, { data: v, exp: Date.now() + ms }); }

// Platforms to probe when searching for a live game — includes regional siblings
// so a LAN tournament can detect a player whose summoner is on LAS and vice-versa.
const SPECTATOR_PROBE_PLATFORMS: Record<string, string[]> = {
  la1: ['la1', 'la2'],
  la2: ['la2', 'la1'],
  na1: ['na1'],
  br1: ['br1'],
  euw1: ['euw1'],
  eun1: ['eun1'],
  kr:   ['kr'],
  jp1:  ['jp1'],
};

// ─── Core helper — build live data for a tournament ──────────────────────────
async function buildLiveData(id: string) {
  const t = await getT(id);
  if (!t) return null;

  const platform = t.region || 'la1';
  const activeMatches = (t.bracket || []).filter(
    m => m.matchStatus === 'active' || m.matchStatus === 'ready'
  );

  const regs = await getRegs(t.id);

  // Map teamName → all registered player Riot IDs (captain first, then rest of roster)
  const teamPlayersMap = new Map<string, string[]>();
  regs.forEach(r => {
    const ids: string[] = [r.captainRiotId];
    (r.players || []).forEach((p: any) => {
      if (p.riotId && p.riotId !== r.captainRiotId) ids.push(p.riotId);
    });
    teamPlayersMap.set(r.teamName, ids);
  });

  // Resolve PUUID from Riot ID (cached 10 min)
  async function resolvePuuid(riotId: string): Promise<string | null> {
    const ck = `puuid:${platform}:${riotId}`;
    const cached = lcGet(ck);
    if (cached !== undefined) return cached as string | null;
    try {
      const [gameName, tagLine] = riotId.split('#');
      if (!gameName || !tagLine) return null;
      const account = await getAccountByRiotId(gameName.trim(), tagLine.trim(), { platformHint: platform });
      const puuid = account?.puuid ?? null;
      if (puuid) lcSet(ck, puuid, 10 * 60_000);
      return puuid;
    } catch { return null; }
  }

  console.log(`[live:${id}] platform=${platform} activeMatches=${activeMatches.length} regs=${regs.length}`);
  activeMatches.forEach(m => console.log(`  match ${m.id}: ${m.team1} vs ${m.team2} (${m.matchStatus})`));
  regs.forEach(r => console.log(`  reg team="${r.teamName}" captain="${r.captainRiotId}" players=${(r.players||[]).length}`));

  const results = await Promise.all(activeMatches.map(async (match) => {
    // Gather all players from both teams (up to 10 Riot IDs to probe)
    const allRiotIds: string[] = [];
    for (const tn of [match.team1, match.team2]) {
      if (!tn) continue;
      const ids = teamPlayersMap.get(tn) ?? [];
      ids.forEach(rid => { if (rid && !allRiotIds.includes(rid)) allRiotIds.push(rid); });
    }

    // ── Per-team PUUID sets — used to verify a spectator game is THIS match ──────
    const team1Puuids = new Set<string>(match.team1Puuids ?? []);
    const team2Puuids = new Set<string>(match.team2Puuids ?? []);
    for (const rid of (match.team1 ? teamPlayersMap.get(match.team1) ?? [] : [])) {
      const p = await resolvePuuid(rid); if (p) team1Puuids.add(p);
    }
    for (const rid of (match.team2 ? teamPlayersMap.get(match.team2) ?? [] : [])) {
      const p = await resolvePuuid(rid); if (p) team2Puuids.add(p);
    }

    // ── Authoritative game id from the tournament CODE (source of truth) ────────
    // Prefer a callback-linked gameId; otherwise ask Riot which game the code produced.
    let codeGameId: number | null = match.gameId ?? null;
    if (match.code) {
      const ck = `codegame:${match.code}`;
      const cached = lcGet(ck);
      if (cached !== undefined) {
        codeGameId = (cached as number | null) ?? codeGameId;
      } else {
        try {
          const games = await getGamesByCode(match.code);
          const g = games.length ? Number(games[games.length - 1].gameId) : null;
          if (g) codeGameId = g;
          lcSet(ck, g, 30_000);
        } catch { /* keep existing */ }
      }
    }

    // A spectator game counts as the tournament match ONLY if:
    //   a) its gameId equals the code's game (or callback-linked gameId), OR
    //   b) it's a CUSTOM game (queueId 0 — what tournament codes create) that has
    //      at least one registered player from EACH team (scrim/arena-proof).
    // Anything else (Arena/CHERRY, ARAM, ranked, normals) is rejected.
    const isTournamentGame = (game: any): boolean => {
      if (!game) return false;
      if (codeGameId && Number(game.gameId) === Number(codeGameId)) return true;
      const q = game.gameQueueConfigId ?? game.gameQueueId;
      if (q !== 0) return false;
      const gp = (game.participants ?? []).map((p: any) => p.puuid).filter(Boolean) as string[];
      const inT1 = gp.some((p) => team1Puuids.has(p));
      const inT2 = gp.some((p) => team2Puuids.has(p));
      return inT1 && inT2;
    };

    console.log(`[live:${id}] match ${match.id} → probing ${allRiotIds.length} Riot IDs (codeGameId=${codeGameId ?? '—'}):`, allRiotIds);

    let liveGame: any = null;
    for (const riotId of allRiotIds) {
      const ck = `live:${platform}:${riotId}`;
      const cached = lcGet(ck);
      if (cached && isTournamentGame(cached)) { console.log(`  [cache HIT game] ${riotId}`); liveGame = cached; break; }

      const puuid = await resolvePuuid(riotId);
      if (!puuid) { console.log(`  [puuid FAIL] ${riotId}`); continue; }
      console.log(`  [puuid ok] ${riotId} → ${puuid.slice(0,12)}...`);

      try {
        const probePlatforms = SPECTATOR_PROBE_PLATFORMS[platform] ?? [platform];
        let game: any = null;

        for (const pf of probePlatforms) {
          // 1. Try spectator by-puuid
          game = await getLiveGameByPuuid(pf, puuid);
          if (game) { console.log(`  [by-puuid] ${riotId} on ${pf} gameId=${game.gameId} q=${game.gameQueueConfigId}`); break; }

          // 2. Try spectator by-summoner
          try {
            const summoner = await getSummonerByPUUID(pf, puuid);
            if (summoner?.id) {
              game = await getLiveGame(pf, summoner.id);
              if (game) { console.log(`  [by-summoner] ${riotId} on ${pf} gameId=${game.gameId} q=${game.gameQueueConfigId}`); break; }
            }
          } catch (e: any) {
            console.log(`  [by-summoner ERROR] ${riotId} on ${pf}:`, e?.response?.status ?? e?.message);
          }
        }

        if (game) {
          lcSet(ck, game, 60_000);
          if (isTournamentGame(game)) {
            console.log(`  [LIVE — tournament game] ${riotId} gameId=${game.gameId}`);
            liveGame = game;
            break;
          } else {
            console.log(`  [skip — not the tournament game] ${riotId} gameId=${game.gameId} q=${game.gameQueueConfigId}`);
          }
        } else {
          console.log(`  [not in game] ${riotId}`);
          lcSet(ck, null, 15_000);
        }
      } catch (err: any) {
        console.error(`  [spectator ERROR] ${riotId}:`, err?.response?.status, err?.message);
      }
    }

    // ── Fallback: lobby events ─────────────────────────────────────────────────
    // If no player had a valid Riot ID (bad registration data), try fetching the
    // summoner IDs directly from the tournament code's lobby events. Still gated by
    // isTournamentGame so we never surface an unrelated game as live.
    if (!liveGame && match.code) {
      console.log(`  [lobby fallback] trying code ${match.code}`);
      try {
        const events = await getLobbyEvents(match.code);
        const summonerIds: string[] = [
          ...new Set(
            ((events?.eventList ?? []) as any[])
              .filter(e => e.summonerId)
              .map(e => e.summonerId as string)
          ),
        ];
        console.log(`  [lobby fallback] found ${summonerIds.length} summonerIds`);
        for (const sid of summonerIds) {
          const ck = `live-sid:${platform}:${sid}`;
          const cached = lcGet(ck);
          if (cached && isTournamentGame(cached)) { liveGame = cached; break; }
          try {
            const game = await getLiveGame(platform, sid);
            if (game) {
              lcSet(ck, game, 60_000);
              if (isTournamentGame(game)) {
                console.log(`  [LIVE via lobby] summonerId=${sid.slice(0,10)}... gameId=${game.gameId}`);
                liveGame = game;
                break;
              }
            } else {
              lcSet(ck, null, 15_000);
            }
          } catch {}
        }
      } catch (lobbyErr: any) {
        console.log(`  [lobby fallback error] ${lobbyErr.message}`);
      }
    }

    let blueTeam: any[] = [], redTeam: any[] = [], gameLength = 0, gameId: number | null = null;
    if (liveGame) {
      gameLength = liveGame.gameLength ?? 0;
      gameId     = liveGame.gameId ?? null;
      (liveGame.participants ?? []).forEach((p: any) => {
        const entry = {
          summonerName: p.riotId?.split('#')[0] ?? p.summonerName ?? 'Unknown',
          riotId:       p.riotId ?? null,
          championId:   p.championId,
          spell1Id:     p.spell1Id,
          spell2Id:     p.spell2Id,
          teamId:       p.teamId,
        };
        if (p.teamId === 100) blueTeam.push(entry); else redTeam.push(entry);
      });
    }

    return {
      matchId: match.id, round: match.round, matchNumber: match.matchNumber,
      team1: match.team1, team2: match.team2,
      score1: match.score1 ?? 0, score2: match.score2 ?? 0,
      matchStatus: match.matchStatus, code: match.code,
      isLive: !!liveGame, gameId, gameLength, blueTeam, redTeam,
      bannedChampions: (liveGame?.bannedChampions ?? []).map((b: any) => ({
        championId: b.championId, teamId: b.teamId, pickTurn: b.pickTurn,
      })),
    };
  }));

  return {
    tournamentId: t.id, tournamentName: t.name, phase: t.phase,
    region: platform, logoUrl: t.logoUrl, bannerUrl: t.bannerUrl,
    matches: results, timestamp: Date.now(),
  };
}

// GET /:id/debug-live — returns raw resolution info for troubleshooting
router.get('/:id/debug-live', requireAuth, async (req: any, res) => {
  try {
    // Accept either internal slug OR riot_tournament_id
    let t = await getT(req.params.id);
    if (!t) {
      const [[row]] = await pool.query<any[]>(
        'SELECT * FROM tournaments WHERE riot_tournament_id = ?', [req.params.id]
      );
      if (row) t = rowToTournament(row);
    }
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado', hint: 'Llama a /api/tournaments/debug-list para ver los IDs disponibles' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede hacer esto' });
    const platform = t.region || 'la1';
    const regs = await getRegs(t.id);
    const activeMatches = (t.bracket || []).filter(
      m => m.matchStatus === 'active' || m.matchStatus === 'ready'
    );

    const info: any = { tournamentId: t.id, phase: t.phase, platform, activeMatches: activeMatches.length, teams: [] };

    for (const r of regs) {
      const teamInfo: any = { teamName: r.teamName, captainRiotId: r.captainRiotId, players: [], spectatorResults: [] };
      const allIds = [r.captainRiotId, ...(r.players||[]).map((p:any)=>p.riotId).filter(Boolean)];
      for (const riotId of allIds) {
        try {
          const [gameName, tagLine] = riotId.split('#');
          if (!gameName || !tagLine) { teamInfo.players.push({ riotId, error: 'formato inválido (falta #tag)' }); continue; }
          const account = await getAccountByRiotId(gameName.trim(), tagLine.trim(), { platformHint: platform });
          if (!account?.puuid) { teamInfo.players.push({ riotId, error: 'cuenta no encontrada' }); continue; }
          const puuid = account.puuid;
          let gameInfo: any = null;
          try {
            const g = await getLiveGameByPuuid(platform, puuid);
            gameInfo = g ? { gameId: g.gameId, gameLength: g.gameLength, participants: g.participants?.length } : null;
          } catch (e: any) { gameInfo = { error: e?.response?.status ?? e?.message }; }
          teamInfo.players.push({ riotId, puuid: puuid.slice(0,12)+'...', inGame: !!gameInfo, gameInfo });
        } catch (e: any) {
          teamInfo.players.push({ riotId, error: e?.response?.status ?? e?.message });
        }
      }
      info.teams.push(teamInfo);
    }
    res.json(info);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

function sanitizeLivePayload(data: any, access: ViewerAccess) {
  if (!data) return data;
  const canViewCodes = access === 'owner' || access === 'participant';
  return {
    ...data,
    viewerAccess: access,
    matches: (data.matches || []).map((m: any) => (
      canViewCodes ? m : { ...m, code: null }
    )),
  };
}

// GET /:id/live-matches — REST endpoint (polling)
router.get('/:id/live-matches', optionalAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    const data = await buildLiveData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Torneo no encontrado' });
    const access = await getViewerAccess(t, req.auth);
    res.json(sanitizeLivePayload(data, access));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /:id/live-stream — SSE endpoint (real-time, every 15s)
router.get('/:id/live-stream', optionalAuth, async (req: any, res) => {
  res.setHeader('Content-Type',     'text/event-stream');
  res.setHeader('Cache-Control',    'no-cache');
  res.setHeader('Connection',       'keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.flushHeaders();

  const push = (obj: object) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      (res as any).flush?.();
    } catch {}
  };

  const tournId = req.params.id;
  const tick = async () => {
    try {
      const t = await getT(tournId);
      const data = await buildLiveData(tournId);
      if (!data) { push({ error: 'Torneo no encontrado' }); return; }
      const access = t ? await getViewerAccess(t, req.auth) : 'public';
      push(sanitizeLivePayload(data, access));
    } catch (e: any) { push({ error: e.message }); }
  };

  // Heartbeat every 30s to keep connection alive through proxies
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); (res as any).flush?.(); } catch {}
  }, 30_000);

  await tick();
  const interval = setInterval(tick, 15_000);
  req.on('close', () => { clearInterval(interval); clearInterval(heartbeat); });
});

export default router;
