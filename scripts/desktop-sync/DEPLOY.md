# Desktop Sync Deployment Guide

Get all three agents (Hal, Hermes, ClaudeClaw) reading from the same up-to-date second-brain.

## The Problem

- Hal and Hermes read from `D:\second-brain` on the desktop
- ClaudeClaw reads from `C:\Users\drmwe\Claude\second-brain\` on the laptop
- When any agent pushes, the desktop clone goes stale until someone manually pulls
- Hal's Docker mount is a bind-mount -- it sees whatever's on disk, but nobody's pulling

## The Fix

A 30-minute Task Scheduler job on the desktop that runs `git pull origin main` on `D:\second-brain`. Silent, no window, auto-recovers from merge conflicts.

---

## Step-by-step (5 minutes)

### 1. Copy files to desktop

Copy this entire `desktop-sync` folder to the desktop. Suggested location:

```
D:\scripts\desktop-sync\
```

It contains:
- `sync-second-brain.ps1` -- the sync script (runs every 30 min)
- `install-sync-task.ps1` -- one-time installer for the Task Scheduler job

### 2. Install the scheduled task

Open PowerShell **as Administrator** on the desktop:

```powershell
cd D:\scripts\desktop-sync
.\install-sync-task.ps1
```

### 3. Verify it works

```powershell
# Check the task exists
Get-ScheduledTask -TaskName SecondBrainSync

# Run it manually right now
Start-ScheduledTask -TaskName SecondBrainSync

# Check the log (wait 5 seconds)
Start-Sleep 5
Get-Content D:\second-brain-sync.log -Tail 5
```

You should see: `OK | No changes` or `PULLED | ...`

### 4. Update Hermes (ops agent)

On the laptop, the ops agent CLAUDE.md has already been updated (see below). Push ClaudeClaw to get the changes:

```bash
cd ~/Claude/claudeclaw-os
git add agents/ops/CLAUDE.md
git commit -m "ops: add second-brain sync protocol for Hermes"
git push origin master
```

Then on the desktop, pull the ClaudeClaw repo so Hermes picks up the new instructions.

---

## What each agent does now

| Agent | Pulls from | Frequency | How |
|-------|-----------|-----------|-----|
| Hal | `D:\second-brain` (Docker mount) | Every 30 min (host-level Task Scheduler) | `SecondBrainSync` task pulls, Hal sees it via bind-mount |
| Hermes | `D:\second-brain` (via ClaudeClaw ops agent) | Every 30 min (same host pull) + reads on demand | Same bind-mount benefit |
| ClaudeClaw | `C:\Users\drmwe\Claude\second-brain\` | Every 4 hours (cron task `1062172e`) | `git pull` in cron job |

## Troubleshooting

```powershell
# Check task status
Get-ScheduledTask -TaskName SecondBrainSync | Get-ScheduledTaskInfo

# Check log
Get-Content D:\second-brain-sync.log -Tail 20

# Manual pull
git -C D:\second-brain pull origin main

# Restart task after issues
Stop-ScheduledTask -TaskName SecondBrainSync
Start-ScheduledTask -TaskName SecondBrainSync

# Remove task entirely
Unregister-ScheduledTask -TaskName SecondBrainSync -Confirm:$false
```
