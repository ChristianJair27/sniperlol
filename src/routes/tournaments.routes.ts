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
// Solo helpers puros (sin ciclo: el scheduler importa estas rutas dinámicamente).
import { todayStartFor } from '../services/tournament-scheduler.service.js';
import { sendTournamentInvitationEmail, isDeliverableEmail } from '../services/mail.service.js';
import { pool } from '../db.js';

const router = Router();

// ─── Types ────────────────────────────────────────────────────────────────────
type TournamentPhase = 'registration' | 'checkin' | 'active' | 'complete' | 'cancelled';
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
  // Series (Bo3/Bo5): juegos ya jugados de este enfrentamiento. gameId (arriba)
  // apunta al último juego para compat con la vista de stats.
  games?: Array<{ gameId: number; gameRegion?: string; winner?: string | null }>;
  // Juegos necesarios para ganar la serie (1=Bo1 default, 2=Bo3, 3=Bo5).
  seriesTo?: number;
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
  id: number;
  teamName: string; captainRiotId: string;
  players: RosterPlayer[];
  contact: string; registeredAt: string;
  checkedIn: boolean; checkedInAt?: string;
  registeredBy?: number;
  captainUserId?: number;
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
  // Fearless draft: campeones ya jugados en el torneo quedan bloqueados para
  // picks siguientes (la plataforma los muestra; el lobby no lo puede forzar).
  fearless?: boolean;
  // Formato del bracket: eliminación directa (default), round robin (liga) o suizo.
  bracketType?: 'single_elim' | 'round_robin' | 'swiss';
  // Series: juegos necesarios para ganar un enfrentamiento (1=Bo1, 2=Bo3, 3=Bo5).
  seriesTo?: number;
  // Registro externo (p.ej. formulario de la liga): la UI manda ahí y el
  // registro directo en ATAK se bloquea para no-organizadores.
  registrationUrl?: string;
  // Reglamento (PDF/URL) mostrado en la pestaña Reglas.
  rulesUrl?: string;
  // Override para la final (p.ej. Bo3 todo el torneo y final Bo5 → finalSeriesTo=3).
  finalSeriesTo?: number;
  // Suizo: nº de rondas planeadas. Si está definido, el sync avanza de ronda
  // solo y cierra el torneo al terminar la última; la última ronda usa
  // finalSeriesTo. undefined = manual (botón "Siguiente ronda").
  swissRounds?: number;
  // Formato de juego custom: tamaño de equipo (1-5) y mapa. Los códigos de
  // Riot soportan SR y ARAM; ARENA no tiene lobbies custom, así que se juega
  // como LADDER: las duplas juegan Arena normal dentro de la ventana del evento
  // y el sync puntúa los placements desde el historial (queue 1700/1710).
  teamSize?: number;
  gameMap?: 'SR' | 'ARAM' | 'ARENA';
  pickType?: string;
  // Fin de la ventana de juego (ladder Arena) — al llegar, el sync cierra.
  endDate?: string;
  // Estado del ladder Arena (partidas procesadas + puntos por dupla).
  ladder?: ArenaLadder;
  // Si el torneo nació de una plantilla de torneos diarios.
  scheduleId?: number;
  // Privado: invisible al público; inscripción solo con invitación (correo).
  isPrivate?: boolean;
}
export interface ArenaLadder {
  processed: string[]; // riot match ids ya puntuados
  teams: Record<string, {
    games: Array<{ matchId: string; placement: number; at: number }>;
    points: number;
  }>;
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
    // Soft-hide: torneos de prueba fuera de listas públicas sin borrar datos
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS hidden TINYINT(1) DEFAULT 0`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS fearless TINYINT(1) DEFAULT 0`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS bracket_type VARCHAR(20) DEFAULT 'single_elim'`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS series_to INT DEFAULT 1`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS registration_url VARCHAR(500)`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS rules_url VARCHAR(500)`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS final_series_to INT DEFAULT 1`,
    // Suizo: nº de rondas planeadas → habilita avance automático de ronda.
    // NULL = manual (comportamiento clásico con el botón "Siguiente ronda").
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS swiss_rounds INT DEFAULT NULL`,
    // Torneo privado: no aparece en listas públicas y solo se puede inscribir
    // quien tenga invitación del organizador (por correo).
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_private TINYINT(1) DEFAULT 0`,
    // Formatos custom: 1v1-5v5, mapa (SR/ARAM/ARENA) y pick type del lobby.
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS team_size INT DEFAULT 5`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS game_map VARCHAR(16) DEFAULT 'SR'`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS pick_type VARCHAR(32) DEFAULT NULL`,
    // Ladder Arena: ventana de juego + estado de puntuación.
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS end_date VARCHAR(50) DEFAULT NULL`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS ladder JSON DEFAULT NULL`,
    // Torneos diarios: plantilla que generó este torneo (NULL = manual).
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS schedule_id INT DEFAULT NULL`,
    // Plantillas de torneos diarios: el scheduler crea una instancia por día
    // a la hora configurada, abre inscripciones y auto-inicia.
    `CREATE TABLE IF NOT EXISTS tournament_schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(200) NOT NULL,
      description TEXT,
      game_map VARCHAR(16) NOT NULL DEFAULT 'SR',
      team_size INT NOT NULL DEFAULT 5,
      pick_type VARCHAR(32) DEFAULT NULL,
      bracket_type VARCHAR(20) NOT NULL DEFAULT 'single_elim',
      series_to INT NOT NULL DEFAULT 1,
      final_series_to INT NOT NULL DEFAULT 1,
      swiss_rounds INT DEFAULT NULL,
      max_participants INT NOT NULL DEFAULT 16,
      prize VARCHAR(500) DEFAULT '',
      region VARCHAR(10) DEFAULT 'la1',
      logo_url VARCHAR(1000),
      banner_url VARCHAR(1000),
      start_hour INT NOT NULL DEFAULT 20,
      start_minute INT NOT NULL DEFAULT 0,
      tz_offset_minutes INT NOT NULL DEFAULT -360,
      days JSON DEFAULT NULL,
      open_before_minutes INT NOT NULL DEFAULT 720,
      min_teams INT NOT NULL DEFAULT 2,
      duration_hours INT NOT NULL DEFAULT 3,
      auto_start TINYINT(1) NOT NULL DEFAULT 1,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      create_riot TINYINT(1) NOT NULL DEFAULT 0,
      created_by INT,
      last_spawned_date VARCHAR(10) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    // Series Bo3/Bo5: una fila de stats POR JUEGO (antes: una por enfrentamiento)
    `ALTER TABLE tournament_match_stats DROP INDEX unique_bracket_match`,
    `ALTER TABLE tournament_match_stats ADD UNIQUE KEY unique_bracket_game (tournament_id, bracket_match_id, game_id)`,
    // Sprint 0: gate de organizador + cuotas + logs de auditoría
    `ALTER TABLE users MODIFY provider ENUM('local','google','riot') NOT NULL DEFAULT 'local'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS organizer_status ENUM('none','approved','suspended') NOT NULL DEFAULT 'none'`,
    `ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS codes_generated INT NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS access_denied_log (
      id INT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NULL,
      endpoint VARCHAR(120) NOT NULL, reason VARCHAR(60) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_user (user_id), KEY idx_when (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE IF NOT EXISTS callback_log (
      id INT AUTO_INCREMENT PRIMARY KEY, received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      code VARCHAR(100) NULL, valid_key TINYINT(1) NOT NULL DEFAULT 0, payload LONGTEXT NULL,
      KEY idx_when (received_at), KEY idx_code (code)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  ]) {
    // Errores benignos (columna/índice ya existe) se ignoran; el resto SE LOGUEA.
    // El .catch(()=>{}) silencioso de antes fue lo que escondió el bug del enum.
    try { await pool.query(col); }
    catch (e: any) {
      const benign = ['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR', 'ER_CANT_DROP_FIELD_OR_KEY'];
      if (!benign.includes(e.code)) {
        console.error(`[initTables] DDL FALLÓ (${e.code}): ${col.slice(0, 80)}… → ${e.message}`);
      }
    }
  }
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
  .then(() => {
    startTournamentBackgroundSync();
    // Torneos diarios: import dinámico para no crear ciclo routes ↔ scheduler.
    import('../services/tournament-scheduler.service.js')
      .then(m => m.startDailyTournamentScheduler())
      .catch(err => console.error('[tournaments] scheduler no arrancó:', err.message));
  })
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
export async function getOrCreateProviderId(): Promise<number> {
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
    fearless:   !!row.fearless,
    bracketType: (row.bracket_type as any) || 'single_elim',
    seriesTo:      Number(row.series_to) || 1,
    finalSeriesTo: Number(row.final_series_to) || Number(row.series_to) || 1,
    swissRounds:   row.swiss_rounds ? Number(row.swiss_rounds) : undefined,
    registrationUrl: row.registration_url || undefined,
    rulesUrl:        row.rules_url || undefined,
    teamSize:  Math.min(5, Math.max(1, Number(row.team_size) || 5)),
    gameMap:   (['SR','ARAM','ARENA'].includes(row.game_map) ? row.game_map : 'SR') as TournamentData['gameMap'],
    pickType:  row.pick_type || undefined,
    endDate:   row.end_date || undefined,
    ladder:    parseJson(row.ladder) || undefined,
    scheduleId: row.schedule_id ? Number(row.schedule_id) : undefined,
    isPrivate: !!row.is_private,
  };
}

export async function getT(id: string): Promise<TournamentData | null> {
  const [[row]] = await pool.query<any[]>('SELECT * FROM tournaments WHERE id = ?', [id]);
  return row ? rowToTournament(row) : null;
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
      t.bracket   ? JSON.stringify(t.bracket)   : null,
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

export function sanitizeBracket(bracket: BracketMatch[] | undefined, access: ViewerAccess) {
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
               : t.phase==='active' ? 'progreso'
               : t.phase==='cancelled' ? 'cancelado' : 'finalizado';
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
    region:t.region||'la1', logoUrl:t.logoUrl, bannerUrl:t.bannerUrl, fearless:!!t.fearless,
    bracketType:t.bracketType||'single_elim',
    registrationUrl:t.registrationUrl, rulesUrl:t.rulesUrl,
    teamSize: t.teamSize || 5,
    gameMap: t.gameMap || 'SR',
    pickType: t.pickType,
    seriesTo: t.seriesTo || 1,
    finalSeriesTo: t.finalSeriesTo || t.seriesTo || 1,
    swissRounds: t.swissRounds,
    endDate: t.endDate,
    ladder: t.ladder,
    scheduleId: t.scheduleId,
    isPrivate: !!t.isPrivate,
    viewerAccess: access,
  };
}

// Torneos privados: el público no ve NADA (ni detalle ni bracket ni equipos).
// Owner y participantes (invitados incluidos, vía getViewerAccess) sí.
function privateBlocked(t: TournamentData, access: ViewerAccess): boolean {
  return !!t.isPrivate && access === 'public';
}
const PRIVATE_403 = { error: 'Torneo privado — necesitas una invitación del organizador', isPrivate: true };

export async function getRegs(tournamentId: string): Promise<TeamRegistration[]> {
  const [rows] = await pool.query<any[]>(
    'SELECT * FROM tournament_registrations WHERE tournament_id = ? ORDER BY registered_at ASC',
    [tournamentId]
  );
  return rows.map(r => ({
    id: Number(r.id),
    teamName: r.team_name, captainRiotId: r.captain_riot_id,
    players: parseJson(r.players) || [],
    contact: r.contact || '', registeredAt: r.registered_at,
    checkedIn: !!r.checked_in, checkedInAt: r.checked_in_at || undefined,
    registeredBy: r.registered_by || undefined,
    captainUserId: r.captain_user_id || undefined,
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

// ── Sprint 0: gate de capacidad Riot (base del futuro gate de pago) ───────────
// (a) crear registro de torneo → cualquier usuario auth (sin cambios)
// (b) crear torneo en RIOT / generar códigos reales → organizer approved o admin.
// 'approved' se convertirá en 'plan activo' en la fase de billing: un solo punto.
const RIOT_MAX_TOURNAMENTS_PER_MONTH = Number(process.env.RIOT_MAX_TOURNAMENTS_PER_MONTH || 5);
const RIOT_MAX_CODES_PER_TOURNAMENT = Number(process.env.RIOT_MAX_CODES_PER_TOURNAMENT || 300);

async function logDenied(userId: number | null, endpoint: string, reason: string) {
  try {
    await pool.query('INSERT INTO access_denied_log (user_id, endpoint, reason) VALUES (?,?,?)',
      [userId ?? null, endpoint, reason]);
  } catch (e: any) { console.warn('[access-log]', e.message); }
}

type CapResult = { ok: true } | { ok: false; status: number; error: string; reason: string };
async function riotCapability(req: any): Promise<CapResult> {
  const uid = req.auth?.userId ?? null;
  if (req.auth?.role === 'admin') return { ok: true };
  const [[u]] = await pool.query<any[]>('SELECT role, organizer_status FROM users WHERE id=?', [uid]);
  if (!u) return { ok: false, status: 403, error: 'Usuario no encontrado', reason: 'no_user' };
  if (u.role === 'admin' || u.organizer_status === 'approved') return { ok: true };
  if (u.organizer_status === 'suspended') {
    return { ok: false, status: 403, reason: 'suspended',
      error: 'Tu acceso de organizador está suspendido. Escríbenos a kister@revolution505.com.' };
  }
  return { ok: false, status: 403, reason: 'not_organizer',
    error: 'Crear torneos con códigos oficiales de Riot requiere acceso de organizador. Solicítalo en kister@revolution505.com — la creación de torneos sin códigos sigue disponible.' };
}

/** Cuota mensual: torneos Riot creados por este usuario en los últimos 30 días. */
async function monthlyRiotQuotaExceeded(userId: number): Promise<boolean> {
  const [[{ c }]] = await pool.query<any[]>(
    `SELECT COUNT(*) c FROM tournaments
     WHERE created_by=? AND riot_tournament_id IS NOT NULL
       AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`, [userId]);
  return Number(c) >= RIOT_MAX_TOURNAMENTS_PER_MONTH;
}

/** Cuota por torneo: códigos ya generados + los que se piden. */
async function codesQuotaExceeded(tournamentId: string, toAdd: number): Promise<boolean> {
  const [[row]] = await pool.query<any[]>('SELECT codes_generated FROM tournaments WHERE id=?', [tournamentId]);
  return (Number(row?.codes_generated) || 0) + toAdd > RIOT_MAX_CODES_PER_TOURNAMENT;
}

async function bumpCodesGenerated(tournamentId: string, n: number) {
  try { await pool.query('UPDATE tournaments SET codes_generated = codes_generated + ? WHERE id=?', [n, tournamentId]); }
  catch (e: any) { console.warn('[codes-quota]', e.message); }
}

// ─── Match stats DB helpers ───────────────────────────────────────────────────

export async function getStoredMatchStats(tournamentId: string, bracketMatchId: string) {
  const [[row]] = await pool.query<any[]>(
    // Series Bo3/Bo5: puede haber varias filas (una por juego) — la más reciente
    'SELECT parsed_data, game_end_ts FROM tournament_match_stats WHERE tournament_id=? AND bracket_match_id=? ORDER BY game_end_ts DESC LIMIT 1',
    [tournamentId, bracketMatchId]
  );
  if (!row) return null;
  const parsed = typeof row.parsed_data === 'string' ? JSON.parse(row.parsed_data) : row.parsed_data;
  return { ...parsed, isComplete: !!row.game_end_ts };
}

/** TODOS los juegos guardados de una serie (Bo3/Bo5), en orden de juego. */
export async function getStoredMatchGames(tournamentId: string, bracketMatchId: string) {
  const [rows] = await pool.query<any[]>(
    `SELECT parsed_data, game_end_ts FROM tournament_match_stats
     WHERE tournament_id=? AND bracket_match_id=? AND game_end_ts IS NOT NULL
     ORDER BY game_end_ts ASC`,
    [tournamentId, bracketMatchId]
  );
  return rows.map((row, i) => {
    const parsed = typeof row.parsed_data === 'string' ? JSON.parse(row.parsed_data) : row.parsed_data;
    return { ...parsed, isComplete: true, gameNumber: i + 1 };
  });
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
// Round robin (liga, como el LQC): todos contra todos por el método del círculo.
// Cada ronda = jornada; N equipos → N-1 jornadas (N par con BYE si es impar).
function generateRoundRobin(teams: string[]): BracketMatch[] {
  const list = [...teams];
  if (list.length % 2 === 1) list.push('BYE');
  const n = list.length;
  const rounds = n - 1;
  const matches: BracketMatch[] = [];
  const rot = [...list];
  for (let r = 1; r <= rounds; r++) {
    let mn = 1;
    for (let i = 0; i < n / 2; i++) {
      const t1 = rot[i], t2 = rot[n - 1 - i];
      if (t1 === 'BYE' || t2 === 'BYE') continue; // jornada de descanso
      matches.push({
        id: `r${r}m${mn}`, round: r, matchNumber: mn,
        team1: t1, team2: t2, winner: null, code: null, matchStatus: 'ready',
      });
      mn++;
    }
    // rotación: fijo rot[0], el resto gira
    rot.splice(1, 0, rot.pop()!);
  }
  return matches;
}

// Suizo: la ronda 1 es aleatoria; las siguientes se generan al terminar cada
// ronda (POST /:id/next-round) pareando por récord y evitando revanchas.
function generateSwissRound1(teams: string[]): BracketMatch[] {
  const list = [...teams];
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  const matches: BracketMatch[] = [];
  let mn = 1;
  for (let i = 0; i + 1 < list.length; i += 2) {
    matches.push({ id: `r1m${mn}`, round: 1, matchNumber: mn, team1: list[i], team2: list[i + 1], winner: null, code: null, matchStatus: 'ready' });
    mn++;
  }
  // Equipo impar: BYE = victoria gratis en la ronda
  if (list.length % 2 === 1) {
    matches.push({ id: `r1m${mn}`, round: 1, matchNumber: mn, team1: list[list.length - 1], team2: 'BYE', winner: list[list.length - 1], code: null, matchStatus: 'complete' });
  }
  return matches;
}

/** Parea la siguiente ronda suiza: por récord (wins desc), sin revanchas.
 *  Exportada: el sync en background la usa para el avance automático. */
export function pairSwissRound(t: TournamentData, round: number): BracketMatch[] {
  const played = new Set<string>();
  for (const m of t.bracket || []) {
    if (m.team1 && m.team2) played.add([m.team1, m.team2].sort().join('|'));
  }
  const wins = new Map<string, number>();
  for (const s of t.standings || []) wins.set(s.team, s.wins);
  const teams = [...(t.standings || [])].sort((a, b) => b.wins - a.wins || b.points - a.points).map(s => s.team);

  // Greedy con backtracking: el mejor disponible contra el mejor rival aún no enfrentado
  const result: Array<[string, string]> = [];
  const pool = [...teams];
  function backtrack(): boolean {
    if (pool.length < 2) return true;
    const a = pool.shift()!;
    for (let i = 0; i < pool.length; i++) {
      const b = pool[i];
      if (played.has([a, b].sort().join('|'))) continue;
      pool.splice(i, 1);
      result.push([a, b]);
      if (backtrack()) return true;
      result.pop();
      pool.splice(i, 0, b);
    }
    pool.unshift(a);
    return false;
  }
  if (!backtrack()) {
    // Sin pareo perfecto posible: permitir revanchas como último recurso
    result.length = 0;
    const p2 = [...teams];
    while (p2.length >= 2) result.push([p2.shift()!, p2.shift()!]);
  }

  // La última ronda planeada es "la final" del suizo → usa finalSeriesTo
  // (p.ej. todo Bo3 y la ronda de cierre Bo5).
  const isFinalRound = t.swissRounds != null && round >= t.swissRounds;
  const roundSeriesTo = isFinalRound ? (t.finalSeriesTo || t.seriesTo || 1) : (t.seriesTo || 1);

  const matches: BracketMatch[] = result.map(([t1, t2], i) => ({
    id: `r${round}m${i + 1}`, round, matchNumber: i + 1,
    team1: t1, team2: t2, winner: null, code: null, matchStatus: 'ready',
    seriesTo: roundSeriesTo,
  }));
  // BYE para el sobrante (impar)
  if (pool.length === 1 || teams.length % 2 === 1) {
    const rest = teams.filter(x => !result.some(([a, b]) => a === x || b === x));
    if (rest.length === 1) {
      matches.push({ id: `r${round}m${matches.length + 1}`, round, matchNumber: matches.length + 1, team1: rest[0], team2: 'BYE', winner: rest[0], code: null, matchStatus: 'complete', seriesTo: roundSeriesTo });
    }
  }
  return matches;
}

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

// Tamaño de roster permitido según el formato: teamSize titulares + hasta 2
// suplentes (0 en 1v1). El hint viaja como mensaje de error al frontend.
export function rosterSizeBounds(t: TournamentData): { min: number; max: number; hint: string } {
  const size = Math.min(5, Math.max(1, Number(t.teamSize) || 5));
  const max = size === 1 ? 1 : Math.min(7, size + 2);
  const hint = size === 1
    ? 'Formato 1v1: el roster es exactamente 1 jugador'
    : `Roster de ${size} a ${max} jugadores (${size} titulares + suplentes)`;
  return { min: size, max, hint };
}

// Opciones de lobby para los códigos de Riot según el formato del torneo.
// TOURNAMENT_DRAFT exige 5v5; formatos chicos caen a BLIND_PICK y ARAM a
// ALL_RANDOM. ARENA nunca llega aquí (no tiene lobbies custom → ladder).
export function riotCodeOptions(t: TournamentData): { teamSize: number; mapType: string; pickType: string } {
  const teamSize = Math.min(5, Math.max(1, Number(t.teamSize) || 5));
  const mapType = t.gameMap === 'ARAM' ? 'HOWLING_ABYSS' : 'SUMMONERS_RIFT';
  const pickType = t.pickType
    || (t.gameMap === 'ARAM' ? 'ALL_RANDOM' : teamSize < 5 ? 'BLIND_PICK' : 'TOURNAMENT_DRAFT');
  return { teamSize, mapType, pickType };
}

// Generate (or fall back to a pooled) tournament code for a specific bracket
// match, restricting it to both teams' registered players (allowlist) and
// embedding {tId, mId} in the code metadata so the Riot callback can resolve
// the result automatically. Mutates t.bracket[mi]; caller is responsible for saveT.
export async function assignCodeToMatch(t: TournamentData, mi: number): Promise<string | null> {
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
    // Cuota por torneo (Sprint 0): si se excede, cae al pool pre-generado.
    // La capacidad ya está gateada aguas arriba: sin gate no hay riotTournamentId.
    if (await codesQuotaExceeded(t.id, 1)) {
      console.warn(`[assignCode] cuota de códigos excedida en ${t.id} — usando pool`);
    } else {
      try {
        const metadata = JSON.stringify({ tId: t.id, mId: match.id });
        const codes = await generateCodes(t.riotTournamentId, 1, {
          ...riotCodeOptions(t),
          metadata,
          allowedParticipants: [...team1Puuids, ...team2Puuids],
        });
        code = codes[0] || null;
        if (code) await bumpCodesGenerated(t.id, 1);
      } catch (e: any) {
        console.error(`[assignCode] Riot code gen falló para ${match.id}:`, e.message);
      }
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

  // Advance winner to next round — solo en eliminación directa; en round robin
  // no hay avance (todos juegan contra todos, standings deciden).
  if ((t.bracketType || 'single_elim') === 'single_elim') {
    const nextId = `r${match.round + 1}m${Math.ceil(match.matchNumber / 2)}`;
    const ni = t.bracket!.findIndex(m => m.id === nextId);
    if (ni !== -1) {
      if (match.matchNumber % 2 === 1) t.bracket![ni].team1 = winner;
      else                            t.bracket![ni].team2 = winner;
      if (t.bracket![ni].team1 && t.bracket![ni].team2) {
        await assignCodeToMatch(t, ni);
      }
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

  // Completion: single-elim termina con la final; round robin cuando TODOS
  // los partidos están completos.
  const bt = t.bracketType || 'single_elim';
  if (bt === 'round_robin') {
    if (t.bracket!.every(m => m.matchStatus === 'complete')) t.phase = 'complete';
  } else if (bt === 'swiss') {
    // Suizo no se auto-completa: el organizador decide cuántas rondas
    // (POST /:id/next-round) y cierra con POST /:id/complete.
  } else {
    const maxRound = Math.max(...t.bracket!.map(m => m.round));
    if (t.bracket!.find(m => m.round === maxRound)?.matchStatus === 'complete') t.phase = 'complete';
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET all — list never includes bracket/codes; detail uses GET /:id
router.get('/', optionalAuth, async (req: any, res) => {
  try {
    const [rows] = await pool.query<any[]>(
      'SELECT * FROM tournaments WHERE COALESCE(hidden,0)=0 ORDER BY created_at DESC'
    );
    const out = await Promise.all(rows.map(async (r) => {
      const t = rowToTournament(r);
      const access = await getViewerAccess(t, req.auth);
      // Privados: solo los ven el organizador y los invitados/participantes.
      if (privateBlocked(t, access)) return null;
      const s = serialize(t, access);
      const { bracket: _b, ...listItem } = s;
      return listItem;
    }));
    res.json(out.filter(Boolean));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Torneos diarios (plantillas programadas) ────────────────────────────────
// El scheduler (tournament-scheduler.service) crea una instancia por día a la
// hora configurada, abre inscripciones y auto-inicia con el mínimo de equipos.

function serializeSchedule(r: any) {
  return {
    id: r.id, name: r.name, description: r.description || '',
    gameMap: r.game_map, teamSize: Number(r.team_size) || 5,
    pickType: r.pick_type || null, bracketType: r.bracket_type,
    seriesTo: Number(r.series_to) || 1, finalSeriesTo: Number(r.final_series_to) || 1,
    swissRounds: r.swiss_rounds ? Number(r.swiss_rounds) : null,
    maxParticipants: Number(r.max_participants) || 16,
    prize: r.prize || '', region: r.region || 'la1',
    logoUrl: r.logo_url || null, bannerUrl: r.banner_url || null,
    startHour: Number(r.start_hour), startMinute: Number(r.start_minute),
    tzOffsetMinutes: Number(r.tz_offset_minutes),
    days: (typeof r.days === 'string' ? JSON.parse(r.days || 'null') : r.days) || null,
    openBeforeMinutes: Number(r.open_before_minutes),
    minTeams: Number(r.min_teams), durationHours: Number(r.duration_hours),
    autoStart: !!r.auto_start, enabled: !!r.enabled, createRiot: !!r.create_riot,
    createdBy: r.created_by, lastSpawnedDate: r.last_spawned_date || null,
  };
}

// Próxima ocurrencia (ms UTC) de una plantilla a partir de ahora.
function nextOccurrence(r: any, nowMs: number): number | null {
  const days: number[] | null = (typeof r.days === 'string' ? JSON.parse(r.days || 'null') : r.days) || null;
  for (let d = 0; d < 8; d++) {
    const probe = nowMs + d * 86_400_000;
    const { weekday, startUtcMs } = todayStartFor(
      { start_hour: r.start_hour, start_minute: r.start_minute, tz_offset_minutes: r.tz_offset_minutes },
      probe
    );
    if (days && !days.includes(weekday)) continue;
    if (startUtcMs > nowMs) return startUtcMs;
  }
  return null;
}

// Público: los torneos diarios que vienen (para la sección "Diarios" del frontend).
router.get('/daily/upcoming', async (_req, res) => {
  try {
    const [schedules] = await pool.query<any[]>('SELECT * FROM tournament_schedules WHERE enabled=1');
    const now = Date.now();
    const out = await Promise.all(schedules.map(async (r) => {
      const s = serializeSchedule(r);
      const next = nextOccurrence(r, now);
      // Instancia de hoy (si ya se creó): para linkear directo a inscribirse.
      const [[inst]] = await pool.query<any[]>(
        `SELECT id, phase, participants, max_participants, start_date FROM tournaments
          WHERE schedule_id=? AND phase IN ('registration','checkin','active')
          ORDER BY created_at DESC LIMIT 1`,
        [r.id]
      );
      return {
        ...s,
        nextStartAt: next ? new Date(next).toISOString() : null,
        today: inst ? {
          tournamentId: inst.id, phase: inst.phase,
          participants: Number(inst.participants), maxParticipants: Number(inst.max_participants),
          startDate: inst.start_date,
        } : null,
      };
    }));
    out.sort((a, b) => (a.nextStartAt || 'z').localeCompare(b.nextStartAt || 'z'));
    res.json(out);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Organizador/admin: listado completo de plantillas propias (admin ve todas).
router.get('/schedules', requireAuth, async (req: any, res) => {
  try {
    const [rows] = isAdmin(req)
      ? await pool.query<any[]>('SELECT * FROM tournament_schedules ORDER BY start_hour, start_minute')
      : await pool.query<any[]>('SELECT * FROM tournament_schedules WHERE created_by=? ORDER BY start_hour, start_minute', [req.auth.userId]);
    res.json(rows.map(serializeSchedule));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

function validateScheduleBody(body: any, partial: boolean): { ok: true; fields: Record<string, any> } | { ok: false; error: string } {
  const f: Record<string, any> = {};
  const has = (k: string) => body[k] !== undefined;
  if (!partial || has('name')) {
    const name = String(body.name || '').trim();
    if (!name || name.length > 120) return { ok: false, error: 'name requerido (máx 120)' };
    f.name = name;
  }
  if (has('description')) f.description = String(body.description || '').slice(0, 2000);
  if (!partial || has('gameMap')) {
    if (!['SR', 'ARAM', 'ARENA'].includes(body.gameMap ?? 'SR')) return { ok: false, error: 'gameMap: SR | ARAM | ARENA' };
    f.game_map = body.gameMap ?? 'SR';
  }
  if (!partial || has('teamSize')) {
    const ts = Number(body.teamSize ?? 5);
    if (!Number.isInteger(ts) || ts < 1 || ts > 5) return { ok: false, error: 'teamSize: 1-5' };
    f.team_size = (f.game_map ?? body.gameMap) === 'ARENA' ? 2 : ts;
  }
  if (has('pickType')) {
    if (body.pickType && !['BLIND_PICK', 'DRAFT_MODE', 'ALL_RANDOM', 'TOURNAMENT_DRAFT'].includes(body.pickType))
      return { ok: false, error: 'pickType inválido' };
    f.pick_type = body.pickType || null;
  }
  if (has('bracketType')) {
    if (!['single_elim', 'round_robin', 'swiss'].includes(body.bracketType)) return { ok: false, error: 'bracketType inválido' };
    f.bracket_type = body.bracketType;
  }
  if (has('seriesTo')) {
    if (![1, 2, 3].includes(Number(body.seriesTo))) return { ok: false, error: 'seriesTo: 1|2|3' };
    f.series_to = Number(body.seriesTo);
  }
  if (has('finalSeriesTo')) {
    if (![1, 2, 3].includes(Number(body.finalSeriesTo))) return { ok: false, error: 'finalSeriesTo: 1|2|3' };
    f.final_series_to = Number(body.finalSeriesTo);
  }
  if (has('swissRounds')) {
    const sr = body.swissRounds === null ? null : Number(body.swissRounds);
    if (sr !== null && (!Number.isInteger(sr) || sr < 1 || sr > 12)) return { ok: false, error: 'swissRounds: 1-12 o null' };
    f.swiss_rounds = sr;
  }
  if (has('maxParticipants')) {
    const mp = Number(body.maxParticipants);
    if (!Number.isInteger(mp) || mp < 2 || mp > 256) return { ok: false, error: 'maxParticipants: 2-256' };
    f.max_participants = mp;
  }
  if (has('prize')) f.prize = String(body.prize || '').slice(0, 500);
  if (has('region')) f.region = String(body.region || 'la1').slice(0, 10);
  if (has('logoUrl')) f.logo_url = body.logoUrl || null;
  if (has('bannerUrl')) f.banner_url = body.bannerUrl || null;
  if (!partial || has('startHour')) {
    const h = Number(body.startHour ?? 20);
    if (!Number.isInteger(h) || h < 0 || h > 23) return { ok: false, error: 'startHour: 0-23' };
    f.start_hour = h;
  }
  if (has('startMinute')) {
    const m = Number(body.startMinute);
    if (!Number.isInteger(m) || m < 0 || m > 59) return { ok: false, error: 'startMinute: 0-59' };
    f.start_minute = m;
  }
  if (has('tzOffsetMinutes')) {
    const tz = Number(body.tzOffsetMinutes);
    if (!Number.isInteger(tz) || tz < -720 || tz > 840) return { ok: false, error: 'tzOffsetMinutes inválido' };
    f.tz_offset_minutes = tz;
  }
  if (has('days')) {
    if (body.days !== null) {
      if (!Array.isArray(body.days) || body.days.some((d: any) => !Number.isInteger(d) || d < 0 || d > 6))
        return { ok: false, error: 'days: array de 0(dom)-6(sáb) o null (diario)' };
    }
    f.days = body.days === null ? null : JSON.stringify(body.days);
  }
  if (has('openBeforeMinutes')) {
    const ob = Number(body.openBeforeMinutes);
    if (!Number.isInteger(ob) || ob < 15 || ob > 4320) return { ok: false, error: 'openBeforeMinutes: 15-4320' };
    f.open_before_minutes = ob;
  }
  if (has('minTeams')) {
    const mt = Number(body.minTeams);
    if (!Number.isInteger(mt) || mt < 2 || mt > 64) return { ok: false, error: 'minTeams: 2-64' };
    f.min_teams = mt;
  }
  if (has('durationHours')) {
    const dh = Number(body.durationHours);
    if (!Number.isInteger(dh) || dh < 1 || dh > 72) return { ok: false, error: 'durationHours: 1-72' };
    f.duration_hours = dh;
  }
  if (has('autoStart')) f.auto_start = body.autoStart ? 1 : 0;
  if (has('enabled')) f.enabled = body.enabled ? 1 : 0;
  if (has('createRiot')) f.create_riot = body.createRiot ? 1 : 0;
  return { ok: true, fields: f };
}

// Crear plantilla — mismo gate que crear torneos Riot (organizador aprobado/admin):
// una plantilla genera torneos sola todos los días, no es para cualquier cuenta.
router.post('/schedules', requireAuth, async (req: any, res) => {
  try {
    const cap = await riotCapability(req);
    if (!cap.ok) {
      await logDenied(req.auth?.userId, 'POST /schedules', cap.reason);
      return res.status(cap.status).json({ error: cap.error });
    }
    const v = validateScheduleBody(req.body, false);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const f = { team_size: 5, game_map: 'SR', ...v.fields, created_by: req.auth.userId };
    const cols = Object.keys(f);
    const [result] = await pool.query<any>(
      `INSERT INTO tournament_schedules (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
      cols.map(c => (f as any)[c])
    );
    const [[row]] = await pool.query<any[]>('SELECT * FROM tournament_schedules WHERE id=?', [result.insertId]);
    res.json({ success: true, schedule: serializeSchedule(row) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

async function loadOwnSchedule(req: any, res: any): Promise<any | null> {
  const [[row]] = await pool.query<any[]>('SELECT * FROM tournament_schedules WHERE id=?', [req.params.sid]);
  if (!row) { res.status(404).json({ error: 'Plantilla no encontrada' }); return null; }
  if (!isAdmin(req) && row.created_by !== req.auth.userId) {
    res.status(403).json({ error: 'Solo el creador de la plantilla o un admin' });
    return null;
  }
  return row;
}

router.patch('/schedules/:sid', requireAuth, async (req: any, res) => {
  try {
    const row = await loadOwnSchedule(req, res);
    if (!row) return;
    const v = validateScheduleBody(req.body, true);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const cols = Object.keys(v.fields);
    if (cols.length) {
      await pool.query(
        `UPDATE tournament_schedules SET ${cols.map(c => `${c}=?`).join(', ')} WHERE id=?`,
        [...cols.map(c => (v.fields as any)[c]), row.id]
      );
    }
    const [[updated]] = await pool.query<any[]>('SELECT * FROM tournament_schedules WHERE id=?', [row.id]);
    res.json({ success: true, schedule: serializeSchedule(updated) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/schedules/:sid', requireAuth, async (req: any, res) => {
  try {
    const row = await loadOwnSchedule(req, res);
    if (!row) return;
    await pool.query('DELETE FROM tournament_schedules WHERE id=?', [row.id]);
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST / — create
router.post('/', requireAuth, async (req: any, res) => {
  const { name, prize, startDate, format, description, maxParticipants, checkinDeadline, createRiot } = req.body;
  if (!name || !startDate) return res.status(400).json({ error:'name y startDate requeridos' });

  // Formato custom: tamaño de equipo (1-5), mapa y tipo de bracket.
  const gameMap: TournamentData['gameMap'] =
    ['SR', 'ARAM', 'ARENA'].includes(req.body.gameMap) ? req.body.gameMap : 'SR';
  // Arena siempre se juega en duplas; sin lobbies custom → sin códigos Riot.
  const teamSize = gameMap === 'ARENA' ? 2
    : Math.min(5, Math.max(1, Number(req.body.teamSize) || 5));
  const pickType = typeof req.body.pickType === 'string'
    && ['BLIND_PICK', 'DRAFT_MODE', 'ALL_RANDOM', 'TOURNAMENT_DRAFT'].includes(req.body.pickType)
    ? req.body.pickType : undefined;
  const bracketType = ['single_elim', 'round_robin', 'swiss'].includes(req.body.bracketType)
    ? req.body.bracketType : undefined;
  const seriesTo = [1, 2, 3].includes(Number(req.body.seriesTo)) ? Number(req.body.seriesTo) : 1;
  const finalSeriesTo = [1, 2, 3].includes(Number(req.body.finalSeriesTo)) ? Number(req.body.finalSeriesTo) : seriesTo;
  const swissRounds = Number.isInteger(Number(req.body.swissRounds))
    && Number(req.body.swissRounds) >= 1 && Number(req.body.swissRounds) <= 12
    ? Number(req.body.swissRounds) : null;
  // Ladder Arena: ventana de juego en horas desde el inicio (default 3h).
  const durationHours = Math.min(72, Math.max(1, Number(req.body.durationHours) || 3));
  const endDate = gameMap === 'ARENA'
    ? new Date(new Date(startDate).getTime() + durationHours * 3600_000).toISOString()
    : undefined;
  // Privado: fuera de listas públicas; solo se inscribe quien tenga invitación.
  const isPrivate = !!req.body.isPrivate;

  // Códigos oficiales de Riot SIEMPRE que el mapa lo permita (Arena no tiene
  // lobbies custom). Sin checkbox: si el usuario no es organizador aprobado o
  // agotó cuota, el torneo se crea igual pero sin torneo Riot (los partidos
  // se detectan por roster) — no bloqueamos la creación.
  const wantsRiot = gameMap !== 'ARENA' && createRiot !== false;

  let riotTournamentId: number|undefined;
  let initialCodes: string[] = [];
  let riotSkippedReason: string | undefined;

  if (wantsRiot) {
    const cap = await riotCapability(req);
    if (!cap.ok) {
      await logDenied(req.auth?.userId, 'POST /tournaments createRiot', cap.reason);
      riotSkippedReason = 'Solo organizadores aprobados generan códigos oficiales de Riot.';
    } else if (await monthlyRiotQuotaExceeded(req.auth.userId)) {
      await logDenied(req.auth?.userId, 'POST /tournaments createRiot', 'monthly_quota');
      riotSkippedReason = `Límite de ${RIOT_MAX_TOURNAMENTS_PER_MONTH} torneos Riot por mes alcanzado.`;
    } else {
      try {
        const providerId = await getOrCreateProviderId();
        const rt = await createTournament(providerId, name);
        riotTournamentId = rt.id;
        initialCodes = await generateCodes(
          riotTournamentId, Math.min((maxParticipants||16)*2, 100),
          riotCodeOptions({ teamSize, gameMap, pickType } as TournamentData)
        );
      } catch (err: any) { return res.status(500).json({ error:'Error Riot: '+err.message }); }
    }
  }

  const slug = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
  const id = `${slug}-${Date.now()}`;
  const defaultFormat = gameMap === 'ARENA' ? 'Arena Ladder 2v2'
    : gameMap === 'ARAM' ? `ARAM ${teamSize}v${teamSize}`
    : `${teamSize}v${teamSize} ${bracketType === 'swiss' ? 'Suizo' : bracketType === 'round_robin' ? 'Liga' : 'Single Elimination'}`;
  const newT: TournamentData = {
    id, name, phase:'registration', participants:0,
    maxParticipants:maxParticipants||16,
    prize:prize||'Por definir', startDate,
    format:format||defaultFormat, description:description||'',
    riotTournamentId, codePool:initialCodes,
    checkinDeadline:checkinDeadline||undefined,
    createdBy:req.auth.userId,
    teamSize, gameMap, pickType, endDate,
    bracketType: bracketType || (gameMap === 'ARENA' ? 'round_robin' : 'single_elim'),
    seriesTo, finalSeriesTo, swissRounds: swissRounds ?? undefined,
    isPrivate,
  };

  try {
    await pool.query(
      `INSERT INTO tournaments (id,name,phase,participants,max_participants,prize,start_date,format,description,riot_tournament_id,code_pool,created_by,
        team_size,game_map,pick_type,end_date,bracket_type,series_to,final_series_to,swiss_rounds,is_private)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,name,'registration',0,newT.maxParticipants,newT.prize,startDate,newT.format,
       newT.description,riotTournamentId??null,JSON.stringify(initialCodes),req.auth.userId,
       teamSize, gameMap, pickType ?? null, endDate ?? null,
       newT.bracketType, seriesTo, finalSeriesTo, swissRounds, isPrivate ? 1 : 0]
    );
    if (initialCodes.length) await bumpCodesGenerated(id, initialCodes.length);
    res.json({ success:true, tournament:serialize(newT, 'owner'), riotSkippedReason });
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
  const validKey = !secret || (req.query as any).key === secret;

  // Sprint 0: persistir TODO callback (válidos e inválidos — los inválidos son
  // intentos de abuso que queremos ver). Solo escritura; el polling sigue siendo
  // la fuente de verdad para resultados.
  try {
    await pool.query(
      'INSERT INTO callback_log (code, valid_key, payload) VALUES (?,?,?)',
      [String(req.body?.shortCode ?? '').slice(0, 100) || null, validKey ? 1 : 0,
       JSON.stringify(req.body ?? {}).slice(0, 60000)]
    );
  } catch (e: any) { console.warn('[callback-log]', e.message); }

  if (secret) {
    if (!validKey) {
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

    // Invitación de ACCESO a torneo privado (slot -1, sin equipo): aceptar
    // solo registra el acceso — el invitado luego inscribe su propio equipo.
    if (Number(inv.slot_index) < 0) {
      await pool.query(
        "UPDATE tournament_invitations SET status='accepted', responded_at=? WHERE id=?",
        [new Date().toISOString(), inv.id]
      );
      return res.json({ success: true, status: 'accepted', tournamentId: inv.tournament_id, accessOnly: true });
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
    if (!reg) {
      // El equipo ya no existe (lo borraron o el registro nunca se completó):
      // anular la invitación para que no siga apareciendo como pendiente.
      await pool.query(
        "UPDATE tournament_invitations SET status='declined', responded_at=? WHERE id=?",
        [new Date().toISOString(), inv.id]
      );
      return res.status(410).json({
        error: `El equipo "${inv.team_name}" ya no existe en el torneo. Pide al capitán que te vuelva a invitar.`,
      });
    }

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
    if (privateBlocked(t, access)) return res.status(403).json(PRIVATE_403);
    res.json(serialize(t, access));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Invitaciones de torneo privado (organizador → correo) ────────────────────
// Crea una invitación de ACCESO (slot -1, sin equipo): el invitado la recibe
// por correo + en su dashboard, y con ella puede ver e inscribirse al torneo.
router.post('/:id/invite', requireAuth, async (req: any, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Correo inválido' });
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el organizador puede invitar' });

    const invitedUserId = await findUserByEmail(email);
    if (!invitedUserId) {
      return res.status(400).json({
        error: `No hay cuenta ATAK.GG con el correo ${email}. Pídele que se registre primero en la plataforma.`,
      });
    }
    if (invitedUserId === req.auth.userId) {
      return res.status(400).json({ error: 'Ese es tu propio correo' });
    }

    const [[inviter]] = await pool.query<any[]>('SELECT name, email FROM users WHERE id=? LIMIT 1', [req.auth.userId]);
    await createInvitation(
      t.id, '', invitedUserId, req.auth.userId, -1,
      String(req.body?.name || '').trim() || undefined,
      { tournamentName: t.name, inviterName: inviter?.name || inviter?.email?.split('@')[0] || 'Organizador' }
    );
    res.json({ success: true, message: `Invitación enviada a ${email}` });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Listado de invitados del torneo (organizador) — para gestionar accesos.
router.get('/:id/invites', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el organizador' });
    const [rows] = await pool.query<any[]>(
      `SELECT i.id, i.status, i.player_name, i.created_at, u.email, u.name
         FROM tournament_invitations i LEFT JOIN users u ON u.id = i.invited_user_id
        WHERE i.tournament_id = ? AND i.slot_index = -1
        ORDER BY i.created_at DESC`,
      [t.id]
    );
    res.json(rows.map(r => ({
      id: r.id, status: r.status, email: r.email, name: r.player_name || r.name || null,
      createdAt: r.created_at,
    })));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Register team — auto-fills captain from linked LoL account; validates Riot IDs; sends invitations
router.post('/:id/register', requireAuth, async (req: any, res) => {
  const { teamName, captainRiotId, players, contact } = req.body;
  if (!teamName || !Array.isArray(players)) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    // Roster según el formato: mínimo teamSize titulares; hasta 2 suplentes
    // (en 1v1 no hay suplentes: el equipo ES el jugador).
    const rosterBounds = rosterSizeBounds(t);
    if (players.length < rosterBounds.min || players.length > rosterBounds.max) {
      return res.status(400).json({ error: rosterBounds.hint });
    }
    if (t.phase !== 'registration') return res.status(400).json({ error: 'Inscripciones cerradas' });
    // Torneo privado: solo el organizador o alguien con invitación puede
    // inscribir equipo (la invitación llega por correo desde /invite).
    if (t.isPrivate && !isOwner(req, t)) {
      const [[inv]] = await pool.query<any[]>(
        "SELECT id FROM tournament_invitations WHERE tournament_id=? AND invited_user_id=? AND status IN ('pending','accepted') LIMIT 1",
        [t.id, req.auth.userId]
      );
      if (!inv) return res.status(403).json(PRIVATE_403);
    }
    // Registro externo obligatorio (p.ej. formulario de la liga): solo el
    // organizador puede registrar directo (para correcciones manuales).
    if (t.registrationUrl && !isOwner(req, t)) {
      return res.status(403).json({
        error: 'Las inscripciones de este torneo se hacen en el sitio oficial de la liga',
        registrationUrl: t.registrationUrl,
      });
    }
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
    // Invitaciones DIFERIDAS: solo se crean cuando el equipo ya quedó insertado.
    // Antes se creaban dentro del loop y un fallo posterior (slot inválido,
    // nombre duplicado) dejaba invitaciones huérfanas de un equipo inexistente
    // → "Equipo no encontrado" al aceptarlas.
    const inviteOps: Array<() => Promise<void>> = [];
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
        inviteOps.push(() => createInvitation(t.id, teamName, invitedUserId, userId, i, name, {
          tournamentName: t.name,
          inviterName,
        }));
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
        inviteOps.push(async () => {
          await createInvitation(t.id, teamName, matchedUserId, userId, i, name).catch(() => {});
          await pool.query(
            "UPDATE tournament_invitations SET status='accepted', responded_at=? WHERE tournament_id=? AND team_name=? AND invited_user_id=?",
            [new Date().toISOString(), t.id, teamName, matchedUserId]
          );
        });
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
    // El equipo ya existe en la BD: ahora sí, crear invitaciones y mandar correos.
    for (const op of inviteOps) await op().catch(e => console.error('[register invite]', e.message));

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
router.get('/:id/registrations', optionalAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (privateBlocked(t, await getViewerAccess(t, req.auth))) return res.status(403).json(PRIVATE_403);
    res.json(await getRegs(req.params.id));
  }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE registration — el organizador elimina un equipo antes de que inicie el torneo
router.delete('/:id/registrations/:regId', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el organizador puede eliminar equipos' });
    if (t.phase !== 'registration' && t.phase !== 'checkin')
      return res.status(400).json({ error: 'El torneo ya inició; no se pueden eliminar equipos' });

    const [[reg]] = await pool.query<any[]>(
      'SELECT id, team_name FROM tournament_registrations WHERE tournament_id=? AND id=?',
      [t.id, req.params.regId]
    );
    if (!reg) return res.status(404).json({ error: 'Equipo no encontrado' });

    await pool.query('DELETE FROM tournament_registrations WHERE id=?', [reg.id]);
    await pool.query(
      'DELETE FROM tournament_invitations WHERE tournament_id=? AND team_name=?',
      [t.id, reg.team_name]
    );
    await pool.query('UPDATE tournaments SET participants=GREATEST(participants-1,0) WHERE id=?', [t.id]);

    res.json({ success: true, teamName: reg.team_name });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// PATCH registration — el capitán (o el organizador) edita el roster mientras
// las inscripciones siguen abiertas. Recibe el array completo de players con la
// misma forma que /register: { name, riotId } o { name, inviteEmail }.
router.patch('/:id/registrations/:regId', requireAuth, async (req: any, res) => {
  const { players } = req.body;
  if (!Array.isArray(players)) {
    return res.status(400).json({ error: 'Datos incompletos' });
  }
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    const rosterBounds = rosterSizeBounds(t);
    if (players.length < rosterBounds.min || players.length > rosterBounds.max) {
      return res.status(400).json({ error: rosterBounds.hint });
    }
    if (t.phase !== 'registration')
      return res.status(400).json({ error: 'Solo se puede editar el equipo mientras las inscripciones están abiertas' });

    const [[reg]] = await pool.query<any[]>(
      'SELECT * FROM tournament_registrations WHERE tournament_id=? AND id=?',
      [t.id, req.params.regId]
    );
    if (!reg) return res.status(404).json({ error: 'Equipo no encontrado' });

    const userId = req.auth.userId;
    const captainUserId = Number(reg.captain_user_id || reg.registered_by) || null;
    const isCaptain = captainUserId === userId || Number(reg.registered_by) === userId;
    if (!isCaptain && !isOwner(req, t))
      return res.status(403).json({ error: 'Solo el capitán o el organizador pueden editar el equipo' });

    const platform = t.region || 'la1';
    const linked = captainUserId ? await getLinkedRiotAccount(captainUserId) : null;
    const oldPlayers: RosterPlayer[] = parseJson(reg.players) || [];
    const oldByEmail = new Map(
      oldPlayers.filter(p => p.inviteEmail)
        .map(p => [p.inviteEmail!.toLowerCase(), p] as const)
    );

    const [[editorUser]] = await pool.query<any[]>(
      'SELECT name, email FROM users WHERE id = ? LIMIT 1', [userId]
    );
    const inviterName = editorUser?.name || editorUser?.email?.split('@')[0] || 'Capitán';

    const normalizedPlayers: RosterPlayer[] = [];
    const invitationsSent: string[] = [];
    const keepInvitedUserIds: number[] = [];
    // Invitaciones diferidas: solo se crean/reindexan cuando todo el roster validó
    const inviteOps: Array<() => Promise<void>> = [];

    for (let i = 0; i < players.length; i++) {
      const raw = players[i] || {};
      const name = String(raw.name || '').trim() || `Jugador ${i + 1}`;
      const riotId = String(raw.riotId || '').trim();
      const inviteEmail = String(raw.inviteEmail || '').trim();
      const slot = i;

      if (inviteEmail) {
        const invitedUserId = await findUserByEmail(inviteEmail);
        if (!invitedUserId) {
          return res.status(400).json({
            error: `No hay cuenta ATAK.GG con el correo ${inviteEmail}. El jugador debe registrarse primero.`,
            slot,
          });
        }
        if (invitedUserId === captainUserId) {
          if (!linked) return res.status(400).json({ error: 'El capitán debe vincular su cuenta de LoL para ocupar este slot' });
          normalizedPlayers.push({ name, riotId: linked.riotId, puuid: linked.puuid, userId: invitedUserId, inviteStatus: 'accepted' });
          continue;
        }
        const prev = oldByEmail.get(inviteEmail.toLowerCase());
        if (prev && prev.inviteStatus === 'accepted') {
          // Ya aceptó: conservar sus datos (riotId/puuid/userId)
          normalizedPlayers.push({ ...prev, name });
          keepInvitedUserIds.push(invitedUserId);
          continue;
        }
        normalizedPlayers.push({ name, inviteEmail, inviteStatus: 'pending' });
        keepInvitedUserIds.push(invitedUserId);
        const isNew = !prev;
        inviteOps.push(async () => {
          // Idempotente: si ya existía la invitación solo reindexa slot; email solo si es nueva
          await createInvitation(
            t.id, reg.team_name, invitedUserId, userId, slot, name,
            isNew ? { tournamentName: t.name, inviterName } : undefined
          );
        });
        if (isNew) invitationsSent.push(inviteEmail);
        continue;
      }

      if (!riotId) {
        return res.status(400).json({ error: `Slot ${slot + 1}: ingresa Riot ID o invita por correo`, slot });
      }
      if (!/^.+#.{2,}$/.test(riotId)) {
        return res.status(400).json({ error: `Riot ID inválido en slot ${slot + 1}: ${riotId}` });
      }
      const resolved = await resolveRiotIdToPuuid(riotId, platform);
      if (!resolved) {
        return res.status(400).json({ error: `Cuenta no encontrada: ${riotId}`, slot });
      }
      const matchedUserId = await findUserByRiotId(riotId);
      normalizedPlayers.push({
        name,
        riotId: `${resolved.gameName}#${resolved.tagLine}`,
        puuid: resolved.puuid,
        userId: matchedUserId || undefined,
        inviteStatus: 'accepted',
      });
      if (matchedUserId) keepInvitedUserIds.push(matchedUserId);
    }

    for (const op of inviteOps) await op();

    // Cancelar invitaciones pendientes de jugadores que ya no están en el roster
    if (keepInvitedUserIds.length) {
      await pool.query(
        `DELETE FROM tournament_invitations
         WHERE tournament_id=? AND team_name=? AND status='pending' AND invited_user_id NOT IN (?)`,
        [t.id, reg.team_name, keepInvitedUserIds]
      );
    } else {
      await pool.query(
        `DELETE FROM tournament_invitations WHERE tournament_id=? AND team_name=? AND status='pending'`,
        [t.id, reg.team_name]
      );
    }

    await pool.query(
      'UPDATE tournament_registrations SET players=? WHERE id=?',
      [JSON.stringify(normalizedPlayers), reg.id]
    );

    res.json({
      success: true,
      players: normalizedPlayers,
      invitationsSent: invitationsSent.length,
      message: invitationsSent.length
        ? `Equipo actualizado. Invitaciones enviadas a ${invitationsSent.length} jugador(es).`
        : 'Equipo actualizado.',
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
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
    // Autorización por membresía real (no por captainRiotId del body, que el
    // cliente puede omitir): quien registró al equipo, un jugador del roster
    // (invitación aceptada) o el organizador/admin del torneo.
    const uid = req.auth?.userId;
    const rosterPlayers: RosterPlayer[] = typeof reg.players === 'string' ? JSON.parse(reg.players) : (reg.players ?? []);
    const isMember = reg.registered_by === uid || rosterPlayers.some(p => p.userId === uid);
    if (!isMember && !isOwner(req, t))
      return res.status(403).json({ error:'Solo un miembro del equipo puede hacer check-in' });
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

// Arranque real del torneo — compartido por POST /:id/start y el scheduler de
// torneos diarios. Muta y persiste t; devuelve error legible si no se puede.
export async function startTournamentInternal(t: TournamentData): Promise<{ ok: true } | { ok: false; error: string }> {
  if (t.phase === 'active' || t.phase === 'complete') return { ok: false, error: 'Torneo ya activo o completado' };
  const allRegs = await getRegs(t.id);
  const activeRegs = t.phase === 'checkin' ? allRegs.filter(r => r.checkedIn) : allRegs;
  if (activeRegs.length < 2) return { ok: false, error: 'Mínimo 2 equipos' };

  const teams = activeRegs.map(r => r.teamName);

  if (t.gameMap === 'ARENA') {
    // Ladder: no hay bracket ni códigos — se abre la ventana de juego y el
    // sync puntúa los placements de Arena hasta endDate.
    if (!t.endDate) t.endDate = new Date(Date.now() + 3 * 3600_000).toISOString();
    t.ladder = { processed: [], teams: Object.fromEntries(teams.map(tm => [tm, { games: [], points: 0 }])) };
    t.standings = teams.map((team, i) => ({ position: i + 1, team, wins: 0, losses: 0, points: 0 }));
    t.phase = 'active'; t.participants = teams.length;
    await saveT(t);
    return { ok: true };
  }

  const bracket = t.bracketType === 'round_robin' ? generateRoundRobin(teams)
                : t.bracketType === 'swiss'       ? generateSwissRound1(teams)
                : generateBracket(teams);
  // Series: estampar seriesTo en cada partido; en eliminación la final usa finalSeriesTo
  const maxR = Math.max(...bracket.map(m => m.round));
  for (const m of bracket) {
    m.seriesTo = (t.bracketType !== 'round_robin' && t.bracketType !== 'swiss' && m.round === maxR)
      ? (t.finalSeriesTo || t.seriesTo || 1)
      : (t.seriesTo || 1);
  }
  t.bracket = bracket;
  // Assign an allowlisted, metadata-tagged code to each ready round-1 match.
  for (let i = 0; i < bracket.length; i++) {
    if (bracket[i].round === 1 && bracket[i].matchStatus === 'ready') {
      await assignCodeToMatch(t, i);
    }
  }
  t.standings = teams.map((team, i) => ({ position: i + 1, team, wins: 0, losses: 0, points: 0 }));
  t.phase = 'active'; t.participants = teams.length;
  await saveT(t);
  return { ok: true };
}

// Start tournament
router.post('/:id/start', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error:'Solo el creador puede hacer esto' });
    const result = await startTournamentInternal(t);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ success:true, bracket:t.bracket, standings:t.standings });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET bracket
router.get('/:id/bracket', optionalAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error:'Torneo no encontrado' });
    const access = await getViewerAccess(t, req.auth);
    if (privateBlocked(t, access)) return res.status(403).json(PRIVATE_403);
    res.json({ bracket: sanitizeBracket(t.bracket || [], access), phase: t.phase, viewerAccess: access, bracketType: t.bracketType || 'single_elim' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Tournament dashboard — one aggregated payload for the detail view ─────────
let _ddV = { v: '14.24.1', at: 0 };
async function ddVersion(): Promise<string> {
  if (Date.now() - _ddV.at < 6 * 3600_000) return _ddV.v;
  try {
    const r = await fetch('https://ddragon.leagueoflegends.com/api/versions.json');
    const j: any = await r.json();
    if (Array.isArray(j) && j[0]) _ddV = { v: j[0], at: Date.now() };
  } catch { /* keep last */ }
  return _ddV.v;
}
const TD_PALETTE = ['#e8323c', '#e5e7eb', '#4ade80', '#3b82f6', '#a78bfa', '#22d3ee'];
function tdMono(n?: string | null): string {
  if (!n) return '?';
  const p = n.trim().split(/\s+/);
  return (p.length > 1 ? p[0][0] + p[1][0] : n.slice(0, 2)).toUpperCase();
}

router.get('/:id/dashboard', optionalAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    const access = await getViewerAccess(t, req.auth);
    if (privateBlocked(t, access)) return res.status(403).json(PRIVATE_403);
    const regs = await getRegs(t.id);
    const version = await ddVersion();

    const names = regs.map(r => r.teamName);
    const colorOf = (name?: string | null) => TD_PALETTE[(name ? Math.max(0, names.indexOf(name)) : 0) % TD_PALETTE.length];
    const teamMeta = (name?: string | null) => (name && name !== 'BYE')
      ? { id: name, name, mono: tdMono(name), color: colorOf(name) } : null;

    const bracketArr: BracketMatch[] = t.bracket || [];
    const maxRound = bracketArr.length ? Math.max(...bracketArr.map(m => m.round)) : 0;
    const rlabel = (r: number) => {
      const bt = t.bracketType || 'single_elim';
      if (bt === 'round_robin') return `Jornada ${r}`;
      if (bt === 'swiss') return `Ronda ${r}`;
      const d = maxRound - r;
      return d === 0 ? 'Final' : d === 1 ? 'Semifinales' : d === 2 ? 'Cuartos' : `Ronda ${r}`;
    };
    const rounds = [];
    for (let r = 1; r <= maxRound; r++) {
      const matches = bracketArr.filter(m => m.round === r)
        .sort((a, b) => a.matchNumber - b.matchNumber)
        .map(m => ({
          id: m.id, round: m.round, matchStatus: m.matchStatus,
          teamA: m.team1 ? { ...teamMeta(m.team1), score: m.score1 ?? null } : null,
          teamB: m.team2 ? { ...teamMeta(m.team2), score: m.score2 ?? null } : null,
          winnerId: m.winner || null, scheduledAt: null,
        }));
      rounds.push({ round: r, label: rlabel(r), matches });
    }

    const standings = (t.standings || []).map(s => {
      const games = (s.wins || 0) + (s.losses || 0);
      return {
        teamId: s.team, name: s.team, mono: tdMono(s.team), color: colorOf(s.team),
        wins: s.wins || 0, losses: s.losses || 0,
        winratePct: games ? Math.round((s.wins / games) * 100) : 0,
        streak: null, points: s.points || 0, position: s.position,
      };
    });

    const activeM = bracketArr.find(m => m.matchStatus === 'active');
    const liveMatch = activeM ? {
      matchId: activeM.id, game: 1, timer: null, code: (access === 'owner' || access === 'participant') ? activeM.code : null,
      teamA: { ...teamMeta(activeM.team1), score: activeM.score1 ?? 0, picks: [] },
      teamB: { ...teamMeta(activeM.team2), score: activeM.score2 ?? 0, picks: [] },
      goldDiffSeries: [],
    } : null;

    const schedule = bracketArr
      .filter(m => m.matchStatus !== 'complete' && m.team1 && m.team2 && m.team1 !== 'BYE' && m.team2 !== 'BYE')
      .slice(0, 6)
      .map(m => ({ matchId: m.id, scheduledAt: null, teamA: teamMeta(m.team1), teamB: teamMeta(m.team2), roundLabel: rlabel(m.round), reminded: false }));

    let myTeam: any = null;
    if (req.auth?.userId) {
      const reg = regs.find(r => (r as any).registeredBy === req.auth.userId);
      if (reg) myTeam = {
        tag: reg.teamName, checkinDeadline: t.checkinDeadline ?? null, checkedIn: !!reg.checkedIn,
        roster: (reg.players || []).slice(0, rosterSizeBounds(t).max).map((p: any) => ({ playerName: p.name || p.riotId, role: null, mainChampionId: null, rank: null })),
      };
    }

    let activityByDay: Array<{ day: string; games: number }> = [];
    try {
      const [rows] = await pool.query<any[]>('SELECT game_end_ts FROM tournament_match_stats WHERE tournament_id = ? AND game_end_ts IS NOT NULL', [t.id]);
      const byDay: Record<string, number> = {};
      for (const row of rows) { const d = new Date(Number(row.game_end_ts)).toISOString().slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
      activityByDay = Object.entries(byDay).map(([day, games]) => ({ day, games }));
    } catch { /* optional */ }

    const status = t.phase === 'active' ? 'live' : t.phase === 'complete' ? 'finished'
      : t.phase === 'registration' ? 'registration' : 'checkin';

    res.json({
      tournament: {
        id: t.id, name: t.name, season: null, startDate: t.startDate, endDate: null,
        format: t.format, patch: version, region: t.region, phase: t.phase, status,
        prizePool: t.prize, prizeFinal: null, teamsRegistered: regs.length, teamsMax: t.maxParticipants,
        checkinDeadline: t.checkinDeadline ?? null, logoUrl: t.logoUrl, bannerUrl: t.bannerUrl,
        fearless: !!t.fearless,
        bracketType: t.bracketType || 'single_elim',
        seriesTo: t.seriesTo || 1, finalSeriesTo: t.finalSeriesTo || t.seriesTo || 1,
        swissRounds: t.swissRounds ?? null,
        registrationUrl: t.registrationUrl ?? null, rulesUrl: t.rulesUrl ?? null,
        teamSize: t.teamSize || 5, gameMap: t.gameMap || 'SR',
        isPrivate: !!t.isPrivate,
      },
      bracket: rounds, standings, liveMatch, myTeam, schedule, activityByDay, version, viewerAccess: access,
    });
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

    // Serve from DB cache if complete (game already finished + saved).
    // Series Bo3/Bo5: `games` trae TODOS los juegos en orden; el top-level
    // sigue siendo el último para compatibilidad con clientes viejos.
    const allGames = await getStoredMatchGames(id, matchId);
    if (allGames.length) {
      const seriesDone = match.matchStatus === 'complete';
      const expected = match.matchStatus === 'complete' || (match.games?.length || 0) <= allGames.length;
      if (seriesDone || expected) {
        return res.json({ ...allGames[allGames.length - 1], games: allGames });
      }
    }
    const cached = await getStoredMatchStats(id, matchId);
    if (cached?.isComplete) return res.json({ ...cached, games: allGames.length ? allGames : undefined });

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

// ── Suizo: generar la siguiente ronda (pareo por récord, sin revanchas) ───────
router.post('/:id/next-round', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede hacer esto' });
    if (t.bracketType !== 'swiss') return res.status(400).json({ error: 'Solo para torneos suizos' });
    if (t.phase !== 'active' || !t.bracket?.length) return res.status(400).json({ error: 'Torneo no activo' });

    const maxRound = Math.max(...t.bracket.map(m => m.round));
    const pending = t.bracket.filter(m => m.round === maxRound && m.matchStatus !== 'complete');
    if (pending.length) {
      return res.status(409).json({ error: `Aún hay ${pending.length} partido(s) sin terminar en la ronda ${maxRound}`, pending: pending.map(m => m.id) });
    }

    const newMatches = pairSwissRound(t, maxRound + 1);
    if (!newMatches.length) return res.status(400).json({ error: 'No hay pareos posibles' });
    t.bracket = [...t.bracket, ...newMatches];
    // Códigos para los partidos reales de la nueva ronda
    for (let i = 0; i < t.bracket.length; i++) {
      const m = t.bracket[i];
      if (m.round === maxRound + 1 && m.matchStatus === 'ready' && !m.code) {
        await assignCodeToMatch(t, i);
      }
    }
    await saveT(t);
    res.json({ success: true, round: maxRound + 1, matches: sanitizeBracket(newMatches, 'owner') });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Cerrar torneo manualmente (suizo: el organizador decide cuántas rondas) ──
router.post('/:id/complete', requireAuth, async (req: any, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede hacer esto' });
    if (t.phase !== 'active') return res.status(400).json({ error: 'Torneo no activo' });
    t.phase = 'complete';
    await saveT(t);
    res.json({ success: true, champion: t.standings?.[0]?.team ?? null });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
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

// Global stats — aggregated from all completed bracket matches in this tournament.
// Extraída a función para reutilizarla desde la API pública (/api/public/v1).
export async function computeGlobalStats(id: string) {
  {
    const [rows] = await pool.query<any[]>(
      `SELECT parsed_data, game_duration FROM tournament_match_stats
       WHERE tournament_id = ? AND game_end_ts IS NOT NULL
       ORDER BY fetched_at ASC`,
      [id]
    );

    if (rows.length === 0) {
      return { tournamentId: id, matchesCompleted: 0, players: [] as any[], lastUpdated: Date.now() };
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

    return { tournamentId: id, matchesCompleted: rows.length, players, lastUpdated: Date.now() };
  }
}

router.get('/:id/global-stats', async (req, res) => {
  const { id } = req.params;
  try {
    const t = await getT(id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    res.json(await computeGlobalStats(id));
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

    // Gate (b) + cuotas anti-abuso (Sprint 0)
    const cap = await riotCapability(req);
    if (!cap.ok) {
      await logDenied(req.auth?.userId, 'POST /generate-codes', cap.reason);
      return res.status(cap.status).json({ error: cap.error });
    }
    const n = Math.max(1, Math.min(Number(count) || 10, 100));
    if (await codesQuotaExceeded(t.id, n)) {
      await logDenied(req.auth?.userId, 'POST /generate-codes', 'codes_quota');
      return res.status(429).json({ error: `Límite de ${RIOT_MAX_CODES_PER_TOURNAMENT} códigos por torneo alcanzado.` });
    }
    if (!t.riotTournamentId && await monthlyRiotQuotaExceeded(req.auth.userId)) {
      await logDenied(req.auth?.userId, 'POST /generate-codes', 'monthly_quota');
      return res.status(429).json({ error: `Límite de ${RIOT_MAX_TOURNAMENTS_PER_MONTH} torneos Riot por mes alcanzado.` });
    }

    const providerId = await getOrCreateProviderId();
    let riotTournamentId = t.riotTournamentId;
    if (!riotTournamentId) {
      const rt = await createTournament(providerId, t.name);
      riotTournamentId = rt.id; t.riotTournamentId = riotTournamentId;
    }
    const newCodes = await generateCodes(riotTournamentId!, n, riotCodeOptions(t));
    t.codePool = [...t.codePool, ...newCodes];
    await saveT(t);
    await bumpCodesGenerated(t.id, newCodes.length);
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
  const { logoUrl, bannerUrl, region, name, prize, description, fearless } = req.body;
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!isOwner(req, t)) return res.status(403).json({ error: 'Solo el creador puede editar' });
    if (logoUrl    !== undefined) t.logoUrl    = logoUrl    || undefined;
    if (bannerUrl  !== undefined) t.bannerUrl  = bannerUrl  || undefined;
    const { registrationUrl, rulesUrl } = req.body;
    if (registrationUrl !== undefined || rulesUrl !== undefined) {
      await pool.query('UPDATE tournaments SET registration_url=COALESCE(?, registration_url), rules_url=COALESCE(?, rules_url) WHERE id=?',
        [registrationUrl === undefined ? null : (registrationUrl || null),
         rulesUrl === undefined ? null : (rulesUrl || null), t.id]);
      if (registrationUrl !== undefined) t.registrationUrl = registrationUrl || undefined;
      if (rulesUrl !== undefined) t.rulesUrl = rulesUrl || undefined;
    }
    if (region     !== undefined) t.region     = region     || 'la1';
    if (name       !== undefined) t.name       = name;
    if (prize      !== undefined) t.prize      = prize;
    if (description !== undefined) t.description = description;
    await saveT(t);
    if (fearless !== undefined) {
      await pool.query('UPDATE tournaments SET fearless=? WHERE id=?', [fearless ? 1 : 0, t.id]);
      t.fearless = !!fearless;
    }
    const { bracketType, seriesTo, finalSeriesTo, swissRounds } = req.body;
    const locked = t.phase === 'active' || t.phase === 'complete';
    // Rondas suizas planeadas: se puede ajustar incluso con el torneo activo
    // (es el interruptor del avance automático, no cambia partidos ya jugados).
    if (swissRounds !== undefined) {
      const sr = swissRounds === null ? null : Number(swissRounds);
      if (sr !== null && (!Number.isInteger(sr) || sr < 1 || sr > 12))
        return res.status(400).json({ error: 'swissRounds: entero 1-12 o null (manual)' });
      await pool.query('UPDATE tournaments SET swiss_rounds=? WHERE id=?', [sr, t.id]);
      t.swissRounds = sr ?? undefined;
    }
    if (bracketType !== undefined) {
      if (!['single_elim', 'round_robin', 'swiss'].includes(bracketType))
        return res.status(400).json({ error: 'bracketType inválido (single_elim | round_robin | swiss)' });
      if (locked) return res.status(400).json({ error: 'No se puede cambiar el formato con el torneo iniciado' });
      await pool.query('UPDATE tournaments SET bracket_type=? WHERE id=?', [bracketType, t.id]);
      t.bracketType = bracketType;
    }
    if (seriesTo !== undefined || finalSeriesTo !== undefined) {
      if (locked) return res.status(400).json({ error: 'No se pueden cambiar las series con el torneo iniciado' });
      const st = Number(seriesTo ?? t.seriesTo ?? 1), fst = Number(finalSeriesTo ?? t.finalSeriesTo ?? st);
      if (![1, 2, 3].includes(st) || ![1, 2, 3].includes(fst))
        return res.status(400).json({ error: 'seriesTo/finalSeriesTo: 1 (Bo1), 2 (Bo3) o 3 (Bo5)' });
      await pool.query('UPDATE tournaments SET series_to=?, final_series_to=? WHERE id=?', [st, fst, t.id]);
      t.seriesTo = st; t.finalSeriesTo = fst;
    }
    // Formato de juego (tamaño/mapa/pick): solo antes de iniciar — los códigos
    // ya generados quedarían con el teamSize viejo.
    const { teamSize, gameMap, pickType, endDate } = req.body;
    if (teamSize !== undefined || gameMap !== undefined || pickType !== undefined) {
      if (locked) return res.status(400).json({ error: 'No se puede cambiar el formato de juego con el torneo iniciado' });
      const gm = gameMap !== undefined
        ? (['SR', 'ARAM', 'ARENA'].includes(gameMap) ? gameMap : null)
        : (t.gameMap || 'SR');
      if (!gm) return res.status(400).json({ error: 'gameMap inválido (SR | ARAM | ARENA)' });
      const ts = gm === 'ARENA' ? 2
        : teamSize !== undefined ? Number(teamSize) : (t.teamSize || 5);
      if (!Number.isInteger(ts) || ts < 1 || ts > 5)
        return res.status(400).json({ error: 'teamSize: entero 1-5' });
      const pt = pickType !== undefined
        ? (pickType === null || pickType === '' ? null
          : ['BLIND_PICK', 'DRAFT_MODE', 'ALL_RANDOM', 'TOURNAMENT_DRAFT'].includes(pickType) ? pickType : undefined)
        : (t.pickType ?? null);
      if (pt === undefined) return res.status(400).json({ error: 'pickType inválido' });
      await pool.query('UPDATE tournaments SET team_size=?, game_map=?, pick_type=? WHERE id=?', [ts, gm, pt, t.id]);
      t.teamSize = ts; t.gameMap = gm; t.pickType = pt ?? undefined;
    }
    if (endDate !== undefined) {
      const ed = endDate ? new Date(endDate) : null;
      if (ed && isNaN(ed.getTime())) return res.status(400).json({ error: 'endDate inválido' });
      await pool.query('UPDATE tournaments SET end_date=? WHERE id=?', [ed ? ed.toISOString() : null, t.id]);
      t.endDate = ed ? ed.toISOString() : undefined;
    }
    // Visibilidad: se puede alternar en cualquier fase (hacer público un
    // privado no rompe nada; hacer privado uno público oculta el listado).
    if (req.body.isPrivate !== undefined) {
      await pool.query('UPDATE tournaments SET is_private=? WHERE id=?', [req.body.isPrivate ? 1 : 0, t.id]);
      t.isPrivate = !!req.body.isPrivate;
    }
    res.json({ success: true, tournament: serialize(t) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ── Fearless draft: campeones ya usados por equipo en este torneo ─────────────
// El lobby de Riot no puede forzarlo; la plataforma lo rastrea y lo muestra.
// Asignación por Riot ID del roster (gamertag → equipo); lo que no se puede
// atribuir cae en `unassigned` (igual está bloqueado globalmente).
router.get('/:id/fearless', async (req, res) => {
  try {
    const t = await getT(req.params.id);
    if (!t) return res.status(404).json({ error: 'Torneo no encontrado' });

    const regs = await getRegs(t.id);
    const byRiotId = new Map<string, string>(); // riotId lower → teamName
    for (const reg of regs) for (const p of reg.players || []) {
      const rid = (p.riotId || p.name || '').toLowerCase();
      if (rid) byRiotId.set(rid, reg.teamName);
    }

    const [rows] = await pool.query<any[]>(
      `SELECT parsed_data FROM tournament_match_stats WHERE tournament_id=? AND game_end_ts IS NOT NULL`,
      [t.id]
    );
    const teams = new Map<string, Set<string>>();
    const unassigned = new Set<string>();
    const all = new Set<string>();
    for (const row of rows) {
      const d: any = typeof row.parsed_data === 'string' ? JSON.parse(row.parsed_data) : row.parsed_data;
      for (const p of [...(d.blueTeam ?? []), ...(d.redTeam ?? [])]) {
        if (!p.championName) continue;
        all.add(p.championName);
        const rid = `${p.summonerName}#${p.tagLine || ''}`.toLowerCase();
        const team = byRiotId.get(rid) ?? byRiotId.get((p.summonerName || '').toLowerCase());
        if (team) {
          if (!teams.has(team)) teams.set(team, new Set());
          teams.get(team)!.add(p.championName);
        } else unassigned.add(p.championName);
      }
    }
    res.json({
      fearless: !!t.fearless,
      gamesCounted: rows.length,
      teams: [...teams.entries()].map(([team, champs]) => ({ team, usedChampions: [...champs].sort() })),
      unassigned: [...unassigned].sort(),
      allUsed: [...all].sort(),
    });
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
    //   b) it's a CUSTOM game (gameType CUSTOM_GAME; los códigos crean customs
    //      — queueId 0 en SR, 3220 en ARAM) con al menos un jugador registrado
    //      de CADA equipo (scrim/arena-proof).
    // Anything else (Arena/CHERRY, ARAM normal, ranked, normals) is rejected.
    const isTournamentGame = (game: any): boolean => {
      if (!game) return false;
      if (codeGameId && Number(game.gameId) === Number(codeGameId)) return true;
      const q = game.gameQueueConfigId ?? game.gameQueueId;
      if (game.gameType !== 'CUSTOM_GAME' && q !== 0) return false;
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
