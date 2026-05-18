import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanSourceWorkspace } from '../src/lib/migrate/scan.ts';
import { planMigration } from '../src/lib/migrate/plan.ts';
import { buildAgentTeamMini } from './fixtures/agent-team-mini/_setup.ts';

function makeDest(): { dest: string; cleanup: () => void } {
  const dest = mkdtempSync(join(tmpdir(), 'roster-migrate-dest-'));
  return { dest, cleanup: () => rmSync(dest, { recursive: true, force: true }) };
}

test('planMigration: emits ready-to-run Claude and Codex install lines (ROS-35 merged)', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.equal(plan.scheduleInstalls.length, 2);

    const dreamer = plan.scheduleInstalls.find((s) => s.wrapperBasename === 'dreamer-nightly')!;
    assert.equal(dreamer.tool, 'claude');
    assert.equal(dreamer.blocked, false);
    assert.equal(dreamer.function, 'dreamer');
    assert.equal(dreamer.agent, 'dreamer');
    assert.equal(dreamer.plan, 'nightly');
    assert.match(dreamer.rendered, /--tool claude/);

    const sdr = plan.scheduleInstalls.find((s) => s.wrapperBasename === 'gtm-sdr-daily-outreach')!;
    assert.equal(sdr.tool, 'codex');
    assert.equal(sdr.blocked, false);
    assert.equal(sdr.function, 'gtm');
    assert.equal(sdr.agent, 'sdr');
    assert.equal(sdr.plan, 'daily-outreach');
    assert.match(sdr.rendered, /--tool codex/);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: .env at 0644 produces env-too-open blocker', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.equal(plan.envCopy, null);
    const envBlockers = plan.blockers.filter((b) => b.kind === 'env-too-open');
    assert.equal(envBlockers.length, 1);
    if (envBlockers[0]!.kind === 'env-too-open') {
      assert.equal(envBlockers[0]!.mode, 0o644);
    }
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: dest not initialized produces blocker', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: false });
    const blockers = plan.blockers.filter((b) => b.kind === 'dest-not-initialized');
    assert.equal(blockers.length, 1);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: pending HITL routes to roster/<function>/pending/', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.equal(plan.pendingMoves.length, 1);
    const m = plan.pendingMoves[0]!;
    assert.match(m.destPath, /\/roster\/dreamer\/pending\/L-2026-05-05-001\.md$/);
    assert.equal(m.destFunction, 'dreamer');
    assert.equal(m.destAgent, 'dreamer');
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: log copies routed to <agent>/log/runs/<YYYY-MM>/ (drops project layer)', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.equal(plan.logCopies.length, 1);
    const lc = plan.logCopies[0]!;
    assert.match(lc.destDir, /\/roster\/dreamer\/dreamer\/log\/runs\/2026-04$/);
    assert.equal(lc.files.length, 1);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: subscription-safety warnings propagate from scan', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.equal(plan.subscriptionWarnings.length, 1);
    assert.match(plan.subscriptionWarnings[0]!.wrapperPath, /dreamer-nightly\.sh$/);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: agent.md notes populated', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.equal(plan.agentMdNotes.length, 3);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: manual steps include crontab cleanup and Codex via-cron hint', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const descriptions = plan.manualSteps.map((s) => s.description);
    assert.ok(descriptions.some((d) => /crontab/.test(d)));
    assert.ok(descriptions.some((d) => /--via cron/.test(d)));
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: trackedFiles is sorted by source path', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const sorted = [...plan.trackedFiles].sort((a, b) => a.src.localeCompare(b.src));
    assert.deepEqual(plan.trackedFiles, sorted);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: rendered schedule install command uses POSIX single-quote escaping (ROS-64)', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const dreamer = plan.scheduleInstalls.find((s) => s.wrapperBasename === 'dreamer-nightly')!;

    // Cron expression is single-quoted (not double-quoted).
    assert.match(dreamer.rendered, /--cron '0 3 \* \* \*'/);
    // --cwd value is single-quoted.
    assert.match(dreamer.rendered, /--cwd '[^']+'/);
    // No raw double-quote sequences anywhere in the rendered command.
    assert.equal(dreamer.rendered.includes('"'), false);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: rendered command round-trips through bash argv parsing (ROS-64)', () => {
  // Lock in shell-safety: the rendered command, when interpreted by bash, must
  // tokenize into the exact argv vector we expect. Any quoting bug would
  // mis-split the cron expression (which contains spaces) or splice the dest
  // path with a flag.
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const dreamer = plan.scheduleInstalls.find((s) => s.wrapperBasename === 'dreamer-nightly')!;

    // Use bash to parse the rendered string into argv, then print each on its own line.
    const script = `set -- ${dreamer.rendered}; printf '%s\\n' "$@"`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    const argv = out.split('\n').slice(0, -1); // trailing empty from final \n

    assert.deepEqual(argv, [
      'roster',
      'schedule',
      'install',
      'dreamer/dreamer',
      'nightly',
      '--cron',
      '0 3 * * *',          // single token, NOT three
      '--tool',
      'claude',
      '--cwd',
      dst.dest,
    ]);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('planMigration: pure function — same input twice → identical plans', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan1 = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const plan2 = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.deepEqual(plan1, plan2);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});
