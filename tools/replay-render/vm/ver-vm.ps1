# ATAK.GG · VM de render: abre la consola de la VM (vmconnect) y guarda una captura de la pantalla
# en logs\vmconnect.png para poder ver qué muestra la VM. Se eleva solo. Deja vmconnect abierto.
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"')
  exit
}
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here 'logs\ver-vm.txt'
Set-Content -Path $out -Value "hora: $(Get-Date -Format 'HH:mm:ss')" -Encoding UTF8
function W($t) { Add-Content -Path $out -Value $t -Encoding UTF8 }
$cfg = @{}; Get-Content (Join-Path $here '.env') | ForEach-Object { if ($_ -match '^\s*([A-Z_]+)\s*=\s*(.*)$') { $cfg[$matches[1]] = $matches[2].Trim().Trim('"') } }
$Name = if ($cfg.VM_NAME) { $cfg.VM_NAME } else { 'ATAK-Render' }
$vm = Get-VM -Name $Name
W "estado: $($vm.State) · uptime: $($vm.Uptime)"
if (-not (Get-Process vmconnect -ErrorAction SilentlyContinue)) { Start-Process vmconnect.exe -ArgumentList 'localhost', $Name; W "vmconnect abierto" } else { W "vmconnect ya estaba abierto" }
Start-Sleep 10
try {
  Add-Type -AssemblyName System.Windows.Forms,System.Drawing
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $here 'logs\vmconnect.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  W "captura: logs\vmconnect.png"
} catch { W "captura: error $($_.Exception.Message)" }
W "fin"
