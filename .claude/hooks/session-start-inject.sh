#!/bin/bash
# Session start hook: injects current system state and priorities
# Gives Claude immediate context without needing to search for it

PROJECT_ROOT="C:/Users/drmwe/Claude/claudeclaw-os"

# Get agent status
AGENTS_RUNNING=$(powershell.exe -Command "Get-ScheduledTask | Where-Object { \$_.TaskName -like 'ClaudeClaw*' -and \$_.State -eq 'Running' } | Select-Object -ExpandProperty TaskName" 2>/dev/null | tr '\n' ', ' | sed 's/, $//')

# Get recent hive mind activity (last 3 entries)
RECENT_ACTIVITY=$(node -e "
const db = require('better-sqlite3')('$PROJECT_ROOT/store/claudeclaw.db');
const rows = db.prepare(\"SELECT agent_id, action, summary FROM hive_mind ORDER BY created_at DESC LIMIT 3\").all();
rows.forEach(r => console.log('- [' + r.agent_id + '] ' + r.action + ': ' + (r.summary||'').substring(0,80)));
db.close();
" 2>/dev/null)

# Get BCI priorities from Business Brain (first 8 content lines)
SECOND_BRAIN="C:/Users/drmwe/Claude/second-brain"
BIZ_BRAIN=""
if [ -f "$SECOND_BRAIN/resources/BUSINESS-BRAIN.md" ]; then
  BIZ_BRAIN=$(grep -A 5 "^## Current Priorities" "$SECOND_BRAIN/resources/BUSINESS-BRAIN.md" 2>/dev/null | tail -n +2 | head -5)
fi

# Get pending mission tasks
PENDING_TASKS=$(node -e "
const db = require('better-sqlite3')('$PROJECT_ROOT/store/claudeclaw.db');
const rows = db.prepare(\"SELECT title, assigned_agent FROM mission_tasks WHERE status IN ('queued','in_progress') LIMIT 5\").all();
rows.forEach(r => console.log('- ' + (r.title||'untitled') + ' → ' + (r.assigned_agent||'unassigned')));
if (rows.length === 0) console.log('- None');
db.close();
" 2>/dev/null)

cat << EOF
[SESSION CONTEXT — auto-injected]

Agents online: ${AGENTS_RUNNING:-unknown}

Recent team activity:
${RECENT_ACTIVITY:-No recent activity}

Pending missions:
${PENDING_TASKS:-None}

BCI priorities (Q2 2026):
${BIZ_BRAIN:-See resources/BUSINESS-BRAIN.md}

[END SESSION CONTEXT]
EOF
