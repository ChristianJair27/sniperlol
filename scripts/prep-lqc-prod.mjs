// Preparación de PROD para la LQC (one-off, idempotente):
//  1. Columna `hidden` en tournaments
//  2. Oculta los 4 torneos de prueba
//  3. Crea el torneo limpio `lqc-2026` (si no existe) con Christian como owner
// Uso: node scripts/prep-lqc-prod.mjs
import 'dotenv/config';
import mysql from 'mysql2/promise';

const pool = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});

// 1) columna hidden
try { await pool.query('ALTER TABLE tournaments ADD COLUMN hidden TINYINT(1) DEFAULT 0'); console.log('columna hidden creada'); }
catch (e) { console.log('columna hidden:', e.code === 'ER_DUP_FIELDNAME' ? 'ya existía' : e.message); }

// 2) ocultar pruebas
const TEST_IDS = ['hola-1782358778133', 'prueba-1775360288035', 'prueba-2-1780808822699', 'pruebaaa-1780642164173'];
const [r] = await pool.query('UPDATE tournaments SET hidden=1 WHERE id IN (?)', [TEST_IDS]);
console.log(`ocultos: ${r.affectedRows} torneos de prueba`);

// 3) owner (Christian) — para que el Panel del Organizador aparezca en su cuenta
let ownerId = null;
try {
  const [[u]] = await pool.query("SELECT id FROM users WHERE email='christianjair27@gmail.com'");
  ownerId = u?.id ?? null;
  console.log('owner userId:', ownerId);
} catch (e) { console.log('users lookup:', e.message); }

// 4) torneo LQC limpio
const [[exists]] = await pool.query("SELECT id FROM tournaments WHERE id='lqc-2026'");
if (exists) console.log('lqc-2026 ya existe — sin cambios');
else {
  await pool.query(
    `INSERT INTO tournaments (id, name, phase, participants, max_participants, prize, start_date, format, description, code_pool, created_by)
     VALUES ('lqc-2026', 'LQC 2026', 'registration', 0, 32, 'Por definir', '2026-08-15',
             '5v5 Single Elimination', 'Liga Queretana — clasificatorio oficial 2026. Inscripciones vía lqc.revolution505.com.',
             '[]', ?)`, [ownerId]);
  console.log('torneo lqc-2026 creado');
}
const [list] = await pool.query('SELECT id, name, phase, COALESCE(hidden,0) AS hidden FROM tournaments ORDER BY created_at DESC');
console.table(list);
await pool.end();
