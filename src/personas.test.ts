import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./agent-config.js', () => ({
  listAgentIds: vi.fn(() => ['main', 'research', 'content', 'ops', 'comms']),
  loadAgentConfig: vi.fn((id: string) => {
    // Default behavior: research grants obsidian+supabase, ops grants nothing, others grant all (no mcp_servers field)
    if (id === 'research') return { name: 'r', botToken: 't', botTokenEnv: 'X', mcpServers: ['obsidian', 'supabase'] };
    if (id === 'ops') return { name: 'o', botToken: 't', botTokenEnv: 'X', mcpServers: [] };
    return { name: id, botToken: 't', botTokenEnv: 'X' };
  }),
}));

vi.mock('./config.js', () => ({
  AGENT_MAX_TURNS: 30,
  PROJECT_ROOT: '/will/be/overridden/per/test',
}));

import {
  loadPersona,
  listPersonaSlugs,
  validatePersonaForAgent,
  ALLOWED_MODELS,
} from './personas.js';
import * as config from './config.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'personas'));
  // Re-point PROJECT_ROOT for this test
  (config as { PROJECT_ROOT: string }).PROJECT_ROOT = tmpRoot;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writePersona(slug: string, body: string) {
  // Ensure the YAML's slug field matches the filename slug,
  // since loadPersona enforces filename == slug. Callers can still
  // pass a body with a different slug to test mismatch validation.
  fs.writeFileSync(path.join(tmpRoot, 'personas', `${slug}.yaml`), body);
}

/** Build a YAML body with the slug substituted in. */
function yamlWith(slug: string, mutate: (body: string) => string = (s) => s) {
  return mutate(VALID_YAML.replace('slug: quick-check', `slug: ${slug}`));
}

const VALID_YAML = `
slug: quick-check
name: Quick Check
description: Fast triage
model: claude-haiku-4-5
system_prompt: |
  You are operating in quick mode.
mcp_allowlist: []
daily_cost_cap_usd: 2.0
max_turns: 5
`;

describe('loadPersona — happy path', () => {
  it('loads a valid YAML into a shaped object', () => {
    writePersona('quick-check', VALID_YAML);
    const p = loadPersona('quick-check');
    expect(p.slug).toBe('quick-check');
    expect(p.name).toBe('Quick Check');
    expect(p.model).toBe('claude-haiku-4-5');
    expect(p.systemPrompt).toContain('quick mode');
    expect(p.mcpAllowlist).toEqual([]);
    expect(p.dailyCostCapUsd).toBe(2.0);
    expect(p.maxTurns).toBe(5);
  });

  it('treats max_turns as optional', () => {
    writePersona('p-one', yamlWith('p-one', (b) => b.replace(/max_turns: 5/, '')));
    expect(loadPersona('p-one').maxTurns).toBeUndefined();
  });
});

describe('loadPersona — validation', () => {
  it('throws if file does not exist', () => {
    expect(() => loadPersona('nonexistent')).toThrow(/not found/i);
  });

  it('rejects model not in ALLOWED_MODELS', () => {
    writePersona('bad', yamlWith('bad', (b) => b.replace('claude-haiku-4-5', 'gpt-4o')));
    expect(() => loadPersona('bad')).toThrow(/model/i);
  });

  it('rejects empty model', () => {
    writePersona('bad', yamlWith('bad', (b) => b.replace('model: claude-haiku-4-5', 'model: ""')));
    expect(() => loadPersona('bad')).toThrow(/model/i);
  });

  it('rejects system_prompt > 4096 bytes', () => {
    const huge = 'x'.repeat(5000);
    writePersona('bad', yamlWith('bad', (b) => b.replace('You are operating in quick mode.', huge)));
    expect(() => loadPersona('bad')).toThrow(/system_prompt.*4096|4096.*system_prompt/i);
  });

  it('rejects slug not matching /^[a-z0-9-]+$/', () => {
    // Can't write a file with an invalid slug name via the helper, but we can
    // simulate by writing a file whose body has an invalid slug. loadPersona
    // takes the filename slug as input, so we test the filename-side rejection.
    expect(() => loadPersona('Bad_Slug')).toThrow(/slug/i);
  });

  it('rejects slug that collides with an agent id', () => {
    writePersona('research', yamlWith('research'));
    expect(() => loadPersona('research')).toThrow(/collide|agent/i);
  });

  it('rejects mcp_allowlist that is not an array', () => {
    writePersona('bad', yamlWith('bad', (b) => b.replace('mcp_allowlist: []', 'mcp_allowlist: "obsidian"')));
    expect(() => loadPersona('bad')).toThrow(/mcp_allowlist/i);
  });

  it('rejects missing daily_cost_cap_usd', () => {
    writePersona('bad', yamlWith('bad', (b) => b.replace('daily_cost_cap_usd: 2.0', '')));
    expect(() => loadPersona('bad')).toThrow(/daily_cost_cap/i);
  });

  it('rejects daily_cost_cap_usd <= 0', () => {
    writePersona('bad', yamlWith('bad', (b) => b.replace('daily_cost_cap_usd: 2.0', 'daily_cost_cap_usd: 0')));
    expect(() => loadPersona('bad')).toThrow(/daily_cost_cap/i);
  });

  it('rejects max_turns <= 0 when set', () => {
    writePersona('bad', yamlWith('bad', (b) => b.replace('max_turns: 5', 'max_turns: 0')));
    expect(() => loadPersona('bad')).toThrow(/max_turns/i);
  });

  it('mismatched filename vs slug throws', () => {
    writePersona('wrongname', VALID_YAML);
    expect(() => loadPersona('wrongname')).toThrow(/slug/i);
  });
});

