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

### 2b. Torneos de un jugador

```
GET /players/{riotId}/tournaments        (riotId = nombre#tag, URL-encoded: Kister%23NGC)
```

Para la página de un jugador: en qué torneos está inscrito y cómo va en cada uno.

```json
{
  "ok": true,
  "data": [
    {
      "tournamentId": "lqc-2026", "name": "LQC 2026", "region": "la1", "phase": "active",
      "team": "Requiem",
      "rank": 14, "score": 64, "rankedPlayers": 87,
      "gamesPlayed": 4, "winrate": 100, "avgKda": 5.25,
      "soloTier": "EMERALD", "soloDivision": "I"
    }
  ]
}
```

`rankedPlayers` es cuántos jugadores tienen posición (≥3 partidas), para mostrar "14 de 87". Solo torneos activos o finalizados; array vacío si no está en ninguno.

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

`status` por partido: `pending` (esperando equipos) → `ready` (equipos definidos) → `active` (**emparejada con código de lobby asignado**, no necesariamente jugando) → `complete`.

> ⚠ `active` NO significa "en juego ahora mismo": se pone en cuanto la serie recibe su código, que puede ser horas antes del primer juego. Para saber si la serie empezó usa `gamesPlayed`:
> - `active` + `gamesPlayed: 0` → emparejada, sin empezar.
> - `active` + `gamesPlayed: 1` (de `seriesTo: 2`) → serie en curso, entre juegos.
> No hay hoy una señal fiable de "partida en curso ahora mismo" en esta API.

Campos por partido además de los del ejemplo:

| Campo | Tipo | Significado |
|---|---|---|
| `gamesPlayed` | number | Juegos de la serie ya terminados (0 hasta que acabe el primero). |
| `seriesTo` | number | Victorias necesarias para ganar la serie (2 = Bo3, 3 = Bo5, 1 = Bo1). |
| `scheduledAt` | string \| null | Horario oficial fijado por el organizador, ISO 8601 con zona. `null` si no lo ha cargado. |

Las series con descanso vienen con `team2: "BYE"` y `status: "complete"`: fíltralas antes de contar.
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

- **200** — partida terminada, stats completas. Los campos de primer nivel son el **último juego** de la serie; `games` trae **todos los juegos en orden de juego** (en un Bo3 2-1, tres entradas), cada uno con el mismo shape:

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
        "team": "REV505",
        "rank": 1, "score": 90,
        "soloTier": "EMERALD", "soloDivision": "I", "soloLp": 42,
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

Notas de `/stats`:

- `matchesCompleted` cuenta **juegos** individuales terminados, no series (un Bo3 2-1 son 3).
- `score` (0–100) es la **puntuación del torneo**: promedio de 8 ejes (KDA, WR, daño/min, oro/min, CS/min, visión/min, kills+asistencias por partida, muertes por partida invertidas), cada uno recortado al percentil 5–95 de los jugadores con ≥3 partidas y llevado a 0–100. El recorte es lo que evita que un KDA de 54 aplaste al resto.
- `rank` es la **posición en el torneo** ordenando por `score` (desempate: partidas, luego KDA). Es `null` para quien tiene menos de 3 partidas. Es el mismo "#1" que muestra el dashboard de ATAK: úsenlo tal cual para el bloque de líderes.
- `soloTier` / `soloDivision` / `soloLp` son el rango **solo/dúo actual** de la cuenta (Riot League v4), refrescado por el backend como mucho cada 6 h. `null` si la cuenta no tiene ranked o aún no se ha resuelto. Tiers: IRON, BRONZE, SILVER, GOLD, PLATINUM, EMERALD, DIAMOND, MASTER, GRANDMASTER, CHALLENGER; división I–IV (sin división de MASTER en adelante).
- `team` es el equipo inscrito con el que cruza el Riot ID del jugador (`nombre#tag`, y como respaldo solo el nombre). Es `null` cuando la persona jugó con una cuenta distinta a la registrada; no lo descartes, muéstralo como "Sin equipo".
- `avgKda` = (kills + asistencias) / muertes; con 0 muertes es kills + asistencias. Puede dar valores extremos reales (p.ej. 54 con 9/2/99): conviene un tope visual.
- Las métricas `avg…PerMin` son total del torneo / minutos jugados en el torneo, no promedio de promedios. `avgDamagePerMin` es daño **a campeones**.
- `winrate` es entero 0–100. Para rankings de WR usa un piso de partidas (≥3): con 1 juego hay 100 % que no significan nada.

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
