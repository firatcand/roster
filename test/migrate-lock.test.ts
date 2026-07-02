import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  STALE_LOCK_MS,
  acquireManifestLock,
  manifestLockPathFor,
  releaseManifestLock,
} from '../src/lib/migrate/lock.ts';
import { scanSourceWorkspace } from '../src/lib/migrate/scan.ts';
import { planMigration } from '../src/lib/migrate/plan.ts';
import { executeMigration } from '../src/lib/migrate/execute.ts';
import { manifestPathFor, readManifest, sourceHashFor } from '../src/lib/migrate/manifest.ts';
import { RosterError } from '../src/lib/errors.ts';
import { buildAgentTeamMini } from './fixtures/agent-team-mini/_setup.ts';

const GENEROUS_SLACK_MS = 5 * 60 * 1000;

function makeManifestRoot(): { manifestPath: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-lock-'));
  return {
    manifestPath: join(root, '.roster', 'migration-manifests', 'agent-team-abc123def456.json'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeDest(): { dest: string; cleanup: () => void } {
  const dest = mkdtempSync(join(tmpdir(), 'roster-lock-exec-'));
  writeFileSync(join(dest, 'CONTEXT.md'), '# init\n');
  mkdirSync(join(dest, 'roster'));
  return { dest, cleanup: () => rmSync(dest, { recursive: true, force: true }) };
}

function backdate(path: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  utimesSync(path, then, then);
}

function writeForeignLock(lockPath: string, pid: number): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z' }) + '\n', { flag: 'wx' });
}

const fixedClock = (): Date => new Date('2026-05-18T00:00:00Z');

test('lock: acquire creates <manifest>.lock with pid + startedAt, release removes it', () => {
  const t = makeManifestRoot();
  try {
    const handle = acquireManifestLock(t.manifestPath);
    assert.equal(handle.lockPath, manifestLockPathFor(t.manifestPath));
    assert.equal(handle.lockPath, `${t.manifestPath}.lock`);
    assert.ok(existsSync(handle.lockPath));

    const body = JSON.parse(readFileSync(handle.lockPath, 'utf8')) as { pid: number; startedAt: string };
    assert.equal(body.pid, process.pid);
    assert.equal(typeof body.startedAt, 'string');

    releaseManifestLock(handle);
    assert.equal(existsSync(handle.lockPath), false);

    const again = acquireManifestLock(t.manifestPath);
    assert.ok(existsSync(again.lockPath));
    releaseManifestLock(again);
  } finally {
    t.cleanup();
  }
});

test('lock: release is best-effort — tolerates an already-missing lock', () => {
  const t = makeManifestRoot();
  try {
    const handle = acquireManifestLock(t.manifestPath);
    releaseManifestLock(handle);
    assert.doesNotThrow(() => releaseManifestLock(handle));
    assert.doesNotThrow(() => releaseManifestLock({ lockPath: join(tmpdir(), 'roster-lock-nonexistent', 'x.lock') }));
  } finally {
    t.cleanup();
  }
});

test('lock: fresh held lock refuses with pid, age, and the delete remedy', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    writeForeignLock(lockPath, 54321);
    assert.throws(
      () => acquireManifestLock(t.manifestPath),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /migration manifest/);
        assert.match(err.body, /pid 54321/);
        assert.match(err.body, /\d+[sm] ago/);
        assert.match(err.remedy, /delete /);
        assert.ok(err.remedy.includes(lockPath));
        assert.match(err.remedy, /if that run crashed/);
        return true;
      },
    );
    assert.ok(existsSync(lockPath), 'refusal must not remove the holder lock');
  } finally {
    t.cleanup();
  }
});

test('lock: unparseable lock content still refuses (pid unknown), never clobbers', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, 'not json\n');
    assert.throws(
      () => acquireManifestLock(t.manifestPath),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.body, /pid unknown/);
        return true;
      },
    );
    assert.equal(readFileSync(lockPath, 'utf8'), 'not json\n');
  } finally {
    t.cleanup();
  }
});

test('lock: stale lock (mtime past 15 min + slack) is rename-broken and re-acquired, no debris', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    writeForeignLock(lockPath, 99999);
    backdate(lockPath, STALE_LOCK_MS + GENEROUS_SLACK_MS);

    const winner = acquireManifestLock(t.manifestPath);
    assert.equal(winner.lockPath, lockPath);
    const body = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
    assert.equal(body.pid, process.pid, 'fresh lock belongs to the breaker');
    assert.ok(Date.now() - statSync(lockPath).mtimeMs < 60_000, 'fresh lock has a fresh mtime');

    const debris = readdirSync(dirname(lockPath)).filter((f) => f.includes('.stale-'));
    assert.deepEqual(debris, [], 'winner unlinks the lock it renamed');

    releaseManifestLock(winner);
    assert.equal(existsSync(lockPath), false);
  } finally {
    t.cleanup();
  }
});

