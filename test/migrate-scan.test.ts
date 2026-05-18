import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCrontab } from '../src/lib/migrate/crontab.ts';
import { mapWrapperToAgentPlan, parseWrapperFile } from '../src/lib/migrate/wrapper.ts';
import { scanSourceWorkspace, isLikelyRosterWorkspace } from '../src/lib/migrate/scan.ts';
import { buildAgentTeamMini } from './fixtures/agent-team-mini/_setup.ts';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('parseCrontab: skips comments and empty lines, picks active entries', () => {
  const input = [
    '# comment',
    '',
    '0 3 * * * /path/to/dreamer-nightly.sh',
    '   30 9 * * 1-5 /path/to/gtm-sdr-daily-outreach.sh',
    '# 0 0 * * * /never/runs.sh',
    '@daily /also/never.sh',
  ].join('\n');
  const lines = parseCrontab(input);
  assert.equal(lines.length, 3);
  assert.equal(lines[0]!.cron, '0 3 * * *');
  assert.equal(lines[0]!.wrapperPath, '/path/to/dreamer-nightly.sh');
  assert.equal(lines[1]!.cron, '30 9 * * 1-5');
  assert.equal(lines[1]!.wrapperPath, '/path/to/gtm-sdr-daily-outreach.sh');
  assert.equal(lines[2]!.cron, '@daily');
  assert.equal(lines[2]!.wrapperPath, '/also/never.sh');
});

test('parseCrontab: malformed lines (too few fields) are silently dropped', () => {
  const input = [
    '0 3 * *', // 4 fields
    '0 3 * * * /good.sh',
  ].join('\n');
  const lines = parseCrontab(input);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.cron, '0 3 * * *');
});

test('mapWrapperToAgentPlan: single-segment wrapper matches a top-level agent', () => {
  const known = [{ key: 'dreamer', function: 'dreamer', agent: 'dreamer' }];
  const r = mapWrapperToAgentPlan('dreamer-nightly', known);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.function, 'dreamer');
    assert.equal(r.agent, 'dreamer');
    assert.equal(r.plan, 'nightly');
  }
});

test('mapWrapperToAgentPlan: multi-dash matches longest function/agent prefix', () => {
  const known = [
    { key: 'gtm', function: 'gtm', agent: 'gtm' },
    { key: 'gtm.sdr', function: 'gtm', agent: 'sdr' },
  ];
  const r = mapWrapperToAgentPlan('gtm-sdr-daily-outreach', known);
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.function, 'gtm');
    assert.equal(r.agent, 'sdr');
    assert.equal(r.plan, 'daily-outreach');
  }
});

test('mapWrapperToAgentPlan: exact key match with no remainder → plan=default', () => {
  const known = [{ key: 'dreamer', function: 'dreamer', agent: 'dreamer' }];
  const r = mapWrapperToAgentPlan('dreamer', known);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan, 'default');
});

test('mapWrapperToAgentPlan: no match returns ok:false', () => {
  const known = [{ key: 'dreamer', function: 'dreamer', agent: 'dreamer' }];
  const r = mapWrapperToAgentPlan('unknown-wrapper', known);
  assert.equal(r.ok, false);
});

test('parseWrapperFile: detects claude -p as subscription-safety violation', () => {
  const fix = buildAgentTeamMini();
  try {
    const wrapperPath = join(fix.root, 'scripts', 'cron', 'wrappers', 'dreamer-nightly.sh');
    const parsed = parseWrapperFile(wrapperPath);
    assert.equal(parsed.usesClaudeMinusP, true);
    assert.equal(parsed.kind, 'claude');
    assert.notEqual(parsed.promptFilePath, null);
    assert.match(parsed.promptBody ?? '', /Run dreamer nightly/);
  } finally {
    fix.cleanup();
  }
});

test('parseWrapperFile: detects codex invocation', () => {
  const fix = buildAgentTeamMini();
  try {
    const wrapperPath = join(fix.root, 'scripts', 'cron', 'wrappers', 'gtm-sdr-daily-outreach.sh');
    const parsed = parseWrapperFile(wrapperPath);
    assert.equal(parsed.kind, 'codex');
    assert.equal(parsed.usesClaudeMinusP, false);
  } finally {
    fix.cleanup();
  }
});

test('scanSourceWorkspace: finds top-level + nested agents, ignores function-only dirs', () => {
  const fix = buildAgentTeamMini();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const keys = model.agents.map((a) => (a.parentFunction ? `${a.parentFunction}/${a.name}` : a.name)).sort();
    assert.deepEqual(keys, ['chief-of-staff', 'dreamer', 'gtm/sdr']);
  } finally {
    fix.cleanup();
  }
});

test('scanSourceWorkspace: collects pending HITL items at agent level', () => {
  const fix = buildAgentTeamMini();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    assert.equal(model.pendingItems.length, 1);
    assert.equal(model.pendingItems[0]!.agent, 'dreamer');
    assert.match(model.pendingItems[0]!.filename, /^L-2026-05-05-001\.md$/);
  } finally {
    fix.cleanup();
  }
});

test('scanSourceWorkspace: detects .env at mode 0644', () => {
  const fix = buildAgentTeamMini();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    assert.notEqual(model.envFile, null);
    assert.equal(model.envFile!.mode & 0o777, 0o644);
  } finally {
    fix.cleanup();
  }
});

