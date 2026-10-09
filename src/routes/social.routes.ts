// src/routes/social.routes.ts — Social feed backed by MySQL
import { Router, raw } from 'express';
import rateLimit from 'express-rate-limit';
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
  // Medios subidos por usuarios: videos/imágenes de publicaciones, fotos de comentarios y stickers.
  await pool.query(`CREATE TABLE IF NOT EXISTS social_media (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    kind VARCHAR(16) NOT NULL,
    mime VARCHAR(40) NOT NULL,
    name VARCHAR(80) DEFAULT NULL,
    size INT NOT NULL,
    data LONGBLOB NOT NULL,
    poster MEDIUMBLOB NULL,
    uses INT NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_media_user (user_id, kind), KEY idx_media_kind (kind, created_at)
  ) ENGINE=InnoDB`);
  await pool.query('CREATE TABLE IF NOT EXISTS social_sticker_favs (user_id INT NOT NULL, media_id INT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, media_id)) ENGINE=InnoDB');
  for (const c of ['ADD COLUMN IF NOT EXISTS media_id INT DEFAULT NULL', 'ADD COLUMN IF NOT EXISTS sticker_id INT DEFAULT NULL']) await pool.query(`ALTER TABLE social_comments ${c}`);
  await pool.query('ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS media_id INT DEFAULT NULL');
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
const mediaUrl = (req: any, id: number) => `${req.protocol}://${req.get('host')}/api/social/media/${id}`;
const mediaLimiter = rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false });
const MAGIC: Array<{ mime: string; test: (b: Buffer) => boolean }> = [
  { mime: 'video/mp4', test: (b) => b.toString('latin1', 4, 8) === 'ftyp' },
  { mime: 'video/webm', test: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { mime: 'image/png', test: (b) => b.toString('latin1', 1, 4) === 'PNG' },
  { mime: 'image/gif', test: (b) => b.toString('latin1', 0, 4) === 'GIF8' },
  { mime: 'image/webp', test: (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];
async function avatarsFor(ids: number[]): Promise<Map<number, string | null>> {
  const m = new Map<number, string | null>();
  const list = [...new Set(ids.filter((x) => Number.isFinite(x) && x > 0))];
  if (!list.length) return m;
  try { const [rows] = await pool.query<any[]>(`SELECT id, avatar_url FROM users WHERE id IN (${list.map(() => '?').join(',')})`, list); for (const r of rows) m.set(Number(r.id), r.avatar_url || null); } catch { /* sin avatares */ }
  return m;
}

// ─── Medios: POST /api/social/media (cuerpo = archivo; X-Media-Kind video|image|sticker) ─────
router.post('/media', requireAuth, mediaLimiter, raw({ type: () => true, limit: 80 * 1024 * 1024 }), async (req: any, res) => {
  try {
    const kind = String(req.get('x-media-kind') || 'image').toLowerCase();
    if (!['video', 'image', 'sticker'].includes(kind)) return res.status(400).json({ error: 'kind inválido' });
    const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buf.length < 100) return res.status(400).json({ error: 'archivo vacío' });
    const type = MAGIC.find((x) => x.test(buf));
    if (!type) return res.status(400).json({ error: 'formato no admitido (mp4, webm, jpg, png, gif, webp)' });
    const isVideo = type.mime.startsWith('video/');
    if (kind === 'video' && !isVideo) return res.status(400).json({ error: 'se esperaba un video' });
    if (kind !== 'video' && isVideo) return res.status(400).json({ error: 'se esperaba una imagen' });
    if (kind === 'sticker' && buf.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'sticker: máximo 2 MB' });
    if (kind === 'image' && buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'imagen: máximo 8 MB' });
    const name = decodeURIComponent(String(req.get('x-media-name') || '')).slice(0, 80) || null;
    const [r] = await pool.query<any>('INSERT INTO social_media (user_id, kind, mime, name, size, data) VALUES (?, ?, ?, ?, ?, ?)', [req.auth.userId, kind, type.mime, name, buf.length, buf]);
    res.status(201).json({ id: r.insertId, url: mediaUrl(req, r.insertId), mime: type.mime, kind, size: buf.length });
  } catch (err: any) { res.status(err?.type === 'entity.too.large' ? 413 : 500).json({ error: err?.type === 'entity.too.large' ? 'archivo demasiado grande (máx. 80 MB)' : err.message }); }
});
// POST /api/social/media/:id/poster (JPEG hecho en el navegador con el primer fotograma del video)
router.post('/media/:id/poster', requireAuth, mediaLimiter, raw({ type: () => true, limit: 3 * 1024 * 1024 }), async (req: any, res) => {
  try {
    const id = Number(req.params.id); const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!id || buf.length < 500 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'JPEG requerido' });
    const [r] = await pool.query<any>('UPDATE social_media SET poster = ? WHERE id = ? AND user_id = ?', [buf, id, req.auth.userId]);
    if (!r.affectedRows) return res.status(404).json({ error: 'medio no encontrado' });
    res.json({ ok: true, url: `${mediaUrl(req, id)}/poster.jpg` });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
// GET /api/social/media/:id  (con Range para <video>)
router.get('/media/:id', async (req, res) => {
  try {
    const id = Number(req.params.id); if (!id) return res.status(400).end();
    const [[row]] = await pool.query<any[]>('SELECT mime, data FROM social_media WHERE id = ?', [id]);
    if (!row) return res.status(404).end();
    const data: Buffer = row.data; const total = data.length;
    res.setHeader('Content-Type', row.mime); res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); res.setHeader('Accept-Ranges', 'bytes');
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (range) {
      const start = range[1] ? Number(range[1]) : 0; const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start >= total || start > end) { res.status(416).setHeader('Content-Range', `bytes */${total}`); return res.end(); }
      res.status(206); res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`); res.setHeader('Content-Length', String(end - start + 1));
      return res.end(data.subarray(start, end + 1));
    }
    res.setHeader('Content-Length', String(total)); res.end(data);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
router.get('/media/:id/poster.jpg', async (req, res) => {
  try {
    const [[row]] = await pool.query<any[]>('SELECT poster FROM social_media WHERE id = ?', [Number(req.params.id)]);
    if (!row || !row.poster) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg'); res.setHeader('Cache-Control', 'public, max-age=86400'); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.end(row.poster);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ─── Stickers: GET /api/social/stickers?scope=recent|favs|mine ─────────────────
router.get('/stickers', async (req: any, res) => {
  const viewerId = getViewerId(req); const scope = String(req.query.scope || 'recent');
  try {
    let rows: any[] = [];
    if (scope === 'favs' && viewerId) [rows] = await pool.query<any[]>('SELECT m.id, m.name, m.mime, m.uses FROM social_sticker_favs f JOIN social_media m ON m.id = f.media_id WHERE f.user_id = ? AND m.kind = ? ORDER BY f.created_at DESC LIMIT 100', [viewerId, 'sticker']);
    else if (scope === 'mine' && viewerId) [rows] = await pool.query<any[]>('SELECT id, name, mime, uses FROM social_media WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 100', [viewerId, 'sticker']);
    else [rows] = await pool.query<any[]>('SELECT id, name, mime, uses FROM social_media WHERE kind = ? ORDER BY uses DESC, created_at DESC LIMIT 100', ['sticker']);
    const favs = new Set<number>();
    if (viewerId && rows.length) { const [f] = await pool.query<any[]>(`SELECT media_id FROM social_sticker_favs WHERE user_id = ? AND media_id IN (${rows.map(() => '?').join(',')})`, [viewerId, ...rows.map((r) => r.id)]); for (const x of f) favs.add(Number(x.media_id)); }
    res.json(rows.map((r) => ({ id: r.id, name: r.name, mime: r.mime, uses: r.uses, url: mediaUrl(req, r.id), fav: favs.has(Number(r.id)) })));
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});
// POST /api/social/stickers/:id/fav  (toggle)
router.post('/stickers/:id/fav', requireAuth, async (req: any, res) => {
  const id = Number(req.params.id); if (!id) return res.status(400).json({ error: 'ID inválido' });
  try {
    const [[m]] = await pool.query<any[]>('SELECT id FROM social_media WHERE id = ? AND kind = ?', [id, 'sticker']);
    if (!m) return res.status(404).json({ error: 'sticker no encontrado' });
    const [[f]] = await pool.query<any[]>('SELECT 1 FROM social_sticker_favs WHERE user_id = ? AND media_id = ?', [req.auth.userId, id]);
    if (f) { await pool.query('DELETE FROM social_sticker_favs WHERE user_id = ? AND media_id = ?', [req.auth.userId, id]); return res.json({ fav: false }); }
    await pool.query('INSERT INTO social_sticker_favs (user_id, media_id) VALUES (?, ?)', [req.auth.userId, id]);
    res.json({ fav: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

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
              o.media_url AS orig_media_url, o.title AS orig_title, o.clip_region AS orig_clip_region, o.clip_game_id AS orig_clip_game_id, o.meta_json AS orig_meta_json, o.likes_count AS orig_likes_count,
              o.comments_count AS orig_comments_count, o.reposts_count AS orig_reposts_count
       FROM social_posts p LEFT JOIN social_posts o ON o.id = p.repost_of ${where}
       ORDER BY p.created_at DESC
       LIMIT ? OFFSET ?`,
      [...baseParams, limit, offset]
    );
    for (const p of posts) { try { p.meta = p.meta_json ? JSON.parse(p.meta_json) : null; } catch { p.meta = null; } try { p.orig_meta = p.orig_meta_json ? JSON.parse(p.orig_meta_json) : null; } catch { p.orig_meta = null; } delete p.meta_json; delete p.orig_meta_json; }
    const av = await avatarsFor(posts.map((p) => Number(p.user_id)));
    for (const p of posts) p.user_avatar = av.get(Number(p.user_id)) || null;
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
  const { content = '', tag = 'general', media_id, title, tournament_id } = req.body;
  const userId = req.auth.userId;
  const mediaId = Number(media_id) || null;
  if (!String(content).trim() && !mediaId) return res.status(400).json({ error: 'Contenido requerido' });
  if (String(content).length > 280) return res.status(400).json({ error: 'Máximo 280 caracteres' });
  const safeTag = ALLOWED_TAGS.includes(tag) ? tag : 'general';
  try {
    const userName = await getUserName(userId);
    let media: any = null;
    if (mediaId) {
      [[media]] = await pool.query<any[]>('SELECT id, kind, mime FROM social_media WHERE id = ? AND user_id = ? AND kind IN (?, ?)', [mediaId, userId, 'video', 'image']);
      if (!media) return res.status(400).json({ error: 'medio no encontrado' });
    }
    const kind = media ? (media.kind === 'video' ? 'clip' : 'image') : 'text';
    const tid = String(tournament_id || '').slice(0, 64) || null;
    const [result] = await pool.query<any>(
      'INSERT INTO social_posts (user_id, user_name, content, tag, kind, tournament_id, media_id, media_url, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, userName, String(content).trim(), safeTag, kind, tid, mediaId, media ? mediaUrl(req, media.id) : null, String(title || '').slice(0, 200) || null]
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
      'SELECT * FROM social_comments WHERE post_id = ? ORDER BY created_at ASC LIMIT 200',
      [postId]
    );
    const av = await avatarsFor(comments.map((c) => Number(c.user_id)));
    for (const c of comments) { c.user_avatar = av.get(Number(c.user_id)) || null; c.sticker_url = c.sticker_id ? mediaUrl(req, Number(c.sticker_id)) : null; c.media_url = c.media_id ? mediaUrl(req, Number(c.media_id)) : null; }
    res.json(comments);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/social/posts/:id/comments ─────────────────────────────────────
router.post('/posts/:id/comments', requireAuth, async (req: any, res) => {
  const postId = Number(req.params.id);
  const userId = req.auth.userId;
  const { content = '', sticker_id, media_id } = req.body;
  const stickerId = Number(sticker_id) || null, mediaId = Number(media_id) || null;
  if (isNaN(postId))       return res.status(400).json({ error: 'ID inválido' });
  if (!String(content).trim() && !stickerId && !mediaId) return res.status(400).json({ error: 'Comentario requerido' });
  if (String(content).length > 280) return res.status(400).json({ error: 'Máximo 280 caracteres' });
  try {
    if (stickerId) { const [[st]] = await pool.query<any[]>('SELECT id FROM social_media WHERE id = ? AND kind = ?', [stickerId, 'sticker']); if (!st) return res.status(400).json({ error: 'sticker no encontrado' }); }
    if (mediaId) { const [[mm]] = await pool.query<any[]>('SELECT id FROM social_media WHERE id = ? AND user_id = ? AND kind = ?', [mediaId, userId, 'image']); if (!mm) return res.status(400).json({ error: 'imagen no encontrada' }); }
    const userName = await getUserName(userId);
    const [result] = await pool.query<any>(
      'INSERT INTO social_comments (post_id, user_id, user_name, content, sticker_id, media_id) VALUES (?, ?, ?, ?, ?, ?)',
      [postId, userId, userName, String(content).trim(), stickerId, mediaId]
    );
    await pool.query('UPDATE social_posts SET comments_count = comments_count + 1 WHERE id = ?', [postId]);
    if (stickerId) pool.query('UPDATE social_media SET uses = uses + 1 WHERE id = ?', [stickerId]).catch(() => {});
    const [[comment]] = await pool.query<any[]>(
      'SELECT * FROM social_comments WHERE id = ?', [result.insertId]
    );
    const av = await avatarsFor([userId]);
    comment.user_avatar = av.get(userId) || null; comment.sticker_url = stickerId ? mediaUrl(req, stickerId) : null; comment.media_url = mediaId ? mediaUrl(req, mediaId) : null;
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