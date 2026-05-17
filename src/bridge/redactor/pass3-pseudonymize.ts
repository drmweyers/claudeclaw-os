// Pass 3 — pseudonymization + financial bucketing.
// In v0.1 the default third-party name policy is FULL-REDACT (per Q5 decision).
// Pseudonymization code is included but gated behind config.thirdPartyNamePolicy='pseudonymize'.
// Bucketing is unconditional.

import { createHash } from 'node:crypto';
import type { Pass3Result, RedactionHit, RedactorConfig } from './types.js';

// ─── Financial precision → order-of-magnitude bucket ────────────────
// Matches $1,234.56 / $1234 / $1.2k / $1.2K / etc. Bucketing rule:
//   <$10        → "~$1"
//   <$100       → "~$10"
//   <$1k        → "~$100"
//   <$10k       → "~$1k"
//   <$100k      → "~$10k"
//   <$1M        → "~$100k"
//   <$10M       → "~$1M"
//   >=$10M      → "~$10M+"
const MONEY_RX = /\$\s*([0-9][\d,]*(?:\.\d+)?)\s*([kKmM])?/g;

export function pass3Bucket(input: string, hits: RedactionHit[]): string {
  if (typeof input !== 'string' || input.length === 0) return input ?? '';
  MONEY_RX.lastIndex = 0;
  return input.replace(MONEY_RX, (match, numStr: string, suffix: string | undefined, offset: number) => {
    let n = parseFloat(numStr.replace(/,/g, ''));
    if (!Number.isFinite(n)) return match;
    if (suffix === 'k' || suffix === 'K') n *= 1_000;
    if (suffix === 'm' || suffix === 'M') n *= 1_000_000;
    const bucket = bucketize(n);
    hits.push({
      cls: 'financial_precision',
      span: [offset, offset + match.length],
      pattern: 'money_amount',
      replacement: bucket,
    });
    return bucket;
  });
}

function bucketize(n: number): string {
  const abs = Math.abs(n);
  if (abs < 10) return '~$1';
  if (abs < 100) return '~$10';
  if (abs < 1_000) return '~$100';
  if (abs < 10_000) return '~$1k';
  if (abs < 100_000) return '~$10k';
  if (abs < 1_000_000) return '~$100k';
  if (abs < 10_000_000) return '~$1M';
  return '~$10M+';
}

// ─── Pseudonymization (gated) ───────────────────────────────────────
// v0.1 default policy is full-redact. If the operator opts in to pseudonymization,
// third-party names get a stable alias derived from a secret salt.
//
// The salt MUST live in the local environment and never cross the bridge.
// Default salt is process.env.BRIDGE_PSEUDONYM_SALT; if absent, pseudonymization
// silently fails closed (returns input unchanged).

export function pass3Pseudonymize(
  input: string,
  hits: RedactionHit[],
  cfg: RedactorConfig,
  thirdPartyNameCandidates: string[],
): string {
  if (cfg.thirdPartyNamePolicy !== 'pseudonymize') return input;
  const salt = process.env.BRIDGE_PSEUDONYM_SALT;
  if (!salt) return input;
  let text = input;
  for (const name of thirdPartyNameCandidates) {
    if (!name) continue;
    const alias = `person_${stableHash(name, salt)}`;
    const rx = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
    text = text.replace(rx, (match, offset: number) => {
      hits.push({
        cls: 'third_party_name',
        span: [offset, offset + match.length],
        pattern: 'pseudonymized',
        replacement: alias,
      });
      return alias;
    });
  }
  return text;
}

function stableHash(value: string, salt: string): string {
  return createHash('sha256').update(salt).update(':').update(value.toLowerCase()).digest('hex').slice(0, 4);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Public entry ───────────────────────────────────────────────────
export function pass3(
  input: string,
  cfg: RedactorConfig,
  thirdPartyNameCandidates: string[] = [],
): Pass3Result {
  const hits: RedactionHit[] = [];
  let text = input;
  text = pass3Pseudonymize(text, hits, cfg, thirdPartyNameCandidates);
  text = pass3Bucket(text, hits);
  return { text, hits };
}
