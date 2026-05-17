// Local redaction audit log writer.
// Audit rows are local-only. They MUST NEVER cross the bridge.
// Default path on Hermes side: ~/.openclaw/bridge-audit/redaction-YYYY-MM-DD.jsonl
// Default path on Hal side:    /home/node/bridge-audit/redaction-YYYY-MM-DD.jsonl
//
// The caller passes auditDir via RedactorConfig. We deliberately do not
// auto-default to second-brain — audit logs must stay off the synced path.

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RedactionAuditRow } from './types.js';

export function newAuditId(): string {
  return 'aud_' + randomBytes(2).toString('hex');
}

export function newEventId(): string {
  return 'evt_' + randomBytes(3).toString('hex');
}

export async function writeAudit(row: RedactionAuditRow, auditDir: string): Promise<void> {
  const date = row.ts.slice(0, 10); // YYYY-MM-DD
  const file = join(auditDir, `redaction-${date}.jsonl`);
  await mkdir(auditDir, { recursive: true });
  await appendFile(file, JSON.stringify(row) + '\n', 'utf8');
}
