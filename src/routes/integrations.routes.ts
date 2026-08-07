// src/routes/integrations.routes.ts — Webhooks de integración con sitios aliados.
//
// POST /api/integrations/lqc/register
//   Recibe cada registro del formulario de lqc.revolution505.com (directo o como
//   Database Webhook de Supabase: { type:'INSERT', record:{...} }) y lo inscribe
//   automáticamente en el torneo LQC de ATAK.GG (env LQC_TOURNAMENT_ID).
//
//   Auth: header `X-LQC-Secret` debe coincidir con env LQC_WEBHOOK_SECRET.
//   Idempotente: si el equipo ya existe se agrega/actualiza el jugador por
//   gamertag; reenviar el mismo registro no duplica nada.
import { Router } from 'express';
import { pool } from '../db.js';
import { getT } from './tournaments.routes.js';
import { sendTournamentInvitationEmail, isDeliverableEmail, fixCommonEmailTypos } from '../services/mail.service.js';

// Normaliza + auto-corrige typos inequívocos de dominio (.con→.com, gmial→gmail...).
// El registro llega por webhook: el jugador ya no está enfrente para corregirlo,
// así que se corrige aquí ANTES de guardar/invitar y se deja rastro en logs.
const cleanEmail = (raw?: string): string | undefined => {
  if (!raw) return undefined;
  const { email, fixed, original } = fixCommonEmailTypos(raw);
  if (fixed) console.warn(`[lqc] email con typo auto-corregido: "${original}" → "${email}"`);
  return email;
};

const router = Router();

function bad(res: any, code: number, error: string) { return res.status(code).json({ ok: false, error }); }

