#!/bin/bash
# Morning Brief Generator
# Daily digest of what happened overnight + what's ahead today
# Delivers via Telegram to Mark at 8am ET
#
# Designed as a "silver platter" — agents pre-digest the data,
# Mark reads the synthesis, not the raw JSON.

PROJECT_ROOT="C:/Users/drmwe/Claude/claudeclaw-os"
SECOND_BRAIN="C:/Users/drmwe/Claude/second-brain"
DATE=$(date +%Y-%m-%d)
BRIEF="/tmp/morning-brief-$DATE.md"

cat > "$BRIEF" << HEADER
Morning Brief — $DATE

HEADER

# ── What happened overnight (hive mind) ────────────────────────
echo "TEAM ACTIVITY (last 12h)" >> "$BRIEF"
echo "" >> "$BRIEF"

node -e "
const db = require('better-sqlite3')('$PROJECT_ROOT/store/claudeclaw.db');
const twelveHoursAgo = Math.floor(Date.now()/1000) - (12*60*60);
const rows = db.prepare('SELECT agent_id, action, summary FROM hive_mind WHERE created_at > ? ORDER BY created_at DESC').all(twelveHoursAgo);
if (rows.length === 0) { console.log('Quiet night. No agent activity.'); }
else { rows.forEach(r => console.log('- [' + r.agent_id + '] ' + r.action + ': ' + (r.summary||'').substring(0,100))); }
db.close();
" >> "$BRIEF" 2>/dev/null

echo "" >> "$BRIEF"

# ── Pending mission tasks ──────────────────────────────────────
echo "PENDING MISSIONS" >> "$BRIEF"
echo "" >> "$BRIEF"

node -e "
const db = require('better-sqlite3')('$PROJECT_ROOT/store/claudeclaw.db');
const rows = db.prepare(\"SELECT title, assigned_agent, status FROM mission_tasks WHERE status IN ('queued','in_progress')\").all();
if (rows.length === 0) { console.log('All clear. No pending tasks.'); }
else { rows.forEach(r => console.log('- ' + r.title + ' -> ' + (r.assigned_agent||'unassigned') + ' [' + r.status + ']')); }
db.close();
" >> "$BRIEF" 2>/dev/null

echo "" >> "$BRIEF"

# ── Git activity across projects ──────────────────────────────
echo "DEV ACTIVITY (last 24h)" >> "$BRIEF"
echo "" >> "$BRIEF"

for dir in "$HOME/Claude/SmartSocial" "$HOME/Claude/EvoFitTrainer" "$HOME/Claude/claudeclaw-os" "$HOME/Claude/RAG WebApp"; do
  if [ -d "$dir/.git" ]; then
    name=$(basename "$dir")
    count=$(git -C "$dir" log --oneline --since="24 hours ago" 2>/dev/null | wc -l)
    if [ "$count" -gt 0 ]; then
      latest=$(git -C "$dir" log --oneline -1 --format="%s" 2>/dev/null)
      echo "- $name: $count commits | Latest: $latest" >> "$BRIEF"
    fi
  fi
done

# Check if anything was written
DEV_LINES=$(grep -c "^-" <<< "$(tail -5 "$BRIEF")" 2>/dev/null)
if [ "${DEV_LINES:-0}" -eq 0 ]; then
  echo "No commits in the last 24h." >> "$BRIEF"
fi

echo "" >> "$BRIEF"

# ── Second brain updates (from Hal/Hermes) ────────────────────
echo "SECOND BRAIN UPDATES" >> "$BRIEF"
echo "" >> "$BRIEF"

cd "$SECOND_BRAIN"
git pull origin main --quiet 2>/dev/null

RECENT_CHANGES=$(git log --oneline --since="24 hours ago" --format="%s" 2>/dev/null)
if [ -n "$RECENT_CHANGES" ]; then
  echo "$RECENT_CHANGES" | while read -r line; do
    echo "- $line" >> "$BRIEF"
  done
else
  echo "No vault updates in the last 24h." >> "$BRIEF"
fi

echo "" >> "$BRIEF"

# ── Agent health ──────────────────────────────────────────────
echo "SYSTEM STATUS" >> "$BRIEF"
echo "" >> "$BRIEF"

# Check each scheduled task
for task in "ClaudeClaw" "ClaudeClaw-Research" "ClaudeClaw-Content" "ClaudeClaw-Ops"; do
  STATE=$(powershell.exe -Command "(Get-ScheduledTask -TaskName '$task').State" 2>/dev/null | tr -d '\r')
  if [ "$STATE" = "Running" ]; then
    echo "- $task: running" >> "$BRIEF"
  else
    echo "- $task: ${STATE:-unknown} (CHECK THIS)" >> "$BRIEF"
  fi
done

echo "" >> "$BRIEF"
echo "---" >> "$BRIEF"

# Output the brief (will be picked up by the ClaudeClaw scheduled task runner
# and delivered via Telegram)
cat "$BRIEF"
