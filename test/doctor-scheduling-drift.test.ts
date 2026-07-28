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
  entries: Array<{ name: string; agent: string; plan: string; cron: string; install_mode: 'via-cron' | 'ui-handoff'; tool?: 'codex' | 'claude' }>,
): void {
  const fnDir = join(cwd, 'roster', fnName);
  mkdirSync(fnDir, { recursive: true });
  const lines: string[] = ['version: 1', 'schedules:'];
  for (const e of entries) {
    const tool = e.tool ?? 'codex';
    lines.push(`  - name: ${e.name}`);
    lines.push(`    agent: ${e.agent}`);
    lines.push(`    plan: ${e.plan}`);
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
      cron: '0 9 * * 1-5',
      install_mode: 'via-cron',
    }]);
    // ROS-42: auditCronDrift now passes exitPath when re-rendering — match
    // that here so the byte-exact comparison succeeds.
    const expected = renderCronLine({
      cron: '0 9 * * 1-5',
      workspacePath: dir,
      codexBinaryPath: FAKE_CODEX_BINARY,
      prompt: buildOrchestratorPrompt('gtm', 'sdr', 'cold-outreach', 'sdr-cold'),
      logPath: join(dir, 'logs', 'cron', 'gtm', 'sdr-cold.log'),
      exitDir: join(dir, 'logs', 'cron', 'gtm', 'sdr-cold'),
    });
    const crontab = buildMarkerBlock('gtm/sdr-cold', expected);
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
      cron: '0 9 * * 1-5',
      install_mode: 'via-cron',
    }]);
    const tamperedLine = '0 0 * * * /usr/bin/env echo hello';
    const crontab = buildMarkerBlock('gtm/sdr-cold', tamperedLine);
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
      cron: '0 9 * * 1-5',
      install_mode: 'via-cron',
    }]);
    const expectedForReg = renderCronLine({
      cron: '0 9 * * 1-5',
      workspacePath: dir,
      codexBinaryPath: FAKE_CODEX_BINARY,
      prompt: buildOrchestratorPrompt('gtm', 'sdr', 'cold-outreach', 'sdr-cold'),
      logPath: join(dir, 'logs', 'cron', 'gtm', 'sdr-cold.log'),
    });
    const crontab = [
      buildMarkerBlock('gtm/sdr-cold', expectedForReg),
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

// ── round-6 finding 8: a legacy bare marker is consumed at most ONCE, and only
// by the function its content proves. Before this fix, gtm/nightly AND
// ops/nightly both counted a single bare 'nightly' marker as their own clean
// install.

// Round-6 finding 8 asserted the PROVEN owner consumed the bare marker here.
// Round-7 finding 2 SUPERSEDES that: a bare marker whose schedule name is
// registered by two functions is unattributable (the "proof" is user-editable
// crontab text), so drift REPORTS the ambiguity and NOBODY claims it. The
// round-6 invariant is kept and strengthened — no registration reports OK, and
// the marker is still not double-counted.
test('auditCronDrift (round-7 finding 2, supersedes round-6 finding 8): one legacy bare marker + two same-named registrations → ambiguity reported, claimed by NOBODY', () => {
  const { dir, cleanup } = mkTmp('drift-legacy-owner-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{ name: 'nightly', agent: 'sdr', plan: 'cold', cron: '0 0 * * *', install_mode: 'via-cron' }]);
    writeSchedulesYaml(dir, 'ops', [{ name: 'nightly', agent: 'ops', plan: 'sweep', cron: '0 0 * * *', install_mode: 'via-cron' }]);
    // The bare 'nightly' marker holds gtm's line (function-scoped paths "prove" it).
    const gtmLine = renderCronLine({
      cron: '0 0 * * *',
      workspacePath: dir,
      codexBinaryPath: FAKE_CODEX_BINARY,
      prompt: buildOrchestratorPrompt('gtm', 'sdr', 'cold', 'nightly'),
      logPath: join(dir, 'logs', 'cron', 'gtm', 'nightly.log'),
      exitDir: join(dir, 'logs', 'cron', 'gtm', 'nightly'),
    });
    const crontab = buildMarkerBlock('nightly', gtmLine);
    const r = auditCronDrift({
      cwd: dir,
      crontabIO: fakeCrontab(crontab),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.ok(!r.items.some((i) => i.status === 'ok'), 'no registration silently claims the ambiguous marker');
    const ambiguous = r.items.filter((i) => i.status === 'fail' && i.reason === 'ambiguous-legacy-marker');
    assert.equal(ambiguous.length, 2, 'both same-named registrations report the ambiguity');
    for (const item of ambiguous) {
      if (item.status === 'fail' && item.reason === 'ambiguous-legacy-marker') {
        assert.deepEqual(item.competingFunctions, ['gtm', 'ops'], 'the competing functions are named');
      }
    }
    assert.ok(!r.items.some((i) => i.status === 'fail' && i.reason === 'orphan-marker-block'), 'the block is reported once, as ambiguous — not also as an orphan');
    assert.equal(r.status, 'fail');
  } finally {
    cleanup();
  }
});

test('auditCronDrift (round-6 finding 8): an UNPROVABLE legacy bare marker is consumed by NOBODY — entry fails, marker flagged orphan', () => {
  const { dir, cleanup } = mkTmp('drift-legacy-unprovable-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{ name: 'nightly', agent: 'sdr', plan: 'cold', cron: '0 0 * * *', install_mode: 'via-cron' }]);
    // A genuine pre-scoped-paths line: no /logs/cron/<function>/ evidence.
    const crontab = buildMarkerBlock('nightly', '0 0 * * * codex exec >> /w/logs/cron/nightly.log 2>&1');
    const r = auditCronDrift({
      cwd: dir,
      crontabIO: fakeCrontab(crontab),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.status, 'fail');
    assert.ok(
      r.items.some((i) => i.status === 'fail' && i.reason === 'registered-but-no-marker' && i.name === 'nightly'),
      'the registration does not claim an unprovable marker',
    );
    assert.ok(
      r.items.some((i) => i.status === 'fail' && i.reason === 'orphan-marker-block' && i.name === 'nightly'),
      'the unclaimed marker surfaces as an orphan for the user to migrate',
    );
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

test('auditAltSkillPaths: no legacy ~/.codex/skills → ok absent', () => {
  const { dir, cleanup } = mkTmp('alt-absent-');
  try {
    const r = auditAltSkillPaths({ homeDir: dir });
    assert.equal(r.status, 'ok');
    assert.equal(r.items[0]!.presence, 'absent');
  } finally {
    cleanup();
  }
});

test('auditAltSkillPaths: legacy .codex present + canonical .agents absent → warn (only-alt-present)', () => {
  const { dir, cleanup } = mkTmp('alt-only-');
  try {
    mkdirSync(join(dir, '.codex', 'skills', 'roster-orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.codex', 'skills', 'roster-orchestrator', 'SKILL.md'), '# legacy\n');
    const r = auditAltSkillPaths({ homeDir: dir });
    assert.equal(r.status, 'warn');
    assert.equal(r.items[0]!.presence, 'only-alt-present');
  } finally {
    cleanup();
  }
});

test('auditAltSkillPaths: legacy + canonical with identical content → ok matches-canonical', () => {
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

test('auditAltSkillPaths: legacy + canonical with divergent content → warn (content-diverged)', () => {
  const { dir, cleanup } = mkTmp('alt-diverged-');
  try {
    mkdirSync(join(dir, '.agents', 'skills', 'roster-orchestrator'), { recursive: true });
    mkdirSync(join(dir, '.codex', 'skills', 'roster-orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.agents', 'skills', 'roster-orchestrator', 'SKILL.md'), '# canonical\n');
    writeFileSync(join(dir, '.codex', 'skills', 'roster-orchestrator', 'SKILL.md'), '# legacy different\n');
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
    mkdirSync(join(dir, '.codex', 'skills', 'roster-orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.codex', 'skills', 'roster-orchestrator', 'SKILL.md'), '# legacy\n');
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

// ──────────────────────────────────────────────────────────────────────
// auditStaleFires (ROS-42)
// ──────────────────────────────────────────────────────────────────────

import { auditStaleFires } from '../src/lib/doctor-scheduling-drift.ts';
import { exitDirFor, exitPathForFire } from '../src/lib/cron-exit-log.ts';
import { utimesSync } from 'node:fs';

// Per-fire, function-scoped exit file (round-5): logs/cron/<fn>/<name>/<fireId>.exit
function writeExit(cwd: string, fnName: string, name: string, code: string, mtimeUtc?: Date, fireId = 'fire0'): void {
  mkdirSync(exitDirFor(cwd, fnName, name), { recursive: true });
  const p = exitPathForFire(cwd, fnName, name, fireId);
  writeFileSync(p, code, 'utf8');
  if (mtimeUtc !== undefined) {
    const sec = mtimeUtc.getTime() / 1000;
    utimesSync(p, sec, sec);
  }
}

function writeStateMd(cwd: string, fnName: string, lines: string[]): void {
  const fnDir = join(cwd, 'roster', fnName);
  mkdirSync(fnDir, { recursive: true });
  writeFileSync(join(fnDir, 'state.md'), lines.join('\n') + '\n', 'utf8');
}

test('auditStaleFires: no schedules → ok empty', () => {
  const { dir, cleanup } = mkTmp('stale-empty-');
  try {
    const r = auditStaleFires({ cwd: dir });
    assert.equal(r.status, 'ok');
    assert.equal(r.items.length, 0);
  } finally {
    cleanup();
  }
});

test('auditStaleFires: failed last fire → status=fail, item.status=fail', () => {
  const { dir, cleanup } = mkTmp('stale-failed-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr', agent: 'sdr', plan: 'cold',
      cron: '0 9 * * 1-5', install_mode: 'via-cron',
    }]);
    writeExit(dir, 'gtm', 'sdr', '137');
    const r = auditStaleFires({ cwd: dir });
    assert.equal(r.status, 'fail');
    assert.equal(r.items.length, 1);
    if (r.items[0]!.status === 'fail') {
      assert.equal(r.items[0]!.exitCode, 137);
    }
  } finally {
    cleanup();
  }
});

test('auditStaleFires (round-7 finding 9): a MALFORMED last exit (empty file) is failure evidence → status=fail, exitCode null', () => {
  const { dir, cleanup } = mkTmp('stale-malformed-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr', agent: 'sdr', plan: 'cold',
      cron: '0 9 * * 1-5', install_mode: 'via-cron',
    }]);
    writeExit(dir, 'gtm', 'sdr', ''); // present but unreadable as an exit code
    const r = auditStaleFires({ cwd: dir });
    assert.equal(r.status, 'fail', 'malformed wrapper evidence must not pass as a clean fire (aligned with pending-sync)');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0]!.status, 'fail');
    if (r.items[0]!.status === 'fail') {
      assert.equal(r.items[0]!.exitCode, null, "the malformed class renders distinctly (exit '?')");
    }
  } finally {
    cleanup();
  }
});

test('auditStaleFires: stale last_run → status=warn, item missed-window', () => {
  const { dir, cleanup } = mkTmp('stale-warn-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr', agent: 'sdr', plan: 'cold',
      cron: '0 9 * * 1-5', install_mode: 'via-cron',
    }]);
    writeStateMd(dir, 'gtm', ['2026-05-15T09:05:00Z | gtm/sdr/cold/_demo | success']);
    const r = auditStaleFires({
      cwd: dir,
      now: new Date('2026-05-18T12:00:00Z'),
    });
    assert.equal(r.status, 'warn');
    assert.equal(r.items.length, 1);
    if (r.items[0]!.status === 'warn') {
      assert.equal(r.items[0]!.reason, 'missed-window');
    }
  } finally {
    cleanup();
  }
});

test('auditStaleFires: zero exit + recent state.md → ok recent-run', () => {
  const { dir, cleanup } = mkTmp('stale-ok-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr', agent: 'sdr', plan: 'cold',
      cron: '0 9 * * 1-5', install_mode: 'via-cron',
    }]);
    writeStateMd(dir, 'gtm', ['2026-05-18T09:05:00Z | gtm/sdr/cold/_demo | success']);
    writeExit(dir, 'gtm', 'sdr', '0', new Date('2026-05-18T09:00:00Z'));
    const r = auditStaleFires({
      cwd: dir,
      now: new Date('2026-05-18T10:00:00Z'),
    });
    assert.equal(r.status, 'ok');
    if (r.items[0]!.status === 'ok') {
      assert.equal(r.items[0]!.reason, 'recent-run');
    }
  } finally {
    cleanup();
  }
});

