import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  auditAltSkillPaths,
  auditCronDrift,
  runSchedulingDriftAudit,
} from '../src/lib/doctor-scheduling-drift.ts';
import { getMarkerStrings, renderCronLine } from '../src/lib/codex-cron.ts';
import { buildOrchestratorPrompt } from '../src/lib/schedule-install.ts';
import type { CrontabIO } from '../src/lib/codex-cron.ts';

function mkTmp(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function fakeCrontab(content: string): CrontabIO {
  let current = content;
  return {
    read() {
      if (current.length === 0) return { ok: false, reason: 'no-crontab', content: '' };
      return { ok: true, content: current };
    },
    write(next: string) {
      current = next;
    },
  };
}

function writeSchedulesYaml(
  cwd: string,
  fnName: string,
  entries: Array<{ name: string; agent: string; plan: string; project: string; cron: string; install_mode: 'via-cron' | 'ui-handoff'; tool?: 'codex' | 'claude' }>,
): void {
  const fnDir = join(cwd, 'roster', fnName);
  mkdirSync(fnDir, { recursive: true });
  const lines: string[] = ['version: 1', 'schedules:'];
  for (const e of entries) {
    const tool = e.tool ?? 'codex';
    lines.push(`  - name: ${e.name}`);
    lines.push(`    agent: ${e.agent}`);
    lines.push(`    plan: ${e.plan}`);
    lines.push(`    project: ${e.project}`);
    lines.push(`    cron: "${e.cron}"`);
    lines.push(`    tool: ${tool}`);
    lines.push(`    install_mode: ${e.install_mode}`);
    lines.push(`    status: ${e.install_mode === 'via-cron' ? 'installed' : 'pending-ui-install'}`);
    if (tool === 'codex') {
      lines.push('    subscription_attestation:');
      lines.push('      auth_mode: chatgpt');
      lines.push('      env_policy: cleared');
      lines.push(`      codex_home: /tmp/.codex`);
    }
  }
  writeFileSync(join(fnDir, 'schedules.yaml'), lines.join('\n') + '\n', 'utf8');
}

const FAKE_CODEX_BINARY = '/opt/homebrew/bin/codex';

function buildMarkerBlock(name: string, cronLine: string): string {
  const { begin, end } = getMarkerStrings(name);
  return `${begin}\n${cronLine}\n${end}`;
}

// ──────────────────────────────────────────────────────────────────────
// auditCronDrift
// ──────────────────────────────────────────────────────────────────────

test('auditCronDrift: no schedules.yaml entries → ok empty', () => {
  const { dir, cleanup } = mkTmp('drift-empty-');
  try {
    const r = auditCronDrift({
      cwd: dir,
      crontabIO: fakeCrontab(''),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.items, []);
  } finally {
    cleanup();
  }
});

test('auditCronDrift: registered codex-via-cron entry, no crontab → fail (registered-but-no-marker)', () => {
  const { dir, cleanup } = mkTmp('drift-no-crontab-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr-cold',
      agent: 'sdr',
      plan: 'cold-outreach',
      project: '_demo',
      cron: '0 9 * * 1-5',
      install_mode: 'via-cron',
    }]);
    const r = auditCronDrift({
      cwd: dir,
      crontabIO: fakeCrontab(''), // no-crontab
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.status, 'fail');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.status, 'fail');
    assert.equal(r.items[0]!.name, 'sdr-cold');
    if (r.items[0]!.status === 'fail') {
      assert.equal(r.items[0]!.reason, 'registered-but-no-marker');
    }
  } finally {
    cleanup();
  }
});

test('auditCronDrift: marker block matches rendered line → ok', () => {
  const { dir, cleanup } = mkTmp('drift-match-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr-cold',
      agent: 'sdr',
      plan: 'cold-outreach',
      project: '_demo',
      cron: '0 9 * * 1-5',
      install_mode: 'via-cron',
    }]);
    // ROS-42: auditCronDrift now passes exitPath when re-rendering — match
    // that here so the byte-exact comparison succeeds.
    const expected = renderCronLine({
      cron: '0 9 * * 1-5',
      workspacePath: dir,
      codexBinaryPath: FAKE_CODEX_BINARY,
      prompt: buildOrchestratorPrompt('sdr', 'cold-outreach', '_demo'),
      logPath: join(dir, 'logs', 'cron', 'sdr-cold.log'),
      exitPath: join(dir, 'logs', 'cron', 'sdr-cold.exit'),
    });
    const crontab = buildMarkerBlock('sdr-cold', expected);
    const r = auditCronDrift({
      cwd: dir,
      crontabIO: fakeCrontab(crontab),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.items[0]!.status, 'ok');
  } finally {
    cleanup();
  }
});

test('auditCronDrift: marker block content differs from rendered → fail (cron-line-mismatch)', () => {
  const { dir, cleanup } = mkTmp('drift-mismatch-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr-cold',
      agent: 'sdr',
      plan: 'cold-outreach',
      project: '_demo',
      cron: '0 9 * * 1-5',
      install_mode: 'via-cron',
    }]);
    const tamperedLine = '0 0 * * * /usr/bin/env echo hello';
    const crontab = buildMarkerBlock('sdr-cold', tamperedLine);
    const r = auditCronDrift({
      cwd: dir,
      crontabIO: fakeCrontab(crontab),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.status, 'fail');
    assert.equal(r.items[0]!.status, 'fail');
    if (r.items[0]!.status === 'fail') {
      assert.equal(r.items[0]!.reason, 'cron-line-mismatch');
    }
  } finally {
    cleanup();
  }
});

