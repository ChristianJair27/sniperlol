// src/routes/lcu-proxy.routes.ts
// Proxies LCU (League Client Update) API calls from the Overwolf companion.
// Node.js can disable TLS cert verification; Chromium/CEF cannot.
import { Router } from 'express';
import axios from 'axios';
import https from 'https';

const router = Router();
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

function setCors(req: any, res: any) {
  const origin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Vary', 'Origin');
}

// Handle preflight
router.options('/', (req, res) => {
  setCors(req, res);
  res.sendStatus(204);
});

// GET /api/lcu-proxy/game-data
// Proxies LoL Live Client Data API (port 2999) for Overwolf windows.
// Regular fetch() to localhost:4000 works from any Overwolf window;
// direct access to port 2999 requires the "Web" permission (background-only).
router.get('/game-data', async (req, res) => {
  setCors(req, res);
  try {
    const { data } = await axios.get(
      'https://127.0.0.1:2999/liveclientdata/allgamedata',
      { timeout: 5000, httpsAgent: insecureAgent }
    );
    res.json(data);
  } catch (err: any) {
    const status = err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET' ? 404 : 502;
    res.status(status).json({ ok: false, msg: 'Not in game' });
  }
});

// GET ?port=PORT&password=PASS&path=/lol-gameflow/...
router.get('/', async (req, res) => {
  setCors(req, res);

  const { port, password, path: lcuPath } = req.query as Record<string, string>;

  if (!port || !password || !lcuPath) {
    return res.status(400).json({ ok: false, msg: 'port, password, path required' });
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    return res.status(400).json({ ok: false, msg: 'invalid port' });
  }
  if (!lcuPath.startsWith('/')) {
    return res.status(400).json({ ok: false, msg: 'path must start with /' });
  }

  res.set('Cache-Control', 'no-store');

  try {
    const url = `https://127.0.0.1:${port}${lcuPath}`;
    const auth = Buffer.from(`riot:${password}`).toString('base64');
    const { data } = await axios.get(url, {
      headers: { Authorization: `Basic ${auth}` },
      httpsAgent: insecureAgent,
      timeout: 5000,
      validateStatus: () => true,
    });
    res.json(data);
  } catch (err: any) {
    res.status(502).json({ ok: false, msg: err?.message });
  }
});

export default router;
