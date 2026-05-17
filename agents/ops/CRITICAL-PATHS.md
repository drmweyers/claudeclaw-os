# Ops Agent — Critical Path SOPs

> Deterministic step-by-step for your 3 most common tasks.
> Follow these exactly. Don't improvise the sequence.
> **BEFORE any SOP:** Read `CRITICAL-PATHS-LEARNINGS.md` in this directory for accumulated insights.
> **AFTER any SOP:** Append 2-3 lines to `CRITICAL-PATHS-LEARNINGS.md` with date + what worked/missed.

---

## SOP 1: Morning Inbox Triage

**Trigger:** "triage my inbox", "what emails need attention", "inbox brief"

```
STEP 1: Pull unread messages
  → gws gmail users messages list --params '{"userId":"me","maxResults":20,"q":"is:unread"}'
  → Get subject + sender for each

STEP 2: Classify each message
  → REPLY NOW — Mark's input needed today (client emails, partner comms, time-sensitive)
  → SCHEDULE — contains calendar request or meeting (extract details)
  → FYI — informational, summarize in 1 line
  → DROP — spam, newsletters Mark doesn't read, automated notifications

STEP 3: Build triage summary
  → Format: traffic-light style
  → RED: [count] need reply today (list subjects + senders)
  → YELLOW: [count] scheduling needed
  → GREEN: [count] FYI items (1-line each)
  → GRAY: [count] dropped

STEP 4: Handle automatable items
  → Internal @bcinnovationlabs.com replies: draft and send autonomously
  → Calendar requests: create events (internal=auto, external=ask Mark)
  → FYI items: archive or label

STEP 5: Deliver to Mark via Telegram
  → Send triage summary
  → For REPLY NOW items: show draft replies, wait for approval
  → Log to hive mind: action='inbox_triage', summary='[RED] urgent, [YELLOW] schedule, [GREEN] fyi'

STEP 6: Self-evaluate
  → Read eval.json for sop_1_inbox_triage
  → Score yourself 0.0-1.0 on each criterion
  → Append one JSONL line to eval-scores.jsonl
  → If total < 0.6, note what went wrong in CRITICAL-PATHS-LEARNINGS.md
```

---

## SOP 2: Calendar Management

**Trigger:** "what's on my calendar", "schedule a meeting", "calendar conflicts"

```
STEP 1: Pull today + next 3 days
  → gws calendar events list for primary calendar
  → Include all-day events and recurring

STEP 2: Surface conflicts or gaps
  → Any overlapping events?
  → Any back-to-back with no buffer?
  → Large open blocks that could be used productively?

STEP 3: For new event requests
  → Internal attendees: create autonomously, send invite
  → External attendees: draft event, show Mark, wait for "yes"
  → Always include: title, time, duration, attendees, video link if remote

STEP 4: Prep notes (if meeting is today)
  → Who is attending? Any context from recent emails/conversations?
  → What was discussed last time? (check hive mind, conversation history)
  → Any action items that were due?

STEP 5: Deliver
  → Telegram: today's schedule + any conflicts + prep notes
  → Log to hive mind: action='calendar_brief', summary='[N] events today, [conflicts?]'

STEP 6: Self-evaluate
  → Read eval.json for sop_2_calendar_management
  → Score yourself 0.0-1.0 on each criterion
  → Append one JSONL line to eval-scores.jsonl
  → If total < 0.6, note what went wrong in CRITICAL-PATHS-LEARNINGS.md
```

---

## SOP 3: System Health Check

**Trigger:** "is everything running", "system status", "health check"

```
STEP 1: Check all ClaudeClaw scheduled tasks
  → PowerShell: Get-ScheduledTask | Where TaskName -like 'ClaudeClaw*'
  → Verify state = Running for: ClaudeClaw, ClaudeClaw-Research, ClaudeClaw-Content, ClaudeClaw-Ops

STEP 2: Check bot responsiveness
  → Tail last 20 lines of each log:
    - ~/claudeclaw.log (main)
    - ~/claudeclaw-research.log
    - ~/claudeclaw-content.log
    - ~/claudeclaw-ops.log
  → Look for errors, crash loops, token issues

STEP 3: Check external services
  → SmartSocial API: curl health endpoint
  → ScholarFlow: curl localhost:3201 (if research work expected)
  → Second-brain git status: any uncommitted changes? behind remote?

STEP 4: Check resource usage
  → Disk space: enough room?
  → Node processes: any runaway memory?
  → SQLite DB size: growing too fast?

STEP 5: Report
  → Traffic-light format:
    🟢 All systems nominal
    🟡 [service] degraded: [reason]
    🔴 [service] down: [reason] + remediation steps
  → Log to hive mind: action='health_check', summary='[status]'

STEP 6: Self-evaluate
  → Read eval.json for sop_3_system_health
  → Score yourself 0.0-1.0 on each criterion
  → Append one JSONL line to eval-scores.jsonl
  → If total < 0.6, note what went wrong in CRITICAL-PATHS-LEARNINGS.md
```
