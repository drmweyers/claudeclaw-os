// Bridge redactor — orchestrator.
// Single entry point both Hermes and Hal call before emitting any bridge event.
//
// Contract:
//   - INPUT: a RedactInput with raw payload fields (strings may contain anything).
//   - OUTPUT: { event: RedactedEvent | null, audit: RedactionAuditRow }.
//             event=null when fail-closed — caller emits a bridge_health row instead.
//
// v0.1 behavior:
//   - Pass 1 (regex): always runs. Deterministic. Fail-closed on throw.
//   - Pass 2 (LLM):  noop by default. Config can plug in Anthropic Haiku or local GLM.
//                    Errors → fail-closed: event is suppressed, bridge_health written.
//   - Pass 3 (bucket + optional pseudonymize): always runs for financial; pseudonymize gated.
//   - If any string field contains a sentinel, the ENTIRE event becomes a private_aside
//     placeholder with empty payload.

import { pass1Scrub } from './pass1-regex.js';
import { pass3 } from './pass3-pseudonymize.js';
import { writeAudit, newAuditId, newEventId } from './audit.js';
import type {
  Pass1Result,
  Pass2Result,
  Pass2Span,
  Pass3Result,
  RedactInput,
  RedactedEvent,
  RedactionAuditRow,
  RedactionHit,
  RedactorConfig,
} from './types.js';

const PASS2_TIMEOUT_MS = 10_000;

export interface RedactResult {
  event: RedactedEvent | null;
  /** A health-signal event the caller should emit INSTEAD of the redacted event, when fail-closed. */
  healthEvent: RedactedEvent | null;
  audit: RedactionAuditRow;
}

const DEFAULT_PASS2: NonNullable<RedactorConfig['pass2']> = async () => ({
  additional_spans: [],
  errored: false,
});

export async function redact(input: RedactInput, cfg: RedactorConfig = {}): Promise<RedactResult> {
  const ts = new Date().toISOString();
  const event_id = newEventId();
  const audit_id = newAuditId();
  const pass2Fn = cfg.pass2 ?? DEFAULT_PASS2;

  const audit: RedactionAuditRow = {
    ts,
    event_id,
    audit_id,
    source: input.source,
    event_type: input.event_type,
    pass1_hits: [],
    pass2_hits: [],
    pass3_hits: [],
    dropped_fields: [],
    fail_closed: false,
    emit_suppressed: false,
  };

  const outPayload: Record<string, unknown> = {};
  let sentinelTriggered = false;

  try {
    for (const [key, raw] of Object.entries(input.payload)) {
      if (typeof raw !== 'string') {
        outPayload[key] = raw;
        continue;
      }

      // Pass 1
      const p1: Pass1Result = pass1Scrub(raw, {
        hardRedactNames: cfg.hardRedactNames,
        knownPrincipals: cfg.knownPrincipals,
      });
      audit.pass1_hits.push(...p1.hits);
      if (p1.drop_entirely) {
        sentinelTriggered = true;
        audit.dropped_fields.push(key);
        continue;
      }

      // Pass 2 (optional LLM)
      let p2: Pass2Result;
      try {
        p2 = await withTimeout(pass2Fn(p1.text), PASS2_TIMEOUT_MS);
      } catch {
        p2 = { additional_spans: [], errored: true };
      }
      if (p2.errored) {
        // Fail closed: drop this field. (Per design §3.2.4 — prefer a missing event over a leaked one.)
        audit.fail_closed = true;
        audit.dropped_fields.push(key);
        continue;
      }
      audit.pass2_hits.push(...p2.additional_spans);
      const p2Text = applyPass2Spans(p1.text, p2.additional_spans);

      // Pass 3 (pseudonymize gated + financial buckets unconditional)
      const p3: Pass3Result = pass3(p2Text, cfg, /* candidates */ []);
      audit.pass3_hits.push(...p3.hits);

      outPayload[key] = p3.text;
    }
  } catch (err) {
    // Any unexpected throw in the pipeline → fail closed.
    audit.fail_closed = true;
    audit.emit_suppressed = true;
    if (cfg.auditDir) {
      await safeWriteAudit(audit, cfg.auditDir);
    }
    return {
      event: null,
      healthEvent: buildHealth(input, ts, audit_id, 'emit_failure', String(err)),
      audit,
    };
  }

  if (sentinelTriggered) {
    // Per design: the event becomes a private_aside placeholder.
    if (cfg.auditDir) await safeWriteAudit(audit, cfg.auditDir);
    return {
      event: {
        schema_version: '1.0',
        event_id,
        ts,
        source: input.source,
        source_session_id: input.source_session_id,
        event_type: 'private_aside',
        redacted: true,
        redaction_audit_id: audit_id,
        payload: {},
        links: [],
      },
      healthEvent: null,
      audit,
    };
  }

  if (audit.fail_closed && audit.dropped_fields.length === Object.keys(input.payload).length) {
    // Every field dropped → suppress the event, emit health instead.
    audit.emit_suppressed = true;
    if (cfg.auditDir) await safeWriteAudit(audit, cfg.auditDir);
    return {
      event: null,
      healthEvent: buildHealth(input, ts, audit_id, 'redaction_pass2_fail', 'all fields dropped'),
      audit,
    };
  }

  if (cfg.auditDir) await safeWriteAudit(audit, cfg.auditDir);

  return {
    event: {
      schema_version: '1.0',
      event_id,
      ts,
      source: input.source,
      source_session_id: input.source_session_id,
      event_type: input.event_type,
      redacted: true,
      redaction_audit_id: audit_id,
      payload: outPayload,
      links: [],
    },
    healthEvent: null,
    audit,
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function applyPass2Spans(text: string, spans: Pass2Span[]): string {
  if (spans.length === 0) return text;
  // Apply in reverse order so earlier offsets remain valid.
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of sorted) {
    if (s.start < 0 || s.end > out.length || s.start >= s.end) continue;
    out = out.slice(0, s.start) + `[REDACTED:${s.cls}]` + out.slice(s.end);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pass2 timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function buildHealth(
  input: RedactInput,
  ts: string,
  audit_id: string,
  signal: 'redaction_pass1_fail' | 'redaction_pass2_fail' | 'redaction_pass3_fail' | 'emit_failure',
  detail: string,
): RedactedEvent {
  return {
    schema_version: '1.0',
    event_id: newEventId(),
    ts,
    source: input.source,
    source_session_id: input.source_session_id,
    event_type: 'bridge_health',
    redacted: true,
    redaction_audit_id: audit_id,
    payload: { signal, detail: detail.slice(0, 400) },
    links: [],
  };
}

async function safeWriteAudit(row: RedactionAuditRow, dir: string): Promise<void> {
  try { await writeAudit(row, dir); } catch { /* never propagate audit errors to the emit path */ }
}

export type { RedactInput, RedactedEvent, RedactionAuditRow, RedactorConfig } from './types.js';
