# ATAK.GG · VM de render: reinicia la VM y "pulsa una tecla" para que arranque desde la ISO
# (la ISO de Microsoft pide "Press any key to boot from CD or DVD" y si nadie la pulsa salta el DVD).
# Se eleva solo. Deja el resultado en logs\arrancar-dvd.txt
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force -Path (Join-Path $here 'logs') | Out-Null
$out = Join-Path $here 'logs\arrancar-dvd.txt'
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$log = @("hora: $(Get-Date -Format 'HH:mm:ss')")
$vm = Get-VM -Name $Name
if ($vm.State -ne 'Off') { Stop-VM -Name $Name -TurnOff -Force; Start-Sleep 3 }
Start-VM -Name $Name
$log += "VM arrancada; enviando Enter durante 40 s…"
$vmwmi = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "ElementName='$Name'"
$kb = Get-CimAssociatedInstance -InputObject $vmwmi -ResultClassName Msvm_Keyboard | Select-Object -First 1
$t0 = Get-Date
while (((Get-Date) - $t0).TotalSeconds -lt 40) {
  try { Invoke-CimMethod -InputObject $kb -MethodName TypeKey -Arguments @{ keyCode = 13 } | Out-Null } catch { $log += "teclado: $($_.Exception.Message)"; break }
  Start-Sleep -Milliseconds 400
}
Start-Sleep 45
$vhd = Get-VMHardDiskDrive -VMName $Name | Where-Object { $_.Path -like '*.vhdx' -and $_.Path -notlike '*respuestas*' } | Select-Object -First 1
$log += "disco de la VM: $([math]::Round((Get-Item $vhd.Path).Length/1MB)) MB (si crece, Windows se está instalando)"
$log | Set-Content -Path $out -Encoding UTF8
& (Join-Path $here 'estado.ps1')
