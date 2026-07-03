// src/routes/opgg.routes.ts
// GET /api/opgg/summoner?name=Faker%23KR1&region=KR
// GET /api/opgg/summoner?game_name=Faker&tag_line=KR1&region=KR
// GET /api/opgg/summoner-full?game_name=Faker&tag_line=KR1&region=KR&champion=Katarina
// GET /api/opgg/raw?game_name=Faker&tag_line=KR1&region=KR   ← diagnostic: raw MCP text
import { Router } from 'express';
import axios from 'axios';
import { getSummonerRank, getSummonerFullProfile, normaliseRegion, getChampionBuild } from '../services/opgg.js';

const router = Router();

router.get('/summoner', async (req, res) => {
  let gameName = (req.query.game_name as string ?? '').trim();
  let tagLine  = (req.query.tag_line  as string ?? '').trim();
  const rawName = (req.query.name as string ?? '').trim();
  const region  = (req.query.region as string ?? 'NA').trim();

  // Support "Faker#KR1" shorthand
  if (!gameName && rawName.includes('#')) {
    const [g, t] = rawName.split('#');
    gameName = g; tagLine = t ?? '';
  }

  if (!gameName || !tagLine) {
    return res.status(400).json({ ok: false, msg: 'Provide name=Game%23Tag or game_name + tag_line' });
  }

  try {
    const rank = await getSummonerRank(gameName, tagLine, region);
    if (!rank) return res.status(404).json({ ok: false, msg: 'Summoner not found or unranked' });
    res.json({ ok: true, game_name: gameName, tag_line: tagLine, region, rank });
  } catch (err: any) {
    res.status(500).json({ ok: false, msg: err?.message });
  }
});

