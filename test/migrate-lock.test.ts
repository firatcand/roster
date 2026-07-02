import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

function writeForeignLock(lockPath: string, content: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, content, { flag: 'wx' });
}

function foreignLockJson(pid: unknown): string {
  return JSON.stringify({ pid, startedAt: '2026-01-01T00:00:00.000Z', token: 'foreign-token' }) + '\n';
}

const fixedClock = (): Date => new Date('2026-05-18T00:00:00Z');

test('lock: acquire creates <manifest>.lock with pid + startedAt + token, release removes it', () => {
  const t = makeManifestRoot();
  try {
    const handle = acquireManifestLock(t.manifestPath);
    assert.equal(handle.lockPath, manifestLockPathFor(t.manifestPath));
    assert.equal(handle.lockPath, `${t.manifestPath}.lock`);
    assert.ok(existsSync(handle.lockPath));

    const body = JSON.parse(readFileSync(handle.lockPath, 'utf8')) as { pid: number; startedAt: string; token: string };
    assert.equal(body.pid, process.pid);
    assert.equal(typeof body.startedAt, 'string');
    assert.equal(body.token, handle.token);
    assert.ok(handle.token.length > 0);

    releaseManifestLock(handle);
    assert.equal(existsSync(handle.lockPath), false);

    const again = acquireManifestLock(t.manifestPath);
    assert.ok(existsSync(again.lockPath));
    assert.notEqual(again.token, handle.token, 'each acquire mints a fresh token');
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
    assert.doesNotThrow(() =>
      releaseManifestLock({ lockPath: join(tmpdir(), 'roster-lock-nonexistent', 'x.lock'), token: 'x' }),
    );
  } finally {
    t.cleanup();
  }
});

test('lock: release never unlinks a successor lock (token mismatch → no-op)', () => {
  const t = makeManifestRoot();
  try {
    const handle = acquireManifestLock(t.manifestPath);
    // Manual intervention mid-run: our lock deleted, a successor's created.
    unlinkSync(handle.lockPath);
    const successorContent = JSON.stringify({ pid: 22222, startedAt: new Date().toISOString(), token: 'successor-token' }) + '\n';
    writeFileSync(handle.lockPath, successorContent, { flag: 'wx' });

    releaseManifestLock(handle);
    assert.ok(existsSync(handle.lockPath), 'successor lock survives our release');
    assert.equal(readFileSync(handle.lockPath, 'utf8'), successorContent);
  } finally {
    t.cleanup();
  }
});

test('lock: fresh held lock refuses with pid + age + wait guidance, never breaks', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    writeForeignLock(lockPath, foreignLockJson(54321));
    assert.throws(
      () => acquireManifestLock(t.manifestPath),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /another roster migrate is writing this workspace's migration manifest/);
        assert.match(err.body, /pid 54321/);
        assert.match(err.body, /\d+[sm] ago/);
        assert.match(err.remedy, /Wait for that migrate run to finish/);
        assert.doesNotMatch(err.remedy, /delete/i, 'fresh refusal does not suggest deletion');
        return true;
      },
    );
    assert.equal(readFileSync(lockPath, 'utf8'), foreignLockJson(54321), 'holder lock untouched');
  } finally {
    t.cleanup();
  }
});

test('lock: just-under-threshold lock still gets the fresh (wait) message', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    writeForeignLock(lockPath, foreignLockJson(77777));
    backdate(lockPath, STALE_LOCK_MS - GENEROUS_SLACK_MS);
    assert.throws(
      () => acquireManifestLock(t.manifestPath),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.body, /pid 77777/);
        assert.match(err.remedy, /Wait for that migrate run to finish/);
        return true;
      },
    );
    assert.equal(readFileSync(lockPath, 'utf8'), foreignLockJson(77777), 'held lock untouched');
  } finally {
    t.cleanup();
  }
});