test('scanSourceWorkspace: cron entries pair with wrappers', () => {
  const fix = buildAgentTeamMini();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    assert.equal(model.cronEntries.length, 2);
    const names = model.cronEntries.map((e) => e.wrapper.basename).sort();
    assert.deepEqual(names, ['dreamer-nightly', 'gtm-sdr-daily-outreach']);
  } finally {
    fix.cleanup();
  }
});

test('scanSourceWorkspace: emits subscription-safety warning for claude -p wrappers', () => {
  const fix = buildAgentTeamMini();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const subs = model.warnings.filter((w) => w.kind === 'subscription-safety');
    assert.equal(subs.length, 1);
    if (subs[0]!.kind === 'subscription-safety') {
      assert.match(subs[0]!.wrapperPath, /dreamer-nightly\.sh$/);
    }
  } finally {
    fix.cleanup();
  }
});

test('scanSourceWorkspace: emits agent-md-present warning per agent', () => {
  const fix = buildAgentTeamMini();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const agentMds = model.warnings.filter((w) => w.kind === 'agent-md-present');
    assert.equal(agentMds.length, 3);
  } finally {
    fix.cleanup();
  }
});

test('scanSourceWorkspace: knownAgentPaths is set up for longest-prefix wrapper match', () => {
  const fix = buildAgentTeamMini();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const keys = model.knownAgentPaths.map((k) => k.key).sort();
    assert.deepEqual(keys, ['chief-of-staff', 'dreamer', 'gtm.sdr']);
  } finally {
    fix.cleanup();
  }
});

test('scanSourceWorkspace: rejects sibling-prefix wrapper paths that bypass naive startsWith (ROS-64)', () => {
  // Classic prefix-match exploit: an attacker plants a sibling dir whose name is a
  // string-extension of sourceDir, then references a wrapper inside it. Pre-fix code
  // used `wrapperPath.startsWith(sourceDir)` and accepted the escape; the hardened
  // check uses realpathSync + sep-anchored containment, which rejects it.
  const parent = mkdtempSync(join(tmpdir(), 'roster-traversal-'));
  const src = join(parent, 'src');
  const sibling = join(parent, 'src-evil'); // string-extension of `src`
  try {
    mkdirSync(join(src, 'scripts', 'cron'), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const outsideWrapper = join(sibling, 'wrapper.sh');
    writeFileSync(outsideWrapper, '#!/usr/bin/env bash\nclaude -p "PWNED"\n', 'utf8');

    // outsideWrapper = `${parent}/src-evil/wrapper.sh` — startsWith(`${parent}/src`)
    // is TRUE, but it lives outside the `src` directory.
    writeFileSync(
      join(src, 'scripts', 'cron', 'crontab'),
      `0 3 * * * ${outsideWrapper}\n`,
      'utf8',
    );

    const model = scanSourceWorkspace({ sourceDir: src });

    // The scanner must NOT have parsed the outside wrapper.
    assert.equal(model.cronEntries.length, 0, 'sibling-prefix path must not resolve into a cronEntry');
    const notFound = model.warnings.filter((w) => w.kind === 'wrapper-not-found');
    assert.equal(notFound.length, 1, 'expected exactly one wrapper-not-found warning');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('scanSourceWorkspace: rejects symlink inside sourceDir that targets an ancestor (ROS-64 — realpath containment)', () => {
  // Even with `path.resolve` (lexical), an attacker who can write into sourceDir can
  // plant a symlink that resolves to an outside file. The hardened check uses
  // realpathSync, which dereferences symlinks.
  const parent = mkdtempSync(join(tmpdir(), 'roster-symlink-'));
  const src = join(parent, 'src');
  const outsideTarget = join(parent, 'outside-target.sh');
  try {
    mkdirSync(join(src, 'scripts', 'cron'), { recursive: true });
    writeFileSync(outsideTarget, '#!/usr/bin/env bash\nclaude -p "PWNED"\n', 'utf8');

    // Symlink inside src pointing at the outside file.
    const symlinkPath = join(src, 'looks-inside.sh');
    symlinkSync(outsideTarget, symlinkPath);

    writeFileSync(
      join(src, 'scripts', 'cron', 'crontab'),
      `0 3 * * * ${symlinkPath}\n`,
      'utf8',
    );

    const model = scanSourceWorkspace({ sourceDir: src });
    assert.equal(model.cronEntries.length, 0, 'symlink escape must be rejected');
    const notFound = model.warnings.filter((w) => w.kind === 'wrapper-not-found');
    assert.equal(notFound.length, 1);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('isLikelyRosterWorkspace: detects CONTEXT.md or roster/ directory', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'isLikely-'));
  try {
    assert.equal(isLikelyRosterWorkspace(tmp), false);
    writeFileSync(join(tmp, 'CONTEXT.md'), '# project\n');
    assert.equal(isLikelyRosterWorkspace(tmp), true);

    const tmp2 = mkdtempSync(join(tmpdir(), 'isLikely2-'));
    try {
      mkdirSync(join(tmp2, 'roster'));
      assert.equal(isLikelyRosterWorkspace(tmp2), true);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
