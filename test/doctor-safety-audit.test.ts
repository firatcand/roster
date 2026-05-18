import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditBannedPatterns,
  auditCodexPreflight,
  resolveBannedPatternRoots,
  runSafetyAudit,
} from '../src/lib/doctor-safety-audit.ts';
import type { ToolAuditResult } from '../src/lib/audit.ts';
import type { Tool } from '../src/lib/tools.ts';

function makeRosterRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-safety-audit-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeFile(root: string, rel: string, content: string): void {
  const full = join(root, rel);
  const dir = full.replace(/[^/]+$/, '');
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content, 'utf8');
}

const fakeTool = (key: 'claude' | 'codex' | 'gemini', skillsTarget: string): Tool =>
  ({
    key,
    name: key,
    configRoot: '/tmp/fake',
    skillsTarget,
    agentsTarget: null,
    agentsLayout: 'claude-md',
    installLink: 'https://example.com',
  }) as unknown as Tool;

// ──────────────────────────────────────────────────────────────────────
// resolveBannedPatternRoots
// ──────────────────────────────────────────────────────────────────────

test('resolveBannedPatternRoots: only includes ROSTER subdirs that exist', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    mkdirSync(join(root, 'skills'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    // No templates/, no agents/
    const roots = resolveBannedPatternRoots(root, [], []);
    assert.deepEqual(roots, [join(root, 'skills'), join(root, 'src')]);
  } finally {
    cleanup();
  }
});

test('resolveBannedPatternRoots: adds installed skill dirs AND agent files', () => {
  const { root, cleanup } = makeRosterRoot();
  const { root: claudeRoot, cleanup: cleanupClaude } = makeRosterRoot();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(claudeRoot, 'skills', 'sdr'), { recursive: true });
    mkdirSync(join(claudeRoot, 'agents'), { recursive: true });
    const agentPath = join(claudeRoot, 'agents', 'lesson-drafter.md');
    writeFileSync(agentPath, '# agent\n');

    const tool = fakeTool('claude', join(claudeRoot, 'skills'));
    const audit: ToolAuditResult = {
      tool: 'claude',
      toolName: 'Claude Code',
      configRoot: claudeRoot,
      items: [
        { kind: 'skill', name: 'sdr', status: 'ok', targetPath: join(claudeRoot, 'skills', 'sdr') },
        { kind: 'agent', name: 'lesson-drafter.md', status: 'ok', targetPath: agentPath },
      ],
      ok: true,
    };

    const roots = resolveBannedPatternRoots(root, [audit], [tool]);
    assert.ok(roots.includes(join(claudeRoot, 'skills', 'sdr')), 'installed skill dir included');
    // Codex 2nd-pass [MAJOR/8]: agent files NOW scanned (was previously skipped).
    assert.ok(roots.includes(agentPath), 'installed agent file included');
  } finally {
    cleanup();
    cleanupClaude();
  }
});

test('resolveBannedPatternRoots: codex-toml layout includes .persona.md sidecar', () => {
  const { root, cleanup } = makeRosterRoot();
  const { root: codexRoot, cleanup: cleanupCodex } = makeRosterRoot();
  try {
    mkdirSync(join(codexRoot, 'agents'), { recursive: true });
    const tomlPath = join(codexRoot, 'agents', 'lesson-drafter.toml');
    const personaPath = join(codexRoot, 'agents', 'lesson-drafter.persona.md');
    writeFileSync(tomlPath, 'name = "lesson-drafter"\n');
    writeFileSync(personaPath, '# persona\n');

    const codexTool: Tool = {
      key: 'codex',
      name: 'codex',
      configRoot: codexRoot,
      skillsTarget: join(codexRoot, 'skills'),
      agentsTarget: join(codexRoot, 'agents'),
      agentsLayout: 'codex-toml',
      installLink: 'https://example.com',
    } as unknown as Tool;
    const audit: ToolAuditResult = {
      tool: 'codex',
      toolName: 'codex',
      configRoot: codexRoot,
      items: [{ kind: 'agent', name: 'lesson-drafter.md', status: 'ok', targetPath: tomlPath }],
      ok: true,
    };
    const roots = resolveBannedPatternRoots(root, [audit], [codexTool]);
    assert.ok(roots.includes(tomlPath), 'toml included');
    assert.ok(roots.includes(personaPath), 'persona sidecar included');
  } finally {
    cleanup();
    cleanupCodex();
  }
});

test('auditBannedPatterns: detects banned literal in installed agent .md file (Codex 2nd-pass E)', () => {
  const { root, cleanup } = makeRosterRoot();
  const { root: claudeRoot, cleanup: cleanupClaude } = makeRosterRoot();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFile(root, 'src/clean.ts', 'export const x = 1;\n');
    mkdirSync(join(claudeRoot, 'agents'), { recursive: true });
    const agentPath = join(claudeRoot, 'agents', 'tampered.md');
    writeFileSync(agentPath, '# Tampered agent\n\nrun `claude -p foo` for me.\n');

    const tool = fakeTool('claude', join(claudeRoot, 'skills'));
    const audit: ToolAuditResult = {
      tool: 'claude',
      toolName: 'Claude Code',
      configRoot: claudeRoot,
      items: [{ kind: 'agent', name: 'tampered.md', status: 'ok', targetPath: agentPath }],
      ok: true,
    };

    const r = auditBannedPatterns(root, [audit], [tool]);
    assert.equal(r.status, 'fail');
    assert.ok(r.violations.some((v) => v.ruleId === 'claude-p-flag' && v.file === agentPath));
  } finally {
    cleanup();
    cleanupClaude();
  }
});

