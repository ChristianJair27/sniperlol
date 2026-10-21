// LQC 2026: fija (o quita) el número de rondas del suizo que usa el piloto
// automático.  node scripts/lqc-swiss-rounds.mjs <n|null>
//   n > ronda actual → al cerrarse la ronda vigente genera la siguiente (≤ 60 s).
//   n = ronda actual → al cerrarse genera los PLAYOFFS (Top playoffs_size).
//   null             → piloto en pausa: no genera nada solo.
import mysql from 'mysql2/promise';
import 'dotenv/config';
const arg = process.argv[2];
if (arg === undefined) { console.error('uso: node scripts/lqc-swiss-rounds.mjs <n|null>'); process.exit(1); }
const value = arg === 'null' ? null : Number(arg);
if (value !== null && !(Number.isInteger(value) && value > 0)) { console.error('valor inválido'); process.exit(1); }
const conn = await mysql.createConnection({ host: process.env.MYSQL_HOST, port: Number(process.env.MYSQL_PORT) || 3306, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB });
const [[row]] = await conn.query("SELECT swiss_rounds, fixed_schedule IS NOT NULL AS has_fixed FROM tournaments WHERE id='lqc-2026'");
await conn.query("UPDATE tournaments SET swiss_rounds = ? WHERE id='lqc-2026'", [value]);
console.log(`swiss_rounds: ${row.swiss_rounds} → ${value} (calendario fijo: ${row.has_fixed ? 'sí' : 'no'})`);
await conn.end();
