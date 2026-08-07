import 'dotenv/config';
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});
const [rows] = await c.query(
  "SELECT id, team_name, players, contact FROM tournament_registrations WHERE tournament_id=? AND team_name LIKE '%okoso%'",
  [process.env.LQC_TOURNAMENT_ID || 'lqc-2026']
);
for (const r of rows) {
  console.log('team:', r.team_name, '| reg id:', r.id);
  const ps = typeof r.players === 'string' ? JSON.parse(r.players) : r.players;
  for (const p of ps) console.log(' -', p.riotId || p.name, '| email:', p.inviteEmail || p.email || '(sin email)', '| invite:', p.inviteStatus || '-');
}
await c.end();
