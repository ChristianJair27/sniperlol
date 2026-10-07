# Worker de render de highlights (Windows)

Convierte los replays (.rofl) de las partidas de torneo en clips MP4 de los
momentos clave y los sube a ATAK.GG. Corre en una PC Windows con el cliente de
League abierto y logueado (la reproducción de replays no funciona en máquinas
virtuales: Vanguard las bloquea).

## Requisitos

- Cliente de League abierto, logueado y **en reposo** (no en champ select ni en partida).
- `ffmpeg` en el PATH (`winget install Gyan.FFmpeg`).
- Node 20+.
- `game.cfg` con `EnableReplayApi=1` en `[General]` (el worker lo activa solo).
- Archivo `.env` junto al script:

```
RENDER_TOKEN=<token de subida, el mismo que RENDER_TOKEN en el backend>
ATAK_BACKEND=https://atakback.revolution505.com
REGION=LA1
```

## Uso

```bash
node render.mjs --game 1753784829 --top 6        # una partida, 6 mejores momentos
node render.mjs --tournament lqc-2026            # todas las partidas con replay y sin clips
node render.mjs --tournament lqc-2026 --watch    # se queda vigilando cada 10 min
```

Opciones: `--region LA1`, `--top N` (momentos por partida), `--keep` (no borra los
webm/mp4 de `out/`). Variables: `OUT_DIR`, `FPS` (30), `WIDTH`/`HEIGHT` (1920×1080),
`LOL_DIR` (`C:\Riot Games\League of Legends`).

## Qué hace por partida

1. `GET /api/replays/:region/:gameId/moments` → momentos (primera sangre,
   multikills, aces, barón/heraldo/anciano, inhibidores, peleas) con ventana de
   corte y posición en el mapa.
2. Pide al cliente bajar el replay (`/lol-replays/v1/rofls/:id/download`) y lo
   abre (`/watch`). Espera a que responda la Replay API (`https://127.0.0.1:2999/replay/playback`).
3. Por momento: `/replay/render` (sin niebla, cámara `top` sobre el punto),
   `/replay/playback` (salta al inicio), `/replay/recording` (graba webm entre
   `startTime` y `endTime`), ffmpeg → MP4 (H.264), `POST …/clips/:key`.
4. Cierra `League of Legends.exe`.

Los clips quedan en `GET /api/replays/:region/:gameId/clips` y
`GET /api/replays/tournament/:id/clips`.
