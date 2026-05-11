/**
 * Obsidian vault → memory bridge.
 *
 * Scans the curated set of folders under the second-brain vault and
 * ingests each markdown file as one or more vector-embedded memory rows,
 * replicated once per agent so per-agent searchMemories() sees them
 * without needing a "shared" tier in the existing query layer.
 *
 * Chunking strategy (v2): files are split on H2 headers (`^## `). Each
 * H2 section becomes its own chunk; pre-H2 content (frontmatter + H1 +
 * intro paragraphs) becomes the "_intro" chunk. Files with no H2 fall
 * back to a single whole-note intro chunk. Tiny chunks (<200 chars) are
 * merged into a neighbour to avoid stub spam.
 *
 * Dedup is content-hash based via the vault_sync_state table. Re-syncs
 * skip unchanged files; changed files have ALL their old memory rows
 * deleted and re-chunked from scratch (no per-chunk diffing).
 *
 * Embeddings are generated once per chunk (Gemini gemini-embedding-001)
 * and reused across the per-agent rows for that chunk — embedding text
 * doesn't change between agents.
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
// Per-chunk byte cap. Anything above this is skipped + logged (one section
// shouldn't be a 20KB wall — likely transcript dump, embed will degrade).
const MAX_CHUNK_BYTES = 20_000;
// Below this length a chunk gets merged into a neighbour rather than
// becoming its own row. Stops H2 stubs from spamming the memories table.
const MIN_CHUNK_CHARS = 200;

// Vault content baseline — above the 0.5 save threshold, below conversation
// memories that can score 0.8+ on importance.
const VAULT_IMPORTANCE = 0.6;

const SOURCE_PREFIX = 'vault:';
const INTRO_SLUG = '_intro';

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

interface Chunk {
  /** Slug for the source field (e.g. "section-one" or "_intro"). */
  slug: string;
  /** Heading text used for the chunk's summary. */
  heading: string;
  /** Full chunk text, embedded and stored as raw_text. */
  text: string;
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
 * Slugify a heading: lowercase, non-alphanumerics → "-", collapse runs,
 * trim. Deterministic so re-syncs produce stable source fields.
 * Bounded length so headings can't blow up the source column.
 */
function slugifyHeading(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : 'section';
}

/**
 * Pull a one-line summary from a chunk. For an intro chunk, prefers the
 * first H1; for an H2 chunk, the heading text itself. Final fallback is
 * the file name.
 */
function deriveChunkSummary(chunk: Chunk, relPath: string): string {
  if (chunk.heading) return chunk.heading.slice(0, 200);
  // Intro fallback: scan for an H1.
  const lines = chunk.text.split(/\r?\n/);
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

/**
 * Split a markdown file into H2-section chunks.
 *
 * - chunks[0] = intro (frontmatter + H1 + any text above the first ##)
 * - chunks[1..N] = one per H2, starting at the heading line
 *
 * Tiny chunks (<MIN_CHUNK_CHARS) are merged into a neighbour: backward
 * by default, forward if there's no previous chunk (orphaned intro).
 *
 * If no H2 is found, returns a single intro chunk containing the whole file.
 */
export function chunkMarkdown(content: string): Chunk[] {
  const lines = content.split(/\r?\n/);
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let current: { heading: string; lines: string[] } = { heading: '', lines: [] };

  for (const line of lines) {
    const h2Match = /^## (.+)$/.exec(line);
    if (h2Match) {
      sections.push(current);
      current = { heading: h2Match[1].trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);

  // Build raw chunks (intro + each H2). Drop the intro if it's empty (no
  // prefix content), since splitting a file that starts with "## ..." gives
  // an empty first section.
  const raw: Chunk[] = [];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    const text = s.lines.join('\n');
    if (i === 0 && text.trim().length === 0) continue; // empty intro
    raw.push({
      slug: i === 0 ? INTRO_SLUG : slugifyHeading(s.heading),
      heading: s.heading,
      text,
    });
  }

  if (raw.length === 0) {
    // Pathological: file with nothing parseable. One intro chunk holding the raw text.
    return [{ slug: INTRO_SLUG, heading: '', text: content }];
  }

  // Merge tiny chunks. Backward by default, forward if no predecessor.
  const merged: Chunk[] = [];
  for (const c of raw) {
    if (c.text.length < MIN_CHUNK_CHARS && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.text = prev.text + '\n\n' + c.text;
    } else {
      merged.push({ ...c });
    }
  }

  // Catch an orphaned tiny first chunk: merge it forward into the second.
  if (merged.length >= 2 && merged[0].text.length < MIN_CHUNK_CHARS) {
    const orphan = merged.shift()!;
    merged[0].text = orphan.text + '\n\n' + merged[0].text;
  }

  return merged;
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

    // Split into chunks first so we know what we're embedding.
    const chunks = chunkMarkdown(content);

    // Filter out oversized chunks (one section ballooning to >20KB).
    const acceptedChunks: Chunk[] = [];
    for (const c of chunks) {
      if (Buffer.byteLength(c.text, 'utf-8') > MAX_CHUNK_BYTES) {
        stats.skippedTooLarge++;
        logger.warn({ relPath: file.relPath, slug: c.slug, bytes: c.text.length }, 'vault-sync: chunk too large, skipping');
        continue;
      }
      acceptedChunks.push(c);
    }

    if (acceptedChunks.length === 0) {
      // Every chunk was too large to embed — nothing to do, but don't strand
      // a previous state row pointing at deleted memories.
      if (prev && prev.memory_ids.length > 0) {
        deleteMemoriesByIds(prev.memory_ids);
        deleteVaultSyncState(file.relPath);
      }
      continue;
    }

    // Delete prior memory rows if updating (whole-file replace, no per-chunk diff).
    if (prev && prev.memory_ids.length > 0) {
      deleteMemoriesByIds(prev.memory_ids);
    }

    const topics = deriveTopics(file.relPath);
    const memoryIds: number[] = [];
    let chunkSucceeded = false;

    for (const chunk of acceptedChunks) {
      // Generate embedding (one call per chunk, reused across agent rows).
      let embedding: number[];
      try {
        embedding = await embed(chunk.text);
      } catch (err) {
        stats.errors.push({
          path: file.relPath,
          error: `embed (${chunk.slug}) failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      const summary = deriveChunkSummary(chunk, file.relPath);
      const source = SOURCE_PREFIX + file.relPath + '#' + chunk.slug;

      for (const agentId of agents) {
        try {
          const id = saveStructuredMemoryAtomic(
            chatId,
            chunk.text,
            summary,
            [],
            topics,
            VAULT_IMPORTANCE,
            embedding,
            source,
            agentId,
          );
          memoryIds.push(id);
          chunkSucceeded = true;
        } catch (err) {
          stats.errors.push({
            path: file.relPath,
            error: `save (${chunk.slug}/${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    if (memoryIds.length > 0) {
      upsertVaultSyncState(file.relPath, hash, memoryIds);
      if (prev) stats.updated++; else stats.added++;
    } else if (prev && !chunkSucceeded) {
      // Update wiped old rows but nothing replaced them — clear state too.
      deleteVaultSyncState(file.relPath);
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
