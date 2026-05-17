# Research Agent — Critical Path SOPs

> Deterministic step-by-step for your 3 most common tasks.
> Follow these exactly. Don't improvise the sequence.
> **BEFORE any SOP:** Read `CRITICAL-PATHS-LEARNINGS.md` in this directory for accumulated insights.
> **AFTER any SOP:** Append 2-3 lines to `CRITICAL-PATHS-LEARNINGS.md` with date + what worked/missed.

---

## SOP 1: Deep Research Brief

**Trigger:** "research X", "deep dive on Y", "what's the literature on Z"

```
STEP 1: Scope the question
  → What specifically does Mark want to know?
  → Academic or commercial? (determines ScholarFlow vs web search)
  → What confidence level is needed? (blog post vs investment decision)

STEP 2: Parallel source sweep
  → IF academic: ScholarFlow API (POST localhost:3201/api/research, max_results:15)
  → IF commercial: web search (Firecrawl or agent-browser)
  → IF both: run both, merge results

STEP 3: Synthesize into brief format
  → Lead with the conclusion (one paragraph)
  → 3-5 supporting points with citations
  → Confidence flags: HIGH (peer-reviewed), MEDIUM (reputable pub), LOW (blog/anecdote)
  → Source links for every claim

STEP 4: Deliver as Google Doc
  → Write brief to second-brain/research/[topic]-brief.md
  → Upload to BCI Drive (google-drive-sync skill) in correct folder
  → Send Mark the Google Doc link via Telegram

STEP 5: Log and cross-pollinate
  → Log to hive mind: action='research_brief', summary='[topic] [source count] [confidence]'
  → If findings feed content themes: mission-cli → content agent with summary
  → Git commit + push to second-brain

STEP 6: Self-evaluate
  → Read eval.json for sop_1_deep_research_brief
  → Score yourself 0.0-1.0 on each criterion
  → Append one JSONL line to eval-scores.jsonl
  → If total < 0.6, note what went wrong in CRITICAL-PATHS-LEARNINGS.md
```

---

## SOP 2: Competitive Analysis

**Trigger:** "who are competitors", "competitive landscape", "compare us to X"

```
STEP 1: Define the competitive frame
  → Which BCI product? (SmartSocial, EvoFit, Cognitive Education)
  → Direct competitors only, or adjacent?
  → What dimensions? (features, pricing, market position, tech stack)

STEP 2: Invoke competitive-analysis skill
  → Use competitive-analysis or peptides-competitive-analysis skill
  → Scrape competitor sites (agent-browser for live data)
  → Note dates on all pricing/feature claims (they change fast)

STEP 3: Build comparison table
  → Rows = competitors, Columns = dimensions
  → Flag where BCI has advantage (green), parity (yellow), gap (red)
  → Include pricing tiers if available

STEP 4: Write recommendations
  → "Based on this landscape, BCI should..."
  → Prioritize by impact (what moves the needle most)
  → Flag any urgent threats (competitor launched something we don't have)

STEP 5: Deliver
  → Google Doc in BCI Drive → _research/ folder
  → Send link to Mark
  → Log to hive mind

STEP 6: Self-evaluate
  → Read eval.json for sop_2_competitive_analysis
  → Score yourself 0.0-1.0 on each criterion
  → Append one JSONL line to eval-scores.jsonl
  → If total < 0.6, note what went wrong in CRITICAL-PATHS-LEARNINGS.md
```

---

## SOP 3: Peptides/Longevity Literature Review

**Trigger:** "peptides research", "longevity literature", "what does the evidence say about X"

```
STEP 1: Formulate search queries
  → Break topic into 2-3 specific PubMed-style queries
  → Include MeSH terms if applicable
  → Scope: last 5 years unless historical review needed

STEP 2: Hit ScholarFlow
  → POST localhost:3201/api/research with each query
  → Filter for peer-reviewed only (no preprints for health claims)
  → Cross-reference: if only 1 study supports a claim, flag as preliminary

STEP 3: Regulatory context check
  → Health Canada status for the compound/intervention
  → FDA status (approved, investigational, banned?)
  → Any active clinical trials? (check ClinicalTrials.gov via web search)

STEP 4: Write evidence summary
  → NEVER frame as recommendation (information only)
  → Use "the evidence suggests" not "you should take"
  → Cite DOIs, not just author names
  → Flag evidence quality: RCT > cohort > case study > in vitro

STEP 5: Deliver
  → Google Doc in BCI Drive
  → If for EvoFit content: flag which findings are safe to publish publicly
  → Send link to Mark
  → Log to hive mind

STEP 6: Self-evaluate
  → Read eval.json for sop_3_peptides_literature
  → Score yourself 0.0-1.0 on each criterion
  → Append one JSONL line to eval-scores.jsonl
  → If total < 0.6, note what went wrong in CRITICAL-PATHS-LEARNINGS.md
```
