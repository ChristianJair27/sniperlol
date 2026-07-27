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
import { sendTournamentInvitationEmail, isDeliverableEmail } from '../services/mail.service.js';

const router = Router();

function bad(res: any, code: number, error: string) { return res.status(code).json({ ok: false, error }); }

// Acepta snake_case (columnas Supabase) y camelCase
function pickFrom(r: any, ...keys: string[]) {
  for (const k of keys) { const v = r?.[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
  return '';
}

router.post('/lqc/register', async (req, res) => {
  const secret = process.env.LQC_WEBHOOK_SECRET;
  if (!secret) return bad(res, 503, 'Integración no configurada (falta LQC_WEBHOOK_SECRET)');
  if (req.header('X-LQC-Secret') !== secret) return bad(res, 401, 'Secreto inválido');

  const tournamentId = process.env.LQC_TOURNAMENT_ID;
  if (!tournamentId) return bad(res, 503, 'Falta LQC_TOURNAMENT_ID');

  // Supabase Database Webhook manda { type, table, record, ... }; también
  // aceptamos el objeto plano si lo llaman a mano.
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
    email: pick('correo', 'correo_electronico', 'email') || undefined,
    birthDate: pick('fecha_nacimiento', 'fechaNacimiento', 'birth_date') || undefined,
    schooling: pick('escolaridad', 'schooling') || undefined,
    municipality: pick('municipio', 'municipality') || undefined,
    locality: pick('localidad', 'locality') || undefined,
    gender: pick('genero', 'género', 'gender') || undefined,
    source: 'lqc-form',
    // La UI de ATAK.GG muestra "PENDIENTE" hasta que el jugador acepte desde su cuenta
    inviteEmail: pick('correo', 'correo_electronico', 'email') || undefined,
    inviteStatus: 'pending' as const,
  };
  const captainName  = pick('capitan', 'capitan_nombre', 'nombre_capitan', 'captainName', 'captain_name');
  const captainPhone = pick('capitan_celular', 'celular_capitan', 'captainPhone', 'captain_phone');

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
  const secret = process.env.LQC_WEBHOOK_SECRET;
  if (!secret) return bad(res, 503, 'Integración no configurada (falta LQC_WEBHOOK_SECRET)');
  if (req.header('X-LQC-Secret') !== secret) return bad(res, 401, 'Secreto inválido');

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

export default router;
