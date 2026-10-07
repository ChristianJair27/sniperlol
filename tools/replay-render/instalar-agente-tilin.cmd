@echo off
rem ATAK.GG - instala el agente de la sesion de render (ejecutar UNA vez DENTRO de la sesion de tilin).
rem Registra una tarea que arranca el agente al iniciar sesion y lo arranca ahora mismo.
cd /d "%~dp0"
if not exist "%~dp0out" mkdir "%~dp0out"
schtasks /Delete /TN "ATAK Agent" /F >nul 2>&1
schtasks /Create /TN "ATAK Agent" /SC ONLOGON /RL LIMITED /F /TR "cmd /c \"\"C:\Program Files\nodejs\node.exe\" \"%~dp0agent.mjs\" >> \"%~dp0out\agent.log\" 2>&1\""
start "ATAK Agent" /MIN cmd /c ""C:\Program Files\nodejs\node.exe" "%~dp0agent.mjs" >> "%~dp0out\agent.log" 2>&1"
echo.
echo Agente ATAK instalado y corriendo en esta sesion (%USERNAME%).
echo Ya puedes cambiar de usuario y volver a tu perfil; NO cierres esta sesion.
echo.
pause
