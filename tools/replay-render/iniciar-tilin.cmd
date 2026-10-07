@echo off
rem ATAK.GG - worker de render de highlights (sesion "tilin").
rem Abre los replays directamente con el juego (sin cliente logueado), graba los
rem momentos clave y los sube. Se queda vigilando cada 10 min. Cerrar con Ctrl+C.
cd /d "%~dp0"
title ATAK render worker
node render.mjs --tournament lqc-2026 --watch --direct
pause
