/**
 * Shared Skills directory reader.
 *
 * Scans `<workspace>/second-brain/shared-skills/` (the BCI cross-agent
 * skill library) and exposes a typed list + per-skill detail view to the
 * dashboard. Used by the /api/skills and /api/skills/:id routes.
 *
 * Design notes:
 * - Source of truth is the filesystem, not a database. The second-brain
 *   directory IS the skill registry; we just present it.
 * - We tolerate skill directories without a SKILL.md (some are bundles
 *   of supporting docs only) by surfacing them with `hasContent:false`.
 * - Categories are derived from skill ID prefixes; no metadata change
 *   required in the second-brain itself.
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

// The second-brain lives one level up from claudeclaw-os in Mark's setup.
// Fall back to `~/Claude/second-brain` if the relative path doesn't
// resolve (e.g. CI checkout, custom layout) — we'd rather return an
// empty list than crash the dashboard.
function resolveSharedSkillsRoot(): string {
  const relative = path.resolve(PROJECT_ROOT, '..', 'second-brain', 'shared-skills');
  if (fs.existsSync(relative)) return relative;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    const homePath = path.join(home, 'Claude', 'second-brain', 'shared-skills');
    if (fs.existsSync(homePath)) return homePath;
  }
  return relative;
}

export const SHARED_SKILLS_ROOT = resolveSharedSkillsRoot();

// ── Categorization ──────────────────────────────────────────────────

export interface SkillCategory { id: string; label: string; }

// Single-pass classifier. Order matters — first match wins.
const CATEGORY_RULES: Array<{ category: string; test: (id: string) => boolean }> = [
  { category: 'QA & Testing',         test: (id) => /^forge|user-simulation/.test(id) },
  { category: 'Engineering',          test: (id) => /^(parallel-workflow|coding-|ralph-loop|self-heal|tiered-authorization|superpowers|openwolf|bridge-to-claude-code|engineering)$/.test(id) },
  { category: 'Browser Automation',   test: (id) => /bowser|browser|playwright|firecrawl|website-agent/.test(id) },
  { category: 'Marketing & Funnels',  test: (id) => /funnel|brunson|^marketing$|website-copy|homepage-audit|content-pipeline-research/.test(id) },
  { category: 'Design & Visual',      test: (id) => /design|logo-generator|nano-banana|instagram-slides|stitch-design|talking-head|remotion-video|carousel/.test(id) },
  { category: 'Content',              test: (id) => /^(blog-image-generator|email-professional-format|lead-magnet-generator|digital-product-generator|linkedin-profile-optimizer)$/.test(id) },
  { category: 'EvoFit',               test: (id) => /^evofit-/.test(id) },
  { category: 'Operations',           test: (id) => /^(agent-ops-playbook|autonomous-dispatch|finance-ops|operations|cost-control|cc-board)$/.test(id) },
  { category: 'Integrations',         test: (id) => /^(x-api|x-posting|youtube-api|google-drive-sync)$/.test(id) },
  { category: 'Website',              test: (id) => /^(website-builder|website-copy)$/.test(id) },
];

function classify(skillId: string): string {
  for (const r of CATEGORY_RULES) if (r.test(skillId)) return r.category;
  return 'General';
}

// ── Frontmatter + meta parsing ──────────────────────────────────────

interface SkillFrontmatter {
  name?: string;
  description?: string;
  aliases?: string[];
  // we don't need to type the rest of the keys — they pass through
  [key: string]: unknown;
}

function readFrontmatter(skillMdPath: string): { frontmatter: SkillFrontmatter; body: string } {
  const raw = fs.readFileSync(skillMdPath, 'utf-8');
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('---')) return { frontmatter: {}, body: raw };
  const closeIdx = trimmed.indexOf('\n---', 3);
  if (closeIdx === -1) return { frontmatter: {}, body: raw };
  const yamlBlock = trimmed.slice(3, closeIdx).trim();
  const body = trimmed.slice(closeIdx + 4).trim();
  try {
    const parsed = yaml.load(yamlBlock) as SkillFrontmatter | null;
    return { frontmatter: parsed && typeof parsed === 'object' ? parsed : {}, body };
  } catch (err) {
    // A malformed YAML header should not break the whole list — log and
    // fall back to no frontmatter so the skill still appears with its
    // directory name.
    logger.warn({ err, skillMdPath }, 'shared-skill: frontmatter parse failed');
    return { frontmatter: {}, body };
  }
}

interface SkillMetaJson {
  version?: string;
  publishedAt?: number;  // epoch ms
}

function readMetaJson(metaPath: string): SkillMetaJson {
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      publishedAt: typeof parsed.publishedAt === 'number' ? parsed.publishedAt : undefined,
    };
  } catch { return {}; }
}

// "Last updated" priority:
//   1. _meta.json publishedAt (when the skill was last published)
//   2. SKILL.md mtime
//   3. Directory mtime
function lastUpdatedMs(dir: string, meta: SkillMetaJson): number {
  if (meta.publishedAt && meta.publishedAt > 0) return meta.publishedAt;
  const skillMd = path.join(dir, 'SKILL.md');
  try { if (fs.existsSync(skillMd)) return fs.statSync(skillMd).mtimeMs; } catch {}
  try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
}

// ── Public API ──────────────────────────────────────────────────────

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category: string;
  version: string | null;
  lastUpdated: number;     // epoch ms — frontend formats
  hasContent: boolean;     // false for bundle-only directories without SKILL.md
}

export interface SkillDetail extends SkillSummary {
  body: string;            // SKILL.md body, frontmatter stripped
  aliases: string[];
}

const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/i;

export function listSharedSkills(): { root: string; skills: SkillSummary[] } {
  if (!fs.existsSync(SHARED_SKILLS_ROOT)) {
    return { root: SHARED_SKILLS_ROOT, skills: [] };
  }

  const out: SkillSummary[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(SHARED_SKILLS_ROOT, { withFileTypes: true });
  } catch (err) {
    logger.warn({ err, root: SHARED_SKILLS_ROOT }, 'shared-skills: readdir failed');
    return { root: SHARED_SKILLS_ROOT, skills: [] };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!SAFE_ID_RE.test(id)) continue;

    const dir = path.join(SHARED_SKILLS_ROOT, id);
    const skillMd = path.join(dir, 'SKILL.md');
    const meta = readMetaJson(path.join(dir, '_meta.json'));

    let name = id;
    let description = '';
    const hasContent = fs.existsSync(skillMd);
    if (hasContent) {
      const { frontmatter } = readFrontmatter(skillMd);
      if (typeof frontmatter.name === 'string') name = frontmatter.name;
      if (typeof frontmatter.description === 'string') description = frontmatter.description.replace(/\s+/g, ' ').trim();
    }

    out.push({
      id,
      name,
      description,
      category: classify(id),
      version: meta.version ?? null,
      lastUpdated: lastUpdatedMs(dir, meta),
      hasContent,
    });
  }

  // Sort by category then name. Frontend can re-sort if needed.
  out.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.name.localeCompare(b.name);
  });

  return { root: SHARED_SKILLS_ROOT, skills: out };
}

export function getSharedSkillDetail(id: string): SkillDetail | null {
  if (!SAFE_ID_RE.test(id)) return null;
  const dir = path.join(SHARED_SKILLS_ROOT, id);
  if (!fs.existsSync(dir)) return null;

  const skillMd = path.join(dir, 'SKILL.md');
  const meta = readMetaJson(path.join(dir, '_meta.json'));
  let name = id;
  let description = '';
  let body = '';
  let aliases: string[] = [];
  const hasContent = fs.existsSync(skillMd);

  if (hasContent) {
    const { frontmatter, body: parsedBody } = readFrontmatter(skillMd);
    if (typeof frontmatter.name === 'string') name = frontmatter.name;
    if (typeof frontmatter.description === 'string') description = frontmatter.description.replace(/\s+/g, ' ').trim();
    if (Array.isArray(frontmatter.aliases)) aliases = frontmatter.aliases.filter((a) => typeof a === 'string');
    body = parsedBody;
  }

  return {
    id,
    name,
    description,
    category: classify(id),
    version: meta.version ?? null,
    lastUpdated: lastUpdatedMs(dir, meta),
    hasContent,
    body,
    aliases,
  };
}