test('auditCronDrift: orphan marker (marker in crontab, no registered entry) → fail', () => {
  const { dir, cleanup } = mkTmp('drift-orphan-');
  try {
    // Register one entry; crontab has a marker block for a DIFFERENT name.
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr-cold',
      agent: 'sdr',
      plan: 'cold-outreach',
      project: '_demo',
      cron: '0 9 * * 1-5',
      install_mode: 'via-cron',
    }]);
    const expectedForReg = renderCronLine({
      cron: '0 9 * * 1-5',
      workspacePath: dir,
      codexBinaryPath: FAKE_CODEX_BINARY,
      prompt: buildOrchestratorPrompt('sdr', 'cold-outreach', '_demo'),
      logPath: join(dir, 'logs', 'cron', 'sdr-cold.log'),
    });
    const crontab = [
      buildMarkerBlock('sdr-cold', expectedForReg),
      '',
      buildMarkerBlock('orphan-foo', '0 5 * * * /usr/bin/env echo orphan'),
    ].join('\n');
    const r = auditCronDrift({
      cwd: dir,
      crontabIO: fakeCrontab(crontab),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.status, 'fail');
    const orphan = r.items.find((i) => i.name === 'orphan-foo');
    assert.ok(orphan);
    assert.equal(orphan!.status, 'fail');
    if (orphan!.status === 'fail') {
      assert.equal(orphan!.reason, 'orphan-marker-block');
    }
  } finally {
    cleanup();
  }
});

test('auditCronDrift: ui-handoff entries are ignored (only via-cron is auditable)', () => {
  const { dir, cleanup } = mkTmp('drift-ui-handoff-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr-ui',
      agent: 'sdr',
      plan: 'cold-outreach',
      project: '_demo',
      cron: '0 9 * * 1-5',
      install_mode: 'ui-handoff',
    }]);
    const r = auditCronDrift({
      cwd: dir,
      crontabIO: fakeCrontab(''),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.items, []);
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// auditAltSkillPaths
// ──────────────────────────────────────────────────────────────────────

test('auditAltSkillPaths: no ~/.agents/skills → ok absent', () => {
  const { dir, cleanup } = mkTmp('alt-absent-');
  try {
    const r = auditAltSkillPaths({ homeDir: dir });
    assert.equal(r.status, 'ok');
    assert.equal(r.items[0]!.presence, 'absent');
  } finally {
    cleanup();
  }
});

test('auditAltSkillPaths: alt present + canonical absent → warn (only-alt-present)', () => {
  const { dir, cleanup } = mkTmp('alt-only-');
  try {
    mkdirSync(join(dir, '.agents', 'skills', 'roster-orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'roster-orchestrator', 'SKILL.md'), '# alt\n');
    const r = auditAltSkillPaths({ homeDir: dir });
    assert.equal(r.status, 'warn');
    assert.equal(r.items[0]!.presence, 'only-alt-present');
  } finally {
    cleanup();
  }
});

test('auditAltSkillPaths: alt + canonical with identical content → ok matches-canonical', () => {
  const { dir, cleanup } = mkTmp('alt-match-');
  try {
    mkdirSync(join(dir, '.agents', 'skills', 'roster-orchestrator'), { recursive: true });
    mkdirSync(join(dir, '.codex', 'skills', 'roster-orchestrator'), { recursive: true });
    const body = '# roster-orchestrator\nshared body\n';
    writeFileSync(join(dir, '.agents', 'skills', 'roster-orchestrator', 'SKILL.md'), body);
    writeFileSync(join(dir, '.codex', 'skills', 'roster-orchestrator', 'SKILL.md'), body);
    const r = auditAltSkillPaths({ homeDir: dir });
    assert.equal(r.status, 'ok');
    assert.equal(r.items[0]!.presence, 'matches-canonical');
  } finally {
    cleanup();
  }
});

test('auditAltSkillPaths: alt + canonical with divergent content → warn (content-diverged)', () => {
  const { dir, cleanup } = mkTmp('alt-diverged-');
  try {
    mkdirSync(join(dir, '.agents', 'skills', 'roster-orchestrator'), { recursive: true });
    mkdirSync(join(dir, '.codex', 'skills', 'roster-orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'roster-orchestrator', 'SKILL.md'), '# alt different\n');
    writeFileSync(join(dir, '.codex', 'skills', 'roster-orchestrator', 'SKILL.md'), '# canonical\n');
    const r = auditAltSkillPaths({ homeDir: dir });
    assert.equal(r.status, 'warn');
    assert.equal(r.items[0]!.presence, 'content-diverged');
  } finally {
    cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────
// runSchedulingDriftAudit aggregate
// ──────────────────────────────────────────────────────────────────────

test('runSchedulingDriftAudit: cron-drift fail → ok=false', () => {
  const { dir, cleanup } = mkTmp('aggregate-fail-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr-cold',
      agent: 'sdr',
      plan: 'cold-outreach',
      project: '_demo',
      cron: '0 9 * * 1-5',
      install_mode: 'via-cron',
    }]);
    const r = runSchedulingDriftAudit({
      cwd: dir,
      homeDir: dir,
      crontabIO: fakeCrontab(''),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.ok, false);
    assert.equal(r.cronDrift.status, 'fail');
  } finally {
    cleanup();
  }
});

test('runSchedulingDriftAudit: alt-skill warn does NOT flip ok', () => {
  const { dir, cleanup } = mkTmp('aggregate-warn-only-');
  try {
    mkdirSync(join(dir, '.agents', 'skills', 'roster-orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'roster-orchestrator', 'SKILL.md'), '# alt\n');
    const r = runSchedulingDriftAudit({
      cwd: dir,
      homeDir: dir,
      crontabIO: fakeCrontab(''),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.ok, true);
    assert.equal(r.altSkillPath.status, 'warn');
  } finally {
    cleanup();
  }
});