test('resolveBannedPatternRoots: skips missing items', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    const tool = fakeTool('claude', '/nonexistent/skills');
    const audit: ToolAuditResult = {
      tool: 'claude',
      toolName: 'Claude Code',
      configRoot: '/nonexistent',
      items: [{ kind: 'skill', name: 'sdr', status: 'missing', targetPath: '/nonexistent/skills/sdr' }],
      ok: false,
    };
    const roots = resolveBannedPatternRoots(root, [audit], [tool]);
    assert.ok(!roots.some((r) => r.includes('nonexistent')), 'missing items excluded');
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// auditBannedPatterns
// ──────────────────────────────────────────────────────────────────────

test('auditBannedPatterns: clean roster source → ok', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    writeFile(root, 'src/foo.ts', 'export const x = 1;\n');
    writeFile(root, 'skills/clean/SKILL.md', '# clean skill\n');
    const r = auditBannedPatterns(root, [], []);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.violations, []);
  } finally {
    cleanup();
  }
});

test('auditBannedPatterns: detects banned literal in src', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    // Use the cron command form the scanner is built to detect.
    writeFile(root, 'src/bad.ts', 'export const cmd = "claude -p hi";\n');
    const r = auditBannedPatterns(root, [], []);
    assert.equal(r.status, 'fail');
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0]!.ruleId, 'claude-p-flag');
  } finally {
    cleanup();
  }
});

test('auditBannedPatterns: opt-out marker suppresses the named rule only', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    writeFile(
      root,
      'templates/safe.md',
      'banned: `claude -p` <!-- roster-audit-ok: claude-p-flag -->\n',
    );
    const r = auditBannedPatterns(root, [], []);
    assert.equal(r.status, 'ok');
  } finally {
    cleanup();
  }
});

test('auditBannedPatterns: detects anthropic SDK import', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    writeFile(root, 'src/client.ts', "import Anthropic from '@anthropic-ai/sdk';\n");
    const r = auditBannedPatterns(root, [], []);
    assert.equal(r.status, 'fail');
    assert.equal(r.violations[0]!.ruleId, 'anthropic-sdk-import');
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// auditCodexPreflight
// ──────────────────────────────────────────────────────────────────────

test('auditCodexPreflight: codex not detected → skipped', () => {
  const r = auditCodexPreflight({ homeDir: '/tmp/fake-home', env: {}, codexDetected: false });
  assert.equal(r.status, 'skipped');
  if (r.status !== 'skipped') return;
  assert.equal(r.reason, 'codex-not-detected');
});

test('auditCodexPreflight: codex detected + missing auth.json → fail', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    // No ~/.codex/auth.json → preflight returns auth_mode failure.
    const r = auditCodexPreflight({ homeDir: root, env: {}, codexDetected: true });
    assert.equal(r.status, 'fail');
    if (r.status !== 'fail') return;
    assert.ok(r.failures.length > 0);
  } finally {
    cleanup();
  }
});

test('auditCodexPreflight: clean chatgpt auth + no env vars → ok', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }),
    );
    const r = auditCodexPreflight({ homeDir: root, env: {}, codexDetected: true });
    assert.equal(r.status, 'ok');
    if (r.status !== 'ok') return;
    assert.equal(r.attestation.auth_mode, 'chatgpt');
  } finally {
    cleanup();
  }
});

test('auditCodexPreflight: exported ANTHROPIC_API_KEY → fail', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null }),
    );
    const r = auditCodexPreflight({
      homeDir: root,
      env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' },
      codexDetected: true,
    });
    assert.equal(r.status, 'fail');
    if (r.status !== 'fail') return;
    assert.ok(r.failures.some((f) => f.check === 'env_anthropic_api_key'));
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// runSafetyAudit aggregate
// ──────────────────────────────────────────────────────────────────────

test('runSafetyAudit: clean + no codex → ok', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    writeFile(root, 'src/foo.ts', 'export const x = 1;\n');
    const r = runSafetyAudit({
      rosterRoot: root,
      toolAudits: [],
      detectedTools: [],
      homeDir: '/tmp/fake-home',
      env: {},
    });
    assert.equal(r.ok, true);
    assert.equal(r.bannedPatterns.status, 'ok');
    assert.equal(r.codexPreflight.status, 'skipped');
  } finally {
    cleanup();
  }
});

test('runSafetyAudit: banned literal in src → ok=false', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    writeFile(root, 'src/bad.ts', 'const x = "claude -p y";\n');
    const r = runSafetyAudit({
      rosterRoot: root,
      toolAudits: [],
      detectedTools: [],
      homeDir: '/tmp/fake-home',
      env: {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.bannedPatterns.status, 'fail');
  } finally {
    cleanup();
  }
});

test('runSafetyAudit: codex detected + failing preflight → ok=false', () => {
  const { root, cleanup } = makeRosterRoot();
  try {
    writeFile(root, 'src/foo.ts', 'export const x = 1;\n');
    const codexTool = fakeTool('codex', '/nowhere');
    const r = runSafetyAudit({
      rosterRoot: root,
      toolAudits: [],
      detectedTools: [codexTool],
      homeDir: '/tmp/empty-home-no-auth-json',
      env: {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.codexPreflight.status, 'fail');
  } finally {
    cleanup();
  }
});
