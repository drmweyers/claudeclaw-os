# Content Agent — Critical Path SOPs

> Deterministic step-by-step for your 3 most common tasks.
> Follow these exactly. Don't improvise the sequence. Iterate on the skill, not the path.
> **BEFORE any SOP:** Read `CRITICAL-PATHS-LEARNINGS.md` in this directory for accumulated insights.
> **AFTER any SOP:** Append 2-3 lines to `CRITICAL-PATHS-LEARNINGS.md` with date + what worked/missed.

---

## SOP 1: Generate + Schedule Social Posts

**Trigger:** "write posts about X", "schedule content", "post to LinkedIn/Twitter"

```
STEP 1: Read brand voice
  → Read ~/.claude/skills/mark-weyers-profile/ (Mark's voice)
  → Check which brand surface (BCI, EvoFit, SmartSocial, Cognitive Education)

STEP 2: Generate drafts
  → Use SmartSocial API: POST /api/content/generate
  → OR use linkedin-post-generator skill if LinkedIn-specific
  → Generate 3 variants minimum

STEP 3: Show Mark for approval
  → Present all variants via Telegram
  → Wait for "yes" or edits
  → NEVER publish without approval

STEP 4: Schedule via SmartSocial
  → POST /api/schedule with approved content
  → Optimal times: LinkedIn (Tue-Thu 8-10am ET), Twitter (weekdays 12-3pm ET)
  → Confirm schedule back to Mark

STEP 5: Log to hive mind
  → INSERT into hive_mind: action='content_scheduled', summary='[platforms] [topic] [date]'

STEP 6: Self-evaluate
  → Read eval.json for sop_1_generate_schedule
  → Score yourself 0.0-1.0 on each criterion
  → Append one JSONL line to eval-scores.jsonl
  → If total < 0.6, note what went wrong in CRITICAL-PATHS-LEARNINGS.md
```

---

## SOP 2: LinkedIn Post (Viral Optimization)

**Trigger:** "LinkedIn post", "punch up this post", "write for LinkedIn"

```
STEP 1: Load the linkedin-post-generator skill
  → Read ~/.claude/skills/linkedin-post-generator/SKILL.md (ONCE per session)
  → Contains 50 decoded viral posts + algorithm science

STEP 2: Identify the angle
  → What's the thesis? (one sentence)
  → Who's the audience? (founders, educators, builders?)
  → What's the hook type? (contrarian, story, data, question)

STEP 3: Write using the 4-stage algorithm model
  → Hook (first 2 lines — this determines 80% of performance)
  → Body (short paragraphs, sentence-length variation, no em dashes)
  → CTA (engagement driver — question, not "follow me")
  → Apply Mark's voice rules: evidence-based, builder, no guru-posture

STEP 4: Self-score against viral benchmarks
  → Dwell time potential (long enough to read? 800-1200 chars optimal)
  → Hook strength (would YOU stop scrolling?)
  → Engagement bait (does it invite comments naturally?)

STEP 5: Present + iterate
  → Show Mark the draft
  → Iterate based on feedback
  → Then follow SOP 1 Steps 4-5 to schedule

STEP 6: Self-evaluate
  → Read eval.json for sop_2_linkedin_post
  → Score yourself 0.0-1.0 on each criterion
  → Append one JSONL line to eval-scores.jsonl
  → If total < 0.6, note what went wrong in CRITICAL-PATHS-LEARNINGS.md
```

---

## SOP 3: Content Pipeline Run (SS-PIPELINE)

**Trigger:** "run the pipeline", "autonomous content", "generate this week's content"

```
STEP 1: Load the pipeline skill
  → Read smartsocial-skills/growth/content-pipeline/SKILL.md (ONCE)
  → Also read smartsocial-skills/growth/content-themes/SKILL.md (themes feed the pipeline)

STEP 2: Check existing themes
  → GET /api/content/themes — what themes are active?
  → Any themes need fresh source articles? If yes, queue research agent via mission-cli

STEP 3: Run the 5-step pipeline
  → Step A: Theme selection (pick 2-3 themes for this cycle)
  → Step B: Source article ingestion (from themes)
  → Step C: Content generation (platform-tailored variants)
  → Step D: Brand voice validation (SS-BRAND if available)
  → Step E: Queue for approval

STEP 4: Present approval queue to Mark
  → Show all generated content grouped by platform
  → Mark approves/edits/rejects each piece
  → Approved items → schedule via SmartSocial

STEP 5: Report results
  → Log to hive mind: action='pipeline_run', summary='[N] pieces generated, [M] approved'
  → If analytics from previous cycle available, include performance comparison

STEP 6: Self-evaluate
  → Read eval.json for sop_3_pipeline_run
  → Score yourself 0.0-1.0 on each criterion
  → Append one JSONL line to eval-scores.jsonl
  → If total < 0.6, note what went wrong in CRITICAL-PATHS-LEARNINGS.md
```
