# ATAK.GG · VM de render: estado + captura de pantalla de la VM (logs\vm.png). Se eleva solo.
# Escribe cada dato en cuanto lo tiene (logs\estado.txt), para poder seguirlo desde fuera.
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path (Join-Path $here 'logs') | Out-Null
$out = Join-Path $here 'logs\estado.txt'
Set-Content -Path $out -Value "hora: $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function W($t) { Add-Content -Path $out -Value $t -Encoding UTF8 }
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
try {
  $vm = Get-VM -Name $Name
  W "estado: $($vm.State) · uptime: $($vm.Uptime) · cpu: $($vm.CPUUsage)% · mem: $([math]::Round($vm.MemoryAssigned/1GB,1)) GB"
  W "heartbeat: $((Get-VMIntegrationService -VMName $Name -Name Heartbeat).PrimaryStatusDescription)"
  W "ip: $(((Get-VMNetworkAdapter -VMName $Name).IPAddresses -join ', '))"
  W "boot: $(((Get-VMFirmware -VMName $Name).BootOrder | ForEach-Object { $_.BootType.ToString() + ':' + $_.Device.Name }) -join ' > ')"
  W "discos: $(((Get-VMHardDiskDrive -VMName $Name).Path | ForEach-Object { Split-Path $_ -Leaf }) -join ', ') · dvd: $((Get-VMDvdDrive -VMName $Name).Path)"
} catch { W "error VM: $($_.Exception.Message)" }
try {
  $vmwmi = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$Name'"
  $vssd = Get-CimAssociatedInstance -InputObject $vmwmi -ResultClassName Msvm_VirtualSystemSettingData | Where-Object { $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } | Select-Object -First 1
  $svc = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemManagementService
  $w = 1024; $h = 576
  W "captura: pidiendo thumbnail…"
  $r = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{ TargetSystem = $vssd; WidthPixels = $w; HeightPixels = $h }
  if ($r.ReturnValue -eq 0 -and $r.ImageData) {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
    [System.Runtime.InteropServices.Marshal]::Copy([byte[]]$r.ImageData, 0, $data.Scan0, $r.ImageData.Length)
    $bmp.UnlockBits($data)
    $bmp.Save((Join-Path $here 'logs\vm.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    W "captura: logs\vm.png"
  } else { W "captura: no disponible ($($r.ReturnValue))" }
} catch { W "captura: error $($_.Exception.Message)" }
W "fin"
