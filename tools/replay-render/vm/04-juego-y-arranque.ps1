# ATAK.GG · VM de render (paso 4): disco virtual con el juego + inicio de sesión automático + tarea del worker.
# Sustituye la copia por red (SMB pide credenciales). Se eleva solo. Registro en logs\04-juego.log
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoExit -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
New-Item -ItemType Directory -Force -Path (Join-Path $here 'logs') | Out-Null
Add-Content -Path (Join-Path $here (Join-Path 'logs' 'arranques.txt')) -Value "04 elevado iniciado $(Get-Date -Format 'HH:mm:ss') admin=$(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"
New-Item -ItemType Directory -Force -Path (Join-Path $here 'logs') | Out-Null
Start-Transcript -Path (Join-Path $here (Join-Path 'logs' ('04-juego-' + (Get-Date -Format 'HHmmss') + '.log'))) | Out-Null
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$VmPath = if ($cfg.VM_PATH) { $cfg.VM_PATH } else { 'D:\ATAK-RenderVM' }
$User = $cfg.RENDER_VM_USER; $Pass = $cfg.RENDER_VM_PASS
$cred = New-Object System.Management.Automation.PSCredential($User, (ConvertTo-SecureString $Pass -AsPlainText -Force))
Write-Host "== ATAK Render VM · paso 4: disco del juego + arranque automático ==" -ForegroundColor Cyan

# ── 1) VHDX con el juego (desde la instalación del host) ─────────────────────
$gameVhd = Join-Path $VmPath 'juego.vhdx'
$attached = Get-VMHardDiskDrive -VMName $Name | Where-Object { $_.Path -eq $gameVhd }
if ($attached) { $attached | Remove-VMHardDiskDrive; Write-Host "Disco del juego desconectado de la VM para actualizarlo." }
if (Test-Path $gameVhd) { Dismount-VHD -Path $gameVhd -ErrorAction SilentlyContinue }
if (-not (Test-Path $gameVhd)) { New-VHD -Path $gameVhd -SizeBytes 80GB -Dynamic | Out-Null; $new = $true } else { $new = $false }
$disk = Mount-VHD -Path $gameVhd -PassThru | Get-Disk
if ($new -or $disk.PartitionStyle -eq 'RAW') {
  $disk | Initialize-Disk -PartitionStyle GPT -PassThru | New-Partition -UseMaximumSize -AssignDriveLetter | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'JUEGO' -Confirm:$false | Out-Null
}
$letter = ($disk | Get-Partition | Get-Volume | Where-Object DriveLetter | Select-Object -First 1).DriveLetter
if (-not $letter) { $part = $disk | Get-Partition | Where-Object Type -ne 'Reserved' | Select-Object -First 1; $part | Add-PartitionAccessPath -AssignDriveLetter; $letter = ($part | Get-Volume).DriveLetter }
$dst = "$($letter):\Riot Games\League of Legends"
Write-Host "Copiando el juego a $dst (unos 30 GB, varios minutos)…"
robocopy "C:\Riot Games\League of Legends\Game" "$dst\Game" /MIR /R:1 /W:2 /MT:16 /NFL /NDL /NP /NJH /XD Logs | Out-Null
robocopy "C:\Riot Games\League of Legends\Config" "$dst\Config" /E /R:1 /W:2 /NFL /NDL /NP /NJH /XF PersistedSettings.json | Out-Null
# Permisos amplios en el disco del juego (lo usa el usuario de la VM) y edición de la configuración
# a partir de la copia del host (la copia en el VHDX puede quedar con ACL restrictiva).
icacls "$($letter):\Riot Games" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q | Out-Null
$gc = Join-Path $dst 'Config\game.cfg'
$txt = [IO.File]::ReadAllText('C:\Riot Games\League of Legends\Config\game.cfg')
$txt = $txt -replace '(?m)^WindowMode=.*$', 'WindowMode=1' -replace '(?m)^Width=.*$', 'Width=1920' -replace '(?m)^Height=.*$', 'Height=1080'
if ($txt -notmatch '(?mi)^EnableReplayApi=1') { $txt = $txt -replace '(?m)^\[General\]\s*$', "[General]`r`nEnableReplayApi=1" }
[IO.File]::WriteAllText($gc, $txt, [Text.Encoding]::ASCII)
$gb = [math]::Round((Get-ChildItem $dst -Recurse -File | Measure-Object Length -Sum).Sum / 1GB, 1)
Dismount-VHD -Path $gameVhd
Add-VMHardDiskDrive -VMName $Name -Path $gameVhd
Write-Host "Disco del juego ($gb GB) conectado a la VM." -ForegroundColor Green

