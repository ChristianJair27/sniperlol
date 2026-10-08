# ATAK.GG · VM de render: ver qué hace el worker dentro de la VM (registro, procesos, GPU) y abrir su consola.
# Se eleva solo. Resultado en logs\ver-worker.txt (+ captura logs\vmconnect.png)
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here (Join-Path 'logs' 'ver-worker.txt')
Set-Content -Path $out -Value "hora: $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function W($t) { Add-Content -Path $out -Value $t -Encoding UTF8 }
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$cred = New-Object System.Management.Automation.PSCredential($cfg.RENDER_VM_USER, (ConvertTo-SecureString $cfg.RENDER_VM_PASS -AsPlainText -Force))
try {
  $vm = Get-VM -Name $Name
  W "vm: $($vm.State) · uptime $($vm.Uptime) · cpu $($vm.CPUUsage)%"
  $s = $null
  for ($i = 0; $i -lt 12 -and -not $s; $i++) { try { $s = New-PSSession -VMName $Name -Credential $cred -ErrorAction Stop } catch { Start-Sleep 5 } }
  if (-not $s) { W "sin PowerShell Direct (¿VM arrancando?)" } else {
    $r = Invoke-Command -Session $s -ScriptBlock {
      $o = @()
      $o += "usuario con sesión: $((Get-CimInstance Win32_ComputerSystem).UserName)"
      $o += "gpu: $((Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + ' [' + $_.Status + ']' }) -join ' | ')"
      $o += "disco JUEGO: $((Get-Volume | Where-Object FileSystemLabel -eq 'JUEGO' | Select-Object -First 1).DriveLetter)"
      $o += "procesos: " + ((Get-Process node, 'League of Legends', ffmpeg -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessName + '(' + $_.Id + ')' }) -join ', ')
      $o += "tarea: " + ((schtasks /Query /TN 'ATAK Render' /FO LIST 2>&1 | Select-String 'Estado|Status|Última|Last Run' | ForEach-Object { $_.Line.Trim() }) -join ' · ')
      $o += "puerto 2999: " + ($(if ((netstat -ano -p tcp | Select-String ':2999\s+\S+\s+LISTENING')) { 'ocupado (juego abierto)' } else { 'libre' }))
      $o += "--- worker.log (cola):"
      if (Test-Path 'C:\ATAK\replay-render\out\worker.log') { $o += Get-Content 'C:\ATAK\replay-render\out\worker.log' -Tail 25 } else { $o += '(no existe aún)' }
      $o += "--- r3dlog más reciente:"
      $lg = Get-ChildItem 'C:\Riot Games\League of Legends\Logs\GameLogs' -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
      if (-not $lg) { $jl = (Get-Volume | Where-Object FileSystemLabel -eq 'JUEGO' | Select-Object -First 1).DriveLetter; $lg = Get-ChildItem "$($jl):\Riot Games\League of Legends\Logs\GameLogs" -Directory -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
      if ($lg) { $o += "  $($lg.FullName)"; $o += Get-ChildItem $lg.FullName -Filter '*r3dlog.txt' | ForEach-Object { Get-Content $_.FullName | Select-String 'Adapter|Failed|Error|Replay|ALWAYS\|.*CFG' | Select-Object -First 14 | ForEach-Object { '  ' + $_.Line } } } else { $o += '  (sin logs del juego)' }
      $o
    }
    $r | ForEach-Object { W $_ }
    Remove-PSSession $s
  }
  if (-not (Get-Process vmconnect -ErrorAction SilentlyContinue)) { Start-Process vmconnect.exe -ArgumentList 'localhost', $Name; Start-Sleep 8 }
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $here (Join-Path 'logs' 'vmconnect.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  W "captura: logs\vmconnect.png"
} catch { W "error: $($_.Exception.Message)" }
W "fin"
