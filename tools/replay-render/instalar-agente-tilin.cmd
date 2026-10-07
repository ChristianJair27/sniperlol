@echo off
rem ATAK.GG - instala el agente de la sesion de render (ejecutar UNA vez DENTRO de la sesion de tilin).
rem Registra una tarea que arranca el agente al iniciar sesion y lo arranca ahora mismo.
cd /d "%~dp0"
schtasks /Delete /TN "ATAK Agent" /F >nul 2>&1
schtasks /Create /TN "ATAK Agent" /SC ONLOGON /RL LIMITED /F /TR "\"C:\Program Files
odejs
ode.exe\" \"%~dp0agent.mjs\""
start "ATAK Agent" /MIN "C:\Program Files
odejs
ode.exe" "%~dp0agent.mjs"
echo.
echo Agente ATAK instalado y corriendo en esta sesion (%USERNAME%).
echo Ya puedes cambiar de usuario y volver a tu perfil; NO cierres esta sesion.
echo.
pause
