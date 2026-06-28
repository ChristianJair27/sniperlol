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
initTables().catch(err => console.error('[social] initTables error:', err.message));

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
  const viewerId = getViewerId(req);

  const where      = tag !== 'all' ? 'WHERE p.tag = ?' : '';
  const baseParams = tag !== 'all' ? [tag] : [];

  // Safe: viewerId is either null or a parsed integer — no string input
  const likedExpr = viewerId !== null
    ? `(SELECT COUNT(*) > 0 FROM social_likes sl WHERE sl.post_id = p.id AND sl.user_id = ${viewerId})`
    : 'FALSE';

  try {
    const [posts] = await pool.query<any[]>(
      `SELECT p.id, p.user_id, p.user_name, p.content, p.tag,
              p.likes_count, p.comments_count, p.created_at,
              ${likedExpr} AS liked_by_me
       FROM social_posts p ${where}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...baseParams, limit, offset]
    );
    const [[{ total }]] = await pool.query<any[]>(
      `SELECT COUNT(*) AS total FROM social_posts p ${where}`,
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