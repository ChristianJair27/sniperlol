@echo off
rem Prueba: 2 clips de Hive vs Galaxy (juego 2 de la ronda 6), sin borrar los archivos.
cd /d "%~dp0"
title ATAK render worker (prueba)
node render.mjs --game 1753784829 --top 2 --keep --direct
pause
