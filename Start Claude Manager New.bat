@echo off
title Munder Difflin V2
cd /d "%~dp0"

REM The launcher runs the whole app (server 4840, frontend 5840, canvas 4811/5811)
REM inside a Windows job object tied to THIS window. Closing this window — or
REM Ctrl+C — kills the entire app, so no hidden node/vite instance survives.
REM Chrome is launched outside the job and is never closed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"
