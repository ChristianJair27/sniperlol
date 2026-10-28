# ATAK.GG · VM de render: actualiza el juego de la VM al parche del host SIN perder el anterior
# (los replays solo abren con la versión con la que se jugaron), sube el worker nuevo y lo reinicia.
#   · Disco JUEGO: "Game" = parche actual, "Game-<major.minor>" = el anterior (se guarda solo uno).
#     El worker intercambia las carpetas por nombre según el parche de cada replay.
#   · Copia render.mjs / vod-clips.mjs / agent.mjs / config.json / assets a la VM.
#   · Reescribe el lanzador del agente con la IP actual del host (cambia en cada reinicio).
# Se eleva solo (un aviso UAC). Resultado en logs\actualizar-juego.txt
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Minimized -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$out = Join-Path $here (Join-Path 'logs' 'actualizar-juego.txt')
Set-Content -Path $out -Value "inicio: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -Encoding UTF8
function W($t) { Add-Content -Path $out -Value "$(Get-Date -Format 'HH:mm:ss') $t" -Encoding UTF8 }
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$VmPath = if ($cfg.VM_PATH) { $cfg.VM_PATH } else { 'D:\ATAK-RenderVM' }
$cred = New-Object System.Management.Automation.PSCredential($cfg.RENDER_VM_USER, (ConvertTo-SecureString $cfg.RENDER_VM_PASS -AsPlainText -Force))
$hostGame = 'C:\Riot Games\League of Legends\Game'
$mm = { param($v) ($v -split '\.')[0..1] -join '.' }
$hostVer = & $mm ((Get-Item (Join-Path $hostGame 'League of Legends.exe')).VersionInfo.FileVersion)
W "parche del host: $hostVer"

