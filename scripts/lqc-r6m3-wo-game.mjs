// LQC 2026 · r6m3 2 DOPE vs Requiem → cierra la serie 2-1 para 2 DOPE (6-oct-2026).
// Christian pidió aplicarlo ("aplícalo") tras el reporte de 2 DOPE aceptado por
// la organización de la LQC: Requiem llegó 50 min tarde → un juego perdido por
// W.O. (regla de 30 min); luego Requiem ganó el primer juego jugado y 2 DOPE el
// segundo. En ATAK.GG la serie quedó 1-1 con los dos juegos reales vinculados y
// espera un tercer juego que no existe. Hace lo que haría applyResult (ganador,
// estado, marcador, tabla +1/+3) directo en la base; los juegos se conservan.
// NO toca swiss_rounds (sigue en pausa hasta que Christian fije las rondas).
//
//   node scripts/lqc-r6m3-wo-game.mjs           → solo muestra lo que haría
//   node scripts/lqc-r6m3-wo-game.mjs --apply   → lo aplica (deja respaldo en JSON)
import mysql from 'mysql2/promise';
import fs from 'fs';
import 'dotenv/config';

const APPLY = process.argv.includes('--apply');
const TID = 'lqc-2026', MID = 'r6m3', WINNER = '2 DOPE', LOSER = 'Requiem';
const SCORE = { [WINNER]: 2, [LOSER]: 1 };
const BACKUP = process.env.BACKUP_FILE || 'lqc-r6m3-backup.json';

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB,
});
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

try {
  await conn.beginTransaction();
  const [[row]] = await conn.query(
    'SELECT phase, bracket, standings, swiss_rounds FROM tournaments WHERE id = ? FOR UPDATE', [TID]);
  if (!row) throw new Error('torneo no encontrado');
  const bracket = parse(row.bracket), standings = parse(row.standings);
  const mi = bracket.findIndex((m) => m.id === MID);
  const m = bracket[mi];

  // Solo se toca si la serie está exactamente como se espera (1-1, abierta).
  if (row.phase !== 'active') throw new Error(`torneo en fase ${row.phase}`);
  if (!m) throw new Error('partido no encontrado');
  if (m.team1 !== WINNER || m.team2 !== LOSER) throw new Error(`equipos inesperados: ${m.team1} vs ${m.team2}`);
  if (m.matchStatus === 'complete') throw new Error('la serie ya está cerrada');
  if (Number(m.score1) !== 1 || Number(m.score2) !== 1) throw new Error(`marcador inesperado ${m.score1}-${m.score2} (se esperaba 1-1)`);
  if (bracket.some((x) => x.stage === 'playoffs')) throw new Error('ya hay playoffs generados');
  if (!standings.some((s) => s.team === WINNER) || !standings.some((s) => s.team === LOSER)) throw new Error('equipos no están en la tabla');

  console.log('antes  :', { status: m.matchStatus, winner: m.winner, score: `${m.score1}-${m.score2}`, games: (m.games || []).map((g) => `${g.gameId}:${g.winner}`), swiss_rounds: row.swiss_rounds });

  bracket[mi] = {
    ...m, winner: WINNER, matchStatus: 'complete',
    score1: SCORE[m.team1], score2: SCORE[m.team2],
    // Un juego por W.O. (retraso de Requiem); los dos juegos reales siguen vinculados.
    forfeitGame: { team: LOSER, reason: 'retraso de 50 min (regla de 30 min)', reportedAt: new Date().toISOString() },
    needsManualResult: false,
  };
  const next = standings
    .map((s) => (s.team === WINNER ? { ...s, wins: s.wins + 1, points: s.points + 3 }
      : s.team === LOSER ? { ...s, losses: s.losses + 1 } : s))
    .sort((a, b) => b.points - a.points)
    .map((s, i) => ({ ...s, position: i + 1 }));

  const d = bracket[mi];
  console.log('después:', { status: d.matchStatus, winner: d.winner, score: `${d.score1}-${d.score2}`, swiss_rounds: row.swiss_rounds });
  console.log('tabla  :', next.slice(0, 12).map((s) => `${s.position}. ${s.team} ${s.wins}-${s.losses}`).join(' | '));
  const pending = bracket.filter((x) => x.round === m.round && x.matchStatus !== 'complete').map((x) => `${x.id} ${x.score1 ?? 0}-${x.score2 ?? 0}`);
  console.log('pendientes en la ronda', m.round, ':', pending.length ? pending.join(', ') : 'ninguno');

  if (!APPLY) {
    await conn.rollback();
    console.log('\n(simulación: nada se escribió; usa --apply)');
  } else {
    fs.writeFileSync(BACKUP, JSON.stringify({ at: new Date().toISOString(), match: m, standings }, null, 2));
    await conn.query('UPDATE tournaments SET bracket = ?, standings = ? WHERE id = ?',
      [JSON.stringify(bracket), JSON.stringify(next), TID]);
    await conn.commit();
    console.log(`\nAPLICADO. Respaldo del estado anterior en ${BACKUP}`);
  }
} catch (e) {
  await conn.rollback().catch(() => {});
  console.error('ABORTADO:', e.message);
  process.exitCode = 1;
} finally {
  await conn.end();
}
