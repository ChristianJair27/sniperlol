// Auditoría/reparación de la ronda 1 LQC 2026 (01-sep-2026).
// Recalcula el ganador de CADA juego registrado con la atribución corregida
// (lado ganador vs rosters) y compara con lo guardado. Con --apply repara:
// juegos faltantes, ganadores, marcador, estado de serie y standings.
import 'dotenv/config';
import { pool } from '../src/db.js';
import {
  detectAllGamesByCode, attributeGameWinner, fetchMatchData,
  buildMatchStatsResponse, saveMatchStats,
} from '../src/services/tournament-sync.service.js';
import { notifyDiscordSeriesDone } from '../src/services/discord.service.js';

const TID = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'lqc-2026';
const APPLY = process.argv.includes('--apply');
const pj = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);

const [[row]] = await pool.query<any[]>('SELECT * FROM tournaments WHERE id=?', [TID]);
const bracket: any[] = pj(row.bracket);
const standings: any[] = pj(row.standings);
const region = row.region || 'la1';

// Rosters por equipo (registro).
const [regs] = await pool.query<any[]>('SELECT team_name, players FROM tournament_registrations WHERE tournament_id=?', [TID]);
const roster = new Map<string, Set<string>>();
for (const r of regs) roster.set(r.team_name, new Set((pj(r.players) || []).map((p: any) => p.puuid).filter(Boolean)));
const teamSet = (m: any, side: 1 | 2) => new Set<string>([
  ...(roster.get(side === 1 ? m.team1 : m.team2) ?? []),
  ...((side === 1 ? m.team1Puuids : m.team2Puuids) ?? []),
]);

let changed = false;
for (const m of bracket) {
  if (!m.code || m.team1 === 'BYE' || m.team2 === 'BYE') continue;
  const codeGames = await detectAllGamesByCode(m.code, region);
  const t1 = teamSet(m, 1), t2 = teamSet(m, 2);
  const newGames: any[] = [];
  for (const g of codeGames) {
    const stored = (m.games || []).find((x: any) => x.gameId === g.gameId);
    let winner = attributeGameWinner(m, g.winPuuids ?? [], g.losePuuids ?? [], t1, t2);
    let platform = g.platform;
    if (!winner || !stored) {
      const fetched = await fetchMatchData(g.gameId, g.platform);
      if (!fetched?.data?.info?.gameEndTimestamp) { console.log(`  ${m.id} juego ${g.gameId}: sin Match-V5 aún`); if (stored) newGames.push(stored); continue; }
      platform = fetched.platform;
      if (!winner) {
        const parts: any[] = fetched.data.info.participants;
        winner = attributeGameWinner(m, parts.filter(p => p.win).map(p => p.puuid), parts.filter(p => !p.win).map(p => p.puuid), t1, t2);
      }
      if (!stored && APPLY) {
        const mid = `${platform.toUpperCase()}_${g.gameId}`;
        await saveMatchStats(TID, m.id, mid, g.gameId, buildMatchStatsResponse(fetched.data, mid, true), fetched.data.info.gameDuration, fetched.data.info.gameEndTimestamp);
      }
    }
    const tag = !stored ? 'FALTABA' : stored.winner === winner ? 'ok' : `MAL (guardado: ${stored.winner})`;
    console.log(`${m.id} ${m.team1} vs ${m.team2} · juego ${g.gameId} → ${winner ?? 'AMBIGUO'} [${tag}]`);
    newGames.push({ gameId: g.gameId, gameRegion: platform, winner, ...(winner ? {} : { ambiguous: true }) });
  }
  // Filas de stats que NO son juegos del código (flex enlazadas por "auto-detectar").
  const [stale] = await pool.query<any[]>('SELECT game_id FROM tournament_match_stats WHERE tournament_id=? AND bracket_match_id=?', [TID, m.id]);
  const codeIds = new Set(codeGames.map(g => g.gameId));
  const staleIds = stale.map((r: any) => Number(r.game_id)).filter(gid => !codeIds.has(gid));
  if (staleIds.length && codeGames.length) {
    console.log(`  stats ajenas al código en ${m.id}: ${staleIds.join(', ')} → ${APPLY ? 'ELIMINADAS' : 'se eliminarían'}`);
    if (APPLY) await pool.query('DELETE FROM tournament_match_stats WHERE tournament_id=? AND bracket_match_id=? AND game_id IN (?)', [TID, m.id, staleIds]);
  }
  const s1 = newGames.filter(g => g.winner === m.team1).length;
  const s2 = newGames.filter(g => g.winner === m.team2).length;
  const to = m.seriesTo || 1;
  const seriesWinner = s1 >= to ? m.team1 : s2 >= to ? m.team2 : null;
  const status = seriesWinner ? 'complete' : (m.matchStatus === 'complete' ? 'active' : m.matchStatus);
  const same = JSON.stringify(newGames) === JSON.stringify(m.games || []) && m.score1 === s1 && m.score2 === s2 && (m.winner ?? null) === seriesWinner && m.matchStatus === status;
  if (newGames.length) console.log(`  → serie ${s1}-${s2}${seriesWinner ? ` · gana ${seriesWinner}` : ''} ${same ? '(sin cambios)' : '(SE CORRIGE)'}`);
  if (!same && !m.forfeit) {
    changed = true;
    const wasWinner = m.winner;
    m.games = newGames; m.score1 = s1; m.score2 = s2; m.winner = seriesWinner; m.matchStatus = status;
    m.needsManualResult = newGames.some(g => g.ambiguous);
    if (newGames.length) { m.gameId = newGames[newGames.length - 1].gameId; m.gameRegion = newGames[newGames.length - 1].gameRegion; }
    if (APPLY && seriesWinner && wasWinner !== seriesWinner) {
      notifyDiscordSeriesDone(row.discord_webhook_url, {
        tournamentId: TID, tournamentName: row.name, winner: seriesWinner,
        loser: seriesWinner === m.team1 ? m.team2 : m.team1, score1: s1, score2: s2, forfeit: false,
      });
    }
  }
}

// Standings desde cero a partir del bracket (BYE cuenta como victoria).
const order = new Map(standings.map((s: any, i: number) => [s.team, i]));
const fresh = standings.map((s: any) => ({ ...s, wins: 0, losses: 0, points: 0 }));
for (const m of bracket) {
  if (m.matchStatus !== 'complete' || !m.winner) continue;
  const loser = m.winner === m.team1 ? m.team2 : m.team1;
  for (const s of fresh) {
    if (s.team === m.winner) { s.wins++; s.points += 3; }
    else if (s.team === loser) s.losses++;
  }
}
fresh.sort((a, b) => b.points - a.points || b.wins - a.wins || a.losses - b.losses || (order.get(a.team)! - order.get(b.team)!));
fresh.forEach((s, i) => (s.position = i + 1));
const stDiff = fresh.filter(s => { const o = standings.find((x: any) => x.team === s.team); return o.wins !== s.wins || o.losses !== s.losses || o.points !== s.points; });
if (stDiff.length) { changed = true; console.log('\nStandings a corregir:', stDiff.map(s => `${s.team} ${s.wins}W-${s.losses}L ${s.points}pts`).join(' · ')); }

if (APPLY && changed) {
  await pool.query('UPDATE tournaments SET bracket=?, standings=? WHERE id=?', [JSON.stringify(bracket), JSON.stringify(fresh), TID]);
  console.log('\n✔ Bracket y standings guardados.');
} else if (!changed) console.log('\nNada que corregir.');
else console.log('\n(dry-run: agrega --apply para guardar)');
await pool.end();
