/**
 * CLI entry point for the vault → memory bridge.
 *
 * Usage:
 *   node dist/sync-vault-cli.js                  # full sync
 *   node dist/sync-vault-cli.js --limit 50       # cap files this run
 *   node dist/sync-vault-cli.js --dry-run        # report what'd happen, no writes
 *
 * Resolves the vault root from (in order):
 *   1. --vault <path> arg
 *   2. SECOND_BRAIN_VAULT env var
 *   3. ../second-brain relative to PROJECT_ROOT
 *   4. ~/Claude/second-brain
 */

import fs from 'fs';
import path from 'path';

import { syncVault } from './vault-sync.js';
import { PROJECT_ROOT } from './config.js';
import { initDatabase } from './db.js';
import { logger } from './logger.js';

initDatabase();

function resolveVaultRoot(cliArg: string | null): string | null {
  if (cliArg) {
    return fs.existsSync(cliArg) ? path.resolve(cliArg) : null;
  }
  const fromEnv = process.env.SECOND_BRAIN_VAULT;
  if (fromEnv && fs.existsSync(fromEnv)) return path.resolve(fromEnv);

  const sibling = path.resolve(PROJECT_ROOT, '..', 'second-brain');
  if (fs.existsSync(sibling)) return sibling;

  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    const homePath = path.join(home, 'Claude', 'second-brain');
    if (fs.existsSync(homePath)) return homePath;
  }
  return null;
}

function parseArgs(argv: string[]): { vault: string | null; limit?: number } {
  let vault: string | null = null;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault' && argv[i + 1]) { vault = argv[++i]; }
    else if (a === '--limit' && argv[i + 1]) { limit = parseInt(argv[++i], 10); }
  }
  return { vault, limit };
}

async function main(): Promise<void> {
  const { vault: vaultArg, limit } = parseArgs(process.argv.slice(2));
  const vaultRoot = resolveVaultRoot(vaultArg);

  if (!vaultRoot) {
    console.error('vault root not found. Pass --vault <path> or set SECOND_BRAIN_VAULT.');
    process.exit(1);
  }

  console.log(`Syncing vault: ${vaultRoot}`);
  if (limit) console.log(`  limit: ${limit} files this run`);

  const stats = await syncVault({ vaultRoot, limit });

  console.log('');
  console.log('Sync complete.');
  console.log(`  added:           ${stats.added}`);
  console.log(`  updated:         ${stats.updated}`);
  console.log(`  unchanged:       ${stats.unchanged}`);
  console.log(`  removed:         ${stats.removed}`);
  console.log(`  skipped (small): ${stats.skippedTooSmall}`);
  console.log(`  skipped (large): ${stats.skippedTooLarge}`);
  console.log(`  errors:          ${stats.errors.length}`);
  console.log(`  duration:        ${(stats.durationMs / 1000).toFixed(1)}s`);

  if (stats.errors.length > 0) {
    console.log('');
    console.log('First 5 errors:');
    for (const e of stats.errors.slice(0, 5)) {
      console.log(`  [${e.path}] ${e.error}`);
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'sync-vault-cli failed');
  console.error('sync-vault-cli failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