# ── 2) Dentro de la VM: autologon, lanzador y tarea ───────────────────────────
if ((Get-VM -Name $Name).State -ne 'Running') { Start-VM -Name $Name; Start-Sleep 30 }
$s = $null
for ($i = 0; $i -lt 30 -and -not $s; $i++) { try { $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop } catch { Start-Sleep 10 } }
if (-not $s) { throw "No pude entrar a la VM por PowerShell Direct" }
Copy-Item -ToSession $s -Path (Join-Path $root 'render.mjs') -Destination 'C:\ATAK\replay-render\render.mjs' -Force
Invoke-Command -Session $s -ArgumentList $User, $Pass -ScriptBlock {
  param($User, $Pass)
  # Inicio de sesión automático (el worker necesita escritorio)
  $wl = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
  Set-ItemProperty $wl -Name AutoAdminLogon -Value '1'
  Set-ItemProperty $wl -Name DefaultUserName -Value $User
  Set-ItemProperty $wl -Name DefaultPassword -Value $Pass
  Set-ItemProperty $wl -Name DefaultDomainName -Value $env:COMPUTERNAME
  Remove-ItemProperty $wl -Name AutoLogonCount -ErrorAction SilentlyContinue
  # Sin bloqueo de pantalla / sin contraseña al despertar
  New-Item -Path 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' -Force | Out-Null
  Set-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' -Name NoLockScreen -Value 1 -Type DWord
  powercfg /change standby-timeout-ac 0 | Out-Null; powercfg /change monitor-timeout-ac 0 | Out-Null
  powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 | Out-Null
  # Disco del juego en línea
  Get-Disk | Where-Object { $_.OperationalStatus -eq 'Offline' } | Set-Disk -IsOffline $false -ErrorAction SilentlyContinue
  # Lanzador del worker: localiza la unidad JUEGO y arranca el vigilante
  $cmd = @'
@echo off
setlocal
for /f "tokens=*" %%L in ('powershell -NoProfile -Command "(Get-Volume | Where-Object FileSystemLabel -eq 'JUEGO' | Select-Object -First 1).DriveLetter"') do set JL=%%L
if "%JL%"=="" (echo no encuentro el disco JUEGO >> C:\ATAK\replay-render\out\worker.log & exit /b 1)
set "LOL_DIR=%JL%:\Riot Games\League of Legends"
set ATAK_QUIET=1
cd /d C:\ATAK\replay-render
if not exist out mkdir out
"C:\Program Files\nodejs\node.exe" render.mjs --tournament lqc-2026 --watch --direct >> out\worker.log 2>&1
'@
  New-Item -ItemType Directory -Force -Path 'C:\ATAK\replay-render\out' | Out-Null
  Set-Content -Path 'C:\ATAK\iniciar-worker.cmd' -Value $cmd -Encoding ASCII
  schtasks /Delete /TN "ATAK Render" /F 2>$null | Out-Null
  schtasks /Create /TN "ATAK Render" /SC ONLOGON /RU $User /RL HIGHEST /F /TR "C:\ATAK\iniciar-worker.cmd" | Out-String | Write-Output
  Write-Output "GPU en la VM: $((Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ' | ')"
} | ForEach-Object { "  [vm] $_" }
Remove-PSSession $s
Restart-VM -Name $Name -Force
Write-Host ""
Write-Host "VM reiniciando con inicio de sesión automático; el worker arranca solo al entrar al escritorio." -ForegroundColor Green
Write-Host "Comprueba en 2-3 min: logs\04-juego.log y la consola de la VM."
Stop-Transcript | Out-Null