test('runSchedulingDriftAudit: stale fires WARN does not flip ok; FAIL does', () => {
  const { dir, cleanup } = mkTmp('aggregate-stale-');
  try {
    writeSchedulesYaml(dir, 'gtm', [{
      name: 'sdr', agent: 'sdr', plan: 'cold',
      cron: '0 9 * * 1-5', install_mode: 'via-cron',
    }]);
    writeStateMd(dir, 'gtm', ['2026-05-15T09:05:00Z | gtm/sdr/cold/_demo | success']);
    // Crontab matches what install would render — drift=ok. Stale warns.
    const expected = renderCronLine({
      cron: '0 9 * * 1-5',
      workspacePath: dir,
      codexBinaryPath: FAKE_CODEX_BINARY,
      prompt: buildOrchestratorPrompt('gtm', 'sdr', 'cold', 'sdr'),
      logPath: join(dir, 'logs', 'cron', 'gtm', 'sdr.log'),
      exitDir: join(dir, 'logs', 'cron', 'gtm', 'sdr'),
    });
    const crontab = buildMarkerBlock('gtm/sdr', expected);
    const warnRun = runSchedulingDriftAudit({
      cwd: dir,
      homeDir: dir,
      crontabIO: fakeCrontab(crontab),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
      now: new Date('2026-05-18T12:00:00Z'),
    });
    assert.equal(warnRun.staleFires.status, 'warn');
    assert.equal(warnRun.ok, true, 'WARN must not flip ok');

    // Now add a failed exit → status flips to fail and ok flips to false.
    writeExit(dir, 'gtm', 'sdr', '137');
    const failRun = runSchedulingDriftAudit({
      cwd: dir,
      homeDir: dir,
      crontabIO: fakeCrontab(crontab),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
      now: new Date('2026-05-18T12:00:00Z'),
    });
    assert.equal(failRun.staleFires.status, 'fail');
    assert.equal(failRun.ok, false, 'FAIL must flip ok');
  } finally {
    cleanup();
  }
});

