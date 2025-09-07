// routes/static.ts
import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

// cache simple en memoria 24h
let cache:{ts:number, data:any}|null=null;
const TTL = 24*60*60*1000;

router.get('/arena-augments', async (_req, res) => {
  try {
    if (cache && Date.now()-cache.ts < TTL) {
      return res.json(cache.data);
    }
    const url = 'https://raw.communitydragon.org/latest/cdragon/arena/en_us.json';
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({error:'upstream error', status:r.status});
    const data = await r.json();
    cache = { ts: Date.now(), data };
    res.json(data);
  } catch (e:any) {
    res.status(500).json({error:e?.message || 'fetch failed'});
  }
});

export default router;