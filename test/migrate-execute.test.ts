import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSourceWorkspace } from '../src/lib/migrate/scan.ts';
import { planMigration, type MigrationPlan } from '../src/lib/migrate/plan.ts';
import { executeMigration, renderInstallScript } from '../src/lib/migrate/execute.ts';
import { readManifest } from '../src/lib/migrate/manifest.ts';
import { buildAgentTeamMini } from './fixtures/agent-team-mini/_setup.ts';

function makeDest(): { dest: string; cleanup: () => void } {
  const dest = mkdtempSync(join(tmpdir(), 'roster-execute-'));
  // Mark as initialized
  writeFileSync(join(dest, 'CONTEXT.md'), '# init\n');
  mkdirSync(join(dest, 'roster'));
  return { dest, cleanup: () => rmSync(dest, { recursive: true, force: true }) };
}

function chmodEnvTo600(fixRoot: string): void {
  chmodSync(join(fixRoot, '.env'), 0o600);
}

const fixedClock = (): Date => new Date('2026-05-18T00:00:00Z');

test('executeMigration: blockers present → exits early, no writes', () => {
  const fix = buildAgentTeamMini(); // .env at 0644 → blocker
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const exec = executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock });
    assert.equal(exec.blockersHit, true);
    assert.equal(exec.fileResults.length, 0);
    // No install script created
    assert.equal(existsSync(join(dst.dest, '.roster', 'migration-scripts')), false);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('executeMigration: live run copies pending + logs + .env, writes manifest', () => {
  const fix = buildAgentTeamMini();
  chmodEnvTo600(fix.root);
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.equal(plan.blockers.length, 0, 'plan should have no blockers after chmod');

    const exec = executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock });
    assert.equal(exec.blockersHit, false);

    // Pending file
    const pendingDest = join(dst.dest, 'roster', 'dreamer', 'pending', 'L-2026-05-05-001.md');
    assert.ok(existsSync(pendingDest), 'pending file should be migrated');

    // Log
    const logDest = join(dst.dest, 'roster', 'dreamer', 'dreamer', 'log', 'runs', '2026-04', '2026-04-15-2200.md');
    assert.ok(existsSync(logDest), 'log file should be migrated');

    // .env at 0o600
    const envDest = join(dst.dest, '.env');
    assert.ok(existsSync(envDest));
    assert.equal(statSync(envDest).mode & 0o777, 0o600);

    // Install script
    assert.notEqual(exec.installScriptPath, null);
    assert.ok(existsSync(exec.installScriptPath!));
    const script = readFileSync(exec.installScriptPath!, 'utf8');
    assert.match(script, /roster schedule install 'dreamer'\/'dreamer' 'nightly'/);
    assert.match(script, /roster schedule install 'gtm'\/'sdr' 'daily-outreach' .* --tool codex/);

    // Manifest
    assert.notEqual(exec.manifestPath, null);
    const manifest = readManifest(exec.manifestPath!);
    assert.notEqual(manifest, null);
    assert.equal(manifest!.files.length >= 3, true); // pending + log + .env
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('executeMigration: dry-run writes nothing to disk', () => {
  const fix = buildAgentTeamMini();
  chmodEnvTo600(fix.root);
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const exec = executeMigration(plan, { dryRun: true, forceResync: false, clock: fixedClock });
    assert.equal(exec.blockersHit, false);

    // None of the targets exist
    assert.equal(existsSync(join(dst.dest, 'roster', 'dreamer', 'pending', 'L-2026-05-05-001.md')), false);
    assert.equal(existsSync(join(dst.dest, '.env')), false);
    assert.equal(existsSync(join(dst.dest, '.roster')), false);

    // But the planned file ops are listed
    assert.ok(exec.fileResults.length >= 3);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('executeMigration: idempotency — second live run is all noops', () => {
  const fix = buildAgentTeamMini();
  chmodEnvTo600(fix.root);
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });

    executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock });
    const second = executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock });

    const written = second.fileResults.filter((r) => r.kind === 'written').length;
    const noop = second.fileResults.filter((r) => r.kind === 'noop').length;
    assert.equal(written, 0, 'second run should write nothing');
    assert.equal(noop > 0, true, 'second run should report noops');
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('executeMigration: user hand-edit at dest is preserved (manifest detects drift)', () => {
  const fix = buildAgentTeamMini();
  chmodEnvTo600(fix.root);
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });

    executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock });

    // User edits the migrated pending file
    const pendingDest = join(dst.dest, 'roster', 'dreamer', 'pending', 'L-2026-05-05-001.md');
    writeFileSync(pendingDest, 'USER EDIT — do not touch\n', 'utf8');

    // Re-run migrate
    const second = executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock });

    // The user edit should still be there
    const after = readFileSync(pendingDest, 'utf8');
    assert.match(after, /USER EDIT/);

    // The result should be a skip with the right reason
    const skipped = second.fileResults.find((r) => r.kind === 'skipped' && r.dest === pendingDest);
    assert.notEqual(skipped, undefined);
    if (skipped && skipped.kind === 'skipped') {
      assert.equal(skipped.reason, 'user-hand-edited-destination');
    }
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('renderInstallScript: emits Claude + Codex sections (both ready-to-run post ROS-35)', () => {
  const fix = buildAgentTeamMini();
  chmodEnvTo600(fix.root);
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const script = renderInstallScript(plan, '2026-05-18T00:00:00Z');
    assert.match(script, /^#!\/usr\/bin\/env bash/);
    assert.match(script, /# Claude schedules/);
    assert.match(script, /roster schedule install 'dreamer'\/'dreamer' 'nightly'/);
    assert.match(script, /# Codex schedules/);
    assert.match(script, /roster schedule install 'gtm'\/'sdr' 'daily-outreach' .* --tool codex/);
    assert.match(script, /--via cron/);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

// ROS-68 — defense-in-depth: rendered install script must not have any
// `rm -rf /` (or similar attacker-controlled suffix) escape from a `#`
// comment, even if a malicious or malformed UnmappedWrapper / sourceDir /
// destWorkspace carries embedded \n / \r. The crontab parser already
// rejects newlines in wrapper fields, but the renderer must not rely on
// a parser invariant for safety, and sourceDir/destWorkspace come from CLI.
test('renderInstallScript: every `rm -rf /` substring stays inside a `#` comment under newline-bearing inputs (ROS-68)', () => {
  const plan: MigrationPlan = {
    sourceDir: '/src\nrm -rf /',
    destWorkspace: '/dst\nrm -rf /',
    scheduleInstalls: [],
    unmappedWrappers: [
      {
        basename: 'evil\nrm -rf /',
        cron: '0 9 * * *\nrm -rf /',
        wrapperPath: '/safe.sh\nrm -rf /',
      },
    ],
    pendingMoves: [],
    logCopies: [],
    envCopy: null,
    agentMdNotes: [],
    subscriptionWarnings: [],
    manualSteps: [],
    blockers: [],
    trackedFiles: [],
  };
  const script = renderInstallScript(plan, '2026-05-18T00:00:00Z');
  const lines = script.split('\n');

  // Strongest invariant: any line containing the attacker payload MUST start
  // with `#`. If any line carries the payload outside a comment, the
  // generated script would execute it.
  for (const l of lines) {
    if (l.includes('rm -rf /')) {
      assert.ok(l.startsWith('#'), `payload escaped a comment: ${JSON.stringify(l)}`);
    }
  }

  // Header comment lines must be single-line.
  const sourceLine = lines.find((l) => l.startsWith('# Source:'));
  const destLine = lines.find((l) => l.startsWith('# Destination:'));
  assert.notEqual(sourceLine, undefined, 'header `# Source:` line should appear');
  assert.notEqual(destLine, undefined, 'header `# Destination:` line should appear');
  assert.doesNotMatch(sourceLine!, /[\r\n]/, '# Source line must not contain CR/LF');
  assert.doesNotMatch(destLine!, /[\r\n]/, '# Destination line must not contain CR/LF');

  // TODO line: exactly one, single-line, with all three sanitized values.
  const todoLines = lines.filter((l) => l.startsWith('# TODO'));
  assert.equal(todoLines.length, 1, 'exactly one TODO line should appear');
  assert.doesNotMatch(todoLines[0]!, /[\r\n]/, 'TODO line must not contain CR/LF');
  assert.match(todoLines[0]!, /evil rm -rf \//);
  assert.match(todoLines[0]!, /0 9 \* \* \* rm -rf \//);
  assert.match(todoLines[0]!, /\/safe\.sh rm -rf \//);
});
