import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectStale,
  parseStateMd,
  readEvidenceFileSync,
  readStateMd,
  realEvidenceFs,
  findRecentRuns,
  findMostRecentRun,
  listScheduleRuns,
  writeScheduleRunId,
  MAX_EVIDENCE_BYTES,
  type EvidenceFs,
} from '../src/lib/schedule-state.ts';
import { ConflictError } from '../src/lib/persistence/contracts.ts';
import { ledgerFsSeams } from '../src/lib/persistence/local/ledger.ts';

// Orchestrator appends, so chronological order in the file means oldest line
// first, newest line last. parseStateMd preserves file order; findRecentRuns
// reverse-scans to yield reverse-chronological matches.
const SAMPLE = `2026-05-18T09:00:00Z | gtm/sdr/cold-outreach/acme | success
2026-05-18T10:20:00Z | ops/heartbeat-noop/noop/_demo | failed
2026-05-18T10:25:00Z | ops/heartbeat-noop/noop/_demo | success
2026-05-18T10:30:00Z | ops/heartbeat-noop/noop/_demo | success
`;

test('parseStateMd: parses well-formed lines', () => {
  const r = parseStateMd(SAMPLE);
  assert.equal(r.lines.length, 4);
  assert.equal(r.malformedCount, 0);
  assert.equal(r.lines[0]!.timestamp, '2026-05-18T09:00:00Z');
  assert.equal(r.lines[0]!.scope, 'gtm/sdr/cold-outreach/acme');
  assert.equal(r.lines[0]!.status, 'success');
  assert.equal(r.lines[1]!.status, 'failed');
  assert.equal(r.lines[3]!.timestamp, '2026-05-18T10:30:00Z');
});

test('parseStateMd: blank lines and comments are skipped (not malformed)', () => {
  const content = `# header comment
2026-05-18T10:00:00Z | ops/h/n/p | success

# another comment
2026-05-18T11:00:00Z | ops/h/n/p | failed
`;
  const r = parseStateMd(content);
  assert.equal(r.lines.length, 2);
  assert.equal(r.malformedCount, 0);
});

test('parseStateMd: malformed lines are counted, not crashed on', () => {
  const content = `2026-05-18T10:00:00Z | ops/h/n/p | success
garbage line with no pipes
2026-05-18T11:00:00Z | only two | parts
not-a-timestamp | ops/h/n/p | success
2026-05-18T12:00:00Z |  | success
2026-05-18T13:00:00Z | ops/h/n/p | failed
`;
  const r = parseStateMd(content);
  assert.equal(r.lines.length, 2);
  assert.equal(r.malformedCount, 4);
  assert.equal(r.lines[0]!.timestamp, '2026-05-18T10:00:00Z');
  assert.equal(r.lines[1]!.timestamp, '2026-05-18T13:00:00Z');
});

test('parseStateMd: empty content yields empty result', () => {
  const r = parseStateMd('');
  assert.deepEqual(r, { lines: [], malformedCount: 0 });
});

test('parseStateMd: forward-compat — unknown status passes through opaque', () => {
  const content = `2026-05-18T10:00:00Z | ops/h/n/p | timeout
2026-05-18T11:00:00Z | ops/h/n/p | partial-success
`;
  const r = parseStateMd(content);
  assert.equal(r.lines.length, 2);
  assert.equal(r.malformedCount, 0);
  assert.equal(r.lines[0]!.status, 'timeout');
  assert.equal(r.lines[1]!.status, 'partial-success');
});

test('parseStateMd: ISO-8601 requires Z suffix and second precision', () => {
  const content = `2026-05-18T10:00:00 | ops/h/n/p | success
2026-05-18T10:00:00+00:00 | ops/h/n/p | success
2026-05-18T10:00:00.123Z | ops/h/n/p | success
2026-05-18 10:00:00Z | ops/h/n/p | success
2026-05-18T10:00:00Z | ops/h/n/p | success
`;
  const r = parseStateMd(content);
  assert.equal(r.lines.length, 1);
  assert.equal(r.malformedCount, 4);
});

test('findRecentRuns: filters by function/agent/plan prefix, returns reverse-chronological', () => {
  const parsed = parseStateMd(SAMPLE);
  const ops = findRecentRuns(parsed.lines, 'ops', 'heartbeat-noop', 'noop', 10);
  assert.equal(ops.length, 3);
  assert.equal(ops[0]!.timestamp, '2026-05-18T10:30:00Z');
  assert.equal(ops[1]!.timestamp, '2026-05-18T10:25:00Z');
  assert.equal(ops[2]!.timestamp, '2026-05-18T10:20:00Z');

  const gtm = findRecentRuns(parsed.lines, 'gtm', 'sdr', 'cold-outreach', 10);
  assert.equal(gtm.length, 1);
  assert.equal(gtm[0]!.scope, 'gtm/sdr/cold-outreach/acme');
});