// ── auditCronDrift: capture_events=true re-renders the events form ──────

test('auditCronDrift: capture_events=true entry → events form matches installed line', () => {
  const { dir, cleanup } = mkTmp('drift-capture-events-');
  try {
    // Write schedules.yaml inline so we can include capture_events: true.
    const fnDir = join(dir, 'roster', 'gtm');
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(join(fnDir, 'schedules.yaml'), [
      'version: 1',
      'schedules:',
      '  - name: sdr-events',
      '    agent: sdr',
      '    plan: cold',
      '    cron: "0 9 * * 1-5"',
      '    tool: codex',
      '    install_mode: via-cron',
      '    status: installed',
      '    capture_events: true',
      '    subscription_attestation:',
      '      auth_mode: chatgpt',
      '      env_policy: cleared',
      '      codex_home: /tmp/.codex',
      '',
    ].join('\n'), 'utf8');

    const expected = renderCronLine({
      cron: '0 9 * * 1-5',
      workspacePath: dir,
      codexBinaryPath: FAKE_CODEX_BINARY,
      prompt: buildOrchestratorPrompt('gtm', 'sdr', 'cold', 'sdr-events'),
      logPath: join(dir, 'logs', 'cron', 'gtm', 'sdr-events.log'),
      exitDir: join(dir, 'logs', 'cron', 'gtm', 'sdr-events'),
      eventsPath: join(dir, 'logs', 'cron', 'gtm', 'sdr-events.events.jsonl'),
    });
    // Sanity: the rendered line includes --json (events form signature).
    assert.ok(expected.includes(' exec --json '), 'expected --json in rendered line');

    const crontab = buildMarkerBlock('gtm/sdr-events', expected);
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

test('auditCronDrift: capture_events=true entry vs non-events crontab line → cron-line-mismatch', () => {
  // If a user manually installed without capture_events but the schedules.yaml
  // says capture_events: true, the byte-exact re-render diverges → drift.
  const { dir, cleanup } = mkTmp('drift-capture-events-mismatch-');
  try {
    const fnDir = join(dir, 'roster', 'gtm');
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(join(fnDir, 'schedules.yaml'), [
      'version: 1',
      'schedules:',
      '  - name: sdr-events',
      '    agent: sdr',
      '    plan: cold',
      '    cron: "0 9 * * 1-5"',
      '    tool: codex',
      '    install_mode: via-cron',
      '    status: installed',
      '    capture_events: true',
      '    subscription_attestation:',
      '      auth_mode: chatgpt',
      '      env_policy: cleared',
      '      codex_home: /tmp/.codex',
      '',
    ].join('\n'), 'utf8');

    // Crontab has the non-events form (older install before capture_events flip).
    const nonEvents = renderCronLine({
      cron: '0 9 * * 1-5',
      workspacePath: dir,
      codexBinaryPath: FAKE_CODEX_BINARY,
      prompt: buildOrchestratorPrompt('gtm', 'sdr', 'cold', 'sdr-events'),
      logPath: join(dir, 'logs', 'cron', 'gtm', 'sdr-events.log'),
      exitDir: join(dir, 'logs', 'cron', 'gtm', 'sdr-events'),
    });
    const crontab = buildMarkerBlock('gtm/sdr-events', nonEvents);
    const r = auditCronDrift({
      cwd: dir,
      crontabIO: fakeCrontab(crontab),
      env: { PATH: FAKE_CODEX_BINARY },
      codexBinaryPathOverride: FAKE_CODEX_BINARY,
    });
    assert.equal(r.status, 'fail');
    if (r.items[0]!.status === 'fail') {
      assert.equal(r.items[0]!.reason, 'cron-line-mismatch');
    }
  } finally {
    cleanup();
  }
});
