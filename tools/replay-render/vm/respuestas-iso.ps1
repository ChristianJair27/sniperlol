# ATAK.GG · VM de render: usar respuestas.iso como 2.º DVD (Setup no lee autounattend desde un disco duro),
# reiniciar y pulsar una tecla para arrancar desde la ISO de Windows. Se eleva solo. Resultado en logs\respuestas-iso.txt
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'logs\respuestas-iso.txt'
Set-Content -Path $out -Value "hora: $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function W($t) { Add-Content -Path $out -Value $t -Encoding UTF8 }
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$VmPath = if ($cfg.VM_PATH) { $cfg.VM_PATH } else { 'D:\ATAK-RenderVM' }
try {
  if ((Get-VM -Name $Name).State -ne 'Off') { Stop-VM -Name $Name -TurnOff -Force; Start-Sleep 3 }
  Get-VMHardDiskDrive -VMName $Name | Where-Object { $_.Path -like '*respuestas.vhdx' } | Remove-VMHardDiskDrive
  W "vhdx de respuestas quitado"
  if (-not (Get-VMDvdDrive -VMName $Name | Where-Object { $_.Path -like '*respuestas.iso' })) { Add-VMDvdDrive -VMName $Name -Path (Join-Path $VmPath 'respuestas.iso') }
  W "respuestas.iso montada como DVD"
  $dvds = Get-VMDvdDrive -VMName $Name
  $win = $dvds | Where-Object { $_.Path -like '*Windows11.iso' }
  $os = Get-VMHardDiskDrive -VMName $Name | Where-Object { $_.Path -like '*ATAK-Render.vhdx' }
  Set-VMFirmware -VMName $Name -BootOrder $win, $os
  W "orden de arranque: Windows11.iso > disco"
  Start-VM -Name $Name
  W "VM arrancada; pulsando Enter 40 s"
  $vmwmi = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$Name'"
  $kb = Get-CimAssociatedInstance -InputObject $vmwmi -ResultClassName Msvm_Keyboard | Select-Object -First 1
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt 40) { Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = 13 } | Out-Null; Start-Sleep -Milliseconds 400 }
  W "listo"
} catch { W "error: $($_.Exception.Message)" }
& (Join-Path $here 'estado.ps1')
