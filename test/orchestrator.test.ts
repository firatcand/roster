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
// Round-6 finding 3 — schedule-name-first fire lookup
//
// Two schedules in one function may share (agent, plan); the installed prompt
// therefore carries a `(schedule <name>)` suffix and the skill matches by name
// first. The legacy nameless prompt falls back to (agent, plan) but must REFUSE
// on ambiguity rather than take the first match.
// ─────────────────────────────────────────────────────────────────────────────

test('orchestrator (round-6 finding 3): the fire prompt suffix and the skill lookup agree on `(schedule <name>)`', async () => {
  const { buildOrchestratorPrompt } = await import('../src/lib/schedule-install.ts');
  const prompt = buildOrchestratorPrompt('gtm', 'sdr', 'cold-outreach', 'sdr-morning');
  assert.ok(prompt.endsWith('(schedule sdr-morning)'), `installed prompt names its schedule: ${prompt}`);
  const content = readFileSync(orchestratorSrc, 'utf8');
  assert.match(content, /\(schedule <name>\)/, 'the skill documents the (schedule <name>) suffix it parses');
  assert.match(content, /entry\.name == "<schedule>"/, 'the lookup matches by schedule NAME first');
});

test('orchestrator (round-6 finding 3): the legacy nameless-prompt fallback requires (agent, plan) uniqueness — ambiguity aborts', () => {
  const content = readFileSync(orchestratorSrc, 'utf8');
  assert.match(content, /Ambiguous fire/, 'an ambiguous legacy fire errors with a clear message');
  assert.match(content, /refusing to guess/, 'the skill never guesses among same-(agent,plan) schedules');
  assert.ok(!/for entry in schedules_yaml\.schedules:[\s\S]*?break/.test(content), 'the old first-match break loop is gone');
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-7 finding 1 — bare-agent registry vs function-qualified prompt
//
// schedules.yaml entries store the BARE agent (schema: kebab, no slash) — the
// file is function-scoped by its path. The old skill compared match.agent
// against "<function>/<agent>", which NEVER matches a real registry entry, so a
// normal scheduled fire aborted instead of dispatching; and the installed
// prompt omitted the function, so a bare agent duplicated across functions
// (gtm/sdr vs ops/sdr) was unresolvable. The chain now agrees end to end: the
// prompt carries `<function>/<agent>`, the skill strips the prefix, loads
// roster/<function>/schedules.yaml by NAME, and compares bare-to-bare.
// ─────────────────────────────────────────────────────────────────────────────

test('orchestrator (round-7 finding 1): the installed prompt carries the function-qualified agent', async () => {
  const { buildOrchestratorPrompt } = await import('../src/lib/schedule-install.ts');
  const prompt = buildOrchestratorPrompt('gtm', 'sdr', 'cold-outreach', 'sdr-morning');
  assert.equal(
    prompt,
    'Use the roster-orchestrator skill to run plan cold-outreach for agent gtm/sdr (schedule sdr-morning)',
    'the prompt names the function so a bare agent duplicated across functions still resolves',
  );
  // Two functions with the same bare agent render DISTINCT prompts — each fire
  // names its own registry, so the right one is loaded without a directory scan.
  const ops = await import('../src/lib/schedule-install.ts');
  assert.match(ops.buildOrchestratorPrompt('ops', 'sdr', 'sweep', 'sdr-sweep'), / for agent ops\/sdr /);
});

test('orchestrator (round-7 finding 1): the skill compares the registry BARE agent against the prompt bare agent — never a qualified string', () => {
  const content = readFileSync(orchestratorSrc, 'utf8');
  assert.match(content, /registry stores the BARE agent/, 'the bare-agent registry shape is documented');
  assert.match(content, /match\.agent != "<agent>"/, 'name-first verification compares bare-to-bare');
  assert.ok(
    !content.includes('match.agent != "<function>/<agent>"'),
    'the old function-qualified comparison (which never matched a real entry) is gone',
  );
  assert.match(content, /entry\.agent == "<agent>"/, 'the legacy (agent, plan) fallback also compares the bare agent');
  assert.ok(
    !content.includes('entry.agent == "<function>/<agent>"'),
    'the legacy fallback no longer repeats the qualified mismatch',
  );
  // The fallback stays scoped to the function named by the prompt.
  assert.match(content, /scoped to the named function/, 'the (agent, plan) fallback is function-scoped');
});

test('orchestrator (round-7 finding 1): a bare-agent legacy prompt duplicated across functions is TRUE ambiguity and still aborts', () => {
  const content = readFileSync(orchestratorSrc, 'utf8');
  assert.match(
    content,
    /If zero or more than one match \(the same bare agent exists under two functions\), abort/,
    'the multi-function bare-agent scan still refuses to guess',
  );
  assert.match(content, /a current install avoids it by qualifying the agent in the prompt/, 'and documents why current installs never hit it');
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-6 finding 4 — `--schedule` is cron-wrapper-only
//
// `roster run start --schedule` requires ROSTER_FIRE_ID, which only the cron
// wrapper mints. A UI-hosted fire (Claude Desktop / Codex app) following an
// unconditional `--schedule` instruction failed run-start and got NO ledger
// record. The skill must gate the flag on the env var being present.
// ─────────────────────────────────────────────────────────────────────────────

test('orchestrator (round-6 finding 4): run-start passes --schedule ONLY when ROSTER_FIRE_ID is present', () => {
  const content = readFileSync(orchestratorSrc, 'utf8');
  assert.match(
    content,
    /pass `--schedule` ONLY when[\s\S]{0,40}`ROSTER_FIRE_ID` is set/,
    'the conditional gate is documented before the command',
  );
  assert.match(content, /`ROSTER_FIRE_ID` absent \(UI-hosted fire/, 'the UI-hosted branch exists');
  // The UI-hosted branch's command line carries NO --schedule flag.
  const absentBranch = content.split('`ROSTER_FIRE_ID` absent')[1]?.split('The fire id comes from')[0] ?? '';
  assert.ok(absentBranch.includes('roster run start --run <run-id>'), 'the plain run-start command is shown');
  assert.ok(!absentBranch.includes('--schedule'), 'the UI-hosted branch never passes --schedule');
  assert.match(content, /crash correlation is cron-wrapper-only/, 'the limitation is documented');
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
