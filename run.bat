@echo off
title Box Video Transcriber
set NODE="%~dp0node-v24.15.0-win-x64\node.exe"

if not exist %NODE% (
    echo ERROR: Node.js not found. Please run install.bat first.
    pause
    exit /b 1
)

if not exist "%~dp0.env" (
    echo ERROR: .env file not found.
    echo Copy .env.example to .env and fill in your credentials.
    pause
    exit /b 1
)

if not exist "%~dp0box_jwt_config.json" (
    echo ERROR: box_jwt_config.json not found.
    echo This file must be in the same folder as run.bat.
    pause
    exit /b 1
)

if not exist "%~dp0transcribe_timestamps.js" (
    echo ERROR: transcribe_timestamps.js not found.
    echo Re-extract the update zip into this folder so it lands next to run.bat.
    pause
    exit /b 1
)

echo.
%NODE% "%~dp0transcribe_timestamps.js"
echo.
echo Press any key to close...
pause > nul
