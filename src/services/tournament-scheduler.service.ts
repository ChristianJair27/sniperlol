// Torneos diarios programados: cada plantilla (tournament_schedules) genera una
// instancia por día a su hora configurada. El ciclo de vida es 100% automático:
//
//   spawn  → `open_before_minutes` antes de la hora: se crea el torneo del día
//            (id daily-<slug>-YYYYMMDD) con inscripciones abiertas.
//   start  → a la hora exacta, si hay >= min_teams: bracket + códigos (SR/ARAM)
//            o apertura de ventana ladder (Arena) vía startTournamentInternal.
//   cancel → si a la hora + 20 min de gracia no se llenó el mínimo.
//
// Las horas se guardan como hora local de la plantilla (tz_offset_minutes,
// default -360 = CDMX/Querétaro) para que "todos los días 8pm" signifique 8pm
// de la liga, no del servidor.
import { pool } from '../db.js';

const START_GRACE_MS = 20 * 60_000;

export type ScheduleRow = {
  id: number; name: string; description: string | null;
  game_map: string; team_size: number; pick_type: string | null;
  bracket_type: string; series_to: number; final_series_to: number;
  swiss_rounds: number | null; max_participants: number;
  prize: string; region: string; logo_url: string | null; banner_url: string | null;
  start_hour: number; start_minute: number; tz_offset_minutes: number;
  days: unknown; open_before_minutes: number; min_teams: number;
  duration_hours: number; auto_start: number; enabled: number; create_riot: number;
  created_by: number | null; last_spawned_date: string | null;
};

function parseDays(v: unknown): number[] | null {
  const arr = typeof v === 'string' ? JSON.parse(v || 'null') : v;
  return Array.isArray(arr) && arr.length ? arr.map(Number) : null; // null = todos los días
}

/** Fecha (YYYY-MM-DD), día de semana y ms UTC del arranque de HOY en la tz de la plantilla. */
export function todayStartFor(s: Pick<ScheduleRow, 'start_hour' | 'start_minute' | 'tz_offset_minutes'>, nowMs: number) {
  const local = new Date(nowMs + s.tz_offset_minutes * 60_000);
  const dateStr = local.toISOString().slice(0, 10);
  const weekday = local.getUTCDay();
  const startUtcMs = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    s.start_hour, s.start_minute
  ) - s.tz_offset_minutes * 60_000;
  return { dateStr, weekday, startUtcMs };
}

