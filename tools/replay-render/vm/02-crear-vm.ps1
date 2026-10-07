# ATAK.GG · VM de render (paso 2/3): crear la VM con GPU particionada e instalar Windows desatendido.
# REQUIERE ADMIN. Hyper-V ya habilitado (paso 1 + reinicio). Lee vm\.env (ISO, ruta, nombre, credenciales).
#
#   .\02-crear-vm.ps1                → crea la VM y la arranca; Windows se instala solo (10–20 min)
#   .\02-crear-vm.ps1 -GpuPercent 50 → porcentaje de la GPU para la VM (por defecto 50)
param([int]$GpuPercent = 50, [int]$MemoryGB = 12, [int]$Cpu = 6, [int]$DiskGB = 120)
# Si no somos administrador, relanzar elevado (aparece el aviso de Windows para aceptar).
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoExit -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"' + ($(if ($args.Count) { ' ' + ($args -join ' ') } else { '' })))
  exit
}
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'logs') | Out-Null
Start-Transcript -Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) (Join-Path 'logs' ([IO.Path]::GetFileNameWithoutExtension($MyInvocation.MyCommand.Path) + '.log'))) -Append | Out-Null
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = @{}
Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$VmPath = if ($cfg.VM_PATH) { $cfg.VM_PATH } else { 'D:\ATAK-RenderVM' }
$Iso = $cfg.VM_ISO
$User = $cfg.RENDER_VM_USER; $Pass = $cfg.RENDER_VM_PASS
if (-not $Iso -or -not (Test-Path $Iso)) { throw "VM_ISO en vm\.env no apunta a una ISO de Windows existente: '$Iso'" }
if (-not $User -or -not $Pass) { throw "Faltan RENDER_VM_USER / RENDER_VM_PASS en vm\.env" }
Write-Host "== ATAK Render VM · paso 2: crear '$Name' en $VmPath ==" -ForegroundColor Cyan

if (Get-VM -Name $Name -ErrorAction SilentlyContinue) { throw "La VM '$Name' ya existe. Bórrala (Remove-VM) o cambia VM_NAME en .env" }
New-Item -ItemType Directory -Force -Path $VmPath | Out-Null

# ── Disco de respuestas (autounattend.xml) ────────────────────────────────────
# Windows Setup busca autounattend.xml en la raíz de cualquier unidad: se le da un VHDX pequeño.
$xmlTpl = Get-Content (Join-Path $here 'autounattend.xml') -Raw
$xml = $xmlTpl.Replace('__USER__', $User).Replace('__PASS__', [System.Security.SecurityElement]::Escape($Pass))
$ansVhd = Join-Path $VmPath 'respuestas.vhdx'
if (Test-Path $ansVhd) { Remove-Item $ansVhd -Force }
New-VHD -Path $ansVhd -SizeBytes 64MB -Fixed | Out-Null
$disk = Mount-VHD -Path $ansVhd -PassThru | Get-Disk
$disk | Initialize-Disk -PartitionStyle MBR -PassThru | New-Partition -UseMaximumSize -AssignDriveLetter | Format-Volume -FileSystem FAT32 -NewFileSystemLabel 'RESP' -Confirm:$false | Out-Null
$letter = ($disk | Get-Partition | Get-Volume | Where-Object DriveLetter).DriveLetter
Set-Content -Path "$($letter):\autounattend.xml" -Value $xml -Encoding UTF8
Dismount-VHD -Path $ansVhd
Write-Host "Disco de respuestas listo ($ansVhd)."

# ── VM ─────────────────────────────────────────────────────────────────────────
$vhd = Join-Path $VmPath "$Name.vhdx"
$switch = (Get-VMSwitch | Where-Object { $_.Name -eq 'Default Switch' } | Select-Object -First 1)
if (-not $switch) { $switch = Get-VMSwitch | Select-Object -First 1 }
New-VM -Name $Name -Generation 2 -MemoryStartupBytes ($MemoryGB * 1GB) -NewVHDPath $vhd -NewVHDSizeBytes ($DiskGB * 1GB) -Path $VmPath -SwitchName $switch.Name | Out-Null
Set-VM -Name $Name -ProcessorCount $Cpu -CheckpointType Disabled -AutomaticStartAction Start -AutomaticStartDelay 60 -AutomaticStopAction ShutDown `
  -GuestControlledCacheTypes $true -LowMemoryMappedIoSpace 1GB -HighMemoryMappedIoSpace 32GB
Set-VMMemory -VMName $Name -DynamicMemoryEnabled $false
Set-VMVideo -VMName $Name -ResolutionType Single -HorizontalResolution 1920 -VerticalResolution 1080
# TPM + Secure Boot (Windows 11 los exige; no estorban con Windows 10)
Set-VMKeyProtector -VMName $Name -NewLocalKeyProtector
Enable-VMTPM -VMName $Name
Set-VMFirmware -VMName $Name -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
# Servicios de integración (PowerShell Direct + copia de archivos)
Enable-VMIntegrationService -VMName $Name -Name 'Guest Service Interface' -ErrorAction SilentlyContinue
# Discos: ISO de Windows + disco de respuestas
Add-VMDvdDrive -VMName $Name -Path $Iso
Add-VMHardDiskDrive -VMName $Name -Path $ansVhd
$dvd = Get-VMDvdDrive -VMName $Name
$os = Get-VMHardDiskDrive -VMName $Name | Where-Object Path -eq $vhd
Set-VMFirmware -VMName $Name -BootOrder $dvd, $os

# ── GPU particionada ───────────────────────────────────────────────────────────
$max = [math]::Round(1000000000 / 100 * $GpuPercent); $min = [math]::Round($max * 0.8)
Add-VMGpuPartitionAdapter -VMName $Name
Set-VMGpuPartitionAdapter -VMName $Name `
  -MinPartitionVRAM $min -MaxPartitionVRAM $max -OptimalPartitionVRAM $max `
  -MinPartitionEncode $min -MaxPartitionEncode $max -OptimalPartitionEncode $max `
  -MinPartitionDecode $min -MaxPartitionDecode $max -OptimalPartitionDecode $max `
  -MinPartitionCompute $min -MaxPartitionCompute $max -OptimalPartitionCompute $max
Write-Host "GPU particionada al $GpuPercent %."

# ── Carpeta compartida con los archivos del juego (solo lectura) ───────────────
if (-not (Get-SmbShare -Name 'RiotGames' -ErrorAction SilentlyContinue)) {
  New-SmbShare -Name 'RiotGames' -Path 'C:\Riot Games' -ReadAccess 'Everyone' -Description 'ATAK render VM: archivos del juego (solo lectura)' | Out-Null
  Write-Host "Recurso compartido \\$env:COMPUTERNAME\RiotGames creado (solo lectura)."
}

Start-VM -Name $Name
Write-Host ""
Write-Host "VM '$Name' creada y arrancando. Windows se instala solo (10–20 min); la VM se reinicia un par de veces." -ForegroundColor Green
Write-Host "Puedes mirarla en el Administrador de Hyper-V → Conectar. Cuando aparezca el escritorio, ejecuta 03-preparar-guest.ps1 (admin)."