// GET /api/opgg/summoner-full?game_name=Faker&tag_line=KR1&region=KR&champion=Katarina
router.get('/summoner-full', async (req, res) => {
  let gameName = (req.query.game_name as string ?? '').trim();
  let tagLine  = (req.query.tag_line  as string ?? '').trim();
  const rawName  = (req.query.name     as string ?? '').trim();
  const region   = (req.query.region   as string ?? 'NA').trim();
  const champion = (req.query.champion as string ?? '').trim();

  if (!gameName && rawName.includes('#')) {
    const [g, t] = rawName.split('#');
    gameName = g; tagLine = t ?? '';
  }

  if (!gameName || !tagLine) {
    return res.status(400).json({ ok: false, msg: 'Provide game_name + tag_line or name=Game%23Tag' });
  }

  try {
    const profile = await getSummonerFullProfile(gameName, tagLine, region);
    if (!profile) return res.status(404).json({ ok: false, msg: 'Summoner not found or unranked' });

    // Find champion-specific stat if champion name provided
    let champion_stat: Record<string, any> | null = null;
    if (champion) {
      const needle = champion.toLowerCase().replace(/['\s.&]/g, '');
      const cs = profile.champion_stats.find(c =>
        c.champion_name.toLowerCase().replace(/['\s.&]/g, '') === needle
      );
      if (cs) {
        const play = cs.play || 1;
        // Detect if kill/death/assist are totals or per-game averages.
        // OP.GG sometimes returns totals (especially for large play counts).
        // If kill > play * 20, treat as totals and divide.
        // OP.GG champion_stats kill/death/assist are always career totals
        const avg_kills   = parseFloat((cs.kill   / play).toFixed(1));
        const avg_deaths  = parseFloat((cs.death  / play).toFixed(1));
        const avg_assists = parseFloat((cs.assist / play).toFixed(1));
        const kda_ratio = avg_deaths === 0
          ? 'Perfect'
          : parseFloat(((avg_kills + avg_assists) / avg_deaths).toFixed(2));
        champion_stat = {
          champion_name: cs.champion_name,
          play: cs.play,
          win: cs.win,
          lose: cs.lose,
          win_rate: parseFloat(((cs.win / play) * 100).toFixed(1)),
          avg_kills,
          avg_deaths,
          avg_assists,
          kda: kda_ratio,
          op_score: cs.op_score,
        };
      }
    }

    const solo = profile.rank;
    const season_play = solo.wins + solo.losses;

    res.json({
      ok: true,
      rank: profile.rank,
      champion_stat,
      champion_stats: profile.champion_stats,   // full season stats for all champions
      level: profile.level,
      is_hot_streak: profile.is_hot_streak,
      is_veteran: profile.is_veteran,
      is_fresh_blood: profile.is_fresh_blood,
      season_play,
      season_win_rate: season_play > 0 ? Math.round((solo.wins / season_play) * 100) : null,
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, msg: err?.message });
  }
});

// GET /api/opgg/tier-list?position=BOTTOM — curated meta picks with OP.GG tier scores
const CURATED: Record<string, { name: string; id: number; opggPos: string }[]> = {
  top:     [{name:'Jax',id:24,opggPos:'top'},{name:'Darius',id:122,opggPos:'top'},{name:'Fiora',id:114,opggPos:'top'},{name:'Mordekaiser',id:82,opggPos:'top'},{name:'Garen',id:86,opggPos:'top'},{name:'Renekton',id:58,opggPos:'top'},{name:'Malphite',id:54,opggPos:'top'},{name:'Camille',id:164,opggPos:'top'},{name:'Gwen',id:887,opggPos:'top'},{name:'Sett',id:875,opggPos:'top'}],
  jungle:  [{name:'Hecarim',id:120,opggPos:'jungle'},{name:'Warwick',id:19,opggPos:'jungle'},{name:'Amumu',id:32,opggPos:'jungle'},{name:'Vi',id:254,opggPos:'jungle'},{name:'Lee Sin',id:64,opggPos:'jungle'},{name:'Sejuani',id:113,opggPos:'jungle'},{name:'Diana',id:131,opggPos:'jungle'},{name:'Volibear',id:106,opggPos:'jungle'},{name:'Xin Zhao',id:5,opggPos:'jungle'},{name:'Rammus',id:33,opggPos:'jungle'}],
  mid:     [{name:'Lux',id:99,opggPos:'mid'},{name:'Ahri',id:103,opggPos:'mid'},{name:'Vex',id:888,opggPos:'mid'},{name:'Zed',id:238,opggPos:'mid'},{name:'Yone',id:777,opggPos:'mid'},{name:'Orianna',id:61,opggPos:'mid'},{name:'Viktor',id:112,opggPos:'mid'},{name:'Akali',id:84,opggPos:'mid'},{name:'Syndra',id:134,opggPos:'mid'},{name:'Katarina',id:55,opggPos:'mid'}],
  bottom:  [{name:'Jinx',id:222,opggPos:'adc'},{name:'Caitlyn',id:51,opggPos:'adc'},{name:'Jhin',id:202,opggPos:'adc'},{name:'Miss Fortune',id:21,opggPos:'adc'},{name:'Ashe',id:22,opggPos:'adc'},{name:'Ezreal',id:81,opggPos:'adc'},{name:'Sivir',id:15,opggPos:'adc'},{name:'Kaisa',id:145,opggPos:'adc'},{name:'Lucian',id:236,opggPos:'adc'},{name:'Draven',id:119,opggPos:'adc'}],
  utility: [{name:'Thresh',id:412,opggPos:'support'},{name:'Lulu',id:117,opggPos:'support'},{name:'Nami',id:267,opggPos:'support'},{name:'Soraka',id:16,opggPos:'support'},{name:'Leona',id:89,opggPos:'support'},{name:'Blitzcrank',id:53,opggPos:'support'},{name:'Janna',id:40,opggPos:'support'},{name:'Senna',id:235,opggPos:'support'},{name:'Nautilus',id:111,opggPos:'support'},{name:'Pyke',id:555,opggPos:'support'}],
};
const ALIAS: Record<string, string> = { JUNGLE:'jungle', TOP:'top', MIDDLE:'mid', BOTTOM:'bottom', UTILITY:'utility', MID:'mid', ADC:'bottom', SUPPORT:'utility' };
const tierCache = new Map<string, { data: any[]; exp: number }>();

router.get('/tier-list', async (req, res) => {
  const rawPos = ((req.query.position as string) ?? 'bottom').toUpperCase();
  const posKey = ALIAS[rawPos] ?? 'bottom';
  const cacheKey = `tier:${posKey}`;
  const cached = tierCache.get(cacheKey);
  if (cached && cached.exp > Date.now()) return res.json({ ok: true, picks: cached.data });

  const champs = CURATED[posKey] ?? CURATED.bottom;
  try {
    const results = await Promise.all(
      champs.map(async c => {
        const build = await getChampionBuild(c.name, c.opggPos).catch(() => null);
        const tier  = build?.tier ?? 5;
        const rank  = build?.rank ?? 99;
        const wr    = build?.win_rate != null ? Math.round(build.win_rate * 100) : null;
        const score = parseFloat(Math.max(0, 10 - tier * 1.8 - rank * 0.01).toFixed(1));
        return { name: c.name, id: c.id, tier, rank, wr, score };
      })
    );
    const picks = results.sort((a, b) => b.score - a.score);
    tierCache.set(cacheKey, { data: picks, exp: Date.now() + 30 * 60 * 1000 });
    res.json({ ok: true, picks });
  } catch (err: any) {
    res.status(500).json({ ok: false, msg: err?.message });
  }
});

// GET /api/opgg/raw — returns the raw OP.GG MCP text so we can inspect the schema
// Example: /api/opgg/raw?game_name=Kister&tag_line=NGC&region=LAN
router.get('/raw', async (req, res) => {
  let gameName = (req.query.game_name as string ?? '').trim();
  let tagLine  = (req.query.tag_line  as string ?? '').trim();
  const rawName  = (req.query.name as string ?? '').trim();
  const region   = (req.query.region as string ?? 'LAN').trim();

  if (!gameName && rawName.includes('#')) { [gameName, tagLine] = rawName.split('#'); }
  if (!gameName || !tagLine) return res.status(400).json({ ok: false, msg: 'need game_name + tag_line' });

  try {
    const { data: json } = await axios.post('https://mcp-api.op.gg/mcp', {
      jsonrpc: '2.0', id: Date.now(), method: 'tools/call',
      params: {
        name: 'lol_get_summoner_profile',
        arguments: {
          game_name: gameName, tag_line: tagLine,
          region: normaliseRegion(region),
          desired_output_fields: [
            'data.summoner.ranked_most_champions',
            'data.summoner.ranked_most_champions.my_champion_stats',
          ],
        },
      },
    }, { timeout: 20000 });

    const text: string = json.result?.content?.[0]?.text ?? '';
    res.type('text/plain').send(text || '(empty response)');
  } catch (err: any) {
    res.status(500).json({ ok: false, msg: err?.message });
  }
});

export default router;
