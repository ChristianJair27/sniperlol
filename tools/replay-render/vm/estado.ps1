# ATAK.GG · VM de render: estado + captura de pantalla de la VM (logs\vm.png). Se eleva solo.
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path (Join-Path $here 'logs') | Out-Null
$out = Join-Path $here 'logs\estado.txt'
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$vm = Get-VM -Name $Name
$lines = @()
$lines += "hora: $(Get-Date -Format 'HH:mm:ss')"
$lines += "estado: $($vm.State) · uptime: $($vm.Uptime) · cpu: $($vm.CPUUsage)% · mem: $([math]::Round($vm.MemoryAssigned/1GB,1)) GB"
$lines += "heartbeat: $((Get-VMIntegrationService -VMName $Name -Name Heartbeat).PrimaryStatusDescription)"
$lines += "ip: $(((Get-VMNetworkAdapter -VMName $Name).IPAddresses -join ', '))"
$lines += "gpu: $((Get-VMGpuPartitionAdapter -VMName $Name | Measure-Object).Count) adaptador(es) particionado(s)"
$lines += "boot: $((Get-VMFirmware -VMName $Name).BootOrder | ForEach-Object { $_.BootType + ':' + $_.Device.Name } | Out-String).Trim()"
# Captura de la pantalla de la VM
try {
  $vmwmi = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$Name'"
  $vssd = Get-CimAssociatedInstance -InputObject $vmwmi -ResultClassName Msvm_VirtualSystemSettingData | Where-Object { $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } | Select-Object -First 1
  $svc = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_VirtualSystemManagementService
  $w = 1024; $h = 576
  $r = Invoke-CimMethod -InputObject $svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{ TargetSystem = $vssd; WidthPixels = $w; HeightPixels = $h }
  if ($r.ReturnValue -eq 0 -and $r.ImageData) {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, $bmp.PixelFormat)
    [System.Runtime.InteropServices.Marshal]::Copy([byte[]]$r.ImageData, 0, $data.Scan0, $r.ImageData.Length)
    $bmp.UnlockBits($data)
    $bmp.Save((Join-Path $here 'logs\vm.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    $lines += "captura: logs\vm.png"
  } else { $lines += "captura: no disponible ($($r.ReturnValue))" }
} catch { $lines += "captura: error $($_.Exception.Message)" }
$lines | Set-Content -Path $out -Encoding UTF8
