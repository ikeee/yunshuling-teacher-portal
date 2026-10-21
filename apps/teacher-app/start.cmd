@echo off
title Bilibili Downloader (yutto web)
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 app.py
) else (
  python app.py
)
echo.
echo Server stopped. Press any key to close.
pause >nul
