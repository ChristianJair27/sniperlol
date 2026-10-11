// LQC 2026: da de alta un jugador en la plantilla de un equipo.
//   node scripts/lqc-roster-add.mjs "<equipo>" "<GameName#TAG>" [--apply]
// Resuelve el puuid en la API de Riot (account-v1), lo añade al JSON `players`
// de tournament_registrations (source: manual, aceptado) y avisa si el equipo
// tiene una serie pendiente cuyo código habría que regenerar (la allowlist del
// código de torneo se fija al crearlo; una ronda nueva ya lo incluye sola).
import mysql from 'mysql2/promise';
import 'dotenv/config';

const TID = 'lqc-2026';
const [team, riotId] = process.argv.slice(2);
const apply = process.argv.includes('--apply');
if (!team || !riotId || !riotId.includes('#')) { console.error('uso: node scripts/lqc-roster-add.mjs "<equipo>" "<GameName#TAG>" [--apply]'); process.exit(1); }
const [gameName, tagLine] = riotId.split('#');

const res = await fetch(`https://americas.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, { headers: { 'X-Riot-Token': process.env.RIOT_API_KEY } });
if (!res.ok) { console.error(`Riot no encuentra ${riotId} (HTTP ${res.status})`); process.exit(2); }
const acc = await res.json();
const canonical = `${acc.gameName}#${acc.tagLine}`;

const conn = await mysql.createConnection({ host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB });
const [regs] = await conn.query('SELECT id, team_name, players FROM tournament_registrations WHERE tournament_id = ? AND team_name = ?', [TID, team]);
if (regs.length !== 1) { console.error(`equipo "${team}" no encontrado (${regs.length} coincidencias)`); await conn.end(); process.exit(3); }
const reg = regs[0];
const players = typeof reg.players === 'string' ? JSON.parse(reg.players) : (reg.players || []);
if (players.some((p) => p.puuid === acc.puuid)) { console.log(`${canonical} ya está en ${reg.team_name}`); await conn.end(); process.exit(0); }

const entry = { name: canonical, riotId: canonical, source: 'manual', inviteStatus: 'accepted', puuid: acc.puuid, addedAt: new Date().toISOString() };
console.log(`${reg.team_name}: ${players.length} jugadores → ${players.length + 1}; alta: ${canonical} (puuid ${acc.puuid.slice(0, 8)}…)`);

// Serie pendiente del equipo (su código no incluye al nuevo jugador).
const [[t]] = await conn.query('SELECT bracket FROM tournaments WHERE id = ?', [TID]);
const bracket = typeof t.bracket === 'string' ? JSON.parse(t.bracket) : (t.bracket || []);
const pending = bracket.filter((m) => (m.team1 === reg.team_name || m.team2 === reg.team_name) && m.matchStatus !== 'complete' && m.team1 && m.team2);
if (pending.length) console.log(`AVISO: serie(s) pendiente(s) con código ya generado: ${pending.map((m) => `${m.id} ${m.team1} vs ${m.team2}`).join(', ')} → regenerar código (patrón r2m1 del 12-sep).`);
else console.log('Sin series pendientes: la próxima ronda incluirá al jugador en la allowlist.');

if (apply) {
  await conn.query('UPDATE tournament_registrations SET players = ? WHERE id = ?', [JSON.stringify([...players, entry]), reg.id]);
  console.log('guardado');
} else console.log('(dry-run: añade --apply para guardar)');
await conn.end();
