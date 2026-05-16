import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { listAgentIds, loadAgentConfig } from './agent-config.js';
import * as config from './config.js';

export const ALLOWED_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export interface Persona {
  slug: string;
  name: string;
  description: string;
  model: AllowedModel;
  systemPrompt: string;
  mcpAllowlist: string[];
  dailyCostCapUsd: number;
  maxTurns?: number;
}

const PERSONA_SLUG_RE = /^[a-z0-9-]+$/;
const MAX_SYSTEM_PROMPT_BYTES = 4096;

function personasDir(): string {
  return path.join(config.PROJECT_ROOT, 'personas');
}

function personaPath(slug: string): string {
  return path.join(personasDir(), `${slug}.yaml`);
}

/**
 * Load and validate a persona by slug. Throws if the file is missing,
 * malformed, or fails any schema rule.
 */
export function loadPersona(slug: string): Persona {
  if (!PERSONA_SLUG_RE.test(slug)) {
    throw new Error(`Invalid persona slug "${slug}": must match /^[a-z0-9-]+$/`);
  }

  const file = personaPath(slug);
  if (!fs.existsSync(file)) {
    throw new Error(`Persona not found: ${file}`);
  }

  const raw = yaml.load(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Persona ${file}: YAML root is not an object`);
  }

  const fileSlug = String(raw['slug'] ?? '');
  if (fileSlug !== slug) {
    throw new Error(`Persona ${file}: slug field "${fileSlug}" does not match filename "${slug}"`);
  }

  if (!PERSONA_SLUG_RE.test(fileSlug)) {
    throw new Error(`Persona ${file}: slug "${fileSlug}" must match /^[a-z0-9-]+$/`);
  }

  const agentIds = listAgentIds();
  if (agentIds.includes(fileSlug)) {
    throw new Error(
      `Persona slug "${fileSlug}" collides with an existing agent id. Persona and agent namespaces must be disjoint.`,
    );
  }

  const model = String(raw['model'] ?? '');
  if (!ALLOWED_MODELS.includes(model as AllowedModel)) {
    throw new Error(
      `Persona ${file}: model "${model}" not in ALLOWED_MODELS [${ALLOWED_MODELS.join(', ')}]`,
    );
  }

  const systemPrompt = String(raw['system_prompt'] ?? '');
  if (systemPrompt.trim().length === 0) {
    throw new Error(`Persona ${file}: system_prompt is required and must be non-empty`);
  }
  const promptBytes = Buffer.byteLength(systemPrompt, 'utf-8');
  if (promptBytes > MAX_SYSTEM_PROMPT_BYTES) {
    throw new Error(
      `Persona ${file}: system_prompt is ${promptBytes} bytes (max ${MAX_SYSTEM_PROMPT_BYTES})`,
    );
  }

  const mcpAllowlistRaw = raw['mcp_allowlist'];
  if (!Array.isArray(mcpAllowlistRaw)) {
    throw new Error(`Persona ${file}: mcp_allowlist must be an array (use [] for none)`);
  }
  const mcpAllowlist: string[] = mcpAllowlistRaw.map((v) => String(v));

  const dailyCostCapUsd = Number(raw['daily_cost_cap_usd']);
  if (!Number.isFinite(dailyCostCapUsd) || dailyCostCapUsd <= 0) {
    throw new Error(`Persona ${file}: daily_cost_cap_usd must be a positive number (got ${raw['daily_cost_cap_usd']})`);
  }

  let maxTurns: number | undefined;
  if (raw['max_turns'] !== undefined) {
    const parsed = Number(raw['max_turns']);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Persona ${file}: max_turns must be a positive integer when set (got ${raw['max_turns']})`);
    }
    maxTurns = Math.min(parsed, config.AGENT_MAX_TURNS);
  }

  return {
    slug: fileSlug,
    name: String(raw['name'] ?? fileSlug),
    description: String(raw['description'] ?? ''),
    model: model as AllowedModel,
    systemPrompt,
    mcpAllowlist,
    dailyCostCapUsd,
    maxTurns,
  };
}

/**
 * List all persona slugs available on disk. Reads only `*.yaml` files in
 * the personas directory; ignores README, JSON, hidden files, and dirs.
 * Returns empty array if the directory does not exist.
 */
export function listPersonaSlugs(): string[] {
  const dir = personasDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('.'))
    .map((f) => f.replace(/\.yaml$/, ''));
}

/**
 * Defensive runtime intersection: returns the MCP allowlist that should
 * actually be passed to runAgent for this persona. Caller is responsible
 * for ensuring the persona was validated against the agent at queue time;
 * this re-intersects in case the agent's mcp_servers changed between
 * queue and dispatch.
 *
 * @param personaAllowlist The persona's declared mcp_allowlist.
 * @param agentAllowlist The agent's current mcp_servers, or undefined (= grants all).
 * @returns The intersected allowlist. If the agent grants all MCPs, returns
 *          the persona allowlist unchanged. If the persona has no MCPs, returns [].
 */
export function intersectMcpAllowlists(
  personaAllowlist: string[],
  agentAllowlist?: string[],
): string[] {
  if (personaAllowlist.length === 0) return [];
  if (agentAllowlist === undefined) return [...personaAllowlist];
  return personaAllowlist.filter((m) => agentAllowlist.includes(m));
}

/**
 * Verify a persona is compatible with a specific agent: every entry in
 * the persona's mcp_allowlist must also be in the agent's mcp_servers
 * allowlist. If the agent has no mcp_servers field (= grants all MCPs),
 * any persona allowlist is acceptable.
 *
 * Throws on mismatch so callers (mission-cli, scheduler) can fail loud.
 */
export function validatePersonaForAgent(persona: Persona, agentId: string): void {
  if (persona.mcpAllowlist.length === 0) return; // persona uses no MCPs; always fine

  let agentMcpServers: string[] | undefined;
  try {
    const agentConfig = loadAgentConfig(agentId);
    agentMcpServers = agentConfig.mcpServers;
  } catch (err) {
    throw new Error(`validatePersonaForAgent: cannot load agent "${agentId}": ${(err as Error).message}`);
  }

  // If the agent has no mcp_servers field at all (undefined), it grants all MCPs.
  if (agentMcpServers === undefined) return;

  const missing = persona.mcpAllowlist.filter((m) => !agentMcpServers!.includes(m));
  if (missing.length > 0) {
    throw new Error(
      `Persona "${persona.slug}" requires MCP servers [${missing.join(', ')}] that agent "${agentId}" does not grant. Add them to agents/${agentId}/agent.yaml mcp_servers, or remove them from the persona.`,
    );
  }
}
