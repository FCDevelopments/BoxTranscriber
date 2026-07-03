@echo off
title Box Video Transcriber - Setup
echo ============================================
echo        Box Video Transcriber Setup
echo ============================================
echo.

REM Use the bundled Node.js that ships with this package
set NODE="%~dp0node-v24.15.0-win-x64\node.exe"
set NPM="%~dp0node-v24.15.0-win-x64\node_modules\npm\bin\npm-cli.js"

if not exist %NODE% (
    echo ERROR: Bundled Node.js not found.
    echo Make sure you copied the FULL BoxTranscriber folder including
    echo the node-v24.15.0-win-x64 subfolder.
    echo.
    pause
    exit /b 1
)

echo Installing required packages...
echo.
set NODE_TLS_REJECT_UNAUTHORIZED=0
set PATH=%~dp0node-v24.15.0-win-x64;%PATH%
%NODE% %NPM% install --strict-ssl=false
if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: Package installation failed.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   Setup complete!
echo ============================================
echo.
echo Next steps:
echo   1. Open the .env file and fill in your credentials.
echo      (copy .env.example to .env if you have not already)
echo   2. Make sure box_jwt_config.json is in this folder.
echo   3. Double-click run.bat to start transcribing.
echo.
pause
