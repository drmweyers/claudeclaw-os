@echo off
cd /d "C:\Users\drmwe\Claude\claudeclaw-os"
call npm start -- --agent content >> "%USERPROFILE%\claudeclaw-content.log" 2>&1