describe('listPersonaSlugs', () => {
  it('returns empty array when personas dir is empty', () => {
    expect(listPersonaSlugs()).toEqual([]);
  });

  it('returns slugs from .yaml files only (skips README.md, .json, etc.)', () => {
    writePersona('a', yamlWith('a'));
    writePersona('b', yamlWith('b'));
    fs.writeFileSync(path.join(tmpRoot, 'personas', 'README.md'), '# readme');
    fs.writeFileSync(path.join(tmpRoot, 'personas', 'something.json'), '{}');
    expect(listPersonaSlugs().sort()).toEqual(['a', 'b']);
  });

  it('returns empty array when personas dir does not exist', () => {
    fs.rmSync(path.join(tmpRoot, 'personas'), { recursive: true, force: true });
    expect(listPersonaSlugs()).toEqual([]);
  });
});

describe('validatePersonaForAgent', () => {
  it('passes when persona mcp_allowlist is empty (no MCPs needed)', () => {
    writePersona('quick-check', VALID_YAML);
    const p = loadPersona('quick-check');
    expect(() => validatePersonaForAgent(p, 'research')).not.toThrow();
    expect(() => validatePersonaForAgent(p, 'ops')).not.toThrow();
  });

  it('passes when persona mcp_allowlist is a subset of agent mcp_servers', () => {
    writePersona('p-one', yamlWith('p-one', (b) => b.replace('mcp_allowlist: []', 'mcp_allowlist:\n  - obsidian')));
    const p = loadPersona('p-one');
    expect(() => validatePersonaForAgent(p, 'research')).not.toThrow();
  });

  it('throws when persona declares an MCP the agent does not grant', () => {
    writePersona('p-two', yamlWith('p-two', (b) => b.replace('mcp_allowlist: []', 'mcp_allowlist:\n  - web')));
    const p = loadPersona('p-two');
    expect(() => validatePersonaForAgent(p, 'research')).toThrow(/web|allowlist|not.*grant/i);
  });

  it('passes when agent has no mcp_servers field (= grants all MCPs)', () => {
    writePersona('p-three', yamlWith('p-three', (b) => b.replace('mcp_allowlist: []', 'mcp_allowlist:\n  - obsidian\n  - any-mcp')));
    const p = loadPersona('p-three');
    expect(() => validatePersonaForAgent(p, 'main')).not.toThrow();
  });

  it('throws when agent grants no MCPs (empty mcp_servers) and persona wants one', () => {
    writePersona('p-four', yamlWith('p-four', (b) => b.replace('mcp_allowlist: []', 'mcp_allowlist:\n  - obsidian')));
    const p = loadPersona('p-four');
    expect(() => validatePersonaForAgent(p, 'ops')).toThrow();
  });
});

describe('ALLOWED_MODELS', () => {
  it('contains the three current Claude tiers', () => {
    expect(ALLOWED_MODELS).toContain('claude-opus-4-7');
    expect(ALLOWED_MODELS).toContain('claude-sonnet-4-6');
    expect(ALLOWED_MODELS).toContain('claude-haiku-4-5');
  });
});
