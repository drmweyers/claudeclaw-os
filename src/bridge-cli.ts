// Channel 4 bridge — read-side CLI.
//
// Surfaces bridgeRecent() as a Bash-callable tool so ClaudeClaw's spawned
// Claude Code subprocess can voluntarily consult what Hal (or its own
// hermes-side past) has been doing without a programmatic API.
//
// Usage:
//   node dist/bridge-cli.js recent [hal|hermes] [sinceHours]
//   node dist/bridge-cli.js emit-test     # synthetic event for smoke-testing
//
// Designed to print JSON so the calling agent can parse it directly.

import { bridgeRecent, emitBridgeEvent } from './bridge.js';

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'recent') {
    const source = (rest[0] ?? 'hal') as 'hal' | 'hermes';
    const sinceHours = Number(rest[1] ?? '24');
    if (source !== 'hal' && source !== 'hermes') {
      console.error('source must be "hal" or "hermes"');
      process.exit(2);
    }
    if (!Number.isFinite(sinceHours) || sinceHours <= 0) {
      console.error('sinceHours must be a positive number');
      process.exit(2);
    }
    const events = await bridgeRecent(source, sinceHours);
    console.log(JSON.stringify({ source, sinceHours, count: events.length, events }, null, 2));
    return;
  }

  if (cmd === 'emit-test') {
    // For Phase 5 smoke test — fabricate a session_summary with a known
    // credential, a sentinel marker (separate run), and verify both paths.
    const variant = rest[0] ?? 'normal';

    if (variant === 'normal') {
      const summary = 'Smoke test session — discussed bridge wiring. API key sk-ant-api03-aaaabbbbccccddddeeeeffffaaaabbbbccccddddeeeeffff was redacted. Cost ran ~$2.50.';
      const ev = await emitBridgeEvent({
        source_session_id: 'smoke-' + Date.now(),
        event_type: 'session_summary',
        payload: { summary, turn_count: 8, tokens: 4200 },
      });
      console.log(JSON.stringify({ variant, emitted: ev }, null, 2));
      return;
    }

    if (variant === 'sentinel') {
      const ev = await emitBridgeEvent({
        source_session_id: 'smoke-sentinel-' + Date.now(),
        event_type: 'session_summary',
        payload: { summary: '##private this should drop entirely and become a private_aside' },
      });
      console.log(JSON.stringify({ variant, emitted: ev }, null, 2));
      return;
    }

    console.error('unknown emit-test variant. try: normal, sentinel');
    process.exit(2);
  }

  console.error('Usage:\n  node dist/bridge-cli.js recent [hal|hermes] [sinceHours]\n  node dist/bridge-cli.js emit-test [normal|sentinel]');
  process.exit(2);
}

main().catch((err) => {
  console.error('bridge-cli error:', err);
  process.exit(1);
});