// Acepta snake_case (columnas Supabase) y camelCase
function pickFrom(r: any, ...keys: string[]) {
  for (const k of keys) { const v = r?.[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
  return '';
}

// LQC_WEBHOOK_SECRET admite varios secretos separados por coma
// (rotación sin caída: "nuevo,viejo" mientras el otro lado migra al nuevo).
function checkSecret(req: any): 'ok' | 'bad' | 'unconfigured' {
  const secrets = (process.env.LQC_WEBHOOK_SECRET || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!secrets.length) return 'unconfigured';
  return secrets.includes(req.header('X-LQC-Secret') || '') ? 'ok' : 'bad';
}

// Baja de jugador/equipo (DELETE en su Supabase, o llamada directa).
// Idempotente: si ya no existe, responde ok con action:'not_found'.
async function removePlayerOrTeam(tournamentId: string, teamName: string, gamertag: string) {
  const t = await getT(tournamentId);
  if (!t) return { status: 404 as const, body: { ok: false, error: `Torneo ${tournamentId} no existe` } };
  if (t.phase !== 'registration' && t.phase !== 'checkin') {
    return { status: 409 as const, body: { ok: false, error: `Torneo ya iniciado (${t.phase}) — bajas solo con el organizador` } };
  }
  const [[reg]] = await pool.query<any[]>(
    'SELECT * FROM tournament_registrations WHERE tournament_id=? AND LOWER(team_name)=LOWER(?)',
    [tournamentId, teamName]
  );
  if (!reg) return { status: 200 as const, body: { ok: true, action: 'not_found', team: teamName } };

  let players: any[] = typeof reg.players === 'string' ? JSON.parse(reg.players) : (reg.players ?? []);
  if (gamertag) {
    const before = players.length;
    players = players.filter(p => (p.riotId || p.name || '').toLowerCase() !== gamertag.toLowerCase());
    if (players.length === before) return { status: 200 as const, body: { ok: true, action: 'not_found', team: teamName, player: gamertag } };
    if (players.length > 0) {
      await pool.query('UPDATE tournament_registrations SET players=? WHERE id=?', [JSON.stringify(players), reg.id]);
      return { status: 200 as const, body: { ok: true, action: 'player_removed', team: teamName, player: gamertag, teamSize: players.length } };
    }
    // último jugador → cae el equipo completo
  }
  await pool.query('DELETE FROM tournament_registrations WHERE id=?', [reg.id]);
  await pool.query('UPDATE tournaments SET participants = GREATEST(0, participants - 1) WHERE id = ?', [tournamentId]);
  return { status: 200 as const, body: { ok: true, action: 'team_removed', team: teamName } };
}

router.post('/lqc/register', async (req, res) => {
  const auth = checkSecret(req);
  if (auth === 'unconfigured') return bad(res, 503, 'Integración no configurada (falta LQC_WEBHOOK_SECRET)');
  if (auth === 'bad') return bad(res, 401, 'Secreto inválido');

  const tournamentId = process.env.LQC_TOURNAMENT_ID;
  if (!tournamentId) return bad(res, 503, 'Falta LQC_TOURNAMENT_ID');

  // DELETE de Supabase (webhook con eventos INSERT/UPDATE/DELETE apuntando aquí):
  // la fila borrada viene en old_record → damos de baja al jugador/equipo.
  if (req.body?.type === 'DELETE') {
    const old: any = req.body?.old_record ?? {};
    const teamName = pickFrom(old, 'equipo', 'team', 'team_name', 'teamName');
    const gamertag = pickFrom(old, 'gamertag', 'game_tag', 'riot_id', 'riotId');
    if (!teamName) return bad(res, 400, 'DELETE sin equipo en old_record');
    try {
      const r2 = await removePlayerOrTeam(tournamentId, teamName, gamertag);
      return res.status(r2.status).json(r2.body);
    } catch (err: any) {
      console.error('[lqc/register DELETE]', err.message);
      return bad(res, 500, err.message);
    }
  }

  // INSERT y UPDATE de Supabase (record) — o el objeto plano si lo llaman a mano.
  const r: any = req.body?.record ?? req.body ?? {};
  // Acepta snake_case (columnas Supabase) y camelCase
  const pick = (...keys: string[]) => {
    for (const k of keys) { const v = r[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
    return '';
  };

  const teamName  = pick('equipo', 'team', 'team_name', 'teamName');
  const gamertag  = pick('gamertag', 'game_tag', 'riot_id', 'riotId');
  const nombre    = pick('nombre', 'name', 'full_name', 'fullName');
  if (!teamName || !gamertag) return bad(res, 400, 'equipo y gamertag son requeridos');

  const player = {
    name: gamertag,
    riotId: gamertag,
    realName: nombre || undefined,
    phone: pick('celular', 'phone', 'telefono') || undefined,
    email: cleanEmail(pick('correo', 'correo_electronico', 'email')),
    birthDate: pick('fecha_nacimiento', 'fechaNacimiento', 'birth_date') || undefined,
    schooling: pick('escolaridad', 'schooling') || undefined,
    municipality: pick('municipio', 'municipality') || undefined,
    locality: pick('localidad', 'locality') || undefined,
    gender: pick('genero', 'género', 'gender') || undefined,
    source: 'lqc-form',
    // La UI de ATAK.GG muestra "PENDIENTE" hasta que el jugador acepte desde su cuenta
    inviteEmail: cleanEmail(pick('correo', 'correo_electronico', 'email')),
    inviteStatus: 'pending' as const,
  };
  const captainName  = pick('capitan', 'capitan_nombre', 'nombre_capitan', 'captainName', 'captain_name');
  const captainPhone = pick('capitan_celular', 'celular_capitan', 'captainPhone', 'captain_phone');
  // Rol titular/suplente si el form lo manda (opcional)
  const rol = pick('rol', 'role', 'tipo');
  if (rol) (player as any).role = rol.toLowerCase();

  // Resolver PUUID al registrar (best-effort): con esto la atribución de stats,
  // fearless y ganadores funciona aunque el jugador nunca cree cuenta en ATAK.
  const ridMatch = gamertag.match(/^(.{3,16})#(.{2,5})$/);
  if (ridMatch) {
    try {
      const { getAccountByRiotId } = await import('../services/riot.js');
      const acc: any = await getAccountByRiotId(ridMatch[1].trim(), ridMatch[2].trim(), { platformHint: 'la1' });
      if (acc?.puuid) (player as any).puuid = acc.puuid;
    } catch { /* Riot caído o ID inexistente: el registro entra igual */ }
  }

  // Invita al jugador a ATAK.GG por correo (crear cuenta + seguir su torneo).
  // Best-effort: si el SMTP falla, el registro NO se bloquea.
  const inviteByEmail = (t: { id: string; name: string }) => {
    if (!player.email || !isDeliverableEmail(player.email)) return;
    sendTournamentInvitationEmail({
      toEmail: player.email,
      toName: nombre || gamertag,
      inviterName: captainName || 'LQC',
      tournamentName: t.name,
      teamName,
      tournamentId: t.id,
      playerSlotName: gamertag,
    }).then(r => {
      if (r.previewUrl) console.log('[lqc/register] email preview:', r.previewUrl);
    }).catch(e => console.warn('[lqc/register] email no enviado:', e.message));
  };

  try {
    const t = await getT(tournamentId);
    if (!t) return bad(res, 404, `Torneo ${tournamentId} no existe`);
    if (t.phase !== 'registration') return bad(res, 409, `El torneo ya no está en fase de registro (${t.phase})`);

    const [[reg]] = await pool.query<any[]>(
      'SELECT * FROM tournament_registrations WHERE tournament_id=? AND LOWER(team_name)=LOWER(?)',
      [tournamentId, teamName]
    );

    if (!reg) {
      // Equipo nuevo — el primer registro lo crea; capitán = dato del form
      const [regs] = await pool.query<any[]>(
        'SELECT COUNT(*) AS c FROM tournament_registrations WHERE tournament_id=?', [tournamentId]
      );
      if (Number(regs[0].c) >= (t.maxParticipants || 32)) return bad(res, 409, 'Torneo lleno');

      await pool.query(
        `INSERT INTO tournament_registrations (tournament_id, team_name, captain_riot_id, players, contact)
         VALUES (?, ?, ?, ?, ?)`,
        [tournamentId, teamName, captainName || gamertag, JSON.stringify([player]),
         [captainName, captainPhone, player.email].filter(Boolean).join(' · ')]
      );
      await pool.query('UPDATE tournaments SET participants = participants + 1 WHERE id = ?', [tournamentId]);
      inviteByEmail(t);
      return res.json({ ok: true, action: 'team_created', team: teamName, player: gamertag });
    }

    // Equipo existente — upsert del jugador por gamertag (idempotente)
    const players: any[] = typeof reg.players === 'string' ? JSON.parse(reg.players) : (reg.players ?? []);
    const idx = players.findIndex(p => (p.riotId || p.name || '').toLowerCase() === gamertag.toLowerCase());
    if (idx >= 0) players[idx] = { ...players[idx], ...player };
    else {
      if (players.length >= 7) return bad(res, 409, `Equipo ${teamName} ya tiene 7 jugadores (5 titulares + 2 suplentes)`);
      players.push(player);
    }
    await pool.query('UPDATE tournament_registrations SET players=? WHERE id=?', [JSON.stringify(players), reg.id]);
    if (idx < 0) inviteByEmail(t); // solo al agregarse, no en cada update
    return res.json({ ok: true, action: idx >= 0 ? 'player_updated' : 'player_added', team: teamName, player: gamertag, teamSize: players.length });
  } catch (err: any) {
    console.error('[lqc/register]', err.message);
    return bad(res, 500, err.message);
  }
});

// POST /api/integrations/lqc/unregister
//   Baja desde el dashboard de admin de la LQC. Dos modos:
//   - Solo `equipo`            → elimina el equipo completo del torneo.
//   - `equipo` + `gamertag`    → quita solo a ese jugador; si era el último,
//                                elimina el equipo.
//   Acepta el objeto plano o un Database Webhook de Supabase de tipo DELETE
//   ({ type:'DELETE', old_record:{...} }). Idempotente: si el equipo/jugador ya
//   no existe responde ok:true con action:'already_absent'.
//   Solo funciona mientras el torneo no haya iniciado (registration/checkin).
router.post('/lqc/unregister', async (req, res) => {
  const auth = checkSecret(req);
  if (auth === 'unconfigured') return bad(res, 503, 'Integración no configurada (falta LQC_WEBHOOK_SECRET)');
  if (auth === 'bad') return bad(res, 401, 'Secreto inválido');

  const tournamentId = process.env.LQC_TOURNAMENT_ID;
  if (!tournamentId) return bad(res, 503, 'Falta LQC_TOURNAMENT_ID');

  const r: any = req.body?.old_record ?? req.body?.record ?? req.body ?? {};
  const teamName = pickFrom(r, 'equipo', 'team', 'team_name', 'teamName');
  const gamertag = pickFrom(r, 'gamertag', 'game_tag', 'riot_id', 'riotId');
  if (!teamName) return bad(res, 400, 'equipo es requerido');

  try {
    const t = await getT(tournamentId);
    if (!t) return bad(res, 404, `Torneo ${tournamentId} no existe`);
    if (t.phase !== 'registration' && t.phase !== 'checkin') {
      return bad(res, 409, `El torneo ya inició (${t.phase}); las bajas se hacen desde ATAK.GG`);
    }

    const [[reg]] = await pool.query<any[]>(
      'SELECT * FROM tournament_registrations WHERE tournament_id=? AND LOWER(team_name)=LOWER(?)',
      [tournamentId, teamName]
    );
    if (!reg) return res.json({ ok: true, action: 'already_absent', team: teamName });

    const deleteTeam = async () => {
      await pool.query('DELETE FROM tournament_registrations WHERE id=?', [reg.id]);
      await pool.query(
        'DELETE FROM tournament_invitations WHERE tournament_id=? AND team_name=?',
        [tournamentId, reg.team_name]
      );
      await pool.query('UPDATE tournaments SET participants=GREATEST(participants-1,0) WHERE id=?', [tournamentId]);
    };

    if (!gamertag) {
      await deleteTeam();
      return res.json({ ok: true, action: 'team_deleted', team: reg.team_name });
    }

    const players: any[] = typeof reg.players === 'string' ? JSON.parse(reg.players) : (reg.players ?? []);
    const idx = players.findIndex(p => (p.riotId || p.name || '').toLowerCase() === gamertag.toLowerCase());
    if (idx < 0) {
      return res.json({ ok: true, action: 'already_absent', team: reg.team_name, player: gamertag, teamSize: players.length });
    }
    const [removed] = players.splice(idx, 1);

    if (players.length === 0) {
      await deleteTeam();
      return res.json({ ok: true, action: 'team_deleted', team: reg.team_name, reason: 'last_player_removed' });
    }

    await pool.query('UPDATE tournament_registrations SET players=? WHERE id=?', [JSON.stringify(players), reg.id]);
    // Cancelar su invitación pendiente (si el jugador tenía correo de invitación)
    if (removed?.inviteEmail) {
      await pool.query(
        `DELETE ti FROM tournament_invitations ti
         JOIN users u ON u.id = ti.invited_user_id
         WHERE ti.tournament_id=? AND ti.team_name=? AND ti.status='pending' AND LOWER(u.email)=LOWER(?)`,
        [tournamentId, reg.team_name, removed.inviteEmail]
      ).catch(() => {});
    }
    return res.json({ ok: true, action: 'player_removed', team: reg.team_name, player: gamertag, teamSize: players.length });
  } catch (err: any) {
    console.error('[lqc/unregister]', err.message);
    return bad(res, 500, err.message);
  }
});

// ── Registro de EQUIPO COMPLETO en una sola llamada (atómico) ─────────────────
// POST /api/integrations/lqc/register-team
// { equipo, capitan_nombre?, capitan_celular?, jugadores: [{gamertag, nombre, ...}] }
// El roster enviado REEMPLAZA al existente (el capitán manda la lista completa).
// Transacción + SELECT FOR UPDATE: sin carreras aunque lleguen envíos simultáneos.
async function buildPlayerFrom(rec: any) {
  const gamertag = pickFrom(rec, 'gamertag', 'game_tag', 'riot_id', 'riotId');
  const p: any = {
    name: gamertag || pickFrom(rec, 'nombre', 'name'),
    riotId: gamertag || undefined,
    realName: pickFrom(rec, 'nombre', 'name', 'full_name') || undefined,
    phone: pickFrom(rec, 'celular', 'phone', 'telefono') || undefined,
    email: cleanEmail(pickFrom(rec, 'correo', 'correo_electronico', 'email')),
    birthDate: pickFrom(rec, 'fecha_nacimiento', 'fechaNacimiento', 'birth_date') || undefined,
    schooling: pickFrom(rec, 'escolaridad', 'schooling') || undefined,
    municipality: pickFrom(rec, 'municipio', 'municipality') || undefined,
    locality: pickFrom(rec, 'localidad', 'locality') || undefined,
    gender: pickFrom(rec, 'genero', 'género', 'gender') || undefined,
    source: 'lqc-form',
    inviteEmail: cleanEmail(pickFrom(rec, 'correo', 'correo_electronico', 'email')),
    inviteStatus: 'pending' as const,
  };
  const rol = pickFrom(rec, 'rol', 'role', 'tipo');
  if (rol) p.role = rol.toLowerCase();
  const m = (gamertag || '').match(/^(.{3,16})#(.{2,5})$/);
  if (m) {
    try {
      const { getAccountByRiotId } = await import('../services/riot.js');
      const acc: any = await getAccountByRiotId(m[1].trim(), m[2].trim(), { platformHint: 'la1' });
      if (acc?.puuid) p.puuid = acc.puuid;
    } catch { /* best-effort */ }
  }
  return p;
}

router.post('/lqc/register-team', async (req, res) => {
  const auth = checkSecret(req);
  if (auth === 'unconfigured') return bad(res, 503, 'Integración no configurada (falta LQC_WEBHOOK_SECRET)');
  if (auth === 'bad') return bad(res, 401, 'Secreto inválido');
  const tournamentId = process.env.LQC_TOURNAMENT_ID;
  if (!tournamentId) return bad(res, 503, 'Falta LQC_TOURNAMENT_ID');

  const b: any = req.body?.record ?? req.body ?? {};
  const teamName = pickFrom(b, 'equipo', 'team', 'team_name', 'teamName');
  const captainName = pickFrom(b, 'capitan', 'capitan_nombre', 'nombre_capitan', 'captainName', 'captain_name');
  const captainPhone = pickFrom(b, 'capitan_celular', 'celular_capitan', 'captainPhone', 'captain_phone');
  const list: any[] = Array.isArray(b.jugadores) ? b.jugadores : Array.isArray(b.players) ? b.players : [];
  if (!teamName || !list.length) return bad(res, 400, 'equipo y jugadores[] requeridos');
  if (list.length > 7) return bad(res, 409, 'Máximo 7 jugadores (5 titulares + 2 suplentes)');

  try {
    const t = await getT(tournamentId);
    if (!t) return bad(res, 404, `Torneo ${tournamentId} no existe`);
    if (t.phase !== 'registration') return bad(res, 409, `El torneo ya no está en fase de registro (${t.phase})`);

    // PUUIDs fuera de la transacción (llamadas a Riot lentas — no bloquear filas)
    const players = await Promise.all(list.map(buildPlayerFrom));
    const captainRiot = captainName || players[0]?.riotId || players[0]?.name || '';
    const contact = [captainName, captainPhone, players[0]?.email].filter(Boolean).join(' · ');

    const conn = await pool.getConnection();
    let action = 'team_updated';
    try {
      await conn.beginTransaction();
      const [[reg]] = await conn.query<any[]>(
        'SELECT id FROM tournament_registrations WHERE tournament_id=? AND LOWER(team_name)=LOWER(?) FOR UPDATE',
        [tournamentId, teamName]
      );
      if (!reg) {
        const [[{ c }]] = await conn.query<any[]>(
          'SELECT COUNT(*) AS c FROM tournament_registrations WHERE tournament_id=?', [tournamentId]
        );
        if (Number(c) >= (t.maxParticipants || 32)) {
          await conn.rollback(); conn.release();
          return bad(res, 409, 'Torneo lleno');
        }
        // ON DUPLICATE cubre la carrera extrema de dos creaciones simultáneas
        const [ins]: any = await conn.query(
          `INSERT INTO tournament_registrations (tournament_id, team_name, captain_riot_id, players, contact)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE players=VALUES(players), captain_riot_id=VALUES(captain_riot_id), contact=VALUES(contact)`,
          [tournamentId, teamName, captainRiot, JSON.stringify(players), contact]
        );
        if (ins.affectedRows === 1) { // 1 = insert nuevo; 2 = duplicate-update
          await conn.query('UPDATE tournaments SET participants = participants + 1 WHERE id=?', [tournamentId]);
          action = 'team_created';
        }
      } else {
        await conn.query(
          'UPDATE tournament_registrations SET players=?, captain_riot_id=?, contact=? WHERE id=?',
          [JSON.stringify(players), captainRiot, contact, reg.id]
        );
      }
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

    // Invitaciones por correo (best-effort, fuera de la transacción)
    for (const p of players) {
      if (!p.email || !isDeliverableEmail(p.email)) continue;
      sendTournamentInvitationEmail({
        toEmail: p.email, toName: p.realName || p.name, inviterName: captainName || 'LQC',
        tournamentName: t.name, teamName, tournamentId: t.id, playerSlotName: p.riotId || p.name,
      }).catch(e => console.warn('[lqc/register-team] email:', e.message));
    }

    return res.json({ ok: true, action, team: teamName, teamSize: players.length,
      withPuuid: players.filter(p => p.puuid).length });
  } catch (err: any) {
    console.error('[lqc/register-team]', err.message);
    return bad(res, 500, err.message);
  }
});

// Baja explícita (para el dashboard de Sebas si prefiere llamarla directo):
// POST /api/integrations/lqc/unregister { equipo, gamertag? }
// Sin gamertag → borra el equipo completo.
router.post('/lqc/unregister', async (req, res) => {
  const auth = checkSecret(req);
  if (auth === 'unconfigured') return bad(res, 503, 'Integración no configurada (falta LQC_WEBHOOK_SECRET)');
  if (auth === 'bad') return bad(res, 401, 'Secreto inválido');
  const tournamentId = process.env.LQC_TOURNAMENT_ID;
  if (!tournamentId) return bad(res, 503, 'Falta LQC_TOURNAMENT_ID');

  const r: any = req.body?.old_record ?? req.body?.record ?? req.body ?? {};
  const teamName = pickFrom(r, 'equipo', 'team', 'team_name', 'teamName');
  const gamertag = pickFrom(r, 'gamertag', 'game_tag', 'riot_id', 'riotId');
  if (!teamName) return bad(res, 400, 'equipo requerido');
  try {
    const r2 = await removePlayerOrTeam(tournamentId, teamName, gamertag);
    return res.status(r2.status).json(r2.body);
  } catch (err: any) {
    console.error('[lqc/unregister]', err.message);
    return bad(res, 500, err.message);
  }
});

export default router;
