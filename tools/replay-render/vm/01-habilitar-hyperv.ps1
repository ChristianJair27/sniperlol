# ATAK.GG · VM de render (paso 1/3): habilitar Hyper-V en el host. REQUIERE ADMIN y un REINICIO.
# Si no somos administrador, relanzar elevado (aparece el aviso de Windows para aceptar).
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Start-Process powershell.exe -Verb RunAs -ArgumentList ('-NoExit -ExecutionPolicy Bypass -File "' + $MyInvocation.MyCommand.Path + '"' + ($(if ($args.Count) { ' ' + ($args -join ' ') } else { '' })))
  exit
}
$ErrorActionPreference = 'Stop'
Write-Host "== ATAK Render VM · paso 1: Hyper-V ==" -ForegroundColor Cyan
$f = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All
if ($f.State -eq 'Enabled') { Write-Host "Hyper-V ya está habilitado." -ForegroundColor Green; exit 0 }
Write-Host "Habilitando Hyper-V (plataforma + herramientas)…"
$r = Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart
Write-Host ("Hecho. Reinicio necesario: {0}" -f $r.RestartNeeded) -ForegroundColor Yellow
Write-Host "Reinicia la PC cuando puedas y luego ejecuta 02-crear-vm.ps1 (también como administrador)."
Read-Host "Pulsa Enter para cerrar"
