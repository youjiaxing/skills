@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "NODE_BIN=%AGY_PROXY_NODE%"
if not defined NODE_BIN (
  for /f "delims=" %%I in ('where node 2^>nul') do (
    if not defined NODE_BIN set "NODE_BIN=%%I"
  )
)
if not exist "%NODE_BIN%" (
  echo [agy-proxy] Node.js ^>= 22.13 is required but was not found. 1>&2
  exit /b 127
)
"%NODE_BIN%" "%SCRIPT_DIR%agy-proxy.mjs" %*
exit /b %errorlevel%