test('lock: just-under-threshold lock is NOT broken', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    writeForeignLock(lockPath, 77777);
    backdate(lockPath, STALE_LOCK_MS - GENEROUS_SLACK_MS);
    assert.throws(
      () => acquireManifestLock(t.manifestPath),
      (err: unknown) => err instanceof RosterError && /pid 77777/.test(err.body),
    );
    const body = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
    assert.equal(body.pid, 77777, 'held lock untouched');
  } finally {
    t.cleanup();
  }
});

test('lock: rename-loser hits ENOENT, re-enters acquire, refuses against the winner fresh lock', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    writeForeignLock(lockPath, 99999);
    backdate(lockPath, STALE_LOCK_MS + GENEROUS_SLACK_MS);

    const events: string[] = [];
    const winnerStale = `${lockPath}.stale-winner`;
    assert.throws(
      () =>
        acquireManifestLock(t.manifestPath, {
          beforeStaleBreak: () => {
            // Deterministic interleave: between the loser's stat and its rename,
            // the winner renames the stale lock away (winning the break).
            renameSync(lockPath, winnerStale);
            events.push('winner-renamed-stale');
          },
          beforeAttempt: (attempt) => {
            if (attempt === 1) {
              // Before the loser re-enters, the winner finishes its break:
              // unlink the renamed stale file, wx-create its fresh lock.
              unlinkSync(winnerStale);
              writeFileSync(lockPath, JSON.stringify({ pid: 22222, startedAt: new Date().toISOString() }) + '\n', {
                flag: 'wx',
              });
              events.push('winner-created-fresh');
            }
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /migration manifest/);
        assert.match(err.body, /pid 22222/);
        return true;
      },
    );

    assert.deepEqual(events, ['winner-renamed-stale', 'winner-created-fresh'], 'exactly one break attempt by the loser');
    const body = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number };
    assert.equal(body.pid, 22222, 'winner lock survives the losing racer');
    const debris = readdirSync(dirname(lockPath)).filter((f) => f.includes(`.stale-${process.pid}`));
    assert.deepEqual(debris, [], 'loser never renamed, so it owns no stale file');
  } finally {
    t.cleanup();
  }
});

test('executeMigration: dry-run acquires no lock and creates no directories', () => {
  const fix = buildAgentTeamMini();
  chmodSync(join(fix.root, '.env'), 0o600);
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.equal(plan.blockers.length, 0);

    const exec = executeMigration(plan, { dryRun: true, forceResync: false, clock: fixedClock });
    assert.equal(exec.blockersHit, false);

    assert.equal(existsSync(join(dst.dest, '.roster')), false, 'dry-run must not create .roster/');
    const manifestPath = manifestPathFor(plan.destWorkspace, sourceHashFor(plan.sourceDir));
    assert.equal(existsSync(manifestLockPathFor(manifestPath)), false, 'dry-run must not create a lock');
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('executeMigration: pre-held lock — refused run writes NOTHING, winner leaves a valid manifest', () => {
  const fix = buildAgentTeamMini();
  chmodSync(join(fix.root, '.env'), 0o600);
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    assert.equal(plan.blockers.length, 0);

    const manifestPath = manifestPathFor(plan.destWorkspace, sourceHashFor(plan.sourceDir));
    const holder = acquireManifestLock(manifestPath);

    assert.throws(
      () => executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /migration manifest/);
        return true;
      },
    );

    assert.equal(existsSync(manifestPath), false, 'refused run wrote no manifest');
    assert.equal(
      existsSync(join(dst.dest, 'roster', 'dreamer', 'pending', 'L-2026-05-05-001.md')),
      false,
      'refused run copied no pending files',
    );
    assert.equal(existsSync(join(dst.dest, '.env')), false, 'refused run copied no .env');
    assert.equal(
      existsSync(join(dst.dest, '.roster', 'migration-scripts')),
      false,
      'refused run wrote no install script',
    );
    assert.ok(existsSync(holder.lockPath), 'refused run did not disturb the holder lock');

    releaseManifestLock(holder);

    const exec = executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock });
    assert.equal(exec.blockersHit, false);
    const manifest = readManifest(manifestPath);
    assert.notEqual(manifest, null, 'winner manifest is valid');
    assert.ok(manifest!.files.length >= 3);
    assert.equal(existsSync(manifestLockPathFor(manifestPath)), false, 'winner released its lock');
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('executeMigration: a crashed run\'s stale lock is broken automatically', () => {
  const fix = buildAgentTeamMini();
  chmodSync(join(fix.root, '.env'), 0o600);
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const manifestPath = manifestPathFor(plan.destWorkspace, sourceHashFor(plan.sourceDir));
    const lockPath = manifestLockPathFor(manifestPath);
    writeForeignLock(lockPath, 99999);
    backdate(lockPath, STALE_LOCK_MS + GENEROUS_SLACK_MS);

    const exec = executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock });
    assert.equal(exec.blockersHit, false);
    const manifest = readManifest(manifestPath);
    assert.notEqual(manifest, null);
    assert.ok(manifest!.files.length >= 3);
    assert.equal(existsSync(lockPath), false, 'lock released after the run');
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});
