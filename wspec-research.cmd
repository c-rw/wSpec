@echo off
setlocal
set SCRIPT_DIR=%~dp0
node "%SCRIPT_DIR%wspec\mcp\dist\cli.js" workflow research %*
