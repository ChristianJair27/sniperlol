// src/routes/live-clips.routes.ts
// Repeticiones en vivo de una "segunda cámara": alguien espectea la partida con
// su propio OBS (búfer de repetición), un script sube cada repetición guardada
// aquí, y desde la mesa de control se decide cuándo el overlay del caster la
// muestra y cuándo la quita. Todo en MySQL (el backend corre en varias
// instancias: nada en memoria). Escritura con el mismo token del feed.
import { Router, raw } from 'express';
import { pool } from '../db.js';

const router = Router();
const TOKEN = (process.env.LIVE_FEED_TOKEN || '').trim();
const CHANNEL_RE = /^[a-z0-9_-]{2,64}$/i;
const KEEP = 8; // repeticiones guardadas por canal (las más viejas se borran)

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_feed_clips (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      channel    VARCHAR(64) NOT NULL,
      title      VARCHAR(160) NULL,
      mime       VARCHAR(40) NOT NULL,
      size       INT NOT NULL,
      data       LONGBLOB NOT NULL,
      created_at BIGINT NOT NULL,
      INDEX (channel, id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS live_feed_clip_state (
      channel VARCHAR(64) PRIMARY KEY,
      state   TEXT NOT NULL,
      at      BIGINT NOT NULL
    )`);
}
init().catch((e) => console.error('[live-clips] init:', e.message));

const okToken = (req: any) => !!TOKEN && String(req.headers['x-feed-token'] || '') === TOKEN;
const chan = (req: any) => { const c = String(req.params.channel).toLowerCase(); return CHANNEL_RE.test(c) ? c : ''; };
const clipUrl = (req: any, channel: string, id: number) => `${req.protocol}://${req.get('host')}/api/live-feed/${channel}/clips/${id}`;

// POST /api/live-feed/:channel/clips  (cuerpo = MP4, cabecera X-Clip-Title)
router.post('/:channel/clips', raw({ type: () => true, limit: 90 * 1024 * 1024 }), async (req, res) => {
  if (!okToken(req)) return res.status(401).json({ error: 'bad_token' });
  const channel = chan(req); if (!channel) return res.status(400).json({ error: 'bad_channel' });
  const buf: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (buf.length < 10_000) return res.status(400).json({ error: 'video demasiado pequeño' });
  const title = decodeURIComponent(String(req.get('x-clip-title') || '')).slice(0, 160) || null;
  const mime = String(req.get('content-type') || 'video/mp4').slice(0, 40);
  try {
    const [r] = await pool.query<any>('INSERT INTO live_feed_clips (channel, title, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)', [channel, title, mime, buf.length, buf, Date.now()]);
    const [old] = await pool.query<any[]>('SELECT id FROM live_feed_clips WHERE channel = ? ORDER BY id DESC LIMIT 100 OFFSET ?', [channel, KEEP]);
    if (old.length) await pool.query('DELETE FROM live_feed_clips WHERE id IN (?)', [old.map((o) => o.id)]);
    console.log(`[live-clips] ${channel} #${r.insertId} (${(buf.length / 1048576).toFixed(1)} MB)`);
    return res.status(201).json({ ok: true, id: r.insertId, url: clipUrl(req, channel, r.insertId) });
  } catch (e: any) { console.error('[live-clips] upload:', e.message); return res.status(500).json({ error: 'upload_failed' }); }
});

router.get('/:channel/clips', async (req, res) => {
  const channel = chan(req); if (!channel) return res.status(400).json({ error: 'bad_channel' });
  try {
    const [rows] = await pool.query<any[]>('SELECT id, title, size, created_at FROM live_feed_clips WHERE channel = ? ORDER BY id DESC LIMIT ?', [channel, KEEP]);
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, clips: rows.map((r) => ({ id: r.id, title: r.title, size: r.size, createdAt: Number(r.created_at), url: clipUrl(req, channel, r.id) })) });
  } catch { return res.json({ ok: true, clips: [] }); }
});

// GET /api/live-feed/:channel/clips/:id → el video, con Range (el overlay salta a los últimos segundos)
router.get('/:channel/clips/:id', async (req, res) => {
  const channel = chan(req); const id = Number(req.params.id);
  if (!channel || !Number.isInteger(id)) return res.status(400).end();
  try {
    const [[meta]] = await pool.query<any[]>('SELECT size, mime FROM live_feed_clips WHERE channel = ? AND id = ?', [channel, id]);
    if (!meta) return res.status(404).end();
    const size = Number(meta.size);
    res.set({ 'Content-Type': meta.mime || 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' });
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (m) {
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2] || 0));
      let end = m[1] && m[2] ? Number(m[2]) : size - 1;
      end = Math.min(end, size - 1, start + 8 * 1024 * 1024 - 1);
      if (start >= size || start > end) { res.set('Content-Range', `bytes */${size}`); return res.status(416).end(); }
      const [[row]] = await pool.query<any[]>('SELECT SUBSTRING(data, ?, ?) AS part FROM live_feed_clips WHERE id = ?', [start + 1, end - start + 1, id]);
      res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) });
      return res.end(row.part);
    }
    const [[row]] = await pool.query<any[]>('SELECT data FROM live_feed_clips WHERE id = ?', [id]);
    res.set('Content-Length', String(size));
    return res.end(row.data);
  } catch (e: any) { console.error('[live-clips] get:', e.message); return res.status(500).end(); }
});

// Mostrar / quitar desde la mesa de control. state = { show, id, last (s desde el final), at }
router.post('/:channel/clip-state', async (req, res) => {
  if (!okToken(req)) return res.status(401).json({ error: 'bad_token' });
  const channel = chan(req); if (!channel) return res.status(400).json({ error: 'bad_channel' });
  const show = req.body?.show === true;
  const id = Number(req.body?.id) || 0;
  const last = Math.min(30, Math.max(0, Number(req.body?.last) || 0));
  const slow = req.body?.slow === true;
  const state = { show: show && id > 0, id, last, slow, at: Date.now() };
  try {
    await pool.query('INSERT INTO live_feed_clip_state (channel, state, at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE state = VALUES(state), at = VALUES(at)', [channel, JSON.stringify(state), state.at]);
    return res.json({ ok: true, state });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});
router.get('/:channel/clip-state', async (req, res) => {
  const channel = chan(req); if (!channel) return res.status(400).json({ error: 'bad_channel' });
  res.set('Cache-Control', 'no-store');
  try {
    const [[row]] = await pool.query<any[]>('SELECT state FROM live_feed_clip_state WHERE channel = ?', [channel]);
    const state = row ? JSON.parse(row.state) : { show: false, id: 0, last: 0, at: 0 };
    return res.json({ ok: true, state, url: state.id ? clipUrl(req, channel, state.id) : null });
  } catch { return res.json({ ok: true, state: { show: false, id: 0, last: 0, at: 0 }, url: null }); }
});

export default router;
