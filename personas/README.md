# Personas

A **persona** is a reusable preset that any agent can adopt when running a mission task. It bundles a `{model, system_prompt, mcp_allowlist, daily_cost_cap_usd, max_turns}` profile so the same agent can operate in different modes (cheap-and-fast vs deep-and-expensive) without duplicating agent configs.

## How it works

1. `main` agent picks a persona for a mission based on intent (see `agents/main/CLAUDE.md` "Persona Selection" section).
2. `mission-cli create --persona <slug>` validates the slug, intersects the persona's `mcp_allowlist` with the assigned agent's allowed MCPs, and snapshots the persona JSON into `mission_tasks.persona_snapshot` at queue time.
3. The scheduler picks up the mission, checks the 24h rolling cost against `daily_cost_cap_usd`, and (if under cap) calls `runAgent` with the persona's `model`, the intersected MCP allowlist, and the `system_prompt` injected as an `appendSystemPrompt` SDK option.
4. The Telegram reply gets a footer: `via {persona} · {model} · ${cost}`.

The YAML file is a reference; the **snapshot stored on the mission row** is the source of truth at execution time. This means editing `quick-check.yaml` while a mission is in flight will not affect that mission.

## Schema

```yaml
slug: <kebab-case, /^[a-z0-9-]+$/, must not collide with any agent id>
name: <human-readable display name>
description: <one-line purpose>
model: claude-opus-4-7 | claude-sonnet-4-6 | claude-haiku-4-5
system_prompt: |
  <multi-line system prompt addendum, max 4096 bytes>
mcp_allowlist:
  - <mcp-server-name>   # MUST be subset of the assigned agent's mcp_servers
                        # Empty list = no MCPs at all (NOT "all MCPs")
daily_cost_cap_usd: <number, e.g. 2.0>
max_turns: <optional integer, capped at AGENT_MAX_TURNS from .env>
```

## Validation (enforced by `src/personas.ts`)

- `slug` matches `/^[a-z0-9-]+$/` and is NOT in `listAgentIds()` (namespace disjoint from agents)
- `model` is one of `ALLOWED_MODELS`
- `system_prompt` is ≤ 4096 bytes
- `mcp_allowlist` is an array (may be empty)
- `daily_cost_cap_usd` is a positive number
- `max_turns`, if set, is a positive integer

When a persona is invoked for a specific agent, the loader ADDITIONALLY checks that every entry in `mcp_allowlist` is present in that agent's `mcp_servers` allowlist. If the agent has no `mcp_servers` field (= grants all MCPs), the persona's allowlist is the effective set.

## Current pantheon

| Slug | Model | Purpose | Cost cap |
|---|---|---|---|
| `quick-check` | claude-haiku-4-5 | "Is this true", quick lookups, triage | $2/day |

Deep research is intentionally NOT a persona. It's owned by:
- **ScholarFlow** (`POST /api/research`) for academic, citation-bound research
- **Research agent** (`agents/research/`) for broader briefs (competitive intel, peptides, web research)

If you want a research agent to default to Opus, edit `agents/research/agent.yaml`, don't add a persona.

## Adding a new persona

1. Write `personas/<slug>.yaml` matching the schema above
2. Reload (no daemon restart needed — personas are loaded fresh per mission)
3. Add an intent → persona row to `agents/main/CLAUDE.md` "Persona Selection" section so `main` knows when to pick it
4. Validate: `node dist/personas-cli.js list` (if the CLI is built) or run the unit tests

## Killed from earlier versions

- `deep-research` — redundant with ScholarFlow + research agent
- `scribe` — redundant with content agent
- `auditor` — redundant with `@quality-reviewer` / dev flow
- `philosopher` — indistinguishable from `deep-research` minus MCPs
- `mercury` / `labyrinth` — renamed to descriptive English
