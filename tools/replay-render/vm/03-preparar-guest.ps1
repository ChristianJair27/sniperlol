# ATAK.GG · VM de render (paso 3/3): dentro de la VM ya con Windows: driver de la GPU, Node,
# worker, archivos del juego y tarea de arranque. Se ejecuta EN EL HOST (admin) y entra a la VM
# por PowerShell Direct con las credenciales de vm\.env. Se puede repetir sin problema.
# Si no somos administrador, relanzar elevado (aparece el aviso de Windows para aceptar).
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoExit -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"' + ($(if ($args.Count) { ' ' + ($args -join ' ') } else { '' })))
  exit
}
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs') | Out-Null
Start-Transcript -Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) (Join-Path 'logs' ([IO.Path]::GetFileNameWithoutExtension($MyInvocation.MyCommand.Path) + '.log'))) -Append | Out-Null
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here   # tools\replay-render
$cfg = @{}
Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$cred = New-Object System.Management.Automation.PSCredential($cfg.RENDER_VM_USER, (ConvertTo-SecureString $cfg.RENDER_VM_PASS -AsPlainText -Force))
Write-Host "== ATAK Render VM · paso 3: preparar '$Name' ==" -ForegroundColor Cyan

$vm = Get-VM -Name $Name
# GPU particionada: se quitó durante la instalación de Windows (pantalla negra en el instalador). Añadirla ahora.
if (-not (Get-VMGpuPartitionAdapter -VMName $Name -ErrorAction SilentlyContinue)) {
  Write-Host "Añadiendo la GPU particionada (la VM se apaga un momento)…"
  if ($vm.State -ne 'Off') { Stop-VM -Name $Name -Force; Start-Sleep 5 }
  $pct = 50; $max = [math]::Round(1000000000 / 100 * $pct); $min = [math]::Round($max * 0.8)
  Add-VMGpuPartitionAdapter -VMName $Name
  Set-VMGpuPartitionAdapter -VMName $Name -MinPartitionVRAM $min -MaxPartitionVRAM $max -OptimalPartitionVRAM $max -MinPartitionEncode $min -MaxPartitionEncode $max -OptimalPartitionEncode $max -MinPartitionDecode $min -MaxPartitionDecode $max -OptimalPartitionDecode $max -MinPartitionCompute $min -MaxPartitionCompute $max -OptimalPartitionCompute $max
  Set-VM -Name $Name -GuestControlledCacheTypes $true -LowMemoryMappedIoSpace 1GB -HighMemoryMappedIoSpace 32GB
  # Quitar la ISO de respuestas y la de Windows: ya no hacen falta
  Get-VMDvdDrive -VMName $Name | Remove-VMDvdDrive -ErrorAction SilentlyContinue
  $vm = Get-VM -Name $Name
}
if ($vm.State -ne 'Running') { Start-VM -Name $Name; Start-Sleep 30 }
Write-Host "Esperando a que la VM acepte PowerShell Direct (Windows instalado y sesión iniciada)…"
$s = $null
for ($i = 0; $i -lt 60 -and -not $s; $i++) {
  try { $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop } catch { Start-Sleep 10 }
}
if (-not $s) { throw "No pude entrar a la VM. ¿Terminó la instalación de Windows? Revisa en el Administrador de Hyper-V." }
Write-Host "Conectado a la VM." -ForegroundColor Green

