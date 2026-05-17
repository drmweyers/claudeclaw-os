// Pass 1 — regex / heuristic scrubber.
// Conservative, fail-closed, deterministic. No network calls. Runs on every event.
// v0.1: covers credentials, common PII patterns, sentinel markers, deny-list names.

import type { Pass1Result, RedactionHit, RedactionClass } from './types.js';

// ─── Credential patterns ────────────────────────────────────────────
// Order matters: more specific first so we don't double-tag.
const CREDENTIAL_PATTERNS: Array<{ name: string; rx: RegExp }> = [
  { name: 'anthropic_api_key',      rx: /sk-ant-[a-zA-Z0-9_-]{40,}/g },
  { name: 'openai_api_key',         rx: /sk-(?!ant-)[a-zA-Z0-9]{20,}/g },
  { name: 'bci_api_key',            rx: /bci_[a-f0-9]{32,}/g },
  { name: 'bridge_session_token',   rx: /brg_[a-zA-Z0-9_-]{16,}/g },
  { name: 'github_token',           rx: /gh[pousr]_[A-Za-z0-9_]{36,}/g },
  { name: 'aws_access_key',         rx: /AKIA[0-9A-Z]{16}/g },
  { name: 'slack_token',            rx: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'jwt',                    rx: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer_header',          rx: /Bearer\s+[A-Za-z0-9_\-.=]+/gi },
  { name: 'basic_auth_url',         rx: /https?:\/\/[^\s:@]+:[^\s:@/]+@[^\s]+/g },
  // Generic env-style: KEY=VALUE when KEY name signals a secret
  {
    name: 'env_secret_assignment',
    rx: /\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD|CREDENTIAL))\s*=\s*([^\s'"]{6,})/g,
  },
];

// ─── PII patterns ───────────────────────────────────────────────────
const PII_PATTERNS: Array<{ cls: RedactionClass; name: string; rx: RegExp }> = [
  { cls: 'pii_email',       name: 'email',        rx: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { cls: 'pii_phone',       name: 'phone_intl',   rx: /\+\d{1,3}[\s.-]?\(?\d{1,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{0,4}/g },
  { cls: 'pii_phone',       name: 'phone_us',     rx: /\b(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b/g },
  { cls: 'pii_ssn',         name: 'ssn',          rx: /\b\d{3}-\d{2}-\d{4}\b/g },
  { cls: 'pii_credit_card', name: 'credit_card',  rx: /\b(?:\d[ -]?){13,19}\b/g },
];

// ─── Sentinel markers ───────────────────────────────────────────────
// If a sentinel appears anywhere in the input, the ENTIRE turn is dropped.
// This is the conservative read of §3.2.1 "Mark's private asides".
const SENTINEL_RX = /(?:^|\s)(?:##private\b|\(off-record\)|\(don'?t share\))/i;

// ─── Internal-host allow-list ───────────────────────────────────────
// These match credential-shaped patterns but are operational signal, not secrets.
const INTERNAL_HOST_ALLOWLIST = new Set([
  'bci-command-centre',
  'openclaw-gateway',
  'hal.holocrononline.com',
  'evofitmeals.com',
  'localhost',
]);

// ─── Deny-list (names / project codenames) ──────────────────────────
// Configurable at call time via RedactorConfig.hardRedactNames; this is the
// built-in baseline.
const DEFAULT_DENY_LIST: string[] = [
  // Add specific client names, project codenames as needed.
  // Kept empty by default so the project ships without surprise redactions.
];

// ─── Known principals ───────────────────────────────────────────────
// Never redact these — they're the agents and Mark himself.
const KNOWN_PRINCIPALS = new Set([
  'mark', 'mark weyers', 'dr. mark weyers', 'dr mark weyers',
  'hal', 'hermes', 'claude', 'claudeclaw', 'opus', 'sonnet', 'haiku',
  'openclaw',
]);

interface ApplyOpts {
  hardRedactNames?: string[];
  knownPrincipals?: string[];
}

/**
 * Run pass-1 redaction on a string. Returns the scrubbed text + hit list.
 * If a sentinel marker is present anywhere in the input, sets drop_entirely=true
 * and returns the original text untouched (the caller drops the field/event).
 */
export function pass1Scrub(input: string, opts: ApplyOpts = {}): Pass1Result {
  if (typeof input !== 'string' || input.length === 0) {
    return { text: input ?? '', hits: [], drop_entirely: false };
  }

  // Sentinel check — short-circuit before any other work.
  if (SENTINEL_RX.test(input)) {
    return { text: input, hits: [], drop_entirely: true };
  }

  const hits: RedactionHit[] = [];
  // We rebuild the string in a single pass per pattern, tracking offsets.
  // Order: credentials → PII → deny-list names. Replacements use distinct
  // tokens so downstream passes can recognize already-redacted spans.
  let text = input;

  text = applyPatternList(
    text,
    CREDENTIAL_PATTERNS.map((p) => ({ ...p, cls: 'credential' as RedactionClass })),
    (m, p) => `[REDACTED:credential:${p.name}]`,
    hits,
  );

  text = applyPatternList(
    text,
    PII_PATTERNS,
    (m, p) => `[REDACTED:${p.cls}]`,
    hits,
  );

  // Deny-list (exact name matches, case-insensitive, word-boundaried).
  const deny = [...DEFAULT_DENY_LIST, ...(opts.hardRedactNames ?? [])];
  const principals = new Set([
    ...KNOWN_PRINCIPALS,
    ...(opts.knownPrincipals ?? []).map((s) => s.toLowerCase()),
  ]);

  for (const name of deny) {
    if (!name) continue;
    if (principals.has(name.toLowerCase())) continue; // never redact a principal
    const rx = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
    text = text.replace(rx, (match, offset: number) => {
      hits.push({
        cls: 'third_party_name',
        span: [offset, offset + match.length],
        pattern: 'deny_list_name',
        replacement: '[REDACTED:third_party_name]',
      });
      return '[REDACTED:third_party_name]';
    });
  }

  return { text, hits, drop_entirely: false };
}

// ─── helpers ────────────────────────────────────────────────────────

function applyPatternList(
  input: string,
  patterns: Array<{ name: string; rx: RegExp; cls?: RedactionClass }>,
  buildReplacement: (match: string, p: { name: string; rx: RegExp; cls?: RedactionClass }) => string,
  hits: RedactionHit[],
): string {
  let text = input;
  for (const p of patterns) {
    // Reset lastIndex defensively — `g` flag state survives across calls.
    p.rx.lastIndex = 0;
    text = text.replace(p.rx, (match, ...rest) => {
      // Allow-list bypass: if the match is a known internal host, keep it.
      if (INTERNAL_HOST_ALLOWLIST.has(match)) return match;
      // For env-style assignments, rest[0] is the KEY group, rest[1] is the VALUE group.
      // We retain the KEY in the replacement so the event remains intelligible.
      let replacement: string;
      if (p.name === 'env_secret_assignment' && rest.length >= 2) {
        replacement = `${rest[0]}=[REDACTED:credential:${p.name}]`;
      } else {
        replacement = buildReplacement(match, p);
      }
      const offset: number = typeof rest[rest.length - 2] === 'number'
        ? (rest[rest.length - 2] as number)
        : 0;
      hits.push({
        cls: (p.cls ?? 'credential') as RedactionClass,
        span: [offset, offset + match.length],
        pattern: p.name,
        replacement,
      });
      return replacement;
    });
  }
  return text;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
