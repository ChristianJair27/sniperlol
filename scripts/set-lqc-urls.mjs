import 'dotenv/config';
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});
for (const sql of [
  "ALTER TABLE tournaments ADD COLUMN registration_url VARCHAR(500)",
  "ALTER TABLE tournaments ADD COLUMN rules_url VARCHAR(500)",
]) { try { await c.query(sql); console.log('col creada'); } catch (e) { console.log('skip:', e.code); } }
await c.query(`UPDATE tournaments SET
  registration_url='https://lqc.revolution505.com/registro',
  rules_url='/docs/reglamento-lqc.pdf'
  WHERE id='lqc-2026'`);
const [[t]] = await c.query("SELECT id, registration_url, rules_url FROM tournaments WHERE id='lqc-2026'");
console.log(t);
await c.end();
