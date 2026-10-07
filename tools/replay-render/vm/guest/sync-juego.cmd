@echo off
rem Copia (espejo) los archivos del juego desde el host a la VM. Solo trae lo que cambió (parches).
setlocal
set /p HOSTIP=<C:\ATAK\host-ip.txt
robocopy "\\%HOSTIP%\RiotGames\League of Legends\Game" "C:\Riot Games\League of Legends\Game" /MIR /R:2 /W:5 /MT:16 /NFL /NDL /NP /XD Logs
robocopy "\\%HOSTIP%\RiotGames\League of Legends\Config" "C:\Riot Games\League of Legends\Config" /E /R:2 /W:5 /NFL /NDL /NP /XF game.cfg PersistedSettings.json
endlocal
exit /b 0
