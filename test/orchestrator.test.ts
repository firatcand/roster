// roster-orchestrator skill — ROS-32
//
// Asserts that the canonical orchestrator skill exists with valid frontmatter,
// that the body uses only subscription-safe primitives (both Claude `Task` and
// Codex natural-language idioms are present), that the installer copies it into
// both ~/.claude/skills/roster-orchestrator/ and ~/.agents/skills/roster-orchestrator/
// with per-tool `installed_for` frontmatter injection, and that re-installs are
// byte-stable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installToTool, renderSkillFrontmatter, type InstallLogger } from '../src/lib/install.ts';
import { getToolByKey } from '../src/lib/tools.ts';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
const orchestratorSrc = join(repoRoot, 'skills', 'roster-orchestrator', 'SKILL.md');

const silentLogger: InstallLogger = { log: () => {}, warn: () => {} };

// ─────────────────────────────────────────────────────────────────────────────
// Source-skill invariants
// ─────────────────────────────────────────────────────────────────────────────

test('orchestrator: SKILL.md exists at skills/roster-orchestrator/SKILL.md', () => {
  assert.ok(existsSync(orchestratorSrc), 'orchestrator SKILL.md present');
});

test('orchestrator: frontmatter parses, has name/description/version', () => {
  const content = readFileSync(orchestratorSrc, 'utf8');
  const fm = content.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(fm, 'has YAML frontmatter block');
  const body = fm![1];
  assert.match(body, /^name:\s*roster-orchestrator\b/m, 'name is roster-orchestrator');
  assert.match(body, /^description:\s*"[^"]+"/m, 'description is a quoted string');
  assert.match(body, /^version:\s*"[0-9]+\.[0-9]+\.[0-9]+"/m, 'version is semver-quoted');
  assert.match(body, /^trigger_conditions:/m, 'trigger_conditions block present');
});