# ── 1) Driver de la GPU del host → HostDriverStore de la VM (GPU-P) ─────────────
$disp = Get-CimInstance Win32_PnPSignedDriver | Where-Object { $_.DeviceClass -eq 'DISPLAY' -and $_.DeviceName -match 'NVIDIA|AMD|Radeon|Intel' } | Select-Object -First 1
$inf = $disp.InfName   # oemNN.inf
$pub = (pnputil /enum-drivers | Out-String) -split "(?=Nombre publicado|Published Name)" | Where-Object { $_ -match [regex]::Escape($inf) } | Select-Object -First 1
$orig = if ($pub -match '(?m)^(Nombre original|Original Name):\s*(\S+)') { $matches[2] } else { $null }
$folder = Get-ChildItem "$env:windir\System32\DriverStore\FileRepository" -Directory | Where-Object { $orig -and $_.Name -like "$($orig.Replace('.inf',''))_*" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $folder) { throw "No encontré la carpeta del driver de la GPU ($inf / $orig) en DriverStore" }
Write-Host "Driver GPU: $($disp.DeviceName) · $($folder.Name)"
Invoke-Command -Session $s { New-Item -ItemType Directory -Force -Path "$env:windir\System32\HostDriverStore\FileRepository" | Out-Null }
Copy-Item -ToSession $s -Path $folder.FullName -Destination "C:\Windows\System32\HostDriverStore\FileRepository\" -Recurse -Force
$prefix = if ($disp.DeviceName -match 'NVIDIA') { 'nv' } elseif ($disp.DeviceName -match 'AMD|Radeon') { 'amd' } else { 'ig' }
foreach ($sub in 'System32', 'SysWOW64') {
  $files = Get-ChildItem "$env:windir\$sub" -File | Where-Object { $_.Name -like "$prefix*.dll" -or $_.Name -like "$prefix*.exe" }
  foreach ($f in $files) { Copy-Item -ToSession $s -Path $f.FullName -Destination "C:\Windows\$sub\$($f.Name)" -Force -ErrorAction SilentlyContinue }
}
Write-Host "Driver copiado a la VM."

# ── 2) Worker + ffmpeg + token ──────────────────────────────────────────────────
Invoke-Command -Session $s { New-Item -ItemType Directory -Force -Path 'C:\ATAK\replay-render', 'C:\ATAK\replay-render\bin' | Out-Null }
foreach ($f in 'render.mjs', '.env', 'README.md') { Copy-Item -ToSession $s -Path (Join-Path $root $f) -Destination "C:\ATAK\replay-render\$f" -Force }
Copy-Item -ToSession $s -Path (Join-Path $root 'bin\ffmpeg.exe') -Destination 'C:\ATAK\replay-render\bin\ffmpeg.exe' -Force
Copy-Item -ToSession $s -Path (Join-Path $here 'guest\instalar-worker.ps1') -Destination 'C:\ATAK\instalar-worker.ps1' -Force
Copy-Item -ToSession $s -Path (Join-Path $here 'guest\sync-juego.cmd') -Destination 'C:\ATAK\sync-juego.cmd' -Force
# Configuración del juego para la VM: ventana 1920×1080 + Replay API
$gameCfg = Get-Content 'C:\Riot Games\League of Legends\Config\game.cfg' -Raw
$gameCfg = $gameCfg -replace '(?m)^WindowMode=.*$', 'WindowMode=1' -replace '(?m)^Width=.*$', 'Width=1920' -replace '(?m)^Height=.*$', 'Height=1080'
if ($gameCfg -notmatch '(?mi)^EnableReplayApi=1') { $gameCfg = $gameCfg -replace '(?m)^\[General\]\s*$', "[General]`r`nEnableReplayApi=1" }
Set-Content -Path (Join-Path $env:TEMP 'atak-game.cfg') -Value $gameCfg -Encoding ASCII
Copy-Item -ToSession $s -Path (Join-Path $env:TEMP 'atak-game.cfg') -Destination 'C:\ATAK\game.cfg' -Force

# ── 3) Dentro de la VM: Node, juego, tarea ──────────────────────────────────────
$hostIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -like 'vEthernet (Default Switch)*' } | Select-Object -First 1).IPAddress
if (-not $hostIp) { $hostIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -like 'vEthernet*' } | Select-Object -First 1).IPAddress }
Write-Host "Host visto desde la VM: \\$hostIp\RiotGames"
Invoke-Command -Session $s -ArgumentList $hostIp, $cfg.RENDER_VM_USER -ScriptBlock {
  param($hostIp, $user)
  & powershell -NoProfile -ExecutionPolicy Bypass -File 'C:\ATAK\instalar-worker.ps1' -HostIp $hostIp -User $user 2>&1 | ForEach-Object { "  [vm] $_" }
}
Remove-PSSession $s
Write-Host ""
Write-Host "VM lista. El worker arranca solo al iniciar sesión en la VM (ya está en marcha) y sincroniza el juego desde el host en cada parche." -ForegroundColor Green
Write-Host "Registro del worker: dentro de la VM en C:\ATAK\replay-render\out\worker.log (o por Hyper-V → Conectar)."
