// Ranking de campeones estilo League of Graphs, versión ATAK: posición por
// puntos de maestría dentro de NUESTRA base (regional y global). LoG saca su
// "#719 de LAN" de una base crawleada por años — ninguna API pública la da.
// Nuestro ladder arranca sembrado con la comunidad (cuentas vinculadas,
// rosters LQC, invocadores vistos) y crece solo: cada visita a un perfil
// refresca la maestría de ese jugador (throttle 24h).
import { pool } from '../db.js';
import { getChampionMasteriesByPUUID } from './riot.js';

const REFRESH_MS = 24 * 3600_000;

let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      game_name VARCHAR(60), tag_line VARCHAR(12),
      platform VARCHAR(8) NOT NULL,
      puuid VARCHAR(100) NOT NULL,
      summoner_id VARCHAR(80),
      last_refresh TIMESTAMP NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mastery_snapshots (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      player_id BIGINT UNSIGNED NOT NULL,
      champion_id INT NOT NULL,
      points INT NOT NULL,
      level TINYINT NOT NULL,
      last_played BIGINT,
      ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // Claves para upsert + rankings rápidos (benignos si ya existen).
  for (const ddl of [
    'ALTER TABLE players ADD UNIQUE KEY uniq_puuid (puuid)',
    'ALTER TABLE mastery_snapshots ADD UNIQUE KEY uniq_player_champ (player_id, champion_id)',
    'ALTER TABLE mastery_snapshots ADD INDEX idx_champ_points (champion_id, points)',
  ]) {
    try { await pool.query(ddl); }
    catch (e: any) { if (!['ER_DUP_KEYNAME', 'ER_DUP_FIELDNAME'].includes(e.code)) throw e; }
  }
  schemaReady = true;
}

/**
 * Refresca la maestría de un jugador en el ladder (best-effort, throttled).
 * Se llama en cada visita a un perfil — así crece la base sola.
 */
export async function upsertPlayerMastery(
  platform: string, puuid: string, gameName?: string, tagLine?: string
): Promise<void> {
  await ensureSchema();
  const pf = String(platform || 'la1').toLowerCase();

  const [[existing]] = await pool.query<any[]>(
    'SELECT id, last_refresh FROM players WHERE puuid = ?', [puuid]
  );
  if (existing?.last_refresh && Date.now() - new Date(existing.last_refresh).getTime() < REFRESH_MS) {
    return; // fresco: no quemar rate limit de Riot
  }

  const mastery = await getChampionMasteriesByPUUID(pf, puuid);
  if (!Array.isArray(mastery) || !mastery.length) return;

  let playerId = existing?.id;
  if (playerId) {
    await pool.query(
      'UPDATE players SET game_name=COALESCE(?, game_name), tag_line=COALESCE(?, tag_line), platform=?, last_refresh=NOW() WHERE id=?',
      [gameName ?? null, tagLine ?? null, pf, playerId]
    );
  } else {
    const [ins] = await pool.query<any>(
      'INSERT INTO players (game_name, tag_line, platform, puuid, last_refresh) VALUES (?,?,?,?,NOW())',
      [gameName ?? null, tagLine ?? null, pf, puuid]
    );
    playerId = ins.insertId;
  }

  // Upsert por lotes de la maestría actual (una fila por campeón).
  const values: any[] = [];
  for (const m of mastery) {
    const cid = Number(m.championId);
    const pts = Number(m.championPoints);
    if (!Number.isFinite(cid) || !Number.isFinite(pts)) continue;
    values.push([playerId, cid, pts, Number(m.championLevel) || 0, Number(m.lastPlayTime) || null]);
  }
  if (!values.length) return;
  await pool.query(
    `INSERT INTO mastery_snapshots (player_id, champion_id, points, level, last_played)
     VALUES ? ON DUPLICATE KEY UPDATE
       points=VALUES(points), level=VALUES(level), last_played=VALUES(last_played)`,
    [values]
  );
}

export interface ChampionRank {
  championId: number;
  points: number;
  level: number;
  regionRank: number; regionTotal: number;
  globalRank: number; globalTotal: number;
}

/** Rankings del jugador con cada campeón: posición regional y global en ATAK. */
export async function getChampionRanks(platform: string, puuid: string): Promise<ChampionRank[]> {
  await ensureSchema();
  const pf = String(platform || 'la1').toLowerCase();
  const [rows] = await pool.query<any[]>(
    `SELECT m.champion_id, m.points, m.level,
       (SELECT COUNT(*) + 1 FROM mastery_snapshots m2
          JOIN players p2 ON p2.id = m2.player_id
         WHERE m2.champion_id = m.champion_id AND p2.platform = ? AND m2.points > m.points) AS regionRank,
       (SELECT COUNT(*) FROM mastery_snapshots m2
          JOIN players p2 ON p2.id = m2.player_id
         WHERE m2.champion_id = m.champion_id AND p2.platform = ?) AS regionTotal,
       (SELECT COUNT(*) + 1 FROM mastery_snapshots m2
         WHERE m2.champion_id = m.champion_id AND m2.points > m.points) AS globalRank,
       (SELECT COUNT(*) FROM mastery_snapshots m2
         WHERE m2.champion_id = m.champion_id) AS globalTotal
     FROM mastery_snapshots m
     JOIN players p ON p.id = m.player_id
     WHERE p.puuid = ?
     ORDER BY m.points DESC`,
    [pf, pf, puuid]
  );
  return rows.map(r => ({
    championId: Number(r.champion_id),
    points: Number(r.points),
    level: Number(r.level),
    regionRank: Number(r.regionRank), regionTotal: Number(r.regionTotal),
    globalRank: Number(r.globalRank), globalTotal: Number(r.globalTotal),
  }));
}
