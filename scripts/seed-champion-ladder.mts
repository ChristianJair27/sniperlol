// Siembra el ladder de campeones con todos los jugadores que ATAK ya conoce:
// cuentas vinculadas, invocadores vistos en búsquedas y rosters de torneos.
// Re-ejecutable: el throttle de 24h del servicio evita refetches inútiles.
import { config } from 'dotenv';
config();
const { pool } = await import('../src/db.js');
const { upsertPlayerMastery } = await import('../src/services/champion-ladder.service.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Seed = { puuid: string; platform: string; gameName?: string; tagLine?: string };
const seeds = new Map<string, Seed>();
const add = (s: Seed) => { if (s.puuid && !seeds.has(s.puuid)) seeds.set(s.puuid, s); };

const [linked] = await pool.query<any[]>('SELECT puuid, platform, game_name, tag_line FROM user_riot_accounts');
for (const r of linked) add({ puuid: r.puuid, platform: r.platform || 'la1', gameName: r.game_name, tagLine: r.tag_line });

const [seen] = await pool.query<any[]>('SELECT puuid, platform, game_name, tag_line FROM seen_summoners');
for (const r of seen) add({ puuid: r.puuid, platform: r.platform || 'la1', gameName: r.game_name, tagLine: r.tag_line });

const [regs] = await pool.query<any[]>('SELECT tr.players, t.region FROM tournament_registrations tr JOIN tournaments t ON t.id = tr.tournament_id');
for (const r of regs) {
  const players = typeof r.players === 'string' ? JSON.parse(r.players) : (r.players || []);
  for (const p of players) {
    if (!p?.puuid) continue;
    const [gn, tl] = String(p.riotId || '').split('#');
    add({ puuid: p.puuid, platform: r.region || 'la1', gameName: gn, tagLine: tl });
  }
}

console.log(`Sembrando ladder con ${seeds.size} jugadores…`);
let ok = 0, fail = 0, i = 0;
for (const s of seeds.values()) {
  i++;
  try {
    await upsertPlayerMastery(s.platform, s.puuid, s.gameName, s.tagLine);
    ok++;
  } catch (e: any) {
    fail++;
    console.warn(`  [${i}] ${s.gameName ?? s.puuid.slice(0, 8)} falló: ${e?.message}`);
  }
  if (i % 10 === 0) console.log(`  ${i}/${seeds.size}…`);
  await sleep(350); // amable con el rate limit de Riot
}

const [[{ n }]] = await pool.query<any[]>('SELECT COUNT(*) n FROM mastery_snapshots');
const [[{ p }]] = await pool.query<any[]>('SELECT COUNT(*) p FROM players');
console.log(`Listo: ${ok} ok, ${fail} fallos → ${p} jugadores, ${n} filas de maestría en el ladder.`);
process.exit(0);
