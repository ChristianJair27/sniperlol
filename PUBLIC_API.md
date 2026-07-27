# ATAK.GG — API Pública v1

API **de solo lectura** para consumir datos de torneos de ATAK.GG desde sitios externos (p.ej. la página oficial de la LCQ). No requiere autenticación ni API key. CORS abierto (`Access-Control-Allow-Origin: *`) — puedes llamarla directo desde el navegador o desde tu backend.

```
Base URL: https://atakback.revolution505.com/api/public/v1
```

## Convenciones

- Todas las respuestas son JSON con la forma `{ "ok": true, "data": ... }`.
- Errores: `{ "ok": false, "error": "mensaje" }` con status HTTP apropiado (404, 500).
- Los datos se cachean **15 segundos** en el servidor — no tiene sentido hacer polling más rápido que eso.
- Solo `GET`. Cualquier otro método no existe en esta superficie.
- Nunca se exponen códigos de lobby de Riot ni PUUIDs de jugadores.

## Endpoints

### 1. Lista de torneos

```
GET /tournaments
```

```bash
curl https://atakback.revolution505.com/api/public/v1/tournaments
```

```json
{
  "ok": true,
  "data": [
    {
      "id": "lqc-split-primavera-2026",
      "name": "LQC Split Primavera 2026",
      "phase": "registration",
      "startDate": "2026-08-01",
      "format": "Liga + Playoffs",
      "region": "la1",
      "prize": "$15,000 MXN",
      "teamsRegistered": 22,
      "teamsMax": 32,
      "description": "…",
      "logoUrl": null,
      "bannerUrl": null
    }
  ]
}
```

`phase`: `registration` → `checkin` → `active` → `complete`.

### 2. Detalle de torneo (con standings y equipos)

```
GET /tournaments/:id
```

```bash
curl https://atakback.revolution505.com/api/public/v1/tournaments/lqc-split-primavera-2026
```

Incluye todo lo de la lista más:

```json
{
  "standings": [
    { "position": 1, "team": "Eclipse QRO", "wins": 9, "losses": 0, "points": 27 }
  ],
  "teams": [
    { "name": "Eclipse QRO", "checkedIn": true }
  ]
}
```

### 3. Solo standings

```
GET /tournaments/:id/standings
```

Devuelve el array `standings` directamente (mismo shape que arriba).

### 4. Bracket

```
GET /tournaments/:id/bracket
```

```json
{
  "ok": true,
  "data": {
    "phase": "active",
    "matches": [
      {
        "id": "r1m1",
        "round": 1,
        "matchNumber": 1,
        "team1": "Eclipse QRO",
        "team2": "Dragones Querétaro",
        "winner": null,
        "status": "active",
        "score1": null,
        "score2": null,
        "gameId": 1729497715,
        "gameRegion": "la1"
      }
    ]
  }
}
```

`status` por partido: `pending` (esperando equipos) → `ready` (equipos definidos) → `active` (en juego) → `complete`.
Las rondas van de 1 a N; la ronda máxima es la final. `id` del partido tiene forma `r{ronda}m{número}`.

### 5. Partidos (lista plana, filtrable)

```
GET /tournaments/:id/matches
GET /tournaments/:id/matches?status=complete
```

Mismo shape de partido que el bracket, en array plano. El query param `status` filtra por estado.

### 6. Stats por partido

```
GET /tournaments/:id/matches/:matchId/stats
```

```bash
curl https://atakback.revolution505.com/api/public/v1/tournaments/hola-1782358778133/matches/r1m1/stats
```

- **200** — partida terminada, stats completas:

```json
{
  "ok": true,
  "data": {
    "matchId": "LA1_1729497715",
    "gameDuration": 910,
    "gameMode": "CLASSIC",
    "winner": "blue",
    "isComplete": true,
    "blueTeam": [
      {
        "summonerName": "Kister", "tagLine": "NGC",
        "championName": "Katarina", "champLevel": 13,
        "teamId": 100, "win": true,
        "kills": 9, "deaths": 1, "assists": 0, "kda": 9,
        "cs": 127, "csPerMin": 8.4,
        "goldEarned": 8463,
        "totalDamageDealt": 13308, "physicalDamage": 6403, "magicDamage": 5920, "trueDamage": 984,
        "damageTaken": 9693, "healingDone": 2771,
        "visionScore": 6, "wardsPlaced": 4, "wardsKilled": 1,
        "items": [6672, 3153, 0, 0, 0, 0, 3340],
        "summoner1Id": 14, "summoner2Id": 4,
        "perks": { "keystoneId": 8010, "secondaryStyleId": 8100 },
        "pentaKills": 0, "quadraKills": 0, "tripleKills": 0, "doubleKills": 0,
        "firstBloodKill": true, "teamPosition": "MIDDLE"
      }
    ],
    "redTeam": [ "…mismo shape…" ]
  }
}
```

