// Channel 4 bridge emitter — Hermes-side (ClaudeClaw is the laptop runtime).
//
// Source-side redaction + append-only JSONL writes to second-brain/bridge-events/hermes/.
// Every emit path is fire-and-forget: helpers swallow their own errors so a bridge
// failure can never break the user-facing reply path.
//
// Canonical design: bridge-events/docs/bridge-design.md
// Canonical redactor: ~/.openclaw/bridge/redactor/  (mirrored into src/bridge/redactor/
//   so tsc compiles it as part of this project; sync via copy from ~/.openclaw/bridge/)

import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { redact } from './bridge/redactor/index.js';
import type {
  EventType,
  RedactedEvent,
  RedactorConfig,
} from './bridge/redactor/types.js';
import { logger } from './logger.js';

const SECOND_BRAIN_ROOT = join(homedir(), 'Claude', 'second-brain');
export const EVENTS_DIR = join(SECOND_BRAIN_ROOT, 'bridge-events', 'hermes');
export const AUDIT_DIR = join(homedir(), '.openclaw', 'bridge-audit');

// Q4 v0.1: per-call spend marker threshold.
const PER_CALL_SPEND_THRESHOLD_USD = 0.5;

// Per-call dedupe so retries don't double-emit.
const recentSpendKeys = new Set<string>();
const RECENT_SPEND_TTL_MS = 5 * 60 * 1000;

// Default redactor config — Q5 v0.1 locked to full_redact; pass2 stays noop.
const DEFAULT_CFG: RedactorConfig = {
  auditDir: AUDIT_DIR,
  thirdPartyNamePolicy: 'full_redact',
};

export interface EmitInput {
  source_session_id: string;
  event_type: EventType;
  payload: Record<string, unknown>;
}

/**
 * Run an event through the redactor and append it to today's JSONL file.
 * Never throws — failures are logged and swallowed.
 */
export async function emitBridgeEvent(input: EmitInput): Promise<RedactedEvent | null> {
  try {
    const result = await redact(
      { source: 'hermes', ...input },
      DEFAULT_CFG,
    );
    const toWrite = result.event ?? result.healthEvent;
    if (!toWrite) return null;
    const date = toWrite.ts.slice(0, 10);
    await mkdir(EVENTS_DIR, { recursive: true });
    await appendFile(join(EVENTS_DIR, `${date}.jsonl`), JSON.stringify(toWrite) + '\n', 'utf8');
    return toWrite;
  } catch (err) {
    logger.error({ err, event_type: input.event_type }, 'Bridge emit failed');
    return null;
  }
}

/**
 * Per-call spend marker — fires when a single LLM call exceeds the threshold.
 * Called from every saveTokenUsage callsite.
 */
export function maybeEmitSpendMarker(args: {
  agentId: string;
  sessionId: string | undefined;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  persona?: string | null;
}): void {
  if (!Number.isFinite(args.costUsd) || args.costUsd < PER_CALL_SPEND_THRESHOLD_USD) return;

  // Dedupe a 5-minute window of (sessionId, cost-cents) so a retried log
  // can't double-emit. Cheap and good-enough for v0.1.
  const key = `${args.sessionId ?? 'no-sess'}:${Math.round(args.costUsd * 100)}`;
  if (recentSpendKeys.has(key)) return;
  recentSpendKeys.add(key);
  setTimeout(() => recentSpendKeys.delete(key), RECENT_SPEND_TTL_MS).unref?.();

  const payload: Record<string, unknown> = {
    bucket: 'per_call_over_threshold',
    cost_cents: Math.round(args.costUsd * 100),
    input_tokens: args.inputTokens,
    output_tokens: args.outputTokens,
    agent_id: args.agentId,
  };
  if (args.model) payload['model'] = args.model;
  if (args.persona) payload['persona'] = args.persona;

  // fire-and-forget
  void emitBridgeEvent({
    source_session_id: args.sessionId ?? `${args.agentId}:no-sess`,
    event_type: 'spend_marker',
    payload,
  });
}

/**
 * /newchat path — emit either a session_summary (≥6 turns OR ≥1500 tokens)
 * or a decision_record (smaller sessions). Summary text is passed in by the
 * caller (typically the LLM-generated hive-mind summary).
 */
export function emitSessionEnd(args: {
  agentId: string;
  sessionId: string;
  summary: string;
  turnCount: number;
  totalTokens: number;
  totalCostUsd?: number;
  model?: string;
}): void {
  const isSummary = args.turnCount >= 6 || args.totalTokens >= 1500;
  const event_type: EventType = isSummary ? 'session_summary' : 'decision_record';

  const payload: Record<string, unknown> = {
    summary: args.summary,
    turn_count: args.turnCount,
    tokens: args.totalTokens,
    agent_id: args.agentId,
  };
  if (typeof args.totalCostUsd === 'number') {
    payload['cost_cents'] = Math.round(args.totalCostUsd * 100);
  }
  if (args.model) payload['model_used'] = args.model;

  void emitBridgeEvent({
    source_session_id: args.sessionId,
    event_type,
    payload,
  });
}

/**
 * Daily total spend marker. Called once per UTC day from the scheduler tick.
 * Pass yesterday's totals.
 */
export function emitDailyTotal(args: {
  agentId: string;
  date: string; // YYYY-MM-DD (UTC)
  totalCostUsd: number;
  totalTokens: number;
  callCount: number;
}): void {
  void emitBridgeEvent({
    source_session_id: `daily:${args.agentId}:${args.date}`,
    event_type: 'spend_marker',
    payload: {
      bucket: 'daily_total',
      date: args.date,
      cost_cents: Math.round(args.totalCostUsd * 100),
      total_tokens: args.totalTokens,
      call_count: args.callCount,
      agent_id: args.agentId,
    },
  });
}

// ─── Reader helper ──────────────────────────────────────────────────

/**
 * Read recent bridge events from the given source within `sinceHours`.
 * Returns events sorted oldest → newest.
 */
export async function bridgeRecent(
  source: 'hermes' | 'hal',
  sinceHours = 24,
): Promise<RedactedEvent[]> {
  const dir = join(SECOND_BRAIN_ROOT, 'bridge-events', source);
  const files = (await readdir(dir).catch(() => []))
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse()
    .slice(0, 3); // most recent 3 days
  const cutoff = Date.now() - sinceHours * 3_600_000;
  const out: RedactedEvent[] = [];
  for (const f of files) {
    let raw: string;
    try {
      raw = await readFile(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as RedactedEvent;
        if (Date.parse(ev.ts) >= cutoff) out.push(ev);
      } catch {
        // Skip corrupt line per design §4 failure-mode policy.
      }
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1));
}
