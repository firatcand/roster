import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readExitRecord,
  readExitRecordForFire,
  listExitRecords,
  exitDirFor,
  exitPathForFire,
  logPathFor,
  eventsPathFor,
} from '../src/lib/cron-exit-log.ts';
import { MAX_EVIDENCE_BYTES, readEvidenceFileSync } from '../src/lib/schedule-state.ts';

function withTmpCwd<T>(fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-exitlog-'));
  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Per-fire, function-scoped exit file: logs/cron/<function>/<name>/<fireId>.exit
function makeExit(cwd: string, fn: string, name: string, fireId: string, content: string): string {
  const dir = exitDirFor(cwd, fn, name);
  mkdirSync(dir, { recursive: true });
  const p = exitPathForFire(cwd, fn, name, fireId);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ── path helpers ──────────────────────────────────────────────────────────

test('exitDirFor: composes <cwd>/logs/cron/<function>/<name>', () => {
  assert.equal(exitDirFor('/work', 'gtm', 'sdr'), '/work/logs/cron/gtm/sdr');
});

test('exitPathForFire: composes <cwd>/logs/cron/<function>/<name>/<fireId>.exit', () => {
  assert.equal(exitPathForFire('/work', 'gtm', 'sdr', 'ab12'), '/work/logs/cron/gtm/sdr/ab12.exit');
});

test('logPathFor: composes <cwd>/logs/cron/<function>/<name>.log (function-scoped, finding 2)', () => {
  assert.equal(logPathFor('/work', 'gtm', 'sdr'), '/work/logs/cron/gtm/sdr.log');
});

test('eventsPathFor: composes <cwd>/logs/cron/<function>/<name>.events.jsonl (function-scoped, finding 2)', () => {
  assert.equal(eventsPathFor('/work', 'gtm', 'sdr'), '/work/logs/cron/gtm/sdr.events.jsonl');
});

// ── readExitRecord / readExitRecordForFire ─────────────────────────────────

test('readExitRecordForFire: missing file → null', () => {
  withTmpCwd((cwd) => {
    assert.equal(readExitRecordForFire(cwd, 'gtm', 'nope', 'fid1'), null);
  });
});

test('readExitRecordForFire: "0" → exitCode 0, carries function/schedule/fireId', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'gtm', 'sdr', 'fid0', '0');
    const r = readExitRecordForFire(cwd, 'gtm', 'sdr', 'fid0');
    assert.ok(r);
    assert.equal(r.exitCode, 0);
    assert.equal(r.functionName, 'gtm');
    assert.equal(r.scheduleName, 'sdr');
    assert.equal(r.fireId, 'fid0');
    assert.ok(r.mtimeMs > 0);
  });
});

test('readExitRecordForFire: "137" → exitCode 137 (SIGKILL — codex OOM)', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'gtm', 'sdr-cold', 'fidK', '137');
    assert.equal(readExitRecordForFire(cwd, 'gtm', 'sdr-cold', 'fidK')?.exitCode, 137);
  });
});

test('readExitRecordForFire: trailing newline tolerated', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'gtm', 'sdr', 'fidN', '1\n');
    assert.equal(readExitRecordForFire(cwd, 'gtm', 'sdr', 'fidN')?.exitCode, 1);
  });
});

test('readExitRecordForFire: empty file → exitCode null (race with writer)', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'gtm', 'sdr', 'fidE', '');
    const r = readExitRecordForFire(cwd, 'gtm', 'sdr', 'fidE');
    assert.ok(r);
    assert.equal(r.exitCode, null);
  });
});

test('readExitRecordForFire: non-numeric / out-of-range → exitCode null', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'gtm', 'sdr', 'fidX', 'oops');
    assert.equal(readExitRecordForFire(cwd, 'gtm', 'sdr', 'fidX')?.exitCode, null);
    makeExit(cwd, 'gtm', 'sdr', 'fidY', '999');
    assert.equal(readExitRecordForFire(cwd, 'gtm', 'sdr', 'fidY')?.exitCode, null);
  });
});

test('readExitRecord: filename without .exit suffix → null', () => {
  withTmpCwd((cwd) => {
    const dir = exitDirFor(cwd, 'gtm', 'sdr');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'x.run-id');
    writeFileSync(p, '0', 'utf8');
    assert.equal(readExitRecord(cwd, 'gtm', 'sdr', p), null);
  });
});

// ── listExitRecords ────────────────────────────────────────────────────────

test('listExitRecords: empty cwd → empty', () => {
  withTmpCwd((cwd) => {
    assert.equal(listExitRecords(cwd, 'gtm', 'sdr').length, 0);
  });
});

test('listExitRecords: multiple per-fire exits → all returned, sorted by fireId', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'gtm', 'sdr', 'beta', '1');
    makeExit(cwd, 'gtm', 'sdr', 'alpha', '0');
    makeExit(cwd, 'gtm', 'sdr', 'gamma', '2');
    const recs = listExitRecords(cwd, 'gtm', 'sdr');
    assert.equal(recs.length, 3);
    assert.deepEqual(recs.map((x) => x.fireId), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(recs.map((x) => x.exitCode), [0, 1, 2]);
  });
});

