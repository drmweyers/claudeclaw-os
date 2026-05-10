/**
 * Obsidian vault → memory bridge.
 *
 * Scans the curated set of folders under the second-brain vault and
 * ingests each markdown file as a vector-embedded memory row, replicated
 * once per agent so per-agent searchMemories() sees it without needing
 * a "shared" tier in the existing query layer.
 *
 * Dedup is content-hash based via the vault_sync_state table. Re-syncs
 * skip unchanged files; changed files have their old memory rows
 * deleted and re-ingested.
 *
 * Embeddings are generated once per file (Gemini gemini-embedding-001)
 * and reused across the per-agent rows — embedding text doesn't change
 * between agents.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

import { embedText } from './embeddings.js';
import {
  saveStructuredMemoryAtomic,
  getVaultSyncState,
  upsertVaultSyncState,
  deleteVaultSyncState,
  getAllVaultSyncPaths,
  deleteMemoriesByIds,
} from './db.js';
import { ALLOWED_CHAT_ID } from './config.js';
import { logger } from './logger.js';

export const VAULT_AGENTS = ['main', 'ops', 'content', 'research', 'comms'] as const;

export const INCLUDED_FOLDERS = [
  'resources',
  'projects',
  'dev-updates',
  'ops-updates',
  'research',
  'daily-notes',
  'areas/people',
  'content',
  'tasks',
];

// Files smaller than this are noise (frontmatter-only stubs, blank notes).
const MIN_FILE_BYTES = 100;
// Gemini embedding has a token cap. Anything past this is split-or-skip
// territory; for v1 we skip and log so a follow-up pass can chunk.
const MAX_FILE_BYTES = 50_000;

// Vault content baseline — above the 0.5 save threshold, below conversation
// memories that can score 0.8+ on importance.
const VAULT_IMPORTANCE = 0.6;

const SOURCE_PREFIX = 'vault:';

export interface SyncStats {
  added: number;
  updated: number;
  unchanged: number;
  skippedTooSmall: number;
  skippedTooLarge: number;
  removed: number;
  errors: Array<{ path: string; error: string }>;
  durationMs: number;
}

export interface SyncOptions {
  vaultRoot: string;
  /** Skip embedding (test-only injection point). */
  embedFn?: (text: string) => Promise<number[]>;
  /** Override agent list (test-only). */
  agents?: readonly string[];
  /** Override chat_id binding (test-only). Defaults to ALLOWED_CHAT_ID. */
  chatId?: string;
  /** Limit on files to process this run. Default unlimited. */
  limit?: number;
}

interface VaultFile {
  absPath: string;
  relPath: string;
  size: number;
}

async function walkFolder(root: string, folder: string): Promise<VaultFile[]> {
  const out: VaultFile[] = [];
  const start = path.join(root, folder);
  try {
    await fs.access(start);
  } catch {
    return out;
  }
  const stack: string[] = [start];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      logger.warn({ err, dir }, 'vault-sync: readdir failed, skipping');
      continue;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue; // skip .obsidian, .git, etc.
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        try {
          const stat = await fs.stat(full);
          out.push({
            absPath: full,
            relPath: path.relative(root, full).replace(/\\/g, '/'),
            size: stat.size,
          });
        } catch {
          // race: file removed between readdir and stat — skip
        }
      }
    }
  }
  return out;
}

function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Pull a one-line summary from the note. Prefers the first markdown H1;
 * falls back to the first non-empty, non-frontmatter line; final fallback
 * is the file name.
 */
function deriveSummary(text: string, relPath: string): string {
  const lines = text.split(/\r?\n/);
  let inFrontmatter = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (i === 0 && line === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false;
      continue;
    }
    if (!line) continue;
    if (line.startsWith('# ')) return line.slice(2).trim().slice(0, 200);
    return line.slice(0, 200);
  }
  return path.basename(relPath, '.md');
}

/**
 * Topics derived from path components, stripped of separators.
 * E.g. "research/peptides/bpc-157.md" → ["research", "peptides"].
 * Filename itself is excluded — it's already in the summary.
 */
function deriveTopics(relPath: string): string[] {
  const parts = relPath.split('/').slice(0, -1);
  return parts.filter((p) => p.length > 0);
}

export async function syncVault(opts: SyncOptions): Promise<SyncStats> {
  const start = Date.now();
  const stats: SyncStats = {
    added: 0,
    updated: 0,
    unchanged: 0,
    skippedTooSmall: 0,
    skippedTooLarge: 0,
    removed: 0,
    errors: [],
    durationMs: 0,
  };

  const embed = opts.embedFn ?? embedText;
  const agents = opts.agents ?? VAULT_AGENTS;
  const chatId = opts.chatId ?? (ALLOWED_CHAT_ID || 'vault');

  // 1. Discover files in scope.
  const allFiles: VaultFile[] = [];
  for (const folder of INCLUDED_FOLDERS) {
    const files = await walkFolder(opts.vaultRoot, folder);
    allFiles.push(...files);
  }

  const seenPaths = new Set<string>();
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let processed = 0;

  // 2. Sync each file.
  for (const file of allFiles) {
    if (processed >= limit) break;
    seenPaths.add(file.relPath);

    if (file.size < MIN_FILE_BYTES) { stats.skippedTooSmall++; continue; }
    if (file.size > MAX_FILE_BYTES) { stats.skippedTooLarge++; continue; }

    let content: string;
    try {
      content = await fs.readFile(file.absPath, 'utf-8');
    } catch (err) {
      stats.errors.push({ path: file.relPath, error: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const hash = hashContent(content);
    const prev = getVaultSyncState(file.relPath);

    if (prev && prev.content_hash === hash) {
      stats.unchanged++;
      continue;
    }

    // Generate embedding (one call per file, reused across agent rows).
    let embedding: number[];
    try {
      embedding = await embed(content);
    } catch (err) {
      stats.errors.push({
        path: file.relPath,
        error: `embed failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Delete prior memory rows if updating.
    if (prev && prev.memory_ids.length > 0) {
      deleteMemoriesByIds(prev.memory_ids);
    }

    const summary = deriveSummary(content, file.relPath);
    const topics = deriveTopics(file.relPath);
    const source = SOURCE_PREFIX + file.relPath;
    const memoryIds: number[] = [];

    for (const agentId of agents) {
      try {
        const id = saveStructuredMemoryAtomic(
          chatId,
          content,
          summary,
          [],
          topics,
          VAULT_IMPORTANCE,
          embedding,
          source,
          agentId,
        );
        memoryIds.push(id);
      } catch (err) {
        stats.errors.push({
          path: file.relPath,
          error: `save (${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (memoryIds.length > 0) {
      upsertVaultSyncState(file.relPath, hash, memoryIds);
      if (prev) stats.updated++; else stats.added++;
    }

    processed++;
  }

  // 3. Garbage-collect: any path in vault_sync_state that's no longer in
  // the vault (file deleted or moved out of scope) → drop its memories.
  for (const trackedPath of getAllVaultSyncPaths()) {
    if (seenPaths.has(trackedPath)) continue;
    const state = getVaultSyncState(trackedPath);
    if (state) {
      deleteMemoriesByIds(state.memory_ids);
      deleteVaultSyncState(trackedPath);
      stats.removed++;
    }
  }

  stats.durationMs = Date.now() - start;
  return stats;
}