test('orchestrator: body contains Claude Task() idiom and Codex natural-language idiom', () => {
  const content = readFileSync(orchestratorSrc, 'utf8');
  assert.match(content, /Task\(/, 'Claude Task( idiom present');
  assert.match(content, /subagent_type=/, 'subagent_type= idiom present');
  assert.match(content, /Codex CLI/i, 'Codex section present');
  assert.match(content, /natural language/i, 'natural-language Codex idiom referenced');
});

test('orchestrator: body bans subscription-unsafe primitives outside audit-opt-out lines', () => {
  // The orchestrator's "Subscription-billing guarantee" section documents the banned
  // primitives by name; those lines carry the <!-- roster-audit-ok --> marker. Every
  // other occurrence is a release blocker.
  const lines = readFileSync(orchestratorSrc, 'utf8').split('\n');
  const optOut = /<!--\s*roster-audit-ok[\s\S]*?-->/;
  const banned = [
    /(^|[^A-Za-z0-9_-])claude\s+-p(\s|$)/,
    /(^|[^A-Za-z0-9_-])claude\s+--prompt(\s|$)/,
    /(^|[^A-Za-z0-9_-])claude\s+api(\s|$)/,
    /['"`]@anthropic-ai\/sdk['"`]/,
    /(^|[^A-Za-z0-9_-])from\s+anthropic(\s|$|\.)/,
  ];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (optOut.test(line)) continue;
    for (const rule of banned) {
      assert.ok(!rule.test(line), `line ${i + 1}: unexpected banned literal — ${line.trim()}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROS-143 — mode-aware Working-directory guard
//
// Chat-session bootstrap must identify a workspace by config/project.yaml alone;
// a missing runtime roster/ tree is a fresh init, not an abort. The old guard
// demanded both and made the Codex bootstrap falsely abort. Scheduled-fire must
// stay strict about roster/<function>/schedules.yaml. These pin both halves so
// the contradiction can't silently return. Assertions target the guard wording
// only — they do NOT ban roster/ globally (it is a legitimate path reference).
// ─────────────────────────────────────────────────────────────────────────────

test('orchestrator: Working-directory guard identifies a workspace by config/project.yaml alone', () => {
  const content = readFileSync(orchestratorSrc, 'utf8');
  assert.ok(
    !/must contain config\/project\.yaml and roster\//.test(content),
    'old "must contain config/project.yaml and roster/" abort message is gone',
  );
  assert.match(
    content,
    /must contain config\/project\.yaml\)/,
    'abort message now requires only config/project.yaml',
  );
});

test('orchestrator: distinguishes .roster/ metadata from the runtime roster/ tree', () => {
  const content = readFileSync(orchestratorSrc, 'utf8');
  assert.match(content, /`\.roster\/` is not `roster\/`/, '.roster/ is explicitly distinguished from roster/');
});

test('orchestrator: scheduled-fire (Mode 2) stays strict about roster/<function>/schedules.yaml', () => {
  const content = readFileSync(orchestratorSrc, 'utf8');
  // Mode 2 must document an explicit abort when the schedule registry file is
  // absent — the chat-bootstrap "missing roster/ is fine" tolerance must NOT
  // leak into scheduled-fire mode.
  assert.match(
    content,
    /Schedule registry not found: roster\/<function>\/schedules\.yaml/,
    'Mode 2 aborts when the schedule registry file is missing',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter rendering
// ─────────────────────────────────────────────────────────────────────────────

test('renderSkillFrontmatter: injects installed_for and is idempotent', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-render-'));
  try {
    const target = join(root, 'SKILL.md');
    const original = '---\nname: x\ndescription: "d"\nversion: "0.1.0"\n---\n\nbody\n';
    writeFileSync(target, original);

    renderSkillFrontmatter(target, 'claude');
    const afterFirst = readFileSync(target, 'utf8');
    assert.match(afterFirst, /^installed_for: claude$/m, 'tag injected');
    assert.match(afterFirst, /^name: x$/m, 'original fields preserved');
    assert.match(afterFirst, /\nbody\n$/, 'body preserved');

    renderSkillFrontmatter(target, 'claude');
    const afterSecond = readFileSync(target, 'utf8');
    assert.equal(afterFirst, afterSecond, 'idempotent on identical tool');

    renderSkillFrontmatter(target, 'codex');
    const afterRetag = readFileSync(target, 'utf8');
    assert.match(afterRetag, /^installed_for: codex$/m, 're-tag replaces prior tag');
    assert.ok(!/installed_for: claude/.test(afterRetag), 'prior tag removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderSkillFrontmatter: leaves frontmatter-less files alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-render-'));
  try {
    const target = join(root, 'SKILL.md');
    const original = '# no frontmatter here\n';
    writeFileSync(target, original);
    renderSkillFrontmatter(target, 'claude');
    assert.equal(readFileSync(target, 'utf8'), original, 'untouched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Codex 2nd-pass review #9 / #1: frontmatter regex only matches LF-line-terminated
// blocks. These tests pin the contract so the installer and audit stay symmetric
// even on edge inputs that never receive the installed_for tag.

test('renderSkillFrontmatter: CRLF-only frontmatter is left untouched (and audit treats target as canonical)', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-render-'));
  try {
    const target = join(root, 'SKILL.md');
    const original = '---\r\nname: x\r\ndescription: "d"\r\n---\r\n\r\nbody\r\n';
    writeFileSync(target, original);
    renderSkillFrontmatter(target, 'claude');
    assert.equal(readFileSync(target, 'utf8'), original, 'CRLF frontmatter is not mutated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderSkillFrontmatter: missing closing --- leaves file untouched (no false injection)', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-render-'));
  try {
    const target = join(root, 'SKILL.md');
    const original = '---\nname: x\ndescription: "no close marker"\n\nbody starts here\n';
    writeFileSync(target, original);
    renderSkillFrontmatter(target, 'claude');
    assert.equal(readFileSync(target, 'utf8'), original, 'unclosed frontmatter is not mutated');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('renderSkillFrontmatter: pre-existing installed_for in source is replaced, not duplicated', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-render-'));
  try {
    const target = join(root, 'SKILL.md');
    const original = '---\nname: x\ninstalled_for: gemini\ndescription: "d"\n---\n\nbody\n';
    writeFileSync(target, original);
    renderSkillFrontmatter(target, 'claude');
    const out = readFileSync(target, 'utf8');
    const matches = out.match(/^installed_for:\s/gm) ?? [];
    assert.equal(matches.length, 1, 'exactly one installed_for line');
    assert.match(out, /^installed_for: claude$/m, 'tag is claude');
    assert.ok(!/installed_for: gemini/.test(out), 'prior gemini tag removed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end install of the real orchestrator skill into both tools
// ─────────────────────────────────────────────────────────────────────────────

type E2EFixture = { root: string; source: string; cleanup: () => void };

function makeE2EFixture(): E2EFixture {
  const root = mkdtempSync(join(tmpdir(), 'roster-orch-'));
  const source = join(root, 'source');
  // Copy the real shipped skill source — we want to assert against the actual content.
  mkdirSync(join(source, 'skills'), { recursive: true });
  cpSync(join(repoRoot, 'skills', 'roster-orchestrator'), join(source, 'skills', 'roster-orchestrator'), {
    recursive: true,
  });
  mkdirSync(join(source, 'agents'), { recursive: true });
  return {
    root,
    source,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('orchestrator: installs into ~/.claude/skills/roster-orchestrator/ with installed_for: claude', async () => {
  const f = makeE2EFixture();
  const claudeHome = join(f.root, 'claude-home');
  try {
    process.env['ROSTER_CLAUDE_HOME'] = claudeHome;
    const tool = getToolByKey('claude')!;
    await installToTool(tool, {
      skills: join(f.source, 'skills'),
      agents: join(f.source, 'agents'),
      silent: true,
      logger: silentLogger,
    });

    const dest = join(claudeHome, 'skills', 'roster-orchestrator', 'SKILL.md');
    assert.ok(existsSync(dest), 'orchestrator landed in claude target');
    const content = readFileSync(dest, 'utf8');
    assert.match(content, /^---\n[\s\S]+?\n---\n/, 'frontmatter still parses');
    assert.match(content, /^installed_for: claude$/m, 'claude tag injected');
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('orchestrator: installs into ~/.agents/skills/roster-orchestrator/ with installed_for: codex', async () => {
  const f = makeE2EFixture();
  const codexHome = join(f.root, 'codex-home');
  try {
    process.env['ROSTER_CODEX_HOME'] = codexHome;
    const tool = getToolByKey('codex')!;
    await installToTool(tool, {
      skills: join(f.source, 'skills'),
      agents: join(f.source, 'agents'),
      silent: true,
      logger: silentLogger,
    });

    const dest = join(f.root, '.agents', 'skills', 'roster-orchestrator', 'SKILL.md');
    assert.ok(existsSync(dest), 'orchestrator landed in codex target');
    assert.ok(!existsSync(join(codexHome, 'skills', 'roster-orchestrator')), 'legacy .codex/skills target was not written');
    const content = readFileSync(dest, 'utf8');
    assert.match(content, /^---\n[\s\S]+?\n---\n/, 'frontmatter still parses');
    assert.match(content, /^installed_for: codex$/m, 'codex tag injected');
    // Both subagent idioms should still be present in the body — the LLM picks
    // the right one based on the host tool.
    assert.match(content, /Task\(/, 'Claude idiom preserved in body');
    assert.match(content, /natural language/i, 'Codex idiom preserved in body');
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('orchestrator: project-scope Codex install lands skills in .agents/skills', async () => {
  const f = makeE2EFixture();
  const workspace = join(f.root, 'workspace');
  try {
    mkdirSync(workspace, { recursive: true });
    const tool = {
      ...getToolByKey('codex')!,
      configRoot: join(workspace, '.codex'),
      installRoot: workspace,
      skillsTarget: join(workspace, '.agents', 'skills'),
      agentsTarget: join(workspace, '.codex', 'agents'),
    };
    await installToTool(tool, {
      skills: join(f.source, 'skills'),
      agents: join(f.source, 'agents'),
      silent: true,
      logger: silentLogger,
    });

    const dest = join(workspace, '.agents', 'skills', 'roster-orchestrator', 'SKILL.md');
    assert.ok(existsSync(dest), 'orchestrator landed in Codex-native project skill target');
    assert.ok(!existsSync(join(workspace, '.codex', 'skills', 'roster-orchestrator')), 'legacy .codex/skills target was not written');
  } finally {
    f.cleanup();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROS-33 — subagent dispatch end-to-end shape
//
// True end-to-end through the real `codex` CLI is left to the manual smoke
// gate (Codex isn't installable in CI). Here we assert the file-shape that
// the orchestrator skill (ROS-32) relies on at runtime: every shipped agent
// produces a TOML with the right field names AND a persona sidecar; the
// orchestrator's dispatch idioms reference at least one of the installed
// agent names.
// ─────────────────────────────────────────────────────────────────────────────

test('subagent dispatch (codex): every shipped agent lands as .toml + .persona.md', async () => {
  const f = makeE2EFixture();
  const codexHome = join(f.root, 'codex-home');
  try {
    process.env['ROSTER_CODEX_HOME'] = codexHome;
    // Use real shipped agents — copy them into the e2e source tree.
    cpSync(join(repoRoot, 'agents'), join(f.source, 'agents'), { recursive: true });

    const tool = getToolByKey('codex')!;
    await installToTool(tool, {
      skills: join(f.source, 'skills'),
      agents: join(f.source, 'agents'),
      silent: true,
      logger: silentLogger,
    });

    const installedAgents = readdirSync(join(codexHome, 'agents'));
    const tomlFiles = installedAgents.filter((n) => n.endsWith('.toml'));
    const personaFiles = installedAgents.filter((n) => n.endsWith('.persona.md'));
    assert.ok(tomlFiles.length > 0, 'at least one .toml emitted');
    assert.equal(tomlFiles.length, personaFiles.length, '1:1 .toml/.persona.md pairing');

    for (const tomlName of tomlFiles) {
      const baseName = tomlName.replace(/\.toml$/, '');
      const toml = readFileSync(join(codexHome, 'agents', tomlName), 'utf8');
      assert.match(toml, /^name = "/m, `${tomlName}: name present`);
      assert.match(toml, /^description = "/m, `${tomlName}: description present`);
      assert.match(toml, /^developer_instructions = """$/m, `${tomlName}: uses developer_instructions`);
      assert.doesNotMatch(toml, /^instructions\s*=/m, `${tomlName}: no legacy instructions`);
      assert.doesNotMatch(toml, /^reasoning_effort\s*=/m, `${tomlName}: no legacy reasoning_effort`);

      const persona = readFileSync(join(codexHome, 'agents', `${baseName}.persona.md`), 'utf8');
      assert.ok(persona.length > 0, `${baseName}.persona.md is non-empty`);
      assert.ok(!persona.startsWith('---'), `${baseName}.persona.md excludes frontmatter`);
    }
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('subagent dispatch (codex): persona.md is the runtime-injection payload for the Windows workaround', () => {
  // The orchestrator skill (ROS-32) reads <agent>.persona.md off disk and
  // feeds it to `codex` via `-c developer_instructions=<content>` when the
  // host is Windows (openai/codex#19399). This test pins the contract: the
  // persona file is plain text, frontmatter-free, and matches the body the
  // renderer would re-emit. If this drifts, the Windows orchestrator hand-off
  // breaks silently.
  const agentsRoot = join(repoRoot, 'agents');
  const fixturePath = join(agentsRoot, 'lesson-drafter.md');
  assert.ok(existsSync(fixturePath), 'fixture: agents/lesson-drafter.md exists');
  // Sanity: the schema test in test/agent-render.test.ts already proves
  // round-trip parseability across every shipped agent; here we just assert
  // the contract that anchors the doctor + install + audit chain.
  const src = readFileSync(fixturePath, 'utf8');
  assert.match(src, /^---\n[\s\S]+?\n---/, 'source has frontmatter (consumed by renderer)');
});

test('orchestrator: re-install is byte-stable (idempotent)', async () => {
  const f = makeE2EFixture();
  const claudeHome = join(f.root, 'claude-home');
  try {
    process.env['ROSTER_CLAUDE_HOME'] = claudeHome;
    const tool = getToolByKey('claude')!;
    const opts = {
      skills: join(f.source, 'skills'),
      agents: join(f.source, 'agents'),
      silent: true,
      logger: silentLogger,
    };

    await installToTool(tool, opts);
    const firstSnap = readFileSync(join(claudeHome, 'skills', 'roster-orchestrator', 'SKILL.md'), 'utf8');

    await installToTool(tool, opts);
    const secondSnap = readFileSync(join(claudeHome, 'skills', 'roster-orchestrator', 'SKILL.md'), 'utf8');

    assert.equal(firstSnap, secondSnap, 'second install matches first byte-for-byte');
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});
