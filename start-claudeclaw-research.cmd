@echo off
cd /d "C:\Users\drmwe\Claude\claudeclaw-os"
call npm start -- --agent research >> "%USERPROFILE%\claudeclaw-research.log" 2>&1
