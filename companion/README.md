# ATAK Spectator Companion — broadcast en vivo en el navegador

La innovación ATAK: cualquiera puede ver los datos de la partida **en vivo, en el
navegador, sin instalar nada** en `https://atakgg.revolution505.com/broadcast/<canal>`.
Solo la PC que ESPECTEA la partida corre este companion (Node, un archivo, cero
dependencias), que lee la **Live Client Data API oficial de Riot** y empuja
snapshots al backend cada 2 segundos.

```
PC espectadora (LoL en modo espectador + companion)
   └─ https://127.0.0.1:2999/liveclientdata/allgamedata   (API oficial de Riot)
        └─ POST /api/live-feed/<canal>/push  (token)      (backend ATAK)
             └─ GET  /api/live-feed/<canal>   (público)
                  └─ atakgg.revolution505.com/broadcast/<canal>   (todo el mundo)
```

Qué ve la audiencia: marcador por equipo, K/D/A, CS, items, niveles, timers de
respawn, feed de eventos (kills, dragones, barón, torres...) y — si además
transmites con OBS — el video HLS embebido en la misma página.

## Configuración (una sola vez)

1. **Token**: agrega `LIVE_FEED_TOKEN=<un-token-largo-aleatorio>` a las envs del
   backend en Coolify y redeploy. Sin esta env el push queda deshabilitado
   (seguro por defecto). Genera uno: `node -e "console.log(crypto.randomBytes(24).toString('hex'))"`.
2. **PC espectadora**: necesita Node 18+ y el archivo `atak-companion.mjs` (cópialo
   de este repo o descárgalo del server).

## Día de partido (LQC)

1. En la PC espectadora, entra a la partida como **espectador** con el cliente
   de LoL (el botón "VER EN CLIENTE" de atakgg copia el comando).
2. Corre el companion:

```powershell
node atak-companion.mjs --channel lqc-2026 --token TU_TOKEN --label "LQC Semifinal: Lobos vs Cuervos"
```

3. Comparte el link: `https://atakgg.revolution505.com/broadcast/lqc-2026`.
   La página se conecta sola cuando el companion detecta la partida, y muestra
   "no activo" cuando termina. Entre partidas puedes dejar el companion corriendo:
   detecta la siguiente automáticamente.
4. `Ctrl+C` al terminar la jornada (cierra el canal).

Convención de canales: usa el **id del torneo** (ej. `lqc-2026`) para las jornadas
oficiales; cualquier `[a-z0-9_-]` de 2-64 chars sirve para casters/creators.

## Video HLS opcional (broadcast completo con imagen)

1. En Coolify, levanta un contenedor **MediaMTX** (imagen `bluenviron/mediamtx`)
   con los puertos 1935 (RTMP in) y 8888 (HLS out) — sin config extra ya funciona.
2. OBS en la PC espectadora → Transmitir → Servidor `rtmp://TU_SERVER:1935/lqc`,
   clave vacía. (Captura la ventana del cliente espectando.)
3. Pasa la URL HLS al companion y la página la embebe sola:

```powershell
node atak-companion.mjs --channel lqc-2026 --token TU_TOKEN --label "..." --stream "https://TU_SERVER:8888/lqc/index.m3u8"
```

> Nota: sirve el HLS detrás de HTTPS (proxy de Coolify) o el navegador bloqueará
> el contenido mixto.

## Probar sin partida real

```powershell
node mock-liveclient.mjs        # simula el cliente de Riot en :29999
node atak-companion.mjs --channel test --token TU_TOKEN --backend http://localhost:4000 --source "http://127.0.0.1:29999/liveclientdata/allgamedata"
# abre http://localhost:8080/broadcast/test
```

## Flags del companion

| Flag | Descripción |
|---|---|
| `--channel <id>` | Canal del broadcast (obligatorio) |
| `--token <token>` | LIVE_FEED_TOKEN del backend (obligatorio) |
| `--backend <url>` | Backend (default `https://atakback.revolution505.com`) |
| `--label "<texto>"` | Título visible del match |
| `--stream <m3u8>` | URL HLS si también transmites video |
| `--interval <ms>` | Frecuencia de envío (default 2000) |
| `--team1 / --team2 <nombre>` | Nombres de equipos para el overlay de caster |
| `--logo1 / --logo2 <url>` | Logos de equipos para el overlay |
| `--source <url>` | (debug) URL alternativa del Live Client Data |

## Overlay de caster para OBS (branding LQC)

Además de la página pública `/broadcast/<canal>`, existe el overlay transparente
estilo LCK para poner ENCIMA de la captura del juego en OBS:

1. En OBS: **Fuente → Navegador**, URL
   `https://atakgg.revolution505.com/broadcast/<canal>/overlay`, 1920x1080.
2. Muestra: barra superior con equipos/kills/torres (colores y logo LQC),
   dragones tomados por tipo, reloj, **timers reales de Dragón/Heraldo/Barón**
   (calculados de los eventos: cada toma reinicia su respawn) y scoreboard
   inferior con items/KDA/CS/niveles/muertes.
3. Los nombres/logos de equipos salen de `--team1/--team2/--logo1/--logo2`
   (o se parsean del `--label "X vs Y"`).
4. Vista previa sin OBS: agrega `?bg=1` a la URL (pinta un fondo de prueba).

## Límites honestos

- La Live Client Data API **no expone posiciones** de los jugadores, así que no
  hay minimapa en vivo con movimiento (eso solo existe post-partida en la
  Repetición 2D de cada match, con la Match Timeline oficial). Todo lo que se
  muestra es 100% API oficial de Riot: cero ingeniería inversa, cero riesgo
  para la key.
- El companion debe correr en una PC que esté DENTRO de la partida (espectador
  o jugador). Para torneos: la PC del caster/admin espectando.
