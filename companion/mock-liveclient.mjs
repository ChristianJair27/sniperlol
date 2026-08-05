#!/usr/bin/env node
// Mock de la Live Client Data API de Riot para probar el companion sin una
// partida real: sirve /liveclientdata/allgamedata en http://127.0.0.1:29999
// con una partida simulada que avanza (tiempo, kills, niveles, muertes).
// Uso:  node mock-liveclient.mjs
//       node atak-companion.mjs --channel test --token X --backend http://localhost:4001 --source http://127.0.0.1:29999/liveclientdata/allgamedata
import http from 'node:http';

const START = Date.now();
const CHAMPS_ORDER = ['Katarina', 'Pantheon', 'Jinx', 'Thresh', 'MasterYi'];
const CHAMPS_CHAOS = ['Yasuo', 'Xerath', 'Ashe', 'Janna', 'LeeSin'];

const events = [{ EventID: 0, EventName: 'GameStart', EventTime: 0 }];
let nextEventId = 1;

function state() {
  const t = Math.floor((Date.now() - START) / 1000) + 300; // arranca en el min 5
  // Genera un kill aleatorio de vez en cuando
  if (Math.random() < 0.25 && events.length < 90) {
    const killerTeam = Math.random() < 0.5 ? 'ORDER' : 'CHAOS';
    const pool = killerTeam === 'ORDER' ? CHAMPS_ORDER : CHAMPS_CHAOS;
    const vpool = killerTeam === 'ORDER' ? CHAMPS_CHAOS : CHAMPS_ORDER;
    events.push({
      EventID: nextEventId++,
      EventName: 'ChampionKill',
      EventTime: t,
      KillerName: `Mock ${pool[Math.floor(Math.random() * 5)]}#TEST`,
      VictimName: `Mock ${vpool[Math.floor(Math.random() * 5)]}#TEST`,
      Assisters: [],
    });
  }
  if (t > 480 && !events.some(e => e.EventName === 'DragonKill')) {
    events.push({ EventID: nextEventId++, EventName: 'DragonKill', EventTime: t, KillerName: 'Mock Jinx#TEST', DragonType: 'Fire' });
  }

  const mkPlayer = (name, champ, team, i) => {
    const kills = events.filter(e => e.EventName === 'ChampionKill' && e.KillerName === `Mock ${champ}#TEST`).length;
    const deaths = events.filter(e => e.EventName === 'ChampionKill' && e.VictimName === `Mock ${champ}#TEST`).length;
    return {
      riotId: `Mock ${champ}#TEST`,
      summonerName: `Mock ${champ}`,
      championName: champ,
      team,
      level: Math.min(18, 5 + Math.floor(t / 120)),
      position: ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'][i],
      isDead: deaths > 0 && Math.random() < 0.12,
      respawnTimer: Math.random() < 0.12 ? 12.4 : 0,
      scores: { kills, deaths, assists: Math.floor(kills * 1.4), creepScore: 40 + Math.floor(t / 8) + i * 9, wardScore: Math.floor(t / 60) },
      items: [{ itemID: 3078 }, { itemID: 3047 }, { itemID: 1055 }].slice(0, 1 + (i % 3)),
    };
  };

  return {
    gameData: { gameTime: t, gameMode: 'CLASSIC', mapName: 'Map11', mapNumber: 11 },
    allPlayers: [
      ...CHAMPS_ORDER.map((c, i) => mkPlayer(c, c, 'ORDER', i)),
      ...CHAMPS_CHAOS.map((c, i) => mkPlayer(c, c, 'CHAOS', i)),
    ],
    events: { Events: events },
  };
}

http.createServer((req, res) => {
  if (req.url?.startsWith('/liveclientdata/allgamedata')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(state()));
  } else {
    res.writeHead(404); res.end();
  }
}).listen(29999, '127.0.0.1', () => console.log('mock Live Client Data en http://127.0.0.1:29999'));