test('lock: stale lock (past 15 min + slack) REFUSES with crashed-run message — never auto-broken', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    writeForeignLock(lockPath, foreignLockJson(99999));
    backdate(lockPath, STALE_LOCK_MS + GENEROUS_SLACK_MS);

    assert.throws(
      () => acquireManifestLock(t.manifestPath),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /stale migration-manifest lock/);
        assert.match(err.header, /likely crashed/);
        assert.match(err.body, /pid 99999/);
        assert.match(err.body, /\d+m old/);
        assert.match(err.remedy, /Verify no roster migrate is running/);
        assert.match(err.remedy, /delete /);
        assert.ok(err.remedy.includes(lockPath));
        assert.match(err.remedy, /and retry/);
        return true;
      },
    );
    assert.equal(readFileSync(lockPath, 'utf8'), foreignLockJson(99999), 'stale lock is NOT broken or mutated');
  } finally {
    t.cleanup();
  }
});

test('lock: unparseable lock content still refuses (pid unknown), never clobbers', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    writeForeignLock(lockPath, 'not json\n');
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

test('lock: invalid pid values (negative, non-numeric) report pid unknown', () => {
  for (const pid of [-5, 0, 1.5, '123']) {
    const t = makeManifestRoot();
    try {
      const lockPath = manifestLockPathFor(t.manifestPath);
      writeForeignLock(lockPath, foreignLockJson(pid));
      assert.throws(
        () => acquireManifestLock(t.manifestPath),
        (err: unknown) => {
          assert.ok(err instanceof RosterError);
          assert.match(err.body, /pid unknown/, `pid ${JSON.stringify(pid)} must not be trusted`);
          return true;
        },
      );
    } finally {
      t.cleanup();
    }
  }
});

test('lock: oversized lock file (>4 KB) is read capped — refusal with pid unknown, no crash', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    writeForeignLock(lockPath, JSON.stringify({ pid: 54321, padding: 'x'.repeat(64 * 1024) }));
    assert.throws(
      () => acquireManifestLock(t.manifestPath),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.body, /pid unknown/);
        return true;
      },
    );
  } finally {
    t.cleanup();
  }
});

test('lock: symlink at the lock path is refused as suspicious, not treated as a lock, not removed', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    mkdirSync(dirname(lockPath), { recursive: true });
    const target = join(dirname(lockPath), 'innocent.json');
    writeFileSync(target, '{"pid": 1}\n');
    symlinkSync(target, lockPath);

    assert.throws(
      () => acquireManifestLock(t.manifestPath),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /refusing to trust/);
        assert.match(err.body, /symbolic link/);
        assert.match(err.remedy, /remove it manually/);
        return true;
      },
    );
    assert.ok(existsSync(lockPath), 'symlink left in place');
    assert.ok(existsSync(target), 'symlink target untouched');
  } finally {
    t.cleanup();
  }
});

test('lock: directory at the lock path is refused as suspicious', () => {
  const t = makeManifestRoot();
  try {
    const lockPath = manifestLockPathFor(t.manifestPath);
    mkdirSync(lockPath, { recursive: true });
    assert.throws(
      () => acquireManifestLock(t.manifestPath),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.body, /directory/);
        return true;
      },
    );
    assert.ok(existsSync(lockPath));
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

test('executeMigration: crashed-run stale lock refuses; the documented manual delete unblocks', () => {
  const fix = buildAgentTeamMini();
  chmodSync(join(fix.root, '.env'), 0o600);
  const dst = makeDest();
  try {
    const model = scanSourceWorkspace({ sourceDir: fix.root });
    const plan = planMigration(model, { destWorkspace: dst.dest, destIsInitialized: true });
    const manifestPath = manifestPathFor(plan.destWorkspace, sourceHashFor(plan.sourceDir));
    const lockPath = manifestLockPathFor(manifestPath);
    writeForeignLock(lockPath, foreignLockJson(99999));
    backdate(lockPath, STALE_LOCK_MS + GENEROUS_SLACK_MS);

    assert.throws(
      () => executeMigration(plan, { dryRun: false, forceResync: false, clock: fixedClock }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError);
        assert.match(err.header, /likely crashed/);
        assert.match(err.remedy, /delete /);
        return true;
      },
    );
    assert.equal(existsSync(manifestPath), false, 'refused run wrote no manifest');
    assert.ok(existsSync(lockPath), 'stale lock NOT auto-broken');

    // The documented remedy: verify nothing is running, delete, retry.
    unlinkSync(lockPath);
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
