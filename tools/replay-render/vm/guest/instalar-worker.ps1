# Se ejecuta DENTRO de la VM (lo lanza 03-preparar-guest.ps1 por PowerShell Direct).
# Node, archivos del juego desde el host, Replay API y tarea que arranca el worker al iniciar sesión.
param([string]$HostIp, [string]$User)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

# 1) Node (LTS) si falta
if (-not (Get-Command node -ErrorAction SilentlyContinue) -and -not (Test-Path 'C:\Program Files\nodejs\node.exe')) {
  Write-Output "Descargando Node LTS…"
  $msi = "$env:TEMP\node.msi"
  Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi' -OutFile $msi
  Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  Write-Output "Node instalado."
}
$node = 'C:\Program Files\nodejs\node.exe'

# 2) Archivos del juego desde el host (solo lectura). Primera vez ~29 GB; después solo cambios.
Set-Content -Path 'C:\ATAK\host-ip.txt' -Value $HostIp
Write-Output "Sincronizando el juego desde \\$HostIp\RiotGames (puede tardar)…"
& cmd /c "C:\ATAK\sync-juego.cmd" | Select-Object -Last 3 | ForEach-Object { Write-Output $_ }

# 3) Configuración del juego (ventana 1920×1080 + Replay API)
New-Item -ItemType Directory -Force -Path 'C:\Riot Games\League of Legends\Config' | Out-Null
Copy-Item 'C:\ATAK\game.cfg' 'C:\Riot Games\League of Legends\Config\game.cfg' -Force
Remove-Item 'C:\Riot Games\League of Legends\Config\PersistedSettings.json' -Force -ErrorAction SilentlyContinue

# 4) Sin bloqueo de pantalla ni suspensión; defender fuera de la carpeta de render (rendimiento)
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change monitor-timeout-ac 0 | Out-Null
Add-MpPreference -ExclusionPath 'C:\ATAK', 'C:\Riot Games' -ErrorAction SilentlyContinue

# 5) Tarea: al iniciar sesión → sincronizar juego y arrancar el worker (vigilante)
$cmd = "cmd /c `"call C:\ATAK\sync-juego.cmd & cd /d C:\ATAK\replay-render & `"$node`" render.mjs --tournament lqc-2026 --watch --direct >> out\worker.log 2>&1`""
New-Item -ItemType Directory -Force -Path 'C:\ATAK\replay-render\out' | Out-Null
schtasks /Delete /TN 'ATAK Render' /F 2>$null | Out-Null
schtasks /Create /TN 'ATAK Render' /SC ONLOGON /RU $User /RL HIGHEST /F /TR $cmd | Out-Null
schtasks /Run /TN 'ATAK Render' | Out-Null
Write-Output "Tarea 'ATAK Render' registrada y en marcha."
