// Bridge redactor types — shared by Hermes and Hal emitters.
// Canonical source. Do not fork. v0.1 schema.

export type EventSource = 'hermes' | 'hal';

export type EventType =
  | 'decision_record'
  | 'session_summary'
  | 'task_dispatched'
  | 'task_completed'
  | 'content_state_change'
  | 'heartbeat_claim'
  | 'spend_marker'
  | 'private_aside'
  | 'bridge_health';

export type RedactionClass =
  | 'credential'
  | 'pii_email'
  | 'pii_phone'
  | 'pii_ssn'
  | 'pii_credit_card'
  | 'pii_address'
  | 'third_party_name'
  | 'financial_precision'
  | 'private_aside_sentinel'
  | 'unknown';

export interface RedactionHit {
  cls: RedactionClass;
  span: [number, number];
  pattern?: string;
  replacement: string;
}

export interface Pass1Result {
  text: string;
  hits: RedactionHit[];
  /** If true, the entire turn was sentinel-marked and must be dropped (emit private_aside placeholder). */
  drop_entirely: boolean;
}

export interface Pass2Span {
  start: number;
  end: number;
  cls: RedactionClass;
}

export interface Pass2Result {
  /** Spans (against the pass-1 output text) the LLM judged should be redacted. */
  additional_spans: Pass2Span[];
  /** Set true if the LLM call errored or timed out. Caller fails closed. */
  errored: boolean;
}

export interface Pass3Result {
  text: string;
  hits: RedactionHit[];
}

export interface RedactInput {
  source: EventSource;
  source_session_id: string;
  event_type: EventType;
  /** The raw field-by-field payload as the emitter wants to record it. Strings are redacted in-place; other types pass through. */
  payload: Record<string, unknown>;
}

export interface RedactedEvent {
  schema_version: '1.0';
  event_id: string;
  ts: string;
  source: EventSource;
  source_session_id: string;
  event_type: EventType;
  redacted: true;
  redaction_audit_id: string;
  payload: Record<string, unknown>;
  links: Array<{ rel: string; event_id: string }>;
}

export interface RedactionAuditRow {
  ts: string;
  event_id: string;
  audit_id: string;
  source: EventSource;
  event_type: EventType;
  pass1_hits: RedactionHit[];
  pass2_hits: Pass2Span[];
  pass3_hits: RedactionHit[];
  dropped_fields: string[];
  fail_closed: boolean;
  /** If true the emitter wrote a bridge_health row instead of the event. */
  emit_suppressed: boolean;
}

export interface RedactorConfig {
  /** Optional LLM hook for pass 2. v0.1 default: noop (returns no additional spans). */
  pass2?: (scrubbedText: string) => Promise<Pass2Result>;
  /** Names that should NEVER be pseudonymized — they're known principals. */
  knownPrincipals?: string[];
  /** Names that should be HARD-REDACTED, not pseudonymized (Q5 v0.1 default applies if omitted). */
  hardRedactNames?: string[];
  /** v0.1 default: 'full_redact'. Switch to 'pseudonymize' as a config flag in v0.2+. */
  thirdPartyNamePolicy?: 'full_redact' | 'pseudonymize';
  /** Audit log directory. Defaults to local path; never crosses the bridge. */
  auditDir?: string;
}
