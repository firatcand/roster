import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SCOPES,
  detectWorkspace,
  defaultScopeForContext,
  toolForScope,
} from '../src/lib/install-scope.ts';
import { allTools, getToolByKey, type Tool } from '../src/lib/tools.ts';

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function getToolOrFail(key: 'claude' | 'codex' | 'gemini'): Tool {
  const tool = getToolByKey(key);
  if (!tool) throw new Error(`fixture: getToolByKey(${key}) returned undefined`);
  return tool;
}

test('SCOPES enumerates the two supported scopes', () => {
  assert.deepEqual([...SCOPES].sort(), ['project', 'user']);
});

test('detectWorkspace: returns false for an empty directory', () => {
  const { dir, cleanup } = mkTmp('roster-scope-empty');
  try {
    assert.equal(detectWorkspace(dir), false);
  } finally {
    cleanup();
  }
});

test('detectWorkspace: returns true when config/project.yaml exists', () => {
  const { dir, cleanup } = mkTmp('roster-scope-workspace');
  try {
    mkdirSync(join(dir, 'config'));
    writeFileSync(join(dir, 'config', 'project.yaml'), 'name: test\n');
    assert.equal(detectWorkspace(dir), true);
  } finally {
    cleanup();
  }
});

test('detectWorkspace: returns false when config/ exists but project.yaml does not', () => {
  const { dir, cleanup } = mkTmp('roster-scope-partial');
  try {
    mkdirSync(join(dir, 'config'));
    assert.equal(detectWorkspace(dir), false);
  } finally {
    cleanup();
  }
});

test('detectWorkspace: returns false for a non-existent directory', () => {
  // Path that cannot exist (under /dev/null/<nonsense>).
  assert.equal(detectWorkspace('/dev/null/no-such-dir'), false);
});

test('defaultScopeForContext: workspace present → project', () => {
  assert.equal(defaultScopeForContext(true), 'project');
});

test('defaultScopeForContext: workspace absent → user', () => {
  assert.equal(defaultScopeForContext(false), 'user');
});

test('toolForScope: user scope returns the input tool unchanged (identity)', () => {
  for (const tool of allTools()) {
    const out = toolForScope(tool, 'user');
    assert.strictEqual(out, tool, `${tool.key}: user-scope must return the same reference`);
  }
});

test('toolForScope: project scope without workspaceRoot throws', () => {
  const claude = getToolOrFail('claude');
  // Cast-around the overloaded signature to exercise the runtime guard.
  assert.throws(
    () => (toolForScope as (t: Tool, s: 'project', root?: string) => Tool)(claude, 'project'),
    /workspaceRoot is required/,
  );
});

test('toolForScope: project scope rewrites Claude paths under workspaceRoot/.claude/', () => {
  const claude = getToolOrFail('claude');
  const out = toolForScope(claude, 'project', '/ws');
  assert.equal(out.key, 'claude');
  assert.equal(out.name, claude.name);
  assert.equal(out.configRoot, '/ws/.claude');
  assert.equal(out.skillsTarget, '/ws/.claude/skills');
  assert.equal(out.agentsTarget, '/ws/.claude/agents');
  assert.equal(out.agentsLayout, claude.agentsLayout);
  assert.equal(out.installLink, claude.installLink);
});

test('toolForScope: project scope rewrites Codex paths under workspaceRoot/.codex/', () => {
  const codex = getToolOrFail('codex');
  const out = toolForScope(codex, 'project', '/ws');
  assert.equal(out.configRoot, '/ws/.codex');
  assert.equal(out.skillsTarget, '/ws/.codex/skills');
  assert.equal(out.agentsTarget, '/ws/.codex/agents');
  // codex agents render to .toml + .persona.md per ROS-33 — layout must survive scoping.
  assert.equal(out.agentsLayout, 'codex-toml');
});

test('toolForScope: project scope maps Gemini skills to extensions/ (plugin protocol)', () => {
  const gemini = getToolOrFail('gemini');
  const out = toolForScope(gemini, 'project', '/ws');
  assert.equal(out.configRoot, '/ws/.gemini');
  // Gemini uses extensions/ for skills, not skills/. This is load-bearing.
  assert.equal(out.skillsTarget, '/ws/.gemini/extensions');
  assert.equal(out.agentsTarget, '/ws/.gemini/agents');
});

test('toolForScope: project scope preserves null agentsTarget if original tool has no agents', () => {
  const claude = getToolOrFail('claude');
  const noAgentsTool: Tool = { ...claude, agentsTarget: null };
  const out = toolForScope(noAgentsTool, 'project', '/ws');
  assert.equal(out.agentsTarget, null);
  // skillsTarget still rewritten — agents nullness shouldn't leak across to skills.
  assert.equal(out.skillsTarget, '/ws/.claude/skills');
});

test('toolForScope: project scope handles relative workspaceRoot (no normalization)', () => {
  // Documents current behavior: the function does not resolve paths. Callers
  // are responsible for passing an absolute path if they want absolute output.
  const claude = getToolOrFail('claude');
  const out = toolForScope(claude, 'project', './ws');
  assert.equal(out.skillsTarget, 'ws/.claude/skills');
});
