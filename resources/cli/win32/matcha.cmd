@echo off
setlocal

rem Switch console to UTF-8 so Unicode box-drawing and CJK text render correctly
rem on non-English Windows (e.g. Chinese CP936). Save the previous codepage to restore later.
for /f "tokens=2 delims=:." %%a in ('chcp') do set /a "_CP=%%a" 2>nul
chcp 65001 >nul 2>&1

set "MATCHA_ENTRY=%~dp0..\app.asar\runtime-host\build\main-cli.js"

set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\MatchaClaw.exe" "%MATCHA_ENTRY%" %*
set _EXIT=%ERRORLEVEL%

if defined _CP chcp %_CP% >nul 2>&1

endlocal & exit /b %_EXIT%
