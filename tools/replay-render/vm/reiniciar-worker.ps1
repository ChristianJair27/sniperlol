# ATAK.GG · VM de render: reiniciar el worker dentro de la VM con el código actualizado y ver qué hace.
# Se eleva solo. Resultado en logs\reiniciar-worker.txt
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$out = Join-Path $here (Join-Path 'logs' 'reiniciar-worker.txt')
Set-Content -Path $out -Value "hora: $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function W($t) { Add-Content -Path $out -Value $t -Encoding UTF8 }
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$cred = New-Object System.Management.Automation.PSCredential($cfg.RENDER_VM_USER, (ConvertTo-SecureString $cfg.RENDER_VM_PASS -AsPlainText -Force))
try {
  $s = $null
  for ($i = 0; $i -lt 12 -and -not $s; $i++) { try { $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop } catch { Start-Sleep 5 } }
  if (-not $s) { W "sin PowerShell Direct"; W "fin"; exit }
  Copy-Item -ToSession $s -Path (Join-Path $root 'render.mjs') -Destination 'C:\ATAK\replay-render\render.mjs' -Force
  $r = Invoke-Command -Session $s -ScriptBlock {
    $o = @()
    Get-Process node, 'League of Legends', ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep 3
    $jl = (Get-Volume | Where-Object FileSystemLabel -eq 'JUEGO' | Select-Object -First 1).DriveLetter
    # Lanzador: la salida de node va a launcher.log; el worker escribe su propio out\worker.log
    $cmd = "@echo off`r`nsetlocal`r`nset `"LOL_DIR=$($jl):\Riot Games\League of Legends`"`r`nset ATAK_QUIET=1`r`ncd /d C:\ATAK\replay-render`r`nif not exist out mkdir out`r`necho %DATE% %TIME% lanzador iniciado>> out\launcher.log`r`n`"C:\Program Files\nodejs\node.exe`" render.mjs --tournament lqc-2026 --watch --direct >> out\launcher.log 2>&1`r`n"
    Set-Content -Path 'C:\ATAK\iniciar-worker.cmd' -Value $cmd -Encoding ASCII
    Remove-Item 'C:\ATAK\replay-render\out\worker.log' -Force -ErrorAction SilentlyContinue
    $o += "ejecutar: " + ((schtasks /Run /TN 'ATAK Render' 2>&1) -join ' ')
    Start-Sleep 150
    $o += "procesos: " + ((Get-Process node, 'League of Legends', ffmpeg -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName + '(' + $_.Id + ')' }) -join ', ')
    $o += "puerto 2999: " + ($(if ((netstat -ano -p tcp | Select-String ':2999\s+\S+\s+LISTENING')) { 'ocupado' } else { 'libre' }))
    try { $o += "replay api: " + ((Invoke-WebRequest -Uri 'https://127.0.0.1:2999/replay/playback' -UseBasicParsing -SkipCertificateCheck -TimeoutSec 5 -ErrorAction Stop).Content -replace '\s+', ' ') } catch {
      try { [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }; $o += "replay api: " + ((Invoke-WebRequest -Uri 'https://127.0.0.1:2999/replay/playback' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop).Content -replace '\s+', ' ') } catch { $o += "replay api: $($_.Exception.Message)" } }
    $o += "--- worker.log:"
    if (Test-Path 'C:\ATAK\replay-render\out\worker.log') { $o += Get-Content 'C:\ATAK\replay-render\out\worker.log' -Tail 30 } else { $o += '(no existe)' }
    $o += "--- launcher.log:"
    if (Test-Path 'C:\ATAK\replay-render\out\launcher.log') { $o += Get-Content 'C:\ATAK\replay-render\out\launcher.log' -Tail 15 } else { $o += '(no existe)' }
    $o += "--- r3dlog más reciente:"
    $lg = Get-ChildItem "$($jl):\Riot Games\League of Legends\Logs\GameLogs" -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($lg) { $o += "  $($lg.Name)"; $o += Get-ChildItem $lg.FullName -Filter '*r3dlog.txt' | ForEach-Object { Get-Content $_.FullName | Select-String 'Adapter|Failed|Error|CRSH|Replay|Command Line|ReplayApi|port' | Select-Object -First 16 | ForEach-Object { '  ' + $_.Line } } } else { $o += '  (sin logs del juego)' }
    $o
  }
  $r | ForEach-Object { W $_ }
  Remove-PSSession $s
} catch { W "error: $($_.Exception.Message)" }
W "fin"
