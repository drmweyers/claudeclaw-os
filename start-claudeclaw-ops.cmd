@echo off
cd /d "C:\Users\drmwe\Claude\claudeclaw-os"
call npm start -- --agent ops >> "%USERPROFILE%\claudeclaw-ops.log" 2>&1
