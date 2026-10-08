# ATAK.GG · VM de render: revisar/arrancar el worker dentro de la VM y mostrar su registro.
# Se eleva solo. Resultado en logs\arrancar-worker.txt
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$out = Join-Path $here (Join-Path 'logs' 'arrancar-worker.txt')
Set-Content -Path $out -Value "hora: $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function W($t) { Add-Content -Path $out -Value $t -Encoding UTF8 }
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$cred = New-Object System.Management.Automation.PSCredential($cfg.RENDER_VM_USER, (ConvertTo-SecureString $cfg.RENDER_VM_PASS -AsPlainText -Force))
try {
  $s = $null
  for ($i = 0; $i -lt 12 -and -not $s; $i++) { try { $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop } catch { Start-Sleep 5 } }
  if (-not $s) { W "sin PowerShell Direct"; W "fin"; exit }
  # Worker al día + lanzador reescrito (sin depender de la tarea) 
  Copy-Item -ToSession $s -Path (Join-Path $root 'render.mjs') -Destination 'C:\ATAK\replay-render\render.mjs' -Force
  Copy-Item -ToSession $s -Path (Join-Path $root '.env') -Destination 'C:\ATAK\replay-render\.env' -Force
  $r = Invoke-Command -Session $s -ArgumentList $cfg.RENDER_VM_USER -ScriptBlock {
    param($User)
    $o = @()
    $o += "node: $(Test-Path 'C:\Program Files\nodejs\node.exe') · ffmpeg: $(Test-Path 'C:\ATAK\replay-render\bin\ffmpeg.exe') · .env: $(Test-Path 'C:\ATAK\replay-render\.env')"
    $o += "lanzador existía: $(Test-Path 'C:\ATAK\iniciar-worker.cmd')"
    $jl = (Get-Volume | Where-Object FileSystemLabel -eq 'JUEGO' | Select-Object -First 1).DriveLetter
    $o += "disco JUEGO: $jl · exe: $(Test-Path "$($jl):\Riot Games\League of Legends\Game\League of Legends.exe")"
    $cmd = "@echo off`r`nsetlocal`r`nset `"LOL_DIR=$($jl):\Riot Games\League of Legends`"`r`nset ATAK_QUIET=1`r`ncd /d C:\ATAK\replay-render`r`nif not exist out mkdir out`r`necho %DATE% %TIME% lanzador iniciado>> out\worker.log`r`n`"C:\Program Files\nodejs\node.exe`" render.mjs --tournament lqc-2026 --watch --direct >> out\worker.log 2>&1`r`n"
    Set-Content -Path 'C:\ATAK\iniciar-worker.cmd' -Value $cmd -Encoding ASCII
    $o += "tarea antes: " + ((schtasks /Query /TN 'ATAK Render' /V /FO LIST 2>&1 | Select-String 'Estado de la tarea|Task State|Resultado|Last Result|Ejecutar como|Run As|Tarea que se ejecutar|Task To Run' | ForEach-Object { $_.Line.Trim() }) -join ' · ')
    schtasks /Delete /TN 'ATAK Render' /F 2>$null | Out-Null
    $o += "crear tarea: " + ((schtasks /Create /TN 'ATAK Render' /SC ONLOGON /RU $User /RL HIGHEST /F /TR 'C:\ATAK\iniciar-worker.cmd' 2>&1) -join ' ')
    $o += "ejecutar ahora: " + ((schtasks /Run /TN 'ATAK Render' 2>&1) -join ' ')
    Start-Sleep 75
    $o += "procesos: " + ((Get-Process node, 'League of Legends' -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName + '(' + $_.Id + ')' }) -join ', ')
    $o += "--- worker.log:"
    if (Test-Path 'C:\ATAK\replay-render\out\worker.log') { $o += Get-Content 'C:\ATAK\replay-render\out\worker.log' -Tail 30 } else { $o += '(no existe)' }
    $o
  }
  $r | ForEach-Object { W $_ }
  Remove-PSSession $s
} catch { W "error: $($_.Exception.Message)" }
W "fin"