test('findRecentRuns: prefix anchors at trailing slash — partial plan names do not match', () => {
  const content = `2026-05-18T10:00:00Z | gtm/sdr/cold-outreach/acme | success
2026-05-18T11:00:00Z | gtm/sdr/cold/acme | success
`;
  const parsed = parseStateMd(content);
  const cold = findRecentRuns(parsed.lines, 'gtm', 'sdr', 'cold', 10);
  assert.equal(cold.length, 1);
  assert.equal(cold[0]!.scope, 'gtm/sdr/cold/acme');
});

test('findRecentRuns: honors limit', () => {
  const parsed = parseStateMd(SAMPLE);
  const r = findRecentRuns(parsed.lines, 'ops', 'heartbeat-noop', 'noop', 2);
  assert.equal(r.length, 2);
  assert.equal(r[0]!.timestamp, '2026-05-18T10:30:00Z');
  assert.equal(r[1]!.timestamp, '2026-05-18T10:25:00Z');
});

test('findMostRecentRun: returns undefined when no match', () => {
  const parsed = parseStateMd(SAMPLE);
  const r = findMostRecentRun(parsed.lines, 'nonexistent', 'a', 'p');
  assert.equal(r, undefined);
});

test('findMostRecentRun: returns most recent match', () => {
  const parsed = parseStateMd(SAMPLE);
  const r = findMostRecentRun(parsed.lines, 'ops', 'heartbeat-noop', 'noop');
  assert.ok(r);
  assert.equal(r!.timestamp, '2026-05-18T10:30:00Z');
  assert.equal(r!.status, 'success');
});