test('listExitRecords: cross-function same-name schedules are isolated (finding 2)', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'gtm', 'nightly', 'g1', '137');
    makeExit(cwd, 'ops', 'nightly', 'o1', '0');
    const gtm = listExitRecords(cwd, 'gtm', 'nightly');
    const ops = listExitRecords(cwd, 'ops', 'nightly');
    assert.deepEqual(gtm.map((x) => x.fireId), ['g1']);
    assert.deepEqual(ops.map((x) => x.fireId), ['o1']);
    assert.equal(gtm[0]!.exitCode, 137);
    assert.equal(ops[0]!.exitCode, 0);
  });
});

test('listExitRecords: non-.exit siblings ignored', () => {
  withTmpCwd((cwd) => {
    const dir = exitDirFor(cwd, 'gtm', 'sdr');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'f1.run-id'), '{}', 'utf8');
    makeExit(cwd, 'gtm', 'sdr', 'f1', '0');
    const recs = listExitRecords(cwd, 'gtm', 'sdr');
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.fireId, 'f1');
  });
});

test('listExitRecords: malformed exit file included as exitCode=null', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'gtm', 'sdr', 'fg', 'garbage');
    const recs = listExitRecords(cwd, 'gtm', 'sdr');
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.exitCode, null);
  });
});

// ── round-7 finding 7: hardened evidence reads — no hang, no follow, size cap ──
//
// The channel dir is agent-writable, so the readers must survive hostile file
// SHAPES: a FIFO (a plain synchronous read blocks forever — pre-fix this hung
// pending sync, the SessionStart banner, and doctor), a symlink (O_NOFOLLOW
// refuses), and an oversized file (cap enforced BEFORE the read). All classify
// as malformed evidence — which finding 9 treats as failure evidence.

const isPosix = process.platform !== 'win32';

test('readExitRecordForFire (round-7 finding 7): a FIFO at the exit path → malformed evidence (exitCode null), NO block', { timeout: 5000, skip: !isPosix }, () => {
  withTmpCwd((cwd) => {
    const dir = exitDirFor(cwd, 'gtm', 'sdr');
    mkdirSync(dir, { recursive: true });
    const p = exitPathForFire(cwd, 'gtm', 'sdr', 'fidfifo');
    const mk = spawnSync('mkfifo', [p]);
    assert.equal(mk.status, 0, 'mkfifo available on POSIX CI/dev machines');
    // Pre-fix: readFileSync on a reader-only FIFO blocks until a writer appears
    // → this test would trip its 5s timeout. Post-fix it returns immediately.
    const r = readExitRecordForFire(cwd, 'gtm', 'sdr', 'fidfifo');
    assert.ok(r, 'the evidence EXISTS — it must not read as absent');
    assert.equal(r.exitCode, null, 'a FIFO is malformed evidence, never a parsed exit');
  });
});

test('readExitRecordForFire (round-7 finding 7): an oversized exit file → malformed evidence (cap enforced before read)', { timeout: 5000 }, () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'gtm', 'sdr', 'fidbig', '1'.repeat(MAX_EVIDENCE_BYTES + 1));
    const r = readExitRecordForFire(cwd, 'gtm', 'sdr', 'fidbig');
    assert.ok(r);
    assert.equal(r.exitCode, null, 'an oversized file is malformed evidence');
    // The shared reader itself reports the violation class.
    const ev = readEvidenceFileSync(exitPathForFire(cwd, 'gtm', 'sdr', 'fidbig'));
    assert.equal(ev.state, 'malformed');
    assert.equal((ev as { reason: string }).reason, 'oversized');
  });
});

test('readExitRecordForFire (round-7 finding 7): a symlinked exit path is refused (O_NOFOLLOW) → malformed evidence', { timeout: 5000, skip: !isPosix }, () => {
  withTmpCwd((cwd) => {
    const dir = exitDirFor(cwd, 'gtm', 'sdr');
    mkdirSync(dir, { recursive: true });
    const target = join(cwd, 'innocent-target');
    writeFileSync(target, '0', 'utf8');
    symlinkSync(target, exitPathForFire(cwd, 'gtm', 'sdr', 'fidlink'));
    const r = readExitRecordForFire(cwd, 'gtm', 'sdr', 'fidlink');
    assert.ok(r, 'the evidence EXISTS');
    assert.equal(r.exitCode, null, 'a symlink is never followed to a parsed exit code');
  });
});

test('readEvidenceFileSync (round-7 finding 7): a regular file at the cap still reads fine', () => {
  withTmpCwd((cwd) => {
    const p = join(cwd, 'ok.txt');
    writeFileSync(p, 'x'.repeat(MAX_EVIDENCE_BYTES), 'utf8');
    const r = readEvidenceFileSync(p);
    assert.equal(r.state, 'ok');
    assert.equal((r as { content: string }).content.length, MAX_EVIDENCE_BYTES);
    assert.equal(readEvidenceFileSync(join(cwd, 'missing')).state, 'missing');
  });
});