try {
  # ── 1) VM apagada y disco del juego montado en el host ─────────────────────
  $vm = Get-VM -Name $Name
  W "estado de la VM: $($vm.State)"
  if ($vm.State -ne 'Off') { Stop-VM -Name $Name -Force; $i = 0; while ((Get-VM -Name $Name).State -ne 'Off' -and $i -lt 90) { Start-Sleep 2; $i++ } }
  $gameVhd = Join-Path $VmPath 'juego.vhdx'
  Get-VMHardDiskDrive -VMName $Name | Where-Object { $_.Path -eq $gameVhd } | Remove-VMHardDiskDrive
  Dismount-VHD -Path $gameVhd -ErrorAction SilentlyContinue
  $disk = Mount-VHD -Path $gameVhd -PassThru | Get-Disk
  $letter = ($disk | Get-Partition | Get-Volume | Where-Object DriveLetter | Select-Object -First 1).DriveLetter
  if (-not $letter) { $part = $disk | Get-Partition | Where-Object Type -ne 'Reserved' | Select-Object -First 1; $part | Add-PartitionAccessPath -AssignDriveLetter; $letter = ($part | Get-Volume).DriveLetter }
  $dst = "$($letter):\Riot Games\League of Legends"
  $g = Join-Path $dst 'Game'
  $vmVer = & $mm ((Get-Item (Join-Path $g 'League of Legends.exe')).VersionInfo.FileVersion)
  W "parche en la VM: $vmVer (disco $($letter):)"

  # ── 2) Guardar la versión anterior y copiar la nueva ────────────────────────
  if ($vmVer -and $vmVer -ne $hostVer) {
    # Solo se conserva UNA versión anterior (el disco es de 80 GB).
    Get-ChildItem $dst -Directory -Filter 'Game-*' | Where-Object { $_.Name -ne "Game-$vmVer" -and $_.Name -ne "Game-$hostVer" } | ForEach-Object { W "borro la versión vieja $($_.Name)"; Remove-Item $_.FullName -Recurse -Force }
    $old = Join-Path $dst "Game-$vmVer"
    if (Test-Path $old) { Remove-Item $old -Recurse -Force }
    Rename-Item $g "Game-$vmVer"
    Set-Content -Path (Join-Path $old 'atak-version.txt') -Value $vmVer -Encoding ASCII
    $reuse = Join-Path $dst "Game-$hostVer"
    if (Test-Path $reuse) { Rename-Item $reuse 'Game'; W "reutilizo Game-$hostVer" }
    W "versión $vmVer guardada en Game-$vmVer; copiando $hostVer…"
  }
  robocopy $hostGame $g /MIR /R:1 /W:2 /MT:16 /NFL /NDL /NP /NJH /XD Logs /XF atak-version.txt | Out-Null
  robocopy 'C:\Riot Games\League of Legends\Config' (Join-Path $dst 'Config') /E /R:1 /W:2 /NFL /NDL /NP /NJH /XF game.cfg PersistedSettings.json | Out-Null
  Set-Content -Path (Join-Path $g 'atak-version.txt') -Value $hostVer -Encoding ASCII
  icacls $g /grant "*S-1-5-32-545:(OI)(CI)M" /T /C /Q | Out-Null
  $newVer = & $mm ((Get-Item (Join-Path $g 'League of Legends.exe')).VersionInfo.FileVersion)
  W "juego de la VM ahora: $newVer · carpetas: $((Get-ChildItem $dst -Directory -Filter 'Game*' | ForEach-Object Name) -join ', ')"
  $free = [math]::Round((Get-Volume -DriveLetter $letter).SizeRemaining / 1GB, 1)
  W "libre en el disco JUEGO: $free GB"
  Dismount-VHD -Path $gameVhd
  Add-VMHardDiskDrive -VMName $Name -Path $gameVhd

  # ── 3) Encender, subir el worker nuevo y reiniciar el agente ────────────────
  Start-VM -Name $Name
  W "VM encendida; esperando PowerShell Direct…"
  $hostIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -like 'vEthernet (Default Switch)*' } | Select-Object -First 1).IPAddress
  $s = $null
  for ($i = 0; $i -lt 40 -and -not $s; $i++) { Start-Sleep 6; try { $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop } catch { } }
  if (-not $s) { throw 'sin PowerShell Direct' }
  Invoke-Command -Session $s -ScriptBlock { Get-Process node, 'League of Legends' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
  foreach ($f in 'render.mjs', 'vod-clips.mjs', 'agent.mjs', 'config.json') { Copy-Item -ToSession $s -Path (Join-Path $root $f) -Destination "C:\ATAK\replay-render\$f" -Force }
  Invoke-Command -Session $s -ScriptBlock { New-Item -ItemType Directory -Force 'C:\ATAK\replay-render\assets' | Out-Null }
  Get-ChildItem (Join-Path $root 'assets') -File | ForEach-Object { Copy-Item -ToSession $s -Path $_.FullName -Destination "C:\ATAK\replay-render\assets\$($_.Name)" -Force }
  $r = Invoke-Command -Session $s -ArgumentList $hostIp -ScriptBlock {
    param($HostIp)
    $o = @()
    Set-Content -Path 'C:\ATAK\host-ip.txt' -Value $HostIp -Encoding ASCII
    $p = 'C:\ATAK\iniciar-agente.cmd'
    if (Test-Path $p) { $t = [IO.File]::ReadAllText($p) -replace 'AGENT_UPDATE_URL=http://[0-9.]+:8098', "AGENT_UPDATE_URL=http://$($HostIp):8098"; [IO.File]::WriteAllText($p, $t, [Text.Encoding]::ASCII) }
    Get-Disk | Where-Object { $_.OperationalStatus -eq 'Offline' } | Set-Disk -IsOffline $false -ErrorAction SilentlyContinue
    $jl = (Get-Volume | Where-Object FileSystemLabel -eq 'JUEGO' | Select-Object -First 1).DriveLetter
    $o += "disco JUEGO en la VM: $jl"
    Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    $o += "agente: " + ((schtasks /Run /TN 'ATAK Agent' 2>&1) -join ' ')
    Start-Sleep 8
    $o += "ip de la VM: " + ((Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } | Select-Object -ExpandProperty IPAddress) -join ', ')
    $o += "procesos: " + ((Get-Process node -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName + '(' + $_.Id + ')' }) -join ', ')
    $o
  }
  $r | ForEach-Object { W $_ }
  Remove-PSSession $s
  W "host (Default Switch): $hostIp"
} catch { W "ERROR: $($_.Exception.Message)" }
W 'fin'
