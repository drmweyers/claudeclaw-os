#!/bin/bash
# Weekly Summary Tables Generator
# Inspired by Kashef's "silver platter" concept:
# Pre-aggregate KPIs so agents spend time ANALYZING, not RETRIEVING
#
# Run via cron every Monday at 6am: 0 6 * * 1
# Output: second-brain/summaries/weekly-YYYY-MM-DD.md

PROJECT_ROOT="C:/Users/drmwe/Claude/claudeclaw-os"
SECOND_BRAIN="C:/Users/drmwe/Claude/second-brain"
SUMMARY_DIR="$SECOND_BRAIN/summaries"
DATE=$(date +%Y-%m-%d)
OUTPUT="$SUMMARY_DIR/weekly-$DATE.md"

mkdir -p "$SUMMARY_DIR"

cat > "$OUTPUT" << HEADER
# Weekly Business Summary — $DATE

> Auto-generated silver platter. Agents: analyze from HERE, don't re-pull raw data.

HEADER

# ── SmartSocial Metrics ──────────────────────────────────────────
echo "## SmartSocial Performance" >> "$OUTPUT"
echo "" >> "$OUTPUT"

# Pull analytics from SmartSocial API
SMARTSOCIAL_KEY=$(grep SMARTSOCIAL_API_KEY "$PROJECT_ROOT/.env" | cut -d= -f2)
if [ -n "$SMARTSOCIAL_KEY" ]; then
  ANALYTICS=$(curl -s "https://smartsocial-ai.com/api/analytics/summary?period=last7d" \
    -H "X-API-Key: $SMARTSOCIAL_KEY" \
    -H "Content-Type: application/json" 2>/dev/null)

  if [ -n "$ANALYTICS" ] && echo "$ANALYTICS" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    echo "$ANALYTICS" | python3 -c "
import json, sys
data = json.load(sys.stdin)
print('| Metric | Value |')
print('|--------|-------|')
for k, v in data.items():
    if isinstance(v, (int, float, str)):
        print(f'| {k} | {v} |')
" >> "$OUTPUT" 2>/dev/null
  else
    echo "_SmartSocial API unavailable or returned non-JSON._" >> "$OUTPUT"
  fi
else
  echo "_SMARTSOCIAL_API_KEY not set._" >> "$OUTPUT"
fi

echo "" >> "$OUTPUT"

# ── Agent Activity Summary ──────────────────────────────────────
echo "## Agent Activity (Last 7 Days)" >> "$OUTPUT"
echo "" >> "$OUTPUT"

node -e "
const db = require('better-sqlite3')('$PROJECT_ROOT/store/claudeclaw.db');
const oneWeekAgo = Math.floor(Date.now()/1000) - (7*24*60*60);
const rows = db.prepare('SELECT agent_id, COUNT(*) as actions FROM hive_mind WHERE created_at > ? GROUP BY agent_id ORDER BY actions DESC').all(oneWeekAgo);
console.log('| Agent | Actions |');
console.log('|-------|---------|');
rows.forEach(r => console.log('| ' + r.agent_id + ' | ' + r.actions + ' |'));
if (rows.length === 0) console.log('| (none) | 0 |');
db.close();
" >> "$OUTPUT" 2>/dev/null

echo "" >> "$OUTPUT"

# ── Mission Tasks Summary ──────────────────────────────────────
echo "## Mission Tasks" >> "$OUTPUT"
echo "" >> "$OUTPUT"

node -e "
const db = require('better-sqlite3')('$PROJECT_ROOT/store/claudeclaw.db');
const oneWeekAgo = Math.floor(Date.now()/1000) - (7*24*60*60);
const rows = db.prepare('SELECT status, COUNT(*) as cnt FROM mission_tasks WHERE created_at > ? GROUP BY status').all(oneWeekAgo);
console.log('| Status | Count |');
console.log('|--------|-------|');
rows.forEach(r => console.log('| ' + r.status + ' | ' + r.cnt + ' |'));
db.close();
" >> "$OUTPUT" 2>/dev/null

echo "" >> "$OUTPUT"

# ── Git Activity Across Projects ──────────────────────────────
echo "## Development Activity" >> "$OUTPUT"
echo "" >> "$OUTPUT"
echo "| Project | Commits (7d) | Latest |" >> "$OUTPUT"
echo "|---------|-------------|--------|" >> "$OUTPUT"

for dir in "$HOME/Claude/SmartSocial" "$HOME/Claude/EvoFitTrainer" "$HOME/Claude/claudeclaw-os" "$HOME/Claude/RAG WebApp"; do
  if [ -d "$dir/.git" ]; then
    name=$(basename "$dir")
    count=$(git -C "$dir" log --oneline --since="7 days ago" 2>/dev/null | wc -l)
    latest=$(git -C "$dir" log --oneline -1 --format="%s" 2>/dev/null | cut -c1-50)
    echo "| $name | $count | $latest |" >> "$OUTPUT"
  fi
done

echo "" >> "$OUTPUT"
echo "---" >> "$OUTPUT"
echo "_Generated at $(date '+%Y-%m-%d %H:%M') by weekly-summary-tables.sh_" >> "$OUTPUT"

# Commit and push to second-brain
cd "$SECOND_BRAIN"
git add "summaries/weekly-$DATE.md"
git commit -m "chore: weekly summary table $DATE" 2>/dev/null
git push origin main 2>/dev/null

echo "Summary written to: $OUTPUT"
