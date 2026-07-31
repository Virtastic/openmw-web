@echo off
REM Double-click this on Windows to start openmw-web.
REM It just runs server.py from this folder - nothing is installed.
cd /d "%~dp0"
where python >nul 2>&1 || (
  echo Python 3 is required but was not found.
  echo Install it from https://www.python.org/downloads/ - tick "Add python.exe to PATH" -
  echo then double-click this again.
  pause
  exit /b 1
)
python server.py
pause