test('readStateMd: missing file returns empty result', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'state-md-'));
  try {
    const r = readStateMd(join(tmp, 'nonexistent.md'), tmp);
    assert.deepEqual(r, { lines: [], malformedCount: 0 });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readStateMd: reads and parses existing file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'state-md-'));
  try {
    const p = join(tmp, 'state.md');
    writeFileSync(p, SAMPLE, 'utf8');
    const r = readStateMd(p, tmp);
    assert.equal(r.lines.length, 4);
    assert.equal(r.malformedCount, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── round-6 findings 5+9: the per-fire sidecar is CREATE-ONLY ──────────────
//
// A replacing atomic write let a repeated fire id silently REBIND the sidecar
// to another run (and even a same-run replay rewrote firedAt, changing the
// staleness anchor). The writer now creates O_EXCL via the ledger's shared
// hardened core; an existing sidecar is compared, never overwritten.

test('writeScheduleRunId (round-6 finding 5): a same-binding replay is an idempotent no-op — firedAt is NOT rewritten', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-sidecar-replay-'));
  try {
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidX', 1_000);
    // The retry carries a NEW timestamp (a crashed `run start` re-run) — it must
    // succeed silently and keep the ORIGINAL firedAt.
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidX', 9_999);
    const runs = listScheduleRuns(cwd, 'gtm', 'sdr');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.runId, 'run-A');
    assert.equal(runs[0]!.firedAt, 1_000, 'the staleness anchor keeps its first-write value');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeScheduleRunId (round-6 finding 5): a DIFFERENT run id on the same fire id is a ConflictError — no rebind, no overwrite', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-sidecar-rebind-'));
  try {
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidX', 1_000);
    assert.throws(
      () => writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-B', 'fidX', 2_000),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.match(err.message, /run-A/, 'the error names the existing binding');
        assert.match(err.message, /run-B/, 'and the refused one');
        return true;
      },
    );
    const runs = listScheduleRuns(cwd, 'gtm', 'sdr');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.runId, 'run-A', 'the original binding survives');
    assert.equal(runs[0]!.firedAt, 1_000);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeScheduleRunId (round-6 finding 9): a symlink planted at the sidecar path is never written through', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-sidecar-symlink-'));
  try {
    // Materialize the channel dir via a legitimate write, then plant.
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidA', 1_000);
    const victim = join(cwd, 'victim.txt');
    writeFileSync(victim, 'precious');
    symlinkSync(victim, join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'evil.run-id'));
    assert.throws(() => writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-X', 'evil', 2_000), ConflictError);
    assert.equal(readFileSync(victim, 'utf8'), 'precious', 'the symlink target is never truncated');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── round-7 finding 3: the (fireId → runId) mapping is CREATE-ONCE even under a
// concurrent create ─────────────────────────────────────────────────────────
//
// The create-only writer published with rename(2), which REPLACES. Two starts
// racing on one fire id both passed the pre-write existence check and the later
// rename silently rebound the sidecar to the second run — the first run's
// `<fireId>.exit` would then close the WRONG run and the first stayed 'running'
// forever. Publishing with link(2) makes the create atomic: the loser gets
// EEXIST and is arbitrated by content (identical binding = no-op, different run
// = ConflictError).

test('writeScheduleRunId (round-7 finding 3): a sidecar that appears DURING the write cannot rebind the fire — ConflictError, original intact', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-sidecar-race-'));
  const realLink = ledgerFsSeams.linkRaw;
  try {
    const sidecar = join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'fidX.run-id');
    // Simulate the concurrent winner: run A's sidecar lands after this write's
    // existence check but before it publishes.
    ledgerFsSeams.linkRaw = (from: string, to: string) => {
      writeFileSync(sidecar, JSON.stringify({ runId: 'run-A', firedAt: 1_000, fireId: 'fidX' }) + '\n');
      realLink(from, to);
    };
    assert.throws(
      () => writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-B', 'fidX', 2_000),
      (err: unknown) => {
        assert.ok(err instanceof ConflictError);
        assert.match(err.message, /run-A/);
        assert.match(err.message, /run-B/);
        return true;
      },
    );
    ledgerFsSeams.linkRaw = realLink;
    const runs = listScheduleRuns(cwd, 'gtm', 'sdr');
    assert.deepEqual(runs.map((r) => r.runId), ['run-A'], 'the winner keeps the fire id');
    assert.equal(runs[0]!.firedAt, 1_000);
    assert.equal(
      readdirSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr')).filter((f) => f.startsWith('.tmp-')).length,
      0,
      'the loser leaves no staging file behind',
    );
  } finally {
    ledgerFsSeams.linkRaw = realLink;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('writeScheduleRunId (round-7 finding 3): an IDENTICAL binding racing itself stays idempotent (no false conflict)', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-sidecar-race-idem-'));
  const realLink = ledgerFsSeams.linkRaw;
  try {
    const sidecar = join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'fidX.run-id');
    ledgerFsSeams.linkRaw = (from: string, to: string) => {
      writeFileSync(sidecar, JSON.stringify({ runId: 'run-A', firedAt: 1_000, fireId: 'fidX' }) + '\n');
      realLink(from, to);
    };
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidX', 7_777);
    ledgerFsSeams.linkRaw = realLink;
    const runs = listScheduleRuns(cwd, 'gtm', 'sdr');
    assert.deepEqual(runs.map((r) => r.runId), ['run-A']);
    assert.equal(runs[0]!.firedAt, 1_000, 'the first write owns the staleness anchor');
  } finally {
    ledgerFsSeams.linkRaw = realLink;
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── round-7 finding 7: the sidecar read is hardened — a hostile shape never
// hangs or hijacks the scan ─────────────────────────────────────────────────

test('listScheduleRuns (round-7 finding 7): a FIFO planted as a sidecar is skipped without blocking; real sidecars still list', { timeout: 5000, skip: process.platform === 'win32' }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-sidecar-fifo-'));
  try {
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidA', 1_000);
    const fifo = join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'evilfifo.run-id');
    const mk = spawnSync('mkfifo', [fifo]);
    assert.equal(mk.status, 0, 'mkfifo available on POSIX');
    // Pre-fix: readFileSync on the FIFO blocks forever → this test trips its
    // timeout. Post-fix the scan classifies it malformed and moves on.
    const runs = listScheduleRuns(cwd, 'gtm', 'sdr');
    assert.equal(runs.length, 1, 'the FIFO is skipped as malformed, not read');
    assert.equal(runs[0]!.runId, 'run-A');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('listScheduleRuns (round-7 finding 7): a symlinked sidecar is never followed', { skip: process.platform === 'win32' }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-sidecar-link-'));
  try {
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidA', 1_000);
    const target = join(cwd, 'somewhere-else.json');
    writeFileSync(target, JSON.stringify({ runId: 'run-EVIL', firedAt: 5, fireId: 'evil' }));
    symlinkSync(target, join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'evil.run-id'));
    const runs = listScheduleRuns(cwd, 'gtm', 'sdr');
    assert.deepEqual(runs.map((r) => r.runId), ['run-A'], 'the symlink is refused (O_NOFOLLOW), never parsed');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── round-8 finding 1 sweep: every agent-writable evidence read is hardened ──
//
// state.md is the agent's own self-report. A FIFO planted there used to block
// readStateMd forever (wedging doctor, pending sync, and `schedule list`); a
// symlink diverted it. Both now read as malformed — reported, never followed.

test(
  'readStateMd (round-8 finding 1 sweep): a FIFO planted at state.md is malformed, not a hang',
  { timeout: 5000, skip: process.platform === 'win32' ? 'POSIX only' : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'roster-statemd-fifo-'));
    try {
      const path = join(dir, 'state.md');
      const mk = spawnSync('mkfifo', [path]);
      assert.equal(mk.status, 0, 'mkfifo available on POSIX');
      const res = readStateMd(path, dir);
      assert.deepEqual(res.lines, [], 'no lines from a non-regular file');
      assert.equal(res.malformedCount, 1, 'and the hostile shape is REPORTED, not silently empty');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'readStateMd (round-8 finding 1 sweep): a SYMLINK at state.md is refused, not followed',
  { timeout: 5000, skip: process.platform === 'win32' ? 'POSIX only' : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'roster-statemd-link-'));
    try {
      const victim = join(dir, 'victim.md');
      writeFileSync(victim, SAMPLE);
      const path = join(dir, 'state.md');
      symlinkSync(victim, path);
      const res = readStateMd(path, dir);
      assert.deepEqual(res.lines, [], 'the symlink target is never parsed as this function state');
      assert.equal(res.malformedCount, 1);
      // A real regular file at the same path still parses normally.
      rmSync(path);
      writeFileSync(path, SAMPLE);
      assert.equal(readStateMd(path, dir).lines.length, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── round-9 finding 3: a concurrent append must never TEAR a complete line ───
//
// state.md is append-only and its readers (doctor's stale check, pending sync,
// the SessionStart banner) run while the orchestrator is appending. The reader
// allocated `fstat.size + 1` and did ONE read, so a line appended between the
// fstat and the read landed exactly ONE BYTE inside the buffer: a complete,
// valid latest-run line came back truncated, parsed as MALFORMED, and left the
// most recent parsed run pointing at the older line — a false STALE warning for
// a schedule that had just reported success.

function isoSecond(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

test('readStateMd (round-9 finding 3): a line appended between fstat and read is read WHOLE — no torn line, no false stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-statemd-torn-'));
  try {
    const path = join(dir, 'state.md');
    const now = new Date();
    const old = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
    const scope = 'gtm/sdr/cold-outreach/acme';
    writeFileSync(path, `${isoSecond(old)} | ${scope} | success\n`, 'utf8');
    const freshLine = `${isoSecond(now)} | ${scope} | success\n`;

    // The seam reproduces the race deterministically: the append lands AFTER
    // the reader has sized the file and BEFORE it reads a byte.
    let appended = false;
    const racingFs: EvidenceFs = {
      ...realEvidenceFs,
      fstatSync: ((fd: number) => {
        const st = realEvidenceFs.fstatSync(fd);
        if (!appended) {
          appended = true;
          appendFileSync(path, freshLine, 'utf8');
        }
        return st;
      }) as typeof realEvidenceFs.fstatSync,
    };

    const res = readStateMd(path, dir, racingFs);
    assert.equal(appended, true, 'the race must actually have been injected');
    assert.equal(res.malformedCount, 0, 'a complete appended line is never counted malformed');
    assert.equal(res.lines.length, 2, 'the reader sees a consistent, non-truncated view');
    assert.equal(res.lines[1]!.raw, freshLine.trimEnd(), 'the appended line arrives WHOLE, not one byte of it');

    const latest = findMostRecentRun(res.lines, 'gtm', 'sdr', 'cold-outreach');
    assert.equal(latest?.timestamp, isoSecond(now));
    const verdict = detectStale({
      cronExpr: '0 9 * * *',
      lastRun: latest,
      lastFireMtimeMs: undefined,
      now,
      graceMinutes: 120,
    });
    assert.equal(verdict.stale, false, 'the just-reported run must not read as STALE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEvidenceFileSync (round-9 finding 3): growth past the cap between fstat and read is still OVERSIZED, never unbounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-evidence-growth-'));
  try {
    const path = join(dir, 'fire.exit');
    writeFileSync(path, '0\n', 'utf8');
    let grown = false;
    const racingFs: EvidenceFs = {
      ...realEvidenceFs,
      fstatSync: ((fd: number) => {
        const st = realEvidenceFs.fstatSync(fd);
        if (!grown) {
          grown = true;
          appendFileSync(path, 'x'.repeat(MAX_EVIDENCE_BYTES * 2), 'utf8');
        }
        return st;
      }) as typeof realEvidenceFs.fstatSync,
    };
    const read = readEvidenceFileSync(path, MAX_EVIDENCE_BYTES, racingFs);
    assert.equal(read.state, 'malformed');
    assert.equal(read.state === 'malformed' ? read.reason : '', 'oversized');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
