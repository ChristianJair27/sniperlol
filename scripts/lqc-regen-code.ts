// LQC: regenera el código de torneo de una serie pendiente (p.ej. tras dar de alta a un
// jugador: la allowlist del código se fija al crearlo). El código viejo queda en
// prevCodes, así el sync sigue encontrando juegos que se hayan jugado con él.
//   npx tsx scripts/lqc-regen-code.ts r8m4 [--apply]
// Usa la misma lógica que el backend (assignCodeToMatch: allowlist de ambos rosters +
// metadata {tId, mId}) y avisa por correo/Discord igual que cuando se activa una serie.
import 'dotenv/config';
import { getT, assignCodeToMatch } from '../src/routes/tournaments.routes.js';
import { pool } from '../src/db.js';

const TID = 'lqc-2026';
const [matchId] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const apply = process.argv.includes('--apply');
if (!matchId) { console.error('uso: npx tsx scripts/lqc-regen-code.ts <matchId> [--apply]'); process.exit(1); }

const t = await getT(TID);
if (!t?.bracket) { console.error('torneo sin bracket'); process.exit(2); }
const mi = t.bracket.findIndex((m) => m.id === matchId);
if (mi < 0) { console.error(`serie ${matchId} no encontrada`); process.exit(3); }
const m = t.bracket[mi];
console.log(`${m.id} ${m.team1} vs ${m.team2} · ${m.matchStatus} · juegos ${(m.games || []).length} · código actual ${m.code ? m.code.slice(0, 14) + '…' : 'ninguno'}`);
if (m.matchStatus === 'complete') { console.error('la serie ya terminó'); process.exit(4); }
if (!apply) { console.log('(dry-run: añade --apply para regenerar)'); await pool.end(); process.exit(0); }

const old = m.code;
if (old) m.prevCodes = [...new Set([...(m.prevCodes || []), old])];
const code = await assignCodeToMatch(t, mi);
if (!code) { console.error('Riot no devolvió código'); await pool.end(); process.exit(5); }
await pool.query('UPDATE tournaments SET bracket = ? WHERE id = ?', [JSON.stringify(t.bracket), TID]);
console.log(`nuevo código ${code} · allowlist ${m.team1Puuids?.length ?? 0} + ${m.team2Puuids?.length ?? 0} puuids · viejo guardado en prevCodes`);
await pool.end();
