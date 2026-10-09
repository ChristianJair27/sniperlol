# ATAK.GG · VM de render: la deja "dedicada pero educada" con el host y la enciende.
#   · GPU: la partición baja al 30 % (antes 50 %) → el host conserva el 70 %.
#   · CPU: 4 núcleos, tope del 50 % y peso bajo → si el host necesita CPU, gana el host.
#   · RAM: 10 GB fijos.
# Se eleva solo (UAC). Registro en logs\limitar-<hora>.log
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
New-Item -ItemType Directory -Force (Join-Path $here 'logs') | Out-Null
Start-Transcript -Path (Join-Path $here (Join-Path 'logs' ('limitar-' + (Get-Date -Format 'HHmmss') + '.log'))) | Out-Null
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$GpuPercent = 30; $Cpu = 4; $CpuMax = 50; $MemGB = 10

Write-Host "== ATAK Render VM · limitar recursos y encender ==" -ForegroundColor Cyan
$vm = Get-VM -Name $Name
if ($vm.State -ne 'Off') { Write-Host "Apagando la VM para cambiar CPU/GPU…"; Stop-VM -Name $Name -Force; $i = 0; while ((Get-VM -Name $Name).State -ne 'Off' -and $i -lt 60) { Start-Sleep 2; $i++ } }

Set-VM -Name $Name -ProcessorCount $Cpu -MemoryStartupBytes ($MemGB * 1GB) -AutomaticStartAction Start -AutomaticStartDelay 60 -AutomaticStopAction ShutDown
Set-VMMemory -VMName $Name -DynamicMemoryEnabled $false -StartupBytes ($MemGB * 1GB)
Set-VMProcessor -VMName $Name -Count $Cpu -Maximum $CpuMax -Reserve 0 -RelativeWeight 50
Write-Host "CPU: $Cpu núcleos, tope $CpuMax %, peso bajo. RAM: $MemGB GB."

$max = [math]::Round(1000000000 / 100 * $GpuPercent); $min = [math]::Round($max * 0.8)
if (-not (Get-VMGpuPartitionAdapter -VMName $Name -ErrorAction SilentlyContinue)) { Add-VMGpuPartitionAdapter -VMName $Name }
Set-VMGpuPartitionAdapter -VMName $Name -MinPartitionVRAM $min -MaxPartitionVRAM $max -OptimalPartitionVRAM $max -MinPartitionEncode $min -MaxPartitionEncode $max -OptimalPartitionEncode $max -MinPartitionDecode $min -MaxPartitionDecode $max -OptimalPartitionDecode $max -MinPartitionCompute $min -MaxPartitionCompute $max -OptimalPartitionCompute $max
Write-Host "GPU: partición al $GpuPercent %."

Start-VM -Name $Name
Write-Host "VM encendida. En 2-3 minutos el agente y el worker arrancan solos." -ForegroundColor Green
Get-VM -Name $Name | Select-Object Name, State, ProcessorCount, @{n='GB';e={[int]($_.MemoryStartup/1GB)}} | Format-Table -AutoSize
Stop-Transcript | Out-Null
Start-Sleep 8