function slugify(name: string) {
  return name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function spawnDaily(s: ScheduleRow, dateStr: string, startUtcMs: number) {
  const id = `daily-${slugify(s.name)}-${dateStr.replace(/-/g, '')}`;
  const [[exists]] = await pool.query<any[]>('SELECT id FROM tournaments WHERE id=?', [id]);
  if (exists) {
    await pool.query('UPDATE tournament_schedules SET last_spawned_date=? WHERE id=?', [dateStr, s.id]);
    return;
  }

  const gameMap = ['SR', 'ARAM', 'ARENA'].includes(s.game_map) ? s.game_map : 'SR';
  const teamSize = gameMap === 'ARENA' ? 2 : Math.min(5, Math.max(1, Number(s.team_size) || 5));
  const startIso = new Date(startUtcMs).toISOString();
  const endIso = gameMap === 'ARENA'
    ? new Date(startUtcMs + Math.min(72, Math.max(1, s.duration_hours || 3)) * 3600_000).toISOString()
    : null;
  const label = gameMap === 'ARENA' ? 'Arena Ladder 2v2'
    : gameMap === 'ARAM' ? `ARAM ${teamSize}v${teamSize}`
    : `${teamSize}v${teamSize} ${s.bracket_type === 'swiss' ? 'Suizo' : s.bracket_type === 'round_robin' ? 'Liga' : 'Single Elimination'}`;

  // Torneo Riot real (códigos oficiales): opt-in por plantilla — consume cuota.
  let riotTournamentId: number | null = null;
  if (s.create_riot && gameMap !== 'ARENA') {
    try {
      const routes = await import('../routes/tournaments.routes.js');
      const riot = await import('./riot-tournament.service.js');
      const providerId = await routes.getOrCreateProviderId();
      const rt = await riot.createTournament(providerId, `${s.name} ${dateStr}`);
      riotTournamentId = rt.id;
    } catch (e: any) {
      console.error(`[daily] Riot tournament para "${s.name}" falló (sigue sin códigos):`, e.message);
    }
  }

  await pool.query(
    `INSERT INTO tournaments (id,name,phase,participants,max_participants,prize,start_date,format,description,
       riot_tournament_id,code_pool,created_by,team_size,game_map,pick_type,end_date,
       bracket_type,series_to,final_series_to,swiss_rounds,region,logo_url,banner_url,schedule_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, `${s.name} · ${dateStr}`, 'registration', 0, s.max_participants || 16,
      s.prize || 'Gloria y puntos de la comunidad', startIso, label,
      s.description || `Torneo diario automático — inscríbete antes de las ${String(s.start_hour).padStart(2, '0')}:${String(s.start_minute).padStart(2, '0')}.`,
      riotTournamentId, JSON.stringify([]), s.created_by,
      teamSize, gameMap, s.pick_type || null, endIso,
      s.bracket_type || 'single_elim', s.series_to || 1, s.final_series_to || s.series_to || 1,
      s.swiss_rounds, s.region || 'la1', s.logo_url, s.banner_url, s.id,
    ]
  );
  await pool.query('UPDATE tournament_schedules SET last_spawned_date=? WHERE id=?', [dateStr, s.id]);
  console.log(`[daily] "${s.name}" → torneo del día creado: ${id} (inicia ${startIso})`);
}

async function autoStartDue(nowMs: number) {
  const [rows] = await pool.query<any[]>(
    `SELECT t.id, t.participants, t.start_date, s.min_teams, s.auto_start
       FROM tournaments t JOIN tournament_schedules s ON s.id = t.schedule_id
      WHERE t.schedule_id IS NOT NULL AND t.phase IN ('registration','checkin')`
  );
  for (const row of rows) {
    const startMs = Date.parse(row.start_date);
    if (!Number.isFinite(startMs) || nowMs < startMs || !row.auto_start) continue;
    try {
      const routes = await import('../routes/tournaments.routes.js');
      const t = await routes.getT(row.id);
      if (!t) continue;
      if (Number(row.participants) >= Math.max(2, Number(row.min_teams) || 2)) {
        const r = await routes.startTournamentInternal(t);
        console.log(r.ok
          ? `[daily] ${row.id}: iniciado automáticamente (${row.participants} equipos)`
          : `[daily] ${row.id}: no se pudo iniciar — ${r.error}`);
      } else if (nowMs > startMs + START_GRACE_MS) {
        await pool.query("UPDATE tournaments SET phase='cancelled' WHERE id=?", [row.id]);
        console.log(`[daily] ${row.id}: cancelado — solo ${row.participants} equipo(s) al cierre`);
      }
    } catch (e: any) {
      console.error(`[daily] auto-start ${row.id} falló:`, e.message);
    }
  }
}

let tickRunning = false;
export async function schedulerTick(nowMs = Date.now()) {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const [schedules] = await pool.query<any[]>(
      'SELECT * FROM tournament_schedules WHERE enabled=1'
    );
    for (const s of schedules as ScheduleRow[]) {
      try {
        const { dateStr, weekday, startUtcMs } = todayStartFor(s, nowMs);
        const days = parseDays(s.days);
        if (days && !days.includes(weekday)) continue;
        if (s.last_spawned_date === dateStr) continue;
        // Se crea desde open_before antes hasta la gracia después (por si el
        // backend estuvo caído justo a la hora de apertura).
        if (nowMs >= startUtcMs - s.open_before_minutes * 60_000 && nowMs <= startUtcMs + START_GRACE_MS) {
          await spawnDaily(s, dateStr, startUtcMs);
        }
      } catch (e: any) {
        console.error(`[daily] plantilla ${s.id} falló:`, e.message);
      }
    }
    await autoStartDue(nowMs);
  } catch (e: any) {
    // Tabla aún no creada en el primer boot → benigno; cualquier otra cosa se loguea.
    if (e.code !== 'ER_NO_SUCH_TABLE') console.error('[daily] tick error:', e.message);
  } finally {
    tickRunning = false;
  }
}

export function startDailyTournamentScheduler() {
  setTimeout(() => schedulerTick(), 20_000);
  setInterval(() => schedulerTick(), 60_000);
  console.log('[daily] scheduler de torneos diarios iniciado (cada 60s)');
}
