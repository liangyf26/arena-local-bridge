@echo off
rem 停止本地桥：按监听端口找到 node 进程，整树结束（含其 Chrome）
set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :20140 ^| findstr LISTENING') do (
  taskkill /PID %%p /T /F >nul 2>&1
  set FOUND=1
)
if "%FOUND%"=="1" (
  echo [arena-bridge] stopped.
) else (
  echo [arena-bridge] not running.
)
