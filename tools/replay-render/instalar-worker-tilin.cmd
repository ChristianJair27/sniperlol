@echo off
rem ATAK.GG - registra el worker de render para que arranque solo al iniciar sesion
rem ESTE usuario (ejecutar una vez DENTRO de la sesion de tilin) y lo arranca ahora.
cd /d "%~dp0"
schtasks /Delete /TN "ATAK Render" /F >nul 2>&1
schtasks /Create /TN "ATAK Render" /SC ONLOGON /RL LIMITED /F /TR "\"%~dp0iniciar-tilin.cmd\""
start "ATAK Render" /MIN "%~dp0iniciar-tilin.cmd"
echo.
echo Worker de render instalado y corriendo en esta sesion (%USERNAME%).
echo Ya puedes cambiar de usuario y volver a tu perfil; NO cierres esta sesion.
echo El registro queda en out\worker.log
echo.
pause
