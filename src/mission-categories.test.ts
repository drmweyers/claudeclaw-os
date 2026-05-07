// Tests for mission_tasks.category — Operations / Marketing / Implementation.
//
// Why this exists: Mark wants tasks split by category in addition to the
// existing per-agent breakdown in Mission Control. Adding a column +
// optional filter is cheaper than a parallel data store, so all category
// information lives on mission_tasks itself.
//
// These tests pin both the DB layer (schema, helpers) and the HTTP API
// surface that the SPA consumes. A regression here would silently drop
// the new category from create/read/update flows.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  createMissionTask,
  getMissionTask,
  getMissionTasks,
  setMissionTaskCategory,
  claimNextMissionTask,
  completeMissionTask,
  assignMissionTask,
} from './db.js';
import { buildDashboardApp } from './dashboard.js';
import type { Hono } from 'hono';

const TOKEN = 'test-contract-token';

let app: Hono;

beforeAll(() => {
  app = buildDashboardApp(undefined) as unknown as Hono;
});

beforeEach(() => {
  _initTestDatabase();
});

async function post(path: string, body: unknown) {
  return app.request(path + '?token=' + TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown) {
  return app.request(path + '?token=' + TOKEN, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get(path: string) {
  return app.request(path + (path.includes('?') ? '&' : '?') + 'token=' + TOKEN);
}

// ── DB layer ──────────────────────────────────────────────────────

describe('mission_tasks.category — DB', () => {
  it('createMissionTask accepts category and round-trips it', () => {
    createMissionTask('t-ops-1', 'Reset DigitalOcean droplet', 'do it', null, 'dashboard', 5, 'ops');
    const t = getMissionTask('t-ops-1');
    expect(t).not.toBeNull();
    expect(t!.category).toBe('ops');
  });

  it('createMissionTask defaults category to null when not provided', () => {
    createMissionTask('t-none', 'Just a task', 'whatever', null, 'dashboard', 0);
    const t = getMissionTask('t-none');
    expect(t!.category).toBeNull();
  });

  it('setMissionTaskCategory updates an existing task', () => {
    createMissionTask('t-mk', 'Write LinkedIn post', 'write it', null, 'dashboard', 0);
    expect(setMissionTaskCategory('t-mk', 'marketing')).toBe(true);
    expect(getMissionTask('t-mk')!.category).toBe('marketing');
  });

  it('setMissionTaskCategory accepts null to clear', () => {
    createMissionTask('t-clear', 'Some task', 'p', null, 'dashboard', 0, 'impl');
    expect(setMissionTaskCategory('t-clear', null)).toBe(true);
    expect(getMissionTask('t-clear')!.category).toBeNull();
  });

  it('setMissionTaskCategory rejects invalid values without throwing', () => {
    createMissionTask('t-bad', 'Some task', 'p', null, 'dashboard', 0);
    expect(setMissionTaskCategory('t-bad', 'finance' as any)).toBe(false);
    expect(getMissionTask('t-bad')!.category).toBeNull();
  });

  it('getMissionTasks filters by category when provided', () => {
    createMissionTask('a', 't1', 'p', null, 'dashboard', 0, 'ops');
    createMissionTask('b', 't2', 'p', null, 'dashboard', 0, 'marketing');
    createMissionTask('c', 't3', 'p', null, 'dashboard', 0, 'ops');
    createMissionTask('d', 't4', 'p', null, 'dashboard', 0);

    const ops = getMissionTasks(undefined, undefined, 'ops');
    expect(ops.map((t) => t.id).sort()).toEqual(['a', 'c']);

    const all = getMissionTasks();
    expect(all.length).toBe(4);
  });

  it('claimNextMissionTask preserves category on the running task', () => {
    createMissionTask('claim-me', 'tag me', 'p', 'research', 'dashboard', 5, 'impl');
    assignMissionTask('claim-me', 'research'); // no-op (already assigned via createMissionTask)
    const claimed = claimNextMissionTask('research');
    expect(claimed?.id).toBe('claim-me');
    expect(claimed?.category).toBe('impl');
    // Round-trip via DB to confirm persistence, not just the in-memory return value.
    expect(getMissionTask('claim-me')!.category).toBe('impl');
  });

  it('completeMissionTask leaves category intact', () => {
    createMissionTask('done-1', 't', 'p', 'research', 'dashboard', 0, 'marketing');
    completeMissionTask('done-1', 'result text', 'completed');
    const t = getMissionTask('done-1');
    expect(t!.status).toBe('completed');
    expect(t!.category).toBe('marketing');
  });
});

// ── HTTP API ──────────────────────────────────────────────────────

describe('mission_tasks.category — API', () => {
  it('POST /api/mission/tasks accepts category and returns it on the task', async () => {
    const res = await post('/api/mission/tasks', {
      title: 'Write blog draft',
      prompt: 'Outline a 1500-word blog about EvoFit Meals.',
      category: 'marketing',
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.task).toBeTruthy();
    expect(body.task.category).toBe('marketing');
  });

  it('POST without category creates a task with category=null', async () => {
    const res = await post('/api/mission/tasks', {
      title: 'Generic task',
      prompt: 'do something',
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    expect(body.task.category).toBeNull();
  });

  it('POST rejects an unknown category value with 400', async () => {
    const res = await post('/api/mission/tasks', {
      title: 'Generic task',
      prompt: 'do something',
      category: 'finance',
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/mission/tasks/:id updates category alone', async () => {
    const created = await post('/api/mission/tasks', { title: 'Some task', prompt: 'whatever' });
    const id = (await created.json() as any).task.id;

    const res = await patch(`/api/mission/tasks/${id}`, { category: 'impl' });
    expect(res.status).toBe(200);

    const fetched = await get(`/api/mission/tasks/${id}`);
    const body: any = await fetched.json();
    expect(body.task.category).toBe('impl');
  });

  it('PATCH rejects an unknown category value with 400', async () => {
    const created = await post('/api/mission/tasks', { title: 'Some task', prompt: 'whatever' });
    const id = (await created.json() as any).task.id;

    const res = await patch(`/api/mission/tasks/${id}`, { category: 'random-thing' });
    expect(res.status).toBe(400);
  });

  it('GET /api/mission/tasks?category=ops filters server-side', async () => {
    await post('/api/mission/tasks', { title: 'A', prompt: 'p', category: 'ops' });
    await post('/api/mission/tasks', { title: 'B', prompt: 'p', category: 'marketing' });
    await post('/api/mission/tasks', { title: 'C', prompt: 'p', category: 'ops' });

    const res = await get('/api/mission/tasks?category=ops');
    const body: any = await res.json();
    expect(body.tasks.length).toBe(2);
    expect(body.tasks.every((t: any) => t.category === 'ops')).toBe(true);
  });

  it('PATCH {category: null} clears an existing category', async () => {
    const created = await post('/api/mission/tasks', {
      title: 'Some task',
      prompt: 'whatever',
      category: 'impl',
    });
    const id = (await created.json() as any).task.id;
    expect((await (await get(`/api/mission/tasks/${id}`)).json() as any).task.category).toBe('impl');

    const res = await patch(`/api/mission/tasks/${id}`, { category: null });
    expect(res.status).toBe(200);

    const fetched = await get(`/api/mission/tasks/${id}`);
    expect(((await fetched.json()) as any).task.category).toBeNull();
  });
});
