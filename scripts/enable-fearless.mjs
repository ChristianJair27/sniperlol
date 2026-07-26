import 'dotenv/config';
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});
try { await c.query('ALTER TABLE tournaments ADD COLUMN fearless TINYINT(1) DEFAULT 0'); } catch {}
await c.query("UPDATE tournaments SET fearless=1 WHERE id='lqc-2026'");
const [[t]] = await c.query("SELECT id, fearless FROM tournaments WHERE id='lqc-2026'");
console.log(t);
await c.end();
