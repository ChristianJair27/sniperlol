// LQC 2026: export del roster de ATAK para cruzarlo con la base de la liga.
//   node scripts/lqc-roster-export.mjs [salida.csv]
// Columnas: equipo, capitan, gamertag_actual, gamertags_anteriores (alias por renombre), nombre, correo, estado, origen.
import mysql from 'mysql2/promise'; import fs from 'node:fs'; import 'dotenv/config';
const out = process.argv[2] || 'lqc-2026-roster.csv';
const c = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT) || 3306, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB });
const [regs] = await c.query("SELECT team_name, captain_riot_id, players FROM tournament_registrations WHERE tournament_id='lqc-2026' ORDER BY team_name");
const pj = (v) => (typeof v === 'string' ? JSON.parse(v) : v) || [];
const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
const rows = [['equipo', 'capitan', 'gamertag_actual', 'gamertags_anteriores', 'nombre', 'correo', 'estado', 'origen'].join(',')];
let n = 0;
for (const r of regs) for (const p of pj(r.players)) {
  rows.push([r.team_name, r.captain_riot_id, p.riotId || p.inviteRiotId || '', (p.aliases || []).join(' | '), p.realName || p.name || '', p.email || p.inviteEmail || '', p.inviteStatus || 'accepted', p.source || ''].map(q).join(','));
  n++;
}
fs.writeFileSync(out, '\ufeff' + rows.join('\r\n') + '\r\n', 'utf8');
console.log(`${regs.length} equipos, ${n} jugadores → ${out}`);
await c.end();
