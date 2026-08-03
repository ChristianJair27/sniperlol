// AUDITORÍA SOLO LECTURA — SHOW/SELECT únicamente, cero escrituras
import 'dotenv/config';
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});
const tables = ['tournaments', 'tournament_registrations', 'tournament_match_stats', 'tournament_invitations', 'users', 'app_settings'];
for (const t of tables) {
  try {
    const [[r]] = await c.query(`SHOW CREATE TABLE ${t}`);
    console.log(`\n===== ${t} =====\n` + r['Create Table']);
  } catch (e) { console.log(`\n===== ${t} ===== ERROR: ${e.message}`); }
}
console.log('\n===== app_settings (provider ids) =====');
try { const [rows] = await c.query('SELECT k, v, updated_at FROM app_settings'); console.table(rows); } catch (e) { console.log(e.message); }
console.log('\n===== tournaments (resumen) =====');
const [ts] = await c.query('SELECT id, phase, riot_tournament_id, bracket_type, series_to, final_series_to, fearless, COALESCE(hidden,0) hidden, region, registration_url IS NOT NULL AS ext_reg FROM tournaments');
console.table(ts);
console.log('\n===== stats guardadas =====');
const [[ms]] = await c.query('SELECT COUNT(*) AS filas, COUNT(DISTINCT tournament_id) AS torneos FROM tournament_match_stats');
console.log(ms);
console.log('\n===== users =====');
const [[us]] = await c.query("SELECT COUNT(*) AS total, SUM(role='admin') AS admins, SUM(provider='riot') AS riot, SUM(provider='google') AS google FROM users");
console.log(us);
await c.end();
