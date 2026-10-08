// src/routes/social.routes.ts — Social feed backed by MySQL
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { requireAuth } from '../middlewares/requireAuth.js';

const router = Router();

// ─── Auto-create tables ───────────────────────────────────────────────────────
async function initTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      user_id      INT NOT NULL,
      user_name    VARCHAR(100) NOT NULL,
      content      TEXT NOT NULL,
      tag          VARCHAR(50) DEFAULT 'general',
      likes_count  INT DEFAULT 0,
      comments_count INT DEFAULT 0,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_likes (
      post_id  INT NOT NULL,
      user_id  INT NOT NULL,
      PRIMARY KEY (post_id, user_id)
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS social_comments (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      post_id    INT NOT NULL,
      user_id    INT NOT NULL,
      user_name  VARCHAR(100) NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_post (post_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}
async function extendTables() {
  // Publicaciones de clips (highlights del torneo) y reposts.
  const cols = [
    "ADD COLUMN IF NOT EXISTS kind VARCHAR(16) NOT NULL DEFAULT 'text'",
    'ADD COLUMN IF NOT EXISTS tournament_id VARCHAR(64) DEFAULT NULL',
    'ADD COLUMN IF NOT EXISTS clip_region VARCHAR(8) DEFAULT NULL',
    'ADD COLUMN IF NOT EXISTS clip_game_id BIGINT DEFAULT NULL',
    'ADD COLUMN IF NOT EXISTS clip_key VARCHAR(64) DEFAULT NULL',
    'ADD COLUMN IF NOT EXISTS media_url VARCHAR(500) DEFAULT NULL',
    'ADD COLUMN IF NOT EXISTS title VARCHAR(200) DEFAULT NULL',
    'ADD COLUMN IF NOT EXISTS meta_json TEXT DEFAULT NULL',
    'ADD COLUMN IF NOT EXISTS repost_of INT DEFAULT NULL',
    'ADD COLUMN IF NOT EXISTS reposts_count INT NOT NULL DEFAULT 0',
  ];
  for (const c of cols) await pool.query(`ALTER TABLE social_posts ${c}`);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_posts_tournament ON social_posts (tournament_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_posts_repost ON social_posts (repost_of)');
  await pool.query(`CREATE TABLE IF NOT EXISTS social_reposts (post_id INT NOT NULL, user_id INT NOT NULL, repost_id INT NOT NULL, PRIMARY KEY (post_id, user_id)) ENGINE=InnoDB`);
}
initTables().then(extendTables).catch(err => console.error('[social] initTables error:', err.message));

/** Publicación automática de un clip (la crea el backend al recibir el MP4 del render). */
export async function upsertClipPost(c: { tournamentId: string; tournamentName?: string; region: string; gameId: number; key: string; title: string; mediaUrl: string; meta: any }) {
  const [[existing]] = await pool.query<any[]>('SELECT id FROM social_posts WHERE kind = ? AND clip_region = ? AND clip_game_id = ? AND clip_key = ?', ['clip', c.region, c.gameId, c.key]);
  const content = `${c.title} · ${c.meta?.team1 ?? ''} vs ${c.meta?.team2 ?? ''}${c.meta?.round ? ` · Ronda ${c.meta.round}` : ''}${c.meta?.gameNumber ? ` · Juego ${c.meta.gameNumber}` : ''}`.slice(0, 280);
  if (existing) {
    await pool.query('UPDATE social_posts SET title = ?, media_url = ?, meta_json = ?, content = ? WHERE id = ?', [c.title.slice(0, 200), c.mediaUrl, JSON.stringify(c.meta || {}), content, existing.id]);
    return existing.id as number;
  }
  const [r] = await pool.query<any>(
    `INSERT INTO social_posts (user_id, user_name, content, tag, kind, tournament_id, clip_region, clip_game_id, clip_key, media_url, title, meta_json)
     VALUES (0, ?, ?, 'highlight', 'clip', ?, ?, ?, ?, ?, ?, ?)`,
    [c.tournamentName ? `${c.tournamentName} · Highlights` : 'ATAK.GG Highlights', content, c.tournamentId, c.region, c.gameId, c.key, c.mediaUrl, c.title.slice(0, 200), JSON.stringify(c.meta || {})]);
  return r.insertId as number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getViewerId(req: any): number | null {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as any;
    const id = Number(payload.sub || payload.uid);
    return isNaN(id) ? null : id;
  } catch { return null; }
}

async function getUserName(userId: number): Promise<string> {
  try {
    const [[u]] = await pool.query<any[]>('SELECT name, email FROM users WHERE id = ?', [userId]);
    return u?.name || (u?.email ? u.email.split('@')[0] : `Usuario${userId}`);
  } catch { return `Usuario${userId}`; }
}

const ALLOWED_TAGS = ['general', 'highlight', 'lfg', 'ayuda', 'clip', 'torneo'];

// ─── GET /api/social/posts ─────────────────────────────────────────────────────
router.get('/posts', async (req: any, res) => {
  const page   = Math.max(1, Number(req.query.page)  || 1);
  const limit  = Math.min(50, Number(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const tag    = (req.query.tag as string) || 'all';
  const tournament = String(req.query.tournament || '').slice(0, 64);
  const viewerId = getViewerId(req);

  const conds: string[] = []; const baseParams: any[] = [];
  if (tag !== 'all') { conds.push('p.tag = ?'); baseParams.push(tag); }
  // Feed de un torneo: sus clips + los reposts de esos clips
  if (tournament) { conds.push('(p.tournament_id = ? OR o.tournament_id = ?)'); baseParams.push(tournament, tournament); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  // Safe: viewerId is either null or a parsed integer — no string input
  const likedExpr = viewerId !== null
    ? `(SELECT COUNT(*) > 0 FROM social_likes sl WHERE sl.post_id = p.id AND sl.user_id = ${viewerId})`
    : 'FALSE';
  const repostedExpr = viewerId !== null
    ? `(SELECT COUNT(*) > 0 FROM social_reposts sr WHERE sr.post_id = COALESCE(p.repost_of, p.id) AND sr.user_id = ${viewerId})`
    : 'FALSE';

  try {
    const [posts] = await pool.query<any[]>(
      `SELECT p.id, p.user_id, p.user_name, p.content, p.tag, p.kind, p.tournament_id,
              p.clip_region, p.clip_game_id, p.clip_key, p.media_url, p.title, p.meta_json, p.repost_of, p.reposts_count,
              p.likes_count, p.comments_count, p.created_at,
              ${likedExpr} AS liked_by_me, ${repostedExpr} AS reposted_by_me,
              o.id AS orig_id, o.user_name AS orig_user_name, o.content AS orig_content, o.kind AS orig_kind, o.tournament_id AS orig_tournament_id,
              o.media_url AS orig_media_url, o.title AS orig_title, o.meta_json AS orig_meta_json, o.likes_count AS orig_likes_count,
              o.comments_count AS orig_comments_count, o.reposts_count AS orig_reposts_count
       FROM social_posts p LEFT JOIN social_posts o ON o.id = p.repost_of ${where}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...baseParams, limit, offset]
    );
    for (const p of posts) { try { p.meta = p.meta_json ? JSON.parse(p.meta_json) : null; } catch { p.meta = null; } try { p.orig_meta = p.orig_meta_json ? JSON.parse(p.orig_meta_json) : null; } catch { p.orig_meta = null; } delete p.meta_json; delete p.orig_meta_json; }
    const [[{ total }]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS total FROM social_posts p LEFT JOIN social_posts o ON o.id = p.repost_of ${where}`,
      baseParams
    );
    res.json({ posts, total: Number(total), page, pages: Math.ceil(Number(total) / limit) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/social/posts ────────────────────────────────────────────────────
router.post('/posts', requireAuth, async (req: any, res) => {
  const { content, tag = 'general' } = req.body;
  const userId = req.auth.userId;
  if (!content?.trim())    return res.status(400).json({ error: 'Contenido requerido' });
  if (content.length > 280) return res.status(400).json({ error: 'Máximo 280 caracteres' });
  const safeTag = ALLOWED_TAGS.includes(tag) ? tag : 'general';
  try {
    const userName = await getUserName(userId);
    const [result] = await pool.query<any>(
      'INSERT INTO social_posts (user_id, user_name, content, tag) VALUES (?, ?, ?, ?)',
      [userId, userName, content.trim(), safeTag]
    );
    const [[post]] = await pool.query<any[]>(
      'SELECT *, FALSE AS liked_by_me FROM social_posts WHERE id = ?',
      [result.insertId]
    );
    res.status(201).json(post);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/social/posts/:id/like  (toggle) ────────────────────────────────
router.post('/posts/:id/like', requireAuth, async (req: any, res) => {
  const postId = Number(req.params.id);
  const userId = req.auth.userId;
  if (isNaN(postId)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const [[existing]] = await pool.query<any[]>(
      'SELECT 1 FROM social_likes WHERE post_id = ? AND user_id = ?',
      [postId, userId]
    );
    if (existing) {
      await pool.query('DELETE FROM social_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
      await pool.query('UPDATE social_posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = ?', [postId]);
      return res.json({ liked: false });
    }
    await pool.query('INSERT IGNORE INTO social_likes (post_id, user_id) VALUES (?, ?)', [postId, userId]);
    await pool.query('UPDATE social_posts SET likes_count = likes_count + 1 WHERE id = ?', [postId]);
    res.json({ liked: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/social/posts/:id/repost  (toggle) ─────────────────────────────
router.post('/posts/:id/repost', requireAuth, async (req: any, res) => {
  const postId = Number(req.params.id);
  const userId = req.auth.userId;
  if (isNaN(postId)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const [[orig]] = await pool.query<any[]>('SELECT id, repost_of, user_name, title, content, tournament_id FROM social_posts WHERE id = ?', [postId]);
    if (!orig) return res.status(404).json({ error: 'Post no encontrado' });
    const targetId = orig.repost_of || orig.id; // repostear un repost = repostear el original
    const [[existing]] = await pool.query<any[]>('SELECT repost_id FROM social_reposts WHERE post_id = ? AND user_id = ?', [targetId, userId]);
    if (existing) {
      await pool.query('DELETE FROM social_posts WHERE id = ?', [existing.repost_id]);
      await pool.query('DELETE FROM social_reposts WHERE post_id = ? AND user_id = ?', [targetId, userId]);
      await pool.query('UPDATE social_posts SET reposts_count = GREATEST(0, reposts_count - 1) WHERE id = ?', [targetId]);
      return res.json({ reposted: false });
    }
    const userName = await getUserName(userId);
    const comment = String(req.body?.content || '').trim().slice(0, 280);
    const [r] = await pool.query<any>(
      "INSERT INTO social_posts (user_id, user_name, content, tag, kind, repost_of) VALUES (?, ?, ?, 'highlight', 'repost', ?)",
      [userId, userName, comment || `Repost de ${orig.user_name}`, targetId]);
    await pool.query('INSERT INTO social_reposts (post_id, user_id, repost_id) VALUES (?, ?, ?)', [targetId, userId, r.insertId]);
    await pool.query('UPDATE social_posts SET reposts_count = reposts_count + 1 WHERE id = ?', [targetId]);
    res.status(201).json({ reposted: true, id: r.insertId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/social/posts/:id/comments ──────────────────────────────────────
router.get('/posts/:id/comments', async (req, res) => {
  const postId = Number(req.params.id);
  if (isNaN(postId)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const [comments] = await pool.query<any[]>(
      'SELECT * FROM social_comments WHERE post_id = ? ORDER BY created_at ASC LIMIT 100',
      [postId]
    );
    res.json(comments);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/social/posts/:id/comments ─────────────────────────────────────
router.post('/posts/:id/comments', requireAuth, async (req: any, res) => {
  const postId = Number(req.params.id);
  const userId = req.auth.userId;
  const { content } = req.body;
  if (isNaN(postId))       return res.status(400).json({ error: 'ID inválido' });
  if (!content?.trim())    return res.status(400).json({ error: 'Comentario requerido' });
  if (content.length > 280) return res.status(400).json({ error: 'Máximo 280 caracteres' });
  try {
    const userName = await getUserName(userId);
    const [result] = await pool.query<any>(
      'INSERT INTO social_comments (post_id, user_id, user_name, content) VALUES (?, ?, ?, ?)',
      [postId, userId, userName, content.trim()]
    );
    await pool.query('UPDATE social_posts SET comments_count = comments_count + 1 WHERE id = ?', [postId]);
    const [[comment]] = await pool.query<any[]>(
      'SELECT * FROM social_comments WHERE id = ?', [result.insertId]
    );
    res.status(201).json(comment);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/social/posts/:id ────────────────────────────────────────────
router.delete('/posts/:id', requireAuth, async (req: any, res) => {
  const postId = Number(req.params.id);
  const userId = req.auth.userId;
  const role   = req.auth.role;
  if (isNaN(postId)) return res.status(400).json({ error: 'ID inválido' });
  try {
    const [[post]] = await pool.query<any[]>('SELECT user_id FROM social_posts WHERE id = ?', [postId]);
    if (!post) return res.status(404).json({ error: 'Post no encontrado' });
    if (post.user_id !== userId && role !== 'admin')
      return res.status(403).json({ error: 'Sin permiso' });
    await pool.query('DELETE FROM social_likes WHERE post_id = ?', [postId]);
    await pool.query('DELETE FROM social_comments WHERE post_id = ?', [postId]);
    await pool.query('DELETE FROM social_posts WHERE id = ?', [postId]);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;