// Cross-file invariants for guided agent creation (SKILL.md § Cross-file invariants).
//
// Five validators, one per invariant. Each throws on failure with a message
// prefixed `Invariant N (<short name>): <specific failure>`. The aggregate
// validateInvariants(RenderOutput) runs all five and is called by
// atomic-write.ts as Step 1 (Pre-write invariant check) per
// skills/chief-of-staff/SKILL.md § Phase 5 Step 1.
//
// The invariants are pure functions over the render output (the in-memory
// file map + slash command). No fs, no process — the same data the atomic
// transaction is about to write.
//
// Pinned to skills/chief-of-staff/SKILL.md lines 326-339 (invariant list).
// Any change to the invariant set there MUST update this module.

import { parseDocument } from 'yaml';

import type { RenderOutput } from './render.ts';

// Path templates that legitimately survive the render unsubstituted.
// agent.md references files at <plan>.yaml, <project>/..., <YYYY-MM>/...
// These are NOT stub placeholders — they are documented variable parts of
// the runtime file layout. Anything else inside angle brackets is a failed
// substitution and trips invariant 5.
const ALLOWED_PATH_TEMPLATES = new Set([
  'plan',
  'project',
  'YYYY-MM',
  'YYYY-MM-DD-HHMM',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 1 — subagent files match agent.md ## Subagents
// ─────────────────────────────────────────────────────────────────────────────

export function validateSubagentManifest(output: RenderOutput): void {
  const agentMd = findAgentMd(output);
  const declared = parseSubagentsSection(agentMd.content);
  const filesPresent = listSubagentFiles(output);

  const declaredSet = new Set(declared);
  const filesSet = new Set(filesPresent);

  for (const name of declared) {
    if (!filesSet.has(name)) {
      throw new Error(
        `Invariant 1 (subagent manifest): subagent "${name}" listed in agent.md but no file at ` +
          `${agentMd.root}/subagents/${name}.md`,
      );
    }
  }
  for (const name of filesPresent) {
    if (!declaredSet.has(name)) {
      throw new Error(
        `Invariant 1 (subagent manifest): file ${agentMd.root}/subagents/${name}.md exists but ` +
          `"${name}" is not listed in agent.md ## Subagents`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 2 — step ids match between agent.md and starter plans
// ─────────────────────────────────────────────────────────────────────────────

export function validateStepIdsMatchOutput(output: RenderOutput): void {
  const agentMd = findAgentMd(output);
  const groundedIds = new Set(parseStepIds(agentMd.content));
  const planPathPrefix = `${agentMd.root}/plans/`;

  for (const [path, content] of output.files) {
    if (!path.startsWith(planPathPrefix) || !path.endsWith('.yaml')) continue;
    const planName = path.slice(planPathPrefix.length, -5);
    const planIds = new Set(parsePlanStepIds(content));
    for (const id of planIds) {
      if (!groundedIds.has(id)) {
        throw new Error(
          `Invariant 2 (step ids match): plan "${planName}" references step id "${id}" not in agent.md ## Steps`,
        );
      }
    }
    for (const id of groundedIds) {
      if (!planIds.has(id)) {
        throw new Error(
          `Invariant 2 (step ids match): agent.md ## Steps id "${id}" not in plan "${planName}"`,
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 3 — every named tool has a non-empty bindings block
// ─────────────────────────────────────────────────────────────────────────────

export function validateToolBindings(output: RenderOutput): void {
  const agentMd = findAgentMd(output);
  const tools = parseToolsSection(agentMd.content);
  if (tools.length === 0) return;

  const bindings = parseToolsAndBindings(agentMd.content);
  for (const name of tools) {
    const block = bindings.get(name);
    if (!block) {
      throw new Error(
        `Invariant 3 (tool bindings): tool "${name}" listed in agent.md ## Tools but no entry in ## Tools and bindings`,
      );
    }
    if (block.required === null) {
      throw new Error(
        `Invariant 3 (tool bindings): tool "${name}" bindings block missing or has TODO required flag`,
      );
    }
    if (!block.description || block.description.trim() === '') {
      throw new Error(
        `Invariant 3 (tool bindings): tool "${name}" bindings block has empty description`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 4 — slash command description is real
// ─────────────────────────────────────────────────────────────────────────────

export function validateSlashDescription(slashContent: string): void {
  const match = slashContent.match(/^description:\s*(.*)$/m);
  if (!match) {
    throw new Error(`Invariant 4 (slash description): no "description:" line found in slash command frontmatter`);
  }
  const desc = match[1].trim();
  if (desc.length === 0) {
    throw new Error(`Invariant 4 (slash description): description line is empty`);
  }
  if (desc.length > 80) {
    throw new Error(`Invariant 4 (slash description): description is ${desc.length} chars (max 80)`);
  }
  if (desc.includes('<')) {
    throw new Error(`Invariant 4 (slash description): description contains "<" character: ${JSON.stringify(desc)}`);
  }
  if (/TODO:/.test(desc)) {
    throw new Error(`Invariant 4 (slash description): description contains literal "TODO:": ${JSON.stringify(desc)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 5 — no unfilled placeholders in agent.md
// ─────────────────────────────────────────────────────────────────────────────

export function validateNoPlaceholders(agentMdContent: string): void {
  const offenders: string[] = [];
  for (const match of agentMdContent.matchAll(/<([^>]+)>/g)) {
    const inner = match[1];
    if (ALLOWED_PATH_TEMPLATES.has(inner)) continue;
    offenders.push(match[0]);
  }
  if (offenders.length > 0) {
    throw new Error(
      `Invariant 5 (no placeholders): agent.md contains ${offenders.length} unfilled placeholder(s): ` +
        offenders.slice(0, 3).join(', ') +
        (offenders.length > 3 ? `, ... (${offenders.length - 3} more)` : ''),
    );
  }
  // `[ \t]*` not `\s*` — `\s` would consume the newline and pull the next
  // line into the captured gap, so a bare `TODO:` followed by another line
  // would look like it has a description.
  for (const m of agentMdContent.matchAll(/TODO:[ \t]*([^\n]*)/g)) {
    const gap = m[1].trim();
    if (gap.length === 0) {
      throw new Error(`Invariant 5 (no placeholders): bare "TODO:" in agent.md without a gap description`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate runner — called by atomic-write.ts as Step 1
// ─────────────────────────────────────────────────────────────────────────────

export function validateInvariants(output: RenderOutput): void {
  validateSubagentManifest(output);
  validateStepIdsMatchOutput(output);
  validateToolBindings(output);
  validateSlashDescription(output.slashCommand.content);
  validateNoPlaceholders(findAgentMd(output).content);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsers — internal helpers
// ─────────────────────────────────────────────────────────────────────────────

interface AgentMdHandle {
  path: string;
  root: string;
  content: string;
}

function findAgentMd(output: RenderOutput): AgentMdHandle {
  for (const [path, content] of output.files) {
    if (path.endsWith('/agent.md')) {
      return { path, root: path.slice(0, -'/agent.md'.length), content };
    }
  }
  throw new Error(`invariants: no agent.md found in render output (paths: ${[...output.files.keys()].join(', ')})`);
}

function listSubagentFiles(output: RenderOutput): string[] {
  const out: string[] = [];
  for (const path of output.files.keys()) {
    const match = path.match(/\/subagents\/([^/]+)\.md$/);
    if (!match) continue;
    if (match[1] === '_template') continue;
    out.push(match[1]);
  }
  return out.sort();
}

// `## Subagents` bullet form: ` - \`<name>.md\` — <role>...`
// Empty form: a single line containing only "None." after the heading.
function parseSubagentsSection(agentMd: string): string[] {
  const section = extractSection(agentMd, 'Subagents');
  if (section === null) return [];
  if (/^None\.?$/m.test(section.trim())) return [];
  const names: string[] = [];
  for (const m of section.matchAll(/^-\s+`([a-z0-9]+(?:-[a-z0-9]+)*)\.md`/gm)) {
    names.push(m[1]);
  }
  return names.sort();
}

// `## Steps` bullet form: ` - \`<id>\` — **<title>.** <description>`
function parseStepIds(agentMd: string): string[] {
  const section = extractSection(agentMd, 'Steps');
  if (section === null) return [];
  const ids: string[] = [];
  for (const m of section.matchAll(/^-\s+`([a-z0-9]+(?:-[a-z0-9]+)*)`\s+—/gm)) {
    ids.push(m[1]);
  }
  return ids;
}

// `## Tools` bullet form: ` - \`<name>\` — <description> (required|optional)`
// Empty form: "None." line.
function parseToolsSection(agentMd: string): string[] {
  const section = extractSection(agentMd, 'Tools');
  if (section === null) return [];
  if (/^None\.?$/m.test(section.trim())) return [];
  const names: string[] = [];
  for (const m of section.matchAll(/^-\s+`([a-z0-9]+(?:-[a-z0-9]+)*)`\s+—/gm)) {
    names.push(m[1]);
  }
  return names.sort();
}

interface ToolBinding {
  required: boolean | null;
  description: string;
}

function parseToolsAndBindings(agentMd: string): Map<string, ToolBinding> {
  const section = extractSection(agentMd, 'Tools and bindings');
  const out = new Map<string, ToolBinding>();
  if (section === null) return out;
  const fenceMatch = section.match(/```yaml\n([\s\S]*?)\n```/);
  if (!fenceMatch) return out;
  const yaml = fenceMatch[1];
  const doc = parseDocument(yaml);
  if (doc.errors.length > 0) {
    throw new Error(`Invariant 3 (tool bindings): bindings yaml block did not parse: ${doc.errors[0].message}`);
  }
  const root = doc.toJSON();
  if (root === null || typeof root !== 'object') return out;
  for (const [name, raw] of Object.entries(root as Record<string, unknown>)) {
    if (raw === null || typeof raw !== 'object') {
      out.set(name, { required: null, description: '' });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    let required: boolean | null;
    if (entry.required === true) required = true;
    else if (entry.required === false) required = false;
    else required = null;
    const description = typeof entry.description === 'string' ? entry.description : '';
    out.set(name, { required, description });
  }
  return out;
}

function parsePlanStepIds(planYamlContent: string): string[] {
  const doc = parseDocument(planYamlContent);
  if (doc.errors.length > 0) {
    throw new Error(`Invariant 2 (step ids match): plan yaml did not parse: ${doc.errors[0].message}`);
  }
  const root = doc.toJSON();
  if (root === null || typeof root !== 'object') return [];
  const steps = (root as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return [];
  const ids: string[] = [];
  for (const step of steps) {
    if (step !== null && typeof step === 'object' && typeof (step as { id?: unknown }).id === 'string') {
      ids.push((step as { id: string }).id);
    }
  }
  return ids;
}

// Extract a markdown section by H2 heading name. Returns the body text
// (everything between `## <name>` and the next `## ` or end of file), or
// null if the heading is not present. Body excludes the heading line.
function extractSection(md: string, name: string): string | null {
  const headingRe = new RegExp(`^##\\s+${escapeRegex(name)}\\s*$`, 'm');
  const match = md.match(headingRe);
  if (!match || match.index === undefined) return null;
  const start = match.index + match[0].length;
  const rest = md.slice(start);
  const next = rest.search(/^##\s+/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
