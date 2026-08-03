// SPRINT 0 — migración con reporte explícito (nada de errores silenciados)
import 'dotenv/config';
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});
const BENIGN = new Set(['ER_DUP_FIELDNAME', 'ER_DUP_KEYNAME', 'ER_TABLE_EXISTS_ERROR', 'ER_DUP_ENTRY']);
async function run(label, sql, params = []) {
  try {
    const [r] = await c.query(sql, params);
    console.log(`OK   ${label}`, r.affectedRows != null ? `(filas: ${r.affectedRows})` : '');
    return r;
  } catch (e) {
    console.log(`${BENIGN.has(e.code) ? 'SKIP' : 'FAIL'} ${label} → ${e.code}: ${e.message}`);
    if (!BENIGN.has(e.code)) throw e;
    return null;
  }
}

// ── Tarea 2: enum provider + backfill ────────────────────────────────────────
await run('users.provider enum + riot',
  "ALTER TABLE users MODIFY provider ENUM('local','google','riot') NOT NULL DEFAULT 'local'");
const [before] = await c.query("SELECT id, email FROM users WHERE provider='' OR provider IS NULL");
console.log(`users con provider vacío ANTES del backfill: ${before.length}`, before.map(u => u.id));
const bf = await run('backfill provider=riot (email sintético RSO)',
  "UPDATE users SET provider='riot' WHERE (provider='' OR provider IS NULL) AND email LIKE 'riot\\_%@rso.atak.gg'");
const [after] = await c.query("SELECT id, email, provider FROM users WHERE provider='' OR provider IS NULL");
console.log(`users con provider vacío DESPUÉS (ambiguos, NO tocados): ${after.length}`);
if (after.length) console.table(after);

// ── Tarea 1: organizer_status + quotas + log de denegados ────────────────────
await run('users.organizer_status',
  "ALTER TABLE users ADD COLUMN organizer_status ENUM('none','approved','suspended') NOT NULL DEFAULT 'none'");
await run('admins → approved',
  "UPDATE users SET organizer_status='approved' WHERE role='admin' AND organizer_status='none'");
await run('tournaments.codes_generated',
  'ALTER TABLE tournaments ADD COLUMN codes_generated INT NOT NULL DEFAULT 0');
await run('tabla access_denied_log', `
  CREATE TABLE IF NOT EXISTS access_denied_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NULL,
    endpoint VARCHAR(120) NOT NULL,
    reason VARCHAR(60) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY idx_user (user_id), KEY idx_when (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

// ── Tarea 3: callback_log ─────────────────────────────────────────────────────
await run('tabla callback_log', `
  CREATE TABLE IF NOT EXISTS callback_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    code VARCHAR(100) NULL,
    valid_key TINYINT(1) NOT NULL DEFAULT 0,
    payload LONGTEXT NULL,
    KEY idx_when (received_at), KEY idx_code (code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

// ── Verificación final ────────────────────────────────────────────────────────
const [[vu]] = await c.query("SELECT COUNT(*) total, SUM(provider='riot') riot, SUM(organizer_status='approved') approved FROM users");
console.log('\nVERIFICACIÓN users:', vu);
const [cols] = await c.query("SHOW COLUMNS FROM users LIKE 'provider'");
console.log('enum actual:', cols[0].Type);
await c.end();
