// Verificación de solo lectura: por cada juego de cada serie, lados según roster,
// ganador real (Match-V5), comparación con lo guardado, marcador y standings.
import 'dotenv/config';
import { pool } from '../src/db.js';
import { getMatchById } from '../src/services/riot.js';
import { getGamesByCode } from '../src/services/riot-tournament.service.js';
const TID = process.argv[2] || 'lqc-2026';
const pj = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
const [[row]] = await pool.query<any[]>('SELECT bracket, standings FROM tournaments WHERE id=?', [TID]);
const bracket: any[] = pj(row.bracket), standings: any[] = pj(row.standings);
const [regs] = await pool.query<any[]>('SELECT team_name, players FROM tournament_registrations WHERE tournament_id=?', [TID]);
const teamOf = new Map<string, string>();
for (const r of regs) for (const p of pj(r.players) || []) if (p.puuid) teamOf.set(p.puuid, r.team_name);
let problems = 0;
for (const m of bracket) {
  if (m.team2 === 'BYE' || m.team1 === 'BYE') { console.log(`\n${m.id} ${m.team1} vs BYE → ${m.winner} [${m.matchStatus}]`); continue; }
  console.log(`\n══ ${m.id}  ${m.team1} (T1) vs ${m.team2} (T2)  guardado ${m.score1}-${m.score2} · ${m.matchStatus}${m.winner ? ' · gana ' + m.winner : ''}`);
  const codeGames = m.code ? await getGamesByCode(m.code) : [];
  const codeIds = codeGames.map((g: any) => Number(g.gameId)).sort((a, b) => a - b);
  const storedIds = (m.games || []).map((g: any) => Number(g.gameId));
  if (JSON.stringify(codeIds) !== JSON.stringify([...storedIds].sort((a, b) => a - b))) { problems++; console.log(`  ✗ juegos del código ${codeIds} ≠ guardados ${storedIds}`); }
  let s1 = 0, s2 = 0, n = 0;
  for (const gid of storedIds) {
    n++;
    const stored = m.games.find((g: any) => Number(g.gameId) === gid);
    const info = (await getMatchById('la1', `LA1_${gid}`))?.info;
    if (!info) { problems++; console.log(`  juego ${n} (${gid}): ✗ sin Match-V5`); continue; }
    const side = (id: number) => info.participants.filter((p: any) => p.teamId === id);
    const label = (ps: any[]) => {
      const c: Record<string, number> = {};
      for (const p of ps) { const t = teamOf.get(p.puuid) ?? '?'; c[t] = (c[t] || 0) + 1; }
      return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([t, k]) => `${t}×${k}`).join(' + ');
    };
    const blue = side(100), red = side(200);
    const teamOn = (ps: any[]) => { const known = ps.map(p => teamOf.get(p.puuid)).filter(t => t === m.team1 || t === m.team2); return known.length ? known[0] : null; };
    const blueTeam = teamOn(blue), redTeam = teamOn(red);
    const winSide = info.teams.find((t: any) => t.win)?.teamId;
    const realWinner = winSide === 100 ? blueTeam : redTeam;
    const mixed = new Set(blue.map(p => teamOf.get(p.puuid)).filter(t => t === m.team1 || t === m.team2)).size > 1
      || new Set(red.map(p => teamOf.get(p.puuid)).filter(t => t === m.team1 || t === m.team2)).size > 1;
    const codeOk = !info.tournamentCode || info.tournamentCode === m.code;
    const ok = stored.winner === realWinner && !mixed && codeOk && info.gameType === 'CUSTOM_GAME';
    if (!ok) problems++;
    console.log(`  juego ${n} (${gid}) ${new Date(info.gameStartTimestamp).toISOString().slice(0, 16)}Z ${info.gameType}${codeOk ? '' : ' ✗CÓDIGO AJENO'}`);
    console.log(`     azul: ${label(blue)}   |   rojo: ${label(red)}${mixed ? '   ✗ LADOS MEZCLADOS' : ''}`);
    console.log(`     gana lado ${winSide === 100 ? 'azul' : 'rojo'} = ${realWinner ?? '?'}   guardado: ${stored.winner}   ${ok ? '✓' : '✗'}`);
    const unknown = info.participants.filter((p: any) => !teamOf.has(p.puuid)).map((p: any) => `${p.riotIdGameName}#${p.riotIdTagline} (lado ${p.teamId === 100 ? 'azul' : 'rojo'})`);
    if (unknown.length) console.log(`     no registrados: ${unknown.join(', ')}`);
    if (realWinner === m.team1) s1++; else if (realWinner === m.team2) s2++;
  }
  const to = m.seriesTo || 1;
  const expWinner = s1 >= to ? m.team1 : s2 >= to ? m.team2 : null;
  const scoreOk = s1 === (m.score1 ?? 0) && s2 === (m.score2 ?? 0) && (m.winner ?? null) === expWinner && (expWinner ? m.matchStatus === 'complete' : m.matchStatus !== 'complete');
  if (!scoreOk) problems++;
  console.log(`  marcador real ${s1}-${s2}${expWinner ? ' · gana ' + expWinner : ''}  ${scoreOk ? '✓' : '✗ NO COINCIDE'}`);
  const [stats] = await pool.query<any[]>('SELECT game_id FROM tournament_match_stats WHERE tournament_id=? AND bracket_match_id=?', [TID, m.id]);
  const extra = stats.map((s: any) => Number(s.game_id)).filter(g => !storedIds.includes(g));
  const missing = storedIds.filter(g => !stats.some((s: any) => Number(s.game_id) === g));
  if (extra.length || missing.length) { problems++; console.log(`  ✗ stats: sobran ${extra} faltan ${missing}`); }
}
console.log('\n══ Standings');
const exp = new Map<string, { w: number; l: number }>();
for (const s of standings) exp.set(s.team, { w: 0, l: 0 });
for (const m of bracket) if (m.matchStatus === 'complete' && m.winner) { exp.get(m.winner)!.w++; const l = m.winner === m.team1 ? m.team2 : m.team1; if (exp.has(l)) exp.get(l)!.l++; }
for (const s of standings) { const e = exp.get(s.team)!; const ok = e.w === s.wins && e.l === s.losses && s.points === e.w * 3; if (!ok) problems++; console.log(`  ${String(s.position).padStart(2)}. ${s.team.padEnd(22)} ${s.wins}-${s.losses} ${s.points}pts ${ok ? '✓' : `✗ esperado ${e.w}-${e.l}`}`); }
console.log(`\n${problems ? `✗ ${problems} problema(s)` : '✓ TODO CUADRA'}`);
await pool.end();
