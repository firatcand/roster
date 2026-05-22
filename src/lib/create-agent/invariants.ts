// Cross-file invariants for guided agent creation (SKILL.md § Cross-file invariants).
//
// Four validators, one per invariant. Each throws on failure with a message
// prefixed `Invariant N (<short name>): <specific failure>`. The aggregate
// validateInvariants(RenderOutput) runs all four and is called by
// atomic-write.ts as Step 1 (Pre-write invariant check) per
// skills/chief-of-staff/SKILL.md § Phase 5 Step 1.
//
// The invariants are pure functions over the render output (the in-memory
// file map + slash command). No fs, no process — the same data the atomic
// transaction is about to write.
//
// Pinned to skills/chief-of-staff/SKILL.md § Cross-file invariants.
// Any change to the invariant set there MUST update this module.

import { parseAllDocuments, parseDocument } from 'yaml';
import type { Document } from 'yaml';

import type { RenderOutput } from './render.ts';

// Path templates that legitimately survive the render unsubstituted.
// agent.md references files at <plan>.yaml, <YYYY-MM>/..., etc.
// These are NOT stub placeholders — they are documented variable parts of
// the runtime file layout. Anything else inside angle brackets is a failed
// substitution and trips invariant 4.
const ALLOWED_PATH_TEMPLATES = new Set([
  'plan',
  'YYYY-MM',
  'YYYY-MM-DD-HHMM',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 1 — subagent files match agent.md ## Subagents
// ─────────────────────────────────────────────────────────────────────────────

// SKILL.md line 304: subagent files must have all six required sections
// (Role, Inputs, Output, Tools, Boundaries, Quality bar) present and populated.
// Order matches the renderSubagent() output in templates.ts.
const SUBAGENT_REQUIRED_SECTIONS = [
  'Role',
  'Inputs',
  'Output',
  'Tools',
  'Boundaries',
  'Quality bar',
] as const;

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

  // Per SKILL.md line 304: each populated subagent file must have all six
  // required sections, each non-empty. Codex review (ROS-55) flagged this gap
  // — the renderer always produces all six by construction, but the invariant
  // is a defensive check meant to catch external mutations (hand-edits,
  // malformed RenderOutput).
  for (const name of filesPresent) {
    const path = `${agentMd.root}/subagents/${name}.md`;
    const content = output.files.get(path);
    if (content === undefined) continue;
    for (const section of SUBAGENT_REQUIRED_SECTIONS) {
      const body = extractSection(content, section);
      if (body === null) {
        throw new Error(
          `Invariant 1 (subagent manifest): subagent "${name}" missing required section "## ${section}"`,
        );
      }
      if (body.trim() === '') {
        throw new Error(
          `Invariant 1 (subagent manifest): subagent "${name}" has empty section "## ${section}"`,
        );
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 2 — every named tool has a non-empty bindings block
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
        `Invariant 2 (tool bindings): tool "${name}" listed in agent.md ## Tools but no entry in ## Tools and bindings`,
      );
    }
    if (block.required === null) {
      throw new Error(
        `Invariant 2 (tool bindings): tool "${name}" bindings block missing or has TODO required flag`,
      );
    }
    if (!block.description || block.description.trim() === '') {
      throw new Error(
        `Invariant 2 (tool bindings): tool "${name}" bindings block has empty description`,
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 3 — slash command description is real
// ─────────────────────────────────────────────────────────────────────────────

interface SlashFrontmatter {
  doc: Document;
  body: string;
}

// Parses the leading YAML frontmatter block (between the opening `---\n` and
// the next `^---\s*$` line). Returns the parsed Document plus the body that
// follows the closing fence. Throws Invariant 3 (slash description)-prefixed
// errors for any structural defect so I4 and the slash variant of I5 share
// one parse + one consistent failure surface. ROS-59.
function parseSlashFrontmatter(slashContent: string): SlashFrontmatter {
  if (!slashContent.startsWith('---\n')) {
    throw new Error(
      `Invariant 3 (slash description): frontmatter missing — slash command must start with "---" fence`,
    );
  }
  const afterOpen = slashContent.slice(4);
  const closeMatch = afterOpen.match(/^---\s*$/m);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new Error(
      `Invariant 3 (slash description): frontmatter not terminated — missing closing "---" fence`,
    );
  }
  const yamlText = afterOpen.slice(0, closeMatch.index);
  const body = afterOpen.slice(closeMatch.index + closeMatch[0].length);

  // A second `---` inside the frontmatter region is legal YAML stream syntax
  // but ambiguous in markdown frontmatter — reject. Codex review ROS-59 #3.
  const docs = parseAllDocuments(yamlText);
  if (docs.length > 1) {
    throw new Error(
      `Invariant 3 (slash description): frontmatter contains multiple YAML documents — expected exactly one`,
    );
  }
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error(
      `Invariant 3 (slash description): frontmatter yaml did not parse: ${doc.errors[0].message}`,
    );
  }
  return { doc, body };
}

export function validateSlashDescription(slashContent: string): void {
  const { doc } = parseSlashFrontmatter(slashContent);
  const raw = doc.get('description');
  if (raw === undefined || raw === null) {
    throw new Error(
      `Invariant 3 (slash description): no "description:" line found in slash command frontmatter`,
    );
  }
  if (typeof raw !== 'string') {
    throw new Error(
      `Invariant 3 (slash description): description must be a plain-string YAML scalar (got ${Array.isArray(raw) ? 'array' : typeof raw})`,
    );
  }
  const desc = raw.trim();
  if (desc.length === 0) {
    throw new Error(`Invariant 3 (slash description): description line is empty`);
  }
  if (desc.length > 80) {
    throw new Error(`Invariant 3 (slash description): description is ${desc.length} chars (max 80)`);
  }
  if (desc.includes('<')) {
    throw new Error(`Invariant 3 (slash description): description contains "<" character: ${JSON.stringify(desc)}`);
  }
  if (/TODO:/.test(desc)) {
    throw new Error(`Invariant 3 (slash description): description contains literal "TODO:": ${JSON.stringify(desc)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant 4 — no unfilled placeholders in agent.md (and slash body)
// ─────────────────────────────────────────────────────────────────────────────

// Code-fenced YAML / code blocks are governed by other invariants (e.g.,
// invariant 2 owns the ```yaml bindings block). A bindings entry that
// legitimately contains `<example>` inside the fence would otherwise trip
// invariant 4. Strip fenced blocks before scanning. Per pr-toolkit review.
function stripCodeFences(text: string): string {
  return text.replace(/```[a-zA-Z0-9]*\n[\s\S]*?\n```/g, '');
}

export function validateNoPlaceholders(agentMdContent: string, label = 'agent.md'): void {
  const scannable = stripCodeFences(agentMdContent);
  const offenders: string[] = [];
  for (const match of scannable.matchAll(/<([^>]+)>/g)) {
    const inner = match[1];
    if (ALLOWED_PATH_TEMPLATES.has(inner)) continue;
    // Allow Markdown autolinks (<https://...>, <mailto:...>). pr-toolkit review.
    if (/^(?:https?:\/\/|mailto:)/.test(inner)) continue;
    offenders.push(match[0]);
  }
  if (offenders.length > 0) {
    throw new Error(
      `Invariant 4 (no placeholders): ${label} contains ${offenders.length} unfilled placeholder(s): ` +
        offenders.slice(0, 3).join(', ') +
        (offenders.length > 3 ? `, ... (${offenders.length - 3} more)` : ''),
    );
  }
  // `[ \t]*` not `\s*` — `\s` would consume the newline and pull the next
  // line into the captured gap, so a bare `TODO:` followed by another line
  // would look like it has a description.
  for (const m of scannable.matchAll(/TODO:[ \t]*([^\n]*)/g)) {
    const gap = m[1].trim();
    if (gap.length === 0) {
      throw new Error(`Invariant 4 (no placeholders): bare "TODO:" in ${label} without a gap description`);
    }
  }
}

// Scan the slash command body. Strips the entire frontmatter block so a
// multi-line description value (e.g., a YAML block scalar) does not leak
// continuation lines into the body scan. ROS-59 — see Codex review.
export function validateNoPlaceholdersSlash(slashContent: string): void {
  const { body } = parseSlashFrontmatter(slashContent);
  validateNoPlaceholders(body, 'slash command body');
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate runner — called by atomic-write.ts as Step 1
// ─────────────────────────────────────────────────────────────────────────────

export function validateInvariants(output: RenderOutput): void {
  validateSubagentManifest(output);
  validateToolBindings(output);
  validateSlashDescription(output.slashCommand.content);
  validateNoPlaceholders(findAgentMd(output).content);
  validateNoPlaceholdersSlash(output.slashCommand.content);
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
    throw new Error(`Invariant 2 (tool bindings): bindings yaml block did not parse: ${doc.errors[0].message}`);
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
