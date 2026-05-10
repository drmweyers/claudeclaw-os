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
    expect(state!.memory_ids).toHaveLength(2); // one per agent

    // One memory row exists per agent for the same source.
    const all = getRecentMemories('test-chat', 50);
    const matches = all.filter(m => m.source === 'vault:resources/peptides/bpc-157.md');
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
    const matches = all.filter(m => m.source === 'vault:projects/plan.md');
    expect(matches).toHaveLength(1);
    expect(matches[0].summary).toContain('Plan v2');
  });

  it('skips files smaller than MIN_FILE_BYTES and larger than MAX_FILE_BYTES', async () => {
    const root = await makeTempVault();
    await writeNote(root, 'resources/tiny.md', '# tiny\nfoo');                 // ~12 bytes
    await writeNote(root, 'resources/huge.md', '# huge\n' + 'x'.repeat(60_000)); // 60KB
    await writeNote(root, 'resources/ok.md',   `# ok\n\n${PADDING}`);

    const stats = await syncVault({ vaultRoot: root, embedFn: fakeEmbed, agents: ['main'], chatId: 'test-chat' });
    expect(stats.skippedTooSmall).toBe(1);
    expect(stats.skippedTooLarge).toBe(1);
    expect(stats.added).toBe(1);
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
    expect(hits.some(h => h.source === 'vault:research/topic-A.md')).toBe(true);
  });
});
