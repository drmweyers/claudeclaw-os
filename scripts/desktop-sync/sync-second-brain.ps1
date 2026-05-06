# sync-second-brain.ps1 — Keeps D:\second-brain in sync with GitHub
# Runs every 30 min via Task Scheduler on the DESKTOP computer.
# All agents (Hal, Hermes, ClaudeClaw) depend on this repo being current.
#
# What it does:
#   1. git pull origin main on D:\second-brain
#   2. Logs result to D:\second-brain-sync.log
#   3. Exits cleanly (no interactive prompts, no popups)
#
# Install: Run install-sync-task.ps1 as Administrator (one time)

$repoPath = "D:\second-brain"
$logFile  = "D:\second-brain-sync.log"
$branch   = "main"

# Timestamp helper
function ts { Get-Date -Format "yyyy-MM-dd HH:mm:ss" }

# Ensure repo exists
if (-not (Test-Path "$repoPath\.git")) {
    Add-Content $logFile "$(ts) | ERROR | $repoPath is not a git repo. Aborting."
    exit 1
}

try {
    # Pull latest
    $pullResult = git -C $repoPath pull origin $branch 2>&1
    $pullExit   = $LASTEXITCODE

    if ($pullExit -eq 0) {
        if ($pullResult -match "Already up to date") {
            Add-Content $logFile "$(ts) | OK | No changes"
        } else {
            # Log what changed
            $shortlog = ($pullResult | Select-Object -First 5) -join " | "
            Add-Content $logFile "$(ts) | PULLED | $shortlog"
        }
    } else {
        Add-Content $logFile "$(ts) | ERROR | git pull failed (exit $pullExit): $pullResult"

        # Auto-recover: if merge conflict, abort and retry
        if ($pullResult -match "CONFLICT|merge") {
            git -C $repoPath merge --abort 2>&1 | Out-Null
            Add-Content $logFile "$(ts) | RECOVERY | Aborted merge conflict. Manual fix needed."
        }
    }
} catch {
    Add-Content $logFile "$(ts) | EXCEPTION | $($_.Exception.Message)"
}
