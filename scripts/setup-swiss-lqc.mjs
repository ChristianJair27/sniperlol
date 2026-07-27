// Migración series + config LQC suizo Bo3 (final Bo5) — idempotente
import 'dotenv/config';
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});
for (const sql of [
  "ALTER TABLE tournaments ADD COLUMN series_to INT DEFAULT 1",
  "ALTER TABLE tournaments ADD COLUMN final_series_to INT DEFAULT 1",
  "ALTER TABLE tournament_match_stats DROP INDEX unique_bracket_match",
  "ALTER TABLE tournament_match_stats ADD UNIQUE KEY unique_bracket_game (tournament_id, bracket_match_id, game_id)",
]) {
  try { await c.query(sql); console.log('OK:', sql.slice(0, 60)); }
  catch (e) { console.log('skip:', e.code, sql.slice(0, 60)); }
}
await c.query("UPDATE tournaments SET bracket_type='swiss', series_to=2, final_series_to=3 WHERE id='lqc-2026'");
const [[t]] = await c.query("SELECT id, bracket_type, series_to, final_series_to, fearless FROM tournaments WHERE id='lqc-2026'");
console.log(t);
await c.end();