- **202** — la partida aún no termina o no se ha sincronizado:

```json
{ "ok": true, "data": null, "status": "in_progress", "hint": "Reintenta en 60s." }
```

Trátalo como "todavía no", no como error. Las stats aparecen ≤60s después de que termina la partida (sincronización automática).

Para iconos de campeones/ítems usa Data Dragon con `championName` / ids de `items`:
`https://ddragon.leagueoflegends.com/cdn/<version>/img/champion/Katarina.png` (versión vigente en `https://ddragon.leagueoflegends.com/api/versions.json`).

### 7. Stats agregadas del torneo (por jugador)

```
GET /tournaments/:id/stats
```

```json
{
  "ok": true,
  "data": {
    "tournamentId": "hola-1782358778133",
    "matchesCompleted": 1,
    "lastUpdated": 1785037000000,
    "players": [
      {
        "summonerName": "Kister", "tagLine": "NGC",
        "mostPlayedChamp": "Katarina", "championPool": ["Katarina"],
        "gamesPlayed": 1, "wins": 1, "losses": 0, "winrate": 100,
        "totalKills": 9, "totalDeaths": 1, "totalAssists": 0, "avgKda": 9,
        "totalGold": 8463, "avgGoldPerMin": 558,
        "totalDamage": 13308, "avgDamagePerMin": 877.3,
        "totalVisionScore": 6, "avgVisionPerMin": 0.4,
        "totalCs": 127, "avgCsPerMin": 8.4,
        "pentaKills": 0, "quadraKills": 0, "tripleKills": 0, "doubleKills": 0
      }
    ]
  }
}
```

## Recetas rápidas

**Standings en vivo para la home de la LCQ** (refresco cada 30s):

```js
const r = await fetch('https://atakback.revolution505.com/api/public/v1/tournaments/lqc-split-primavera-2026/standings');
const { data: standings } = await r.json();
```

**Marcador del partido en curso:**

```js
const { data } = await (await fetch(`${BASE}/tournaments/${ID}/matches?status=active`)).json();
// data[0] → { team1, team2, score1, score2, ... }
```

**Tabla de líderes (KDA):**

```js
const { data } = await (await fetch(`${BASE}/tournaments/${ID}/stats`)).json();
const top = [...data.players].sort((a, b) => b.avgKda - a.avgKda).slice(0, 10);
```

## Auto-registro desde el formulario LQC (webhook)

Cada registro del formulario de `lqc.revolution505.com/registro` puede inscribirse solo en ATAK.GG:

```
POST https://atakback.revolution505.com/api/integrations/lqc/register
Header: X-LQC-Secret: <secreto compartido — pídeselo a Christian>
Content-Type: application/json
```

Acepta el objeto plano del formulario **o** el payload nativo de un [Supabase Database Webhook](https://supabase.com/docs/guides/database/webhooks) (`{ type:'INSERT', record:{...} }`) — configura el webhook en Supabase sobre INSERT de la tabla de registros y apúntalo a esta URL con el header del secreto. Campos (snake_case o camelCase): `equipo`*, `gamertag`* (ideal Riot ID completo `Nombre#TAG`), `nombre`, `celular`, `correo`, `fecha_nacimiento`, `escolaridad`, `municipio`, `localidad`, `genero`, `capitan_nombre`, `capitan_celular`.

Comportamiento: primer jugador de un equipo lo crea; los siguientes se agregan (máx 7). Idempotente por `gamertag` — reintentos no duplican. Respuestas: `{ok:true, action:'team_created'|'player_added'|'player_updated'}`; `409` si el torneo está lleno, fuera de fase de registro, o el equipo llegó a 7.

Los equipos aparecen al instante en `GET /tournaments/lqc-2026` (campo `teams`) — con eso pintas la lista de inscritos en la página de la LQC con tus propios estilos/animaciones.

**Bajas (borrar jugador/equipo):** el MISMO webhook maneja los DELETE. En Supabase, configura el Database Webhook con los eventos **INSERT, UPDATE y DELETE** apuntando a la misma URL — al borrar una fila, el jugador se da de baja en ATAK.GG (si era el último del equipo, cae el equipo completo). También puedes llamarlo directo desde tu dashboard: `POST /api/integrations/lqc/unregister` con `{ "equipo": "...", "gamertag": "..." }` (sin `gamertag` borra el equipo entero). Todo idempotente. Nota: con el torneo ya iniciado, las bajas se rechazan (409) — se gestionan con el organizador.

## Versionado

La superficie `/api/public/v1` es estable: no se quitarán campos ni cambiarán tipos dentro de v1. Campos nuevos pueden agregarse sin aviso (parser tolerante, por favor). Cambios incompatibles saldrán como `/api/public/v2`.

## Contacto

Dudas o campos que te falten: kister@revolution505.com
