// Deja visible SOLO lqc-2026 (one-off)
import 'dotenv/config';
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});
const [r] = await c.query("UPDATE tournaments SET hidden=1 WHERE id <> 'lqc-2026'");
console.log('ocultos:', r.affectedRows);
const [list] = await c.query('SELECT id, COALESCE(hidden,0) AS hidden FROM tournaments');
console.table(list);
await c.end();
