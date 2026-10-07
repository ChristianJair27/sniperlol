# VM de render con GPU compartida (Hyper-V + GPU-P)

Máquina virtual Windows en la misma PC, con una partición de la GPU (GPU-P), sin Vanguard
y con su propia pantalla virtual: abre los replays directamente con el juego y graba los
highlights mientras el host sigue en uso. Es el mismo esquema que usa Replayit.

## Requisitos del host
- Windows 10/11 Pro, virtualización activa en la BIOS, GPU con driver reciente (WDDM 2.5+).
- ~130 GB libres en el disco de la VM (D:\ATAK-RenderVM) y una ISO de Windows 11 (o 10 ≥ 20H1).
- Ejecutar los scripts como administrador.

## Pasos
1. `01-habilitar-hyperv.ps1` (admin) → reiniciar.
2. Editar `vm\.env`: `VM_ISO` = ruta de la ISO. `02-crear-vm.ps1` (admin): crea la VM
   (12 GB RAM, 6 CPU, 120 GB, 50 % de la GPU), instala Windows desatendido
   (`autounattend.xml`: usuario `render` con inicio de sesión automático) y comparte
   `C:\Riot Games` en solo lectura para la VM.
3. Cuando la VM muestre el escritorio: `03-preparar-guest.ps1` (admin): copia el driver de la
   GPU al `HostDriverStore` de la VM, instala Node, copia el worker + ffmpeg + token, sincroniza
   los 29 GB del juego desde el host, pone `game.cfg` en ventana 1920×1080 con `EnableReplayApi=1`
   y registra la tarea `ATAK Render` (al iniciar sesión: sincroniza el juego y arranca
   `render.mjs --tournament lqc-2026 --watch --direct`).

Repetir el paso 3 cuando cambie el driver de la GPU del host. El juego se re-sincroniza solo
en cada arranque de la VM (robocopy espejo desde `\host\RiotGames`).

## Operación
- Hyper-V Manager → Conectar para ver la VM. Registro: `C:\ATAK\replay-render\out\worker.log`.
- La VM arranca sola con el host (AutomaticStartAction) y se apaga limpiamente al apagarlo.
- GPU: `-GpuPercent` en el paso 2 (50 % por defecto). Si el host nota lag mientras renderiza, bajar a 30.
