// Codex subagent TOML renderer — ROS-33
//
// Schema contract: emits current Codex field names (`developer_instructions`,
// `model_reasoning_effort`) and never the legacy ones (`instructions`,
// `reasoning_effort`). See docs/adr/0001-scheduling-architecture.md and
// openai/codex#19399.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCodexAgentToml, parseAgentSource, RosterAgentRenderError } from '../src/lib/agent-render.ts';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
const agentsDir = join(repoRoot, 'agents');

function readAgent(name: string): string {
  return readFileSync(join(agentsDir, name), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema contract — anchored at start of line so legacy field names inside a
// prompt body don't false-positive. Matches the ban-list anchoring in audit.ts.
// ─────────────────────────────────────────────────────────────────────────────

test('every shipped agent renders with current Codex field names only', () => {
  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length > 0, 'fixture: at least one agent in agents/');
  for (const file of files) {
    const { toml } = renderCodexAgentToml(readFileSync(join(agentsDir, file), 'utf8'));
    assert.match(toml, /^developer_instructions\s*=/m, `${file}: emits developer_instructions`);
    assert.doesNotMatch(toml, /^instructions\s*=/m, `${file}: no legacy instructions key`);
    assert.doesNotMatch(toml, /^reasoning_effort\s*=/m, `${file}: no legacy reasoning_effort key`);
  }
});

test('header comment references openai/codex#19399 with removal-trigger note', () => {
  const { toml } = renderCodexAgentToml(readAgent('lesson-drafter.md'));
  assert.match(toml, /openai\/codex#19399/, 'header cites upstream issue');
  assert.match(toml, /Remove the Windows runtime-injection workaround when this issue closes/, 'removal trigger present');
});

test('persona body equals the source body sans frontmatter (and leading blank lines trimmed)', () => {
  const source = readAgent('lesson-drafter.md');
  const expectedBody =
    source.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^[\n\r]+/, '').replace(/\s+$/, '') + '\n';
  const { personaBody } = renderCodexAgentToml(source);
  assert.equal(personaBody, expectedBody);
});

test('renderCodexAgentToml is idempotent on the rendered output reading the same source twice', () => {
  const source = readAgent('pattern-detector.md');
  const a = renderCodexAgentToml(source);
  const b = renderCodexAgentToml(source);
  assert.equal(a.toml, b.toml);
  assert.equal(a.personaBody, b.personaBody);
});

// ─────────────────────────────────────────────────────────────────────────────
// Field mapping
// ─────────────────────────────────────────────────────────────────────────────

test('optional model + model_reasoning_effort pass through when present', () => {
  const source = [
    '---',
    'name: tester',
    'description: "Test agent"',
    'model: "gpt-5.4"',
    'model_reasoning_effort: "high"',
    '---',
    '',
    'Body content here.',
    '',
  ].join('\n');
  const { toml } = renderCodexAgentToml(source);
  assert.match(toml, /^model\s*=\s*"gpt-5\.4"$/m);
  assert.match(toml, /^model_reasoning_effort\s*=\s*"high"$/m);
});

test('omitted optional model fields are not emitted (codex inherits parent)', () => {
  const source = '---\nname: minimal\ndescription: "Minimal agent"\n---\n\nBody.\n';
  const { toml } = renderCodexAgentToml(source);
  assert.doesNotMatch(toml, /^model\s*=/m, 'no model line');
  assert.doesNotMatch(toml, /^model_reasoning_effort\s*=/m, 'no model_reasoning_effort line');
});

test('legacy reasoning_effort in source is renamed to model_reasoning_effort', () => {
  const source = [
    '---',
    'name: legacy',
    'description: "Legacy field"',
    'reasoning_effort: medium',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
  const { toml } = renderCodexAgentToml(source);
  assert.match(toml, /^model_reasoning_effort\s*=\s*"medium"$/m, 'renamed key emitted');
  assert.doesNotMatch(toml, /^reasoning_effort\s*=/m, 'legacy key not emitted');
});

// ─────────────────────────────────────────────────────────────────────────────
// Escaping
// ─────────────────────────────────────────────────────────────────────────────

test('triple-double-quote in body is escaped to keep TOML well-formed', () => {
  const source = [
    '---',
    'name: tripler',
    'description: "Embedded triple quotes"',
    '---',
    '',
    'When writing, surround quoted text with """ on its own line.',
    '',
  ].join('\n');
  const { toml } = renderCodexAgentToml(source);
  // Three consecutive unescaped quotes appear exactly twice: open + close fences.
  const fences = toml.match(/(?<!\\)"""/g) ?? [];
  assert.equal(fences.length, 2, 'only the open and close fences are unescaped');
  assert.match(toml, /\\"\\"\\"/, 'inline """ was escaped');
});

test('embedded double-quote in description is escaped for basic string', () => {
  const source = '---\nname: quoted\ndescription: "She said \\"hi\\""\n---\n\nBody.\n';
  const parsed = parseAgentSource(source);
  assert.equal(parsed.description, 'She said "hi"', 'unquoter decodes \\"');
  const { toml } = renderCodexAgentToml(source);
  assert.match(toml, /description\s*=\s*"She said \\"hi\\""/, 're-quoted for TOML basic string');
});

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

test('missing required frontmatter throws RosterAgentRenderError', () => {
  const source = '---\nname: x\n---\n\nBody.\n';
  assert.throws(
    () => renderCodexAgentToml(source),
    (err: Error) => err instanceof RosterAgentRenderError && (err as RosterAgentRenderError).field === 'description',
  );
});

test('no frontmatter block throws RosterAgentRenderError', () => {
  assert.throws(
    () => renderCodexAgentToml('just body\n'),
    (err: Error) => err instanceof RosterAgentRenderError,
  );
});

test('agent name ending in .persona is rejected to avoid sidecar collision', () => {
  const source = '---\nname: foo.persona\ndescription: "x"\n---\n\nBody.\n';
  assert.throws(
    () => renderCodexAgentToml(source),
    (err: Error) => err instanceof RosterAgentRenderError && (err as RosterAgentRenderError).field === 'name',
  );
});
