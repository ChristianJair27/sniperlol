// scripts/fix-invite-email.ts
// Corrige el email de un jugador en tournament_registrations y RE-ENVÍA la
// invitación al torneo (el flujo normal solo invita al agregar el jugador,
// no al actualizar — por eso un typo corregido necesita este reenvío manual).
//
// Uso (desde sniperlol/):
//   npx tsx scripts/fix-invite-email.ts --team "Los Rokosos" --gamertag "LRK Arq ByChoko#B51" --email aramperez9@icloud.com
//   Flags: --tournament <id> (default: LQC_TOURNAMENT_ID)  --dry (solo mostrar, sin escribir/enviar)
import './../src/loadEnv.js';
import mysql from 'mysql2/promise';
import { sendTournamentInvitationEmail, isDeliverableEmail } from '../src/services/mail.service.js';

const args: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
}

const TOURNAMENT = args.tournament || process.env.LQC_TOURNAMENT_ID || 'lqc-2026';
const TEAM = args.team;
const GAMERTAG = args.gamertag;
const EMAIL = (args.email || '').trim().toLowerCase();
const DRY = args.dry === 'true';

if (!TEAM || !GAMERTAG || !EMAIL) {
  console.error('Uso: npx tsx scripts/fix-invite-email.ts --team "<equipo>" --gamertag "<riot id>" --email <correo-correcto> [--dry]');
  process.exit(1);
}
if (!isDeliverableEmail(EMAIL)) {
  console.error(`El correo "${EMAIL}" no parece válido/entregable. Revísalo.`);
  process.exit(1);
}

const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});

const [[reg]] = await c.query<any[]>(
  'SELECT * FROM tournament_registrations WHERE tournament_id=? AND LOWER(team_name)=LOWER(?)',
  [TOURNAMENT, TEAM]
) as any;
if (!reg) { console.error(`Equipo "${TEAM}" no encontrado en ${TOURNAMENT}`); process.exit(1); }

const players: any[] = typeof reg.players === 'string' ? JSON.parse(reg.players) : (reg.players ?? []);
const idx = players.findIndex(p => (p.riotId || p.name || '').toLowerCase() === GAMERTAG.toLowerCase());
if (idx < 0) {
  console.error(`Jugador "${GAMERTAG}" no está en el roster. Roster:`);
  players.forEach(p => console.error(' -', p.riotId || p.name, '|', p.inviteEmail || p.email || '(sin email)'));
  process.exit(1);
}

const before = players[idx].inviteEmail || players[idx].email || '(sin email)';
console.log(`Equipo: ${reg.team_name} · Jugador: ${GAMERTAG}`);
console.log(`Email actual:  ${before}`);
console.log(`Email nuevo:   ${EMAIL}`);

if (DRY) { console.log('(dry run: sin cambios ni envío)'); await c.end(); process.exit(0); }

players[idx] = { ...players[idx], email: EMAIL, inviteEmail: EMAIL, inviteStatus: 'pending' };
await c.query('UPDATE tournament_registrations SET players=? WHERE id=?', [JSON.stringify(players), reg.id]);
console.log('BD actualizada ✔');

const [[t]] = await c.query<any[]>('SELECT id, name FROM tournaments WHERE id=?', [TOURNAMENT]) as any;
const r = await sendTournamentInvitationEmail({
  toEmail: EMAIL,
  toName: players[idx].realName || players[idx].name || GAMERTAG,
  inviterName: 'LQC',
  teamName: reg.team_name,
  tournamentId: TOURNAMENT,
  tournamentName: t?.name || 'LQC 2026',
});
console.log(r.sent ? 'Invitación reenviada ✔' : 'No se pudo enviar (revisa SMTP en .env)');
if (r.previewUrl) console.log('Preview:', r.previewUrl);
await c.end();
