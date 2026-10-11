// LQC: encuentra el puuid y el Riot ID actual de un jugador que se renombró,
// buscando su nombre viejo entre los participantes de partidas recientes de sus
// compañeros de equipo (Match-V5 guarda riotIdGameName/riotIdTagline de la fecha).
//   node scripts/lqc-find-renamed.mjs "<equipo>" "<NombreViejo>" "<tagViejo>" [partidasPorJugador=30]
import mysql from 'mysql2/promise';
import 'dotenv/config';
const [team, oldName, oldTag, perArg] = process.argv.slice(2);
const per = Number(perArg) || 30;
const H = { 'X-Riot-Token': process.env.RIOT_API_KEY };
const api = async (url) => { const r = await fetch(url, { headers: H }); if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500)); return api(url); } return r.ok ? r.json() : null; };
const conn = await mysql.createConnection({ host: process.env.MYSQL_HOST, user: process.env.MYSQL_USER, password: process.env.MYSQL_PASSWORD, database: process.env.MYSQL_DB });
const [[reg]] = await conn.query("SELECT players FROM tournament_registrations WHERE tournament_id='lqc-2026' AND team_name=?", [team]);
await conn.end();
const mates = (typeof reg.players === 'string' ? JSON.parse(reg.players) : reg.players).filter((p) => p.puuid);
const ids = new Set();
for (const m of mates) { const l = await api(`https://americas.api.riotgames.com/lol/match/v5/matches/by-puuid/${m.puuid}/ids?count=${per}`); for (const id of l || []) ids.add(id); }
console.log(`${mates.length} compañeros, ${ids.size} partidas distintas`);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const hits = new Map();
let n = 0;
for (const id of ids) {
  const m = await api(`https://americas.api.riotgames.com/lol/match/v5/matches/${id}`); n++;
  for (const p of m?.info?.participants || []) {
    if (norm(p.riotIdGameName) === norm(oldName) && (!oldTag || norm(p.riotIdTagline) === norm(oldTag))) {
      const h = hits.get(p.puuid) || { puuid: p.puuid, games: 0, last: 0, mode: new Set() };
      h.games++; h.last = Math.max(h.last, m.info.gameCreation); h.mode.add(m.info.gameMode); hits.set(p.puuid, h);
    }
  }
}
console.log(`${n} partidas revisadas`);
for (const h of hits.values()) {
  const acc = await api(`https://americas.api.riotgames.com/riot/account/v1/accounts/by-puuid/${h.puuid}`);
  console.log(`puuid ${h.puuid} · ${h.games} partidas con el nombre viejo · última ${new Date(h.last).toISOString().slice(0, 10)} · ahora: ${acc ? `${acc.gameName}#${acc.tagLine}` : '?'}`);
}
if (!hits.size) console.log('sin coincidencias: subir partidasPorJugador o revisar el nombre');
