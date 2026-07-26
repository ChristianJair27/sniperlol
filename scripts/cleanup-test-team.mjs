// Borra el equipo de prueba del webhook en lqc-2026 (one-off)
import 'dotenv/config';
import mysql from 'mysql2/promise';
const c = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});
const [r] = await c.query("DELETE FROM tournament_registrations WHERE tournament_id='lqc-2026' AND team_name='__TEST_WEBHOOK__'");
await c.query("UPDATE tournaments SET participants=GREATEST(0,participants-?) WHERE id='lqc-2026'", [r.affectedRows]);
const [[t]] = await c.query("SELECT participants FROM tournaments WHERE id='lqc-2026'");
console.log('borrados:', r.affectedRows, '| participants lqc-2026:', t.participants);
await c.end();
