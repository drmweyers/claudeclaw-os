@echo off
cd /d "C:\Users\drmwe\Claude\claudeclaw-os"
echo === %DATE% %TIME% === >> "%USERPROFILE%\claudeclaw-vault-sync.log"
node dist/sync-vault-cli.js >> "%USERPROFILE%\claudeclaw-vault-sync.log" 2>&1
