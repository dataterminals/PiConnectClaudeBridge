@echo off
REM Starts the MCP sidecar in the foreground. Claude Code normally launches this itself once the
REM server is registered; run it by hand when you want to watch the log.
cd /d "%~dp0..\sidecar"
node src\server.js %*
