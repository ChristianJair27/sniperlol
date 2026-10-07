# ATAK.GG · VM de render: quitar la GPU particionada durante la instalación de Windows (el instalador
# se queda en negro con el adaptador GPU-P presente; se vuelve a añadir en 03-preparar-guest.ps1),
# reiniciar desde la ISO pulsando una tecla y dejar el estado en logs\sin-gpu.txt. Se eleva solo.
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'logs\sin-gpu.txt'
Set-Content -Path $out -Value "hora: $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function W($t) { Add-Content -Path $out -Value $t -Encoding UTF8 }
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
try {
  if ((Get-VM -Name $Name).State -ne 'Off') { Stop-VM -Name $Name -TurnOff -Force; Start-Sleep 3 }
  $n = (Get-VMGpuPartitionAdapter -VMName $Name | Measure-Object).Count
  if ($n) { Remove-VMGpuPartitionAdapter -VMName $Name; W "GPU particionada quitada ($n) hasta que Windows esté instalado" } else { W "sin GPU particionada (ya quitada)" }
  Start-VM -Name $Name
  W "VM arrancada; pulsando Enter 40 s"
  $vmwmi = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$Name'"
  $kb = Get-CimAssociatedInstance -InputObject $vmwmi -ResultClassName Msvm_Keyboard | Select-Object -First 1
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt 40) { Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = 13 } | Out-Null; Start-Sleep -Milliseconds 400 }
  if (-not (Get-Process vmconnect -ErrorAction SilentlyContinue)) { Start-Process vmconnect.exe -ArgumentList 'localhost', $Name }
  Start-Sleep 60
  $vhd = Get-VMHardDiskDrive -VMName $Name | Where-Object { $_.Path -like '*ATAK-Render.vhdx' } | Select-Object -First 1
  W "disco de la VM: $([math]::Round((Get-Item $vhd.Path).Length/1MB)) MB"
} catch { W "error: $($_.Exception.Message)" }
W "fin"
