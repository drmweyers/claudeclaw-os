import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import {
  _initTestDatabase,
  getVaultSyncState,
  getRecentMemories,
  searchMemories,
} from './db.js';
import { syncVault } from './vault-sync.js';

// Deterministic fake embedding: same text → same vector. The 8-d vector
// is enough for the dedup paths we care about.
function fakeEmbed(text: string): Promise<number[]> {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  const v = Array.from({ length: 8 }, (_, i) => Math.sin(h + i));
  return Promise.resolve(v);
}

async function makeTempVault(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-sync-test-'));
  // Create only the folders the tests use; syncVault tolerates missing ones.
  for (const dir of ['resources', 'projects', 'archive']) {
    await fs.mkdir(path.join(root, dir), { recursive: true });
  }
  return root;
}

async function writeNote(vaultRoot: string, rel: string, content: string): Promise<void> {
  const full = path.join(vaultRoot, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf-8');
}

const PADDING = 'lorem ipsum dolor sit amet '.repeat(20); // ~520 chars to clear MIN_FILE_BYTES

describe('vault-sync', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('first sync of a new note creates one memory row per agent and a sync_state entry', async () => {
    const root = await makeTempVault();
    await writeNote(root, 'resources/peptides/bpc-157.md', `# BPC-157\n\n${PADDING}\n\nNotes on BPC-157.`);

    const stats = await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main', 'ops'],
      chatId: 'test-chat',
    });

    expect(stats.added).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.errors).toHaveLength(0);

    const state = getVaultSyncState('resources/peptides/bpc-157.md');
    expect(state).not.toBeNull();
    expect(state!.memory_ids).toHaveLength(2); // one chunk × two agents (no H2 → intro fallback)

    // One memory row exists per agent for the same source.
    const all = getRecentMemories('test-chat', 50);
    const matches = all.filter(m => m.source.startsWith('vault:resources/peptides/bpc-157.md#'));
    expect(matches).toHaveLength(2);
    const agents = matches.map(m => m.agent_id).sort();
    expect(agents).toEqual(['main', 'ops']);
  });

  it('re-syncing an unchanged note skips it (no new rows)', async () => {
    const root = await makeTempVault();
    await writeNote(root, 'resources/foo.md', `# Foo\n\n${PADDING}`);

    const first = await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main'], chatId: 'test-chat' });
    expect(first.added).toBe(1);

    const second = await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main'], chatId: 'test-chat' });
    expect(second.unchanged).toBe(1);
    expect(second.added).toBe(0);
    expect(second.updated).toBe(0);
  });

  it('changing a note re-embeds and replaces the prior memory rows', async () => {
    const root = await makeTempVault();
    await writeNote(root, 'projects/plan.md', `# Plan v1\n\n${PADDING}`);

    const first = await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main'], chatId: 'test-chat' });
    const stateBefore = getVaultSyncState('projects/plan.md')!;
    const oldIds = stateBefore.memory_ids;
    expect(first.added).toBe(1);

    await writeNote(root, 'projects/plan.md', `# Plan v2 (revised)\n\n${PADDING}\n\nNew section.`);
    const second = await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main'], chatId: 'test-chat' });

    expect(second.updated).toBe(1);
    expect(second.added).toBe(0);

    const stateAfter = getVaultSyncState('projects/plan.md')!;
    expect(stateAfter.content_hash).not.toBe(stateBefore.content_hash);
    // New memory IDs, old ones gone.
    expect(stateAfter.memory_ids.some(id => oldIds.includes(id))).toBe(false);

    // Ensure no orphan memories: search by source returns exactly one row per agent.
    const all = getRecentMemories('test-chat', 50);
    const matches = all.filter(m => m.source.startsWith('vault:projects/plan.md#'));
    expect(matches).toHaveLength(1);
    expect(matches[0].summary).toContain('Plan v2');
  });

  it('skips files smaller than MIN_FILE_BYTES; per-chunk size cap skips oversized chunks', async () => {
    const root = await makeTempVault();
    await writeNote(root, 'resources/tiny.md', '# tiny\nfoo');                 // ~12 bytes
    // No-H2 file of 25KB → one chunk that exceeds MAX_CHUNK_BYTES (20KB) → counted as skippedTooLarge.
    await writeNote(root, 'resources/huge.md', '# huge\n' + 'x'.repeat(25_000));
    await writeNote(root, 'resources/ok.md',   `# ok\n\n${PADDING}`);

    const stats = await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main'], chatId: 'test-chat' });
    expect(stats.skippedTooSmall).toBe(1);
    expect(stats.skippedTooLarge).toBeGreaterThanOrEqual(1); // per-chunk skip
    expect(stats.added).toBe(1); // resources/ok.md
  });

  it('ignores folders not in INCLUDED_FOLDERS (e.g. archive/)', async () => {
    const root = await makeTempVault();
    await writeNote(root, 'archive/old-note.md', `# old\n\n${PADDING}`);
    await writeNote(root, 'resources/new.md',    `# new\n\n${PADDING}`);

    const stats = await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main'], chatId: 'test-chat' });
    expect(stats.added).toBe(1); // only resources/new.md
  });

  it('removes memories for files that are deleted from the vault', async () => {
    const root = await makeTempVault();
    await writeNote(root, 'resources/transient.md', `# Transient\n\n${PADDING}`);

    const first = await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main'], chatId: 'test-chat' });
    expect(first.added).toBe(1);
    expect(getVaultSyncState('resources/transient.md')).not.toBeNull();

    await fs.rm(path.join(root, 'resources/transient.md'));
    const second = await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main'], chatId: 'test-chat' });

    expect(second.removed).toBe(1);
    expect(getVaultSyncState('resources/transient.md')).toBeNull();
    const lingering = getRecentMemories('test-chat', 50)
      .filter(m => m.source === 'vault:resources/transient.md');
    expect(lingering).toHaveLength(0);
  });

  it('vault memories are findable via vector search per agent', async () => {
    const root = await makeTempVault();
    await writeNote(root, 'research/topic-A.md', `# Topic A — peptide research notes\n\n${PADDING}`);

    await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main', 'research'], chatId: 'test-chat' });

    // Query with the same text → identical fake embedding → cosine 1.0 → match.
    const queryText = `# Topic A — peptide research notes\n\n${PADDING}`;
    const queryEmbedding = await fakeEmbed(queryText);
    const hits = searchMemories('test-chat', 'peptide', 5, queryEmbedding, 'research');
    expect(hits.length).toBeGreaterThan(0);
    // After H2 chunking, no-H2 notes fall back to a single intro chunk.
    expect(hits.some(h => h.source.startsWith('vault:research/topic-A.md#'))).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────────
  // H2 chunking
  // ────────────────────────────────────────────────────────────────────

  // Each H2 body must be large enough to clear the 200-char tiny-merge floor.
  const BODY = 'lorem ipsum dolor sit amet '.repeat(15); // ~405 chars

  it('file with 3 H2 sections produces 3 chunks per agent (intro merged forward if tiny)', async () => {
    const root = await makeTempVault();
    const content =
      `## Section One\n\n${BODY}\n\n` +
      `## Section Two\n\n${BODY}\n\n` +
      `## Section Three\n\n${BODY}\n`;
    await writeNote(root, 'resources/three-section.md', content);

    const stats = await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main', 'ops'],
      chatId: 'test-chat',
    });
    expect(stats.added).toBe(1);

    const state = getVaultSyncState('resources/three-section.md')!;
    // 3 chunks × 2 agents = 6 memory rows.
    expect(state.memory_ids).toHaveLength(6);

    const matches = getRecentMemories('test-chat', 50)
      .filter(m => m.source.startsWith('vault:resources/three-section.md#'));
    expect(matches).toHaveLength(6);

    const sources = new Set(matches.map(m => m.source));
    expect(sources.has('vault:resources/three-section.md#section-one')).toBe(true);
    expect(sources.has('vault:resources/three-section.md#section-two')).toBe(true);
    expect(sources.has('vault:resources/three-section.md#section-three')).toBe(true);
  });

  it('file with H1 + intro + 2 H2 sections produces 3 chunks (intro + 2 sections)', async () => {
    const root = await makeTempVault();
    const content =
      `# Top Title\n\n${BODY}\n\n` +              // intro chunk (substantial)
      `## Alpha\n\n${BODY}\n\n` +
      `## Beta\n\n${BODY}\n`;
    await writeNote(root, 'resources/intro-plus-two.md', content);

    await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main'],
      chatId: 'test-chat',
    });

    const state = getVaultSyncState('resources/intro-plus-two.md')!;
    expect(state.memory_ids).toHaveLength(3); // intro + 2 H2 sections, 1 agent

    const matches = getRecentMemories('test-chat', 50)
      .filter(m => m.source.startsWith('vault:resources/intro-plus-two.md#'));
    const sources = matches.map(m => m.source).sort();
    expect(sources).toEqual([
      'vault:resources/intro-plus-two.md#_intro',
      'vault:resources/intro-plus-two.md#alpha',
      'vault:resources/intro-plus-two.md#beta',
    ]);
  });

  it('file with no H2 falls back to single whole-note chunk', async () => {
    const root = await makeTempVault();
    await writeNote(root, 'resources/flat.md', `# Flat\n\n${PADDING}`);

    await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main'],
      chatId: 'test-chat',
    });

    const state = getVaultSyncState('resources/flat.md')!;
    expect(state.memory_ids).toHaveLength(1);

    const matches = getRecentMemories('test-chat', 50)
      .filter(m => m.source.startsWith('vault:resources/flat.md#'));
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe('vault:resources/flat.md#_intro');
  });

  it('tiny H2 section (<200 chars) merges into the previous chunk', async () => {
    const root = await makeTempVault();
    const content =
      `## Big One\n\n${BODY}\n\n` +              // substantial section
      `## Stub\n\nshort.\n\n` +                  // tiny → merge into Big One
      `## Big Two\n\n${BODY}\n`;                 // substantial
    await writeNote(root, 'resources/with-stub.md', content);

    await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main'],
      chatId: 'test-chat',
    });

    const state = getVaultSyncState('resources/with-stub.md')!;
    expect(state.memory_ids).toHaveLength(2); // stub absorbed into big-one

    const matches = getRecentMemories('test-chat', 50)
      .filter(m => m.source.startsWith('vault:resources/with-stub.md#'));
    const sources = matches.map(m => m.source).sort();
    expect(sources).toEqual([
      'vault:resources/with-stub.md#big-one',
      'vault:resources/with-stub.md#big-two',
    ]);

    // The stub's text must still be present somewhere — it should live inside Big One.
    const bigOne = matches.find(m => m.source.endsWith('#big-one'))!;
    expect(bigOne.raw_text).toContain('Stub');
    expect(bigOne.raw_text).toContain('short.');
  });

  it('re-syncing with reordered H2 sections deletes all old chunks and creates new ones', async () => {
    const root = await makeTempVault();
    const v1 =
      `## Alpha\n\n${BODY}\n\n` +
      `## Beta\n\n${BODY}\n\n` +
      `## Gamma\n\n${BODY}\n`;
    await writeNote(root, 'projects/multi.md', v1);

    await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main'],
      chatId: 'test-chat',
    });
    const before = getVaultSyncState('projects/multi.md')!;
    const oldIds = [...before.memory_ids];
    expect(oldIds).toHaveLength(3);

    // Reorder + add new section.
    const v2 =
      `## Gamma\n\n${BODY}\n\n` +
      `## Alpha\n\n${BODY}\n\n` +
      `## Beta\n\n${BODY}\n\n` +
      `## Delta\n\n${BODY}\n`;
    await writeNote(root, 'projects/multi.md', v2);

    const stats2 = await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main'],
      chatId: 'test-chat',
    });
    expect(stats2.updated).toBe(1);

    const after = getVaultSyncState('projects/multi.md')!;
    expect(after.memory_ids).toHaveLength(4);
    // No id from the old set survives.
    expect(after.memory_ids.some(id => oldIds.includes(id))).toBe(false);

    // No orphans in memories table.
    const matches = getRecentMemories('test-chat', 50)
      .filter(m => m.source.startsWith('vault:projects/multi.md#'));
    expect(matches).toHaveLength(4);
  });

  it('deletion of a multi-chunk file GCs every chunk', async () => {
    const root = await makeTempVault();
    const content =
      `## One\n\n${BODY}\n\n` +
      `## Two\n\n${BODY}\n\n` +
      `## Three\n\n${BODY}\n`;
    await writeNote(root, 'resources/doomed.md', content);

    await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main', 'ops'],
      chatId: 'test-chat',
    });

    const before = getVaultSyncState('resources/doomed.md')!;
    expect(before.memory_ids).toHaveLength(6); // 3 chunks × 2 agents

    await fs.rm(path.join(root, 'resources/doomed.md'));
    const stats = await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main', 'ops'],
      chatId: 'test-chat',
    });

    expect(stats.removed).toBe(1);
    expect(getVaultSyncState('resources/doomed.md')).toBeNull();
    const lingering = getRecentMemories('test-chat', 50)
      .filter(m => m.source.startsWith('vault:resources/doomed.md'));
    expect(lingering).toHaveLength(0);
  });

  it('chunk slug is stable across re-syncs of the same heading', async () => {
    const root = await makeTempVault();
    const v1 = `## Peptides & Longevity!!!\n\n${BODY}\n`;
    await writeNote(root, 'research/slug-test.md', v1);

    await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main'],
      chatId: 'test-chat',
    });
    const before = getRecentMemories('test-chat', 50)
      .filter(m => m.source.startsWith('vault:research/slug-test.md#'));
    expect(before).toHaveLength(1);
    const slug1 = before[0].source.split('#')[1];

    // Tweak the body (content_hash changes) but KEEP the heading identical.
    const v2 = `## Peptides & Longevity!!!\n\n${BODY}\n\nExtra line.\n`;
    await writeNote(root, 'research/slug-test.md', v2);
    await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main'],
      chatId: 'test-chat',
    });
    const after = getRecentMemories('test-chat', 50)
      .filter(m => m.source.startsWith('vault:research/slug-test.md#'));
    expect(after).toHaveLength(1);
    const slug2 = after[0].source.split('#')[1];

    expect(slug1).toBe(slug2);
    expect(slug1).toMatch(/^[a-z0-9-]+$/);
  });

  it('previously oversized file (>50KB) now succeeds via chunking', async () => {
    const root = await makeTempVault();
    // 4 sections × ~16KB each = ~64KB total → would have been skipped under the old MAX_FILE_BYTES.
    const big = 'word '.repeat(3200); // ~16KB per section
    const content =
      `## Part 1\n\n${big}\n\n` +
      `## Part 2\n\n${big}\n\n` +
      `## Part 3\n\n${big}\n\n` +
      `## Part 4\n\n${big}\n`;
    await writeNote(root, 'research/oversized.md', content);

    const stats = await syncVault({
      vaultRoot: root,
      embedFn: fakeEmbed,
      agents: ['main'],
      chatId: 'test-chat',
    });

    expect(stats.skippedTooLarge).toBe(0); // no file-level skip anymore
    expect(stats.added).toBe(1);

    const state = getVaultSyncState('research/oversized.md')!;
    expect(state.memory_ids).toHaveLength(4); // 4 chunks, 1 agent
  });
});
