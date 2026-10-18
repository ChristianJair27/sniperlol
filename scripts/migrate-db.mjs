// Migración de la base de ATAK.GG: Hostinger (origen, solo lectura) → MariaDB en Coolify (destino).
//   node scripts/migrate-db.mjs --phase small     # esquema + todas las tablas sin blobs (segundos)
//   node scripts/migrate-db.mjs --phase blobs     # tournament_clips / tournament_replays / social_media, fila a fila (GB)
//   node scripts/migrate-db.mjs --phase verify    # cuenta filas origen vs destino
// Origen: MYSQL_* del .env (Hostinger). Destino: DST_HOST/DST_PORT/DST_USER/DST_PASSWORD/DST_DB (env o .env.migrate).
// Reanudable: en blobs salta las filas cuya clave ya existe en destino.
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import 'dotenv/config';

const phase = (process.argv.find((a) => a.startsWith('--phase')) || '').split('=')[1] || process.argv[process.argv.indexOf('--phase') + 1] || 'small';
if (fs.existsSync('.env.migrate')) for (const l of fs.readFileSync('.env.migrate', 'utf8').split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, ''); }
const src = await mysql.createConnection({ host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB, supportBigNumbers: true, bigNumberStrings: true });
const dst = await mysql.createConnection({ host: process.env.DST_HOST, port: Number(process.env.DST_PORT) || 3306, user: process.env.DST_USER, password: process.env.DST_PASSWORD, database: process.env.DST_DB, supportBigNumbers: true, bigNumberStrings: true });
await dst.query('SET FOREIGN_KEY_CHECKS=0'); await dst.query('SET SESSION sql_mode=""');
const BLOB_TABLES = ['tournament_clips', 'tournament_replays', 'social_media'];
const [tabs] = await src.query('SHOW TABLES'); const tables = tabs.map((r) => Object.values(r)[0]);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// mysql2 convierte las columnas JSON en objetos: al reinsertar hay que volver a texto (si no, '[object Object]').
const norm = (v) => (v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date) ? JSON.stringify(v) : v);

async function ensureTable(t) {
  const [[row]] = await src.query(`SHOW CREATE TABLE \`${t}\``);
  const ddl = row['Create Table'];
  await dst.query(`CREATE TABLE IF NOT EXISTS \`${t}\` ${ddl.replace(/^CREATE TABLE `[^`]+`/, '')}`);
}
async function pk(t) { const [cols] = await src.query(`SHOW KEYS FROM \`${t}\` WHERE Key_name='PRIMARY'`); return cols.map((c) => c.Column_name); }
async function copySmall(t) {
  await ensureTable(t);
  const [rows] = await src.query(`SELECT * FROM \`${t}\``);
  if (!rows.length) { log(t, '0 filas'); return; }
  const cols = Object.keys(rows[0]);
  const chunk = 500;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    await dst.query(`REPLACE INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ?`, [part.map((r) => cols.map((c) => norm(r[c])))]);
  }
  log(t, rows.length, 'filas');
}
async function copyBlobs(t) {
  await ensureTable(t);
  const keys = await pk(t);
  const [ids] = await src.query(`SELECT ${keys.map((k) => `\`${k}\``).join(',')} FROM \`${t}\``);
  const [have] = await dst.query(`SELECT ${keys.map((k) => `\`${k}\``).join(',')} FROM \`${t}\``);
  const sig = (r) => keys.map((k) => String(r[k])).join('|');
  const done = new Set(have.map(sig));
  const todo = ids.filter((r) => !done.has(sig(r)));
  log(t, `${ids.length} filas, ${todo.length} por copiar`);
  let n = 0, bytes = 0;
  for (const id of todo) {
    const where = keys.map((k) => `\`${k}\` = ?`).join(' AND ');
    const [[row]] = await src.query(`SELECT * FROM \`${t}\` WHERE ${where}`, keys.map((k) => id[k]));
    if (!row) continue;
    const cols = Object.keys(row);
    await dst.query(`REPLACE INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => norm(row[c])));
    n++; bytes += Number(row.size) || 0;
    if (n % 10 === 0) log(t, `${n}/${todo.length}`, `${(bytes / 1048576).toFixed(0)} MB`);
  }
  log(t, 'listo', n, 'filas', `${(bytes / 1048576).toFixed(0)} MB`);
}
async function verify() {
  for (const t of tables) {
    const [[a]] = await src.query(`SELECT COUNT(*) n FROM \`${t}\``);
    let b = { n: 'sin tabla' }; try { [[b]] = await dst.query(`SELECT COUNT(*) n FROM \`${t}\``); } catch { /* */ }
    console.log(String(a.n).padStart(7), String(b.n).padStart(9), a.n == b.n ? 'ok ' : '≠  ', t);
  }
}

if (phase === 'small') { for (const t of tables) if (!BLOB_TABLES.includes(t)) await copySmall(t); for (const t of BLOB_TABLES) if (tables.includes(t)) await ensureTable(t); }
else if (phase === 'blobs') { for (const t of BLOB_TABLES) if (tables.includes(t)) await copyBlobs(t); }
else if (phase === 'verify') await verify();
else console.error('fase desconocida');
await src.end(); await dst.end();
