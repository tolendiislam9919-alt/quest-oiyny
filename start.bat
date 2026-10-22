@echo off
chcp 65001 >nul
title Құпия есік — сервер
cd /d "%~dp0"

where python >nul 2>nul
if not errorlevel 1 goto withpython
where py >nul 2>nul
if not errorlevel 1 goto withpy

echo.
echo   Python табылмады. python.org сайтынан орнатыңыз
echo   (орнатқанда "Add python.exe to PATH" белгісін қойыңыз).
echo.
pause
exit /b

:withpython
python server.py
pause
exit /b

:withpy
py server.py
pause
