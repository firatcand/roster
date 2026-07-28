import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acknowledgePendingId,
  acknowledgedPathFor,
  correlateFailedFires,
  countErrorPending,
  syncPending,
} from '../src/lib/pending-sync.ts';
import { rejectItem } from '../src/lib/pending-apply.ts';
import { executePendingSync } from '../src/commands/pending-sync.ts';
import { runSetup } from '../src/lib/persistence/setup.ts';
import { resolveOpsBackend } from '../src/lib/persistence/resolve.ts';
import { exitDirFor, exitPathForFire } from '../src/lib/cron-exit-log.ts';
import { writeScheduleRunId, listScheduleRuns } from '../src/lib/schedule-state.ts';
import type { RunEventEnvelope, RunEventInput, RunStore, WriteOutcome } from '../src/lib/persistence/contracts.ts';

function withTmpCwd<T>(fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-pendingsync-'));
  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Helper: write a valid via-cron codex schedule. attestation is required by
// the schema for tool=codex.
function writeSchedules(cwd: string, fn: string, entries: Array<{
  name: string;
  agent: string;
  plan: string;
  cron?: string;
  install_mode?: 'via-cron' | 'ui-handoff';
}>) {
  const fnDir = join(cwd, 'roster', fn);
  mkdirSync(fnDir, { recursive: true });
  const schedules = entries.map((e) => ({
    name: e.name,
    agent: e.agent,
    plan: e.plan,
    cron: e.cron ?? '0 9 * * 1-5',
    tool: 'codex',
    install_mode: e.install_mode ?? 'via-cron',
    status: e.install_mode === 'ui-handoff' ? 'pending-ui-install' : 'installed',
    subscription_attestation: { auth_mode: 'chatgpt', env_policy: 'cleared', codex_home: '/Users/x/.codex' },
  }));
  // YAML-ish; safe shape.
  const lines = ['version: 1', 'schedules:'];
  for (const s of schedules) {
    lines.push(`  - name: ${s.name}`);
    lines.push(`    agent: ${s.agent}`);
    lines.push(`    plan: ${s.plan}`);
    lines.push(`    cron: '${s.cron}'`);
    lines.push(`    tool: ${s.tool}`);
    lines.push(`    install_mode: ${s.install_mode}`);
    lines.push(`    status: ${s.status}`);
    lines.push(`    subscription_attestation:`);
    lines.push(`      auth_mode: chatgpt`);
    lines.push(`      env_policy: cleared`);
    lines.push(`      codex_home: ${s.subscription_attestation.codex_home}`);
  }
  writeFileSync(join(fnDir, 'schedules.yaml'), lines.join('\n') + '\n', 'utf8');
}

// Per-fire, function-scoped exit file (round-5): logs/cron/<fn>/<name>/<fireId>.exit
function writeExit(
  cwd: string,
  fn: string,
  name: string,
  exitCode: string,
  mtimeUtc: Date | undefined = undefined,
  fireId = 'fire0',
) {
  mkdirSync(exitDirFor(cwd, fn, name), { recursive: true });
  const p = exitPathForFire(cwd, fn, name, fireId);
  writeFileSync(p, exitCode, 'utf8');
  if (mtimeUtc !== undefined) {
    const sec = mtimeUtc.getTime() / 1000;
    utimesSync(p, sec, sec);
  }
}

function writeState(cwd: string, fn: string, line: string) {
  const fnDir = join(cwd, 'roster', fn);
  mkdirSync(fnDir, { recursive: true });
  const path = join(fnDir, 'state.md');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  writeFileSync(path, existing + line + '\n', 'utf8');
}

// ── basic behaviors ───────────────────────────────────────────────────────

test('syncPending: empty workspace → inspected=0, nothing written', () => {
  withTmpCwd((cwd) => {
    const r = syncPending({ cwd });
    assert.equal(r.inspected, 0);
    assert.equal(r.written.length, 0);
    assert.equal(r.skipped.length, 0);
  });
});

test('syncPending: schedule with no signals → inspected, nothing written', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const r = syncPending({ cwd });
    assert.equal(r.inspected, 1);
    assert.equal(r.written.length, 0);
  });
});

// ── failed-exit signal ────────────────────────────────────────────────────

test('syncPending: non-zero exit → writes pending/error-<id>.md (failed-exit)', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '137');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 1);
    assert.equal(r.written[0]!.reason, 'failed-exit');
    assert.equal(r.written[0]!.scheduleName, 'sdr');
    assert.ok(existsSync(r.written[0]!.path));
    const body = readFileSync(r.written[0]!.path, 'utf8');
    assert.match(body, /exit_code: 137/);
    assert.match(body, /type: scheduled-fire-failure/);
    assert.match(body, /Retry/);
  });
});

test('syncPending: zero exit → not surfaced (no failure)', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '0');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 0);
  });
});

test('syncPending (round-7 finding 9): malformed .exit (non-numeric) IS surfaced as failure evidence with a distinct malformed-exit reason', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', 'oops');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 1, 'present-but-unreadable evidence must not pass as a clean run');
    assert.equal(r.written[0]!.reason, 'malformed-exit');
    const body = readFileSync(r.written[0]!.path, 'utf8');
    assert.match(body, /signal: malformed-exit/);
    assert.match(body, /exit_code: <malformed>/);
    assert.match(body, /type: scheduled-fire-failure/);
  });
});

test('syncPending (round-7 finding 9): an EMPTY .exit (zero-length) → malformed-exit error item created', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 1);
    assert.equal(r.written[0]!.reason, 'malformed-exit');
    assert.ok(existsSync(r.written[0]!.path));
  });
});

test('syncPending: idempotent on re-run — same fire → skip-if-exists', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '1', new Date('2026-05-18T09:00:00Z'), 'fireA');

    const first = syncPending({ cwd });
    assert.equal(first.written.length, 1);

    // Same fire id → same pending id → re-sync should skip, not re-write.
    const second = syncPending({ cwd });
    assert.equal(second.written.length, 0);
    assert.equal(second.skipped.length, 1);
    assert.equal(second.skipped[0]!.reason, 'already-exists');
  });
});

test('syncPending: distinct per-fire exits → distinct ids → both surface (finding 1)', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    // Two overlapping fires each write their OWN `<fireId>.exit` — neither clobbers
    // the other, so both failures surface (the old single-file scheme lost one).
    writeExit(cwd, 'gtm', 'sdr', '1', new Date('2026-05-18T09:00:00Z'), 'fireA');
    writeExit(cwd, 'gtm', 'sdr', '1', new Date('2026-05-19T09:00:00Z'), 'fireB');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 2, 'each per-fire exit surfaces as its own error item');
    assert.notEqual(r.written[0]!.path, r.written[1]!.path, 'distinct ids per fire');
  });
});

// ── dry-run ──────────────────────────────────────────────────────────────

test('syncPending: --dry-run reports what would be written but does not write', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '1');
    const r = syncPending({ cwd, dryRun: true });
    assert.equal(r.written.length, 1);
    assert.ok(!existsSync(r.written[0]!.path), 'no actual file in dry-run');
  });
});

// ── stale signal ─────────────────────────────────────────────────────────

test('syncPending: stale last_run (cutoff passed, no .exit) → writes stale pending', () => {
  withTmpCwd((cwd) => {
    // Daily 9am cron. Last run on Friday. now=Monday 12pm. cutoff=11am Mon.
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', cron: '0 9 * * 1-5' }]);
    writeState(cwd, 'gtm', '2026-05-15T09:05:00Z | gtm/sdr/cold/_demo | success');
    const r = syncPending({ cwd, now: new Date('2026-05-18T12:00:00Z') });
    assert.equal(r.written.length, 1);
    assert.equal(r.written[0]!.reason, 'stale');
    const body = readFileSync(r.written[0]!.path, 'utf8');
    assert.match(body, /type: scheduled-fire-stale/);
    assert.match(body, /expected_before:/);
  });
});

test('syncPending: stale + .exit recent → not stale (recent-fire absorbs)', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', cron: '0 9 * * 1-5' }]);
    writeState(cwd, 'gtm', '2026-05-15T09:05:00Z | gtm/sdr/cold/_demo | success');
    // Wrapper ran Mon 09:00; .exit shows zero (so no failed-exit). State.md
    // is still old (agent didn't append) — recent-fire absorbs without
    // surfacing STALE, on the theory that the next fire's success will
    // restore freshness.
    writeExit(cwd, 'gtm', 'sdr', '0', new Date('2026-05-18T09:00:00Z'));
    const r = syncPending({ cwd, now: new Date('2026-05-18T12:00:00Z') });
    assert.equal(r.written.length, 0);
  });
});

// ── countErrorPending ────────────────────────────────────────────────────

test('countErrorPending: counts error-<id>.md across all function dirs', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeSchedules(cwd, 'design', [{ name: 'crit', agent: 'critic', plan: 'review' }]);
    writeExit(cwd, 'gtm', 'sdr', '1');
    writeExit(cwd, 'design', 'crit', '2');
    syncPending({ cwd });
    assert.equal(countErrorPending(cwd), 2);
  });
});

test('countErrorPending: ignores non-error pending items (e.g., manual handoffs)', () => {
  withTmpCwd((cwd) => {
    const pdir = join(cwd, 'roster', 'gtm', 'pending');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, 'manual-followup.md'), '# tbd', 'utf8');
    writeFileSync(join(pdir, 'error-aabbccdd.md'), '# err', 'utf8');
    assert.equal(countErrorPending(cwd), 1);
  });
});

// ── stability ────────────────────────────────────────────────────────────

test('syncPending: ui-handoff codex schedule → no .exit channel (skip failed-exit)', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', install_mode: 'ui-handoff' }]);
    // Even if a .exit exists at the conventional path, we don't read it for
    // ui-handoff (there's no wrapper-installed cron line for it).
    writeExit(cwd, 'gtm', 'sdr', '1');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 0);
    assert.equal(r.inspected, 1);
  });
});

test('syncPending: malformed schedules.yaml is skipped silently', () => {
  withTmpCwd((cwd) => {
    const fnDir = join(cwd, 'roster', 'gtm');
    mkdirSync(fnDir, { recursive: true });
    writeFileSync(join(fnDir, 'schedules.yaml'), 'this is not yaml: : :\n', 'utf8');
    const r = syncPending({ cwd });
    assert.equal(r.inspected, 0);
    assert.equal(r.written.length, 0);
  });
});

// ── multi-schedule fairness ──────────────────────────────────────────────

test('syncPending: failure in one schedule does not skip another', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [
      { name: 'sdr', agent: 'sdr', plan: 'cold' },
      { name: 'bdr', agent: 'bdr', plan: 'warm' },
    ]);
    writeExit(cwd, 'gtm', 'sdr', '137');
    writeExit(cwd, 'gtm', 'bdr', '0');
    const r = syncPending({ cwd });
    assert.equal(r.written.length, 1);
    assert.equal(r.written[0]!.scheduleName, 'sdr');
  });
});

// ── filename shape ───────────────────────────────────────────────────────

test('syncPending: written file matches pending/error-<8 hex>.md', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '1');
    syncPending({ cwd });
    const files = readdirSync(join(cwd, 'roster', 'gtm', 'pending'));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^error-[a-f0-9]{8}\.md$/);
  });
});

// ── ledger correlation of failed/stale fires (finding: correlation is doc-only) ─

// A minimal RunStore that records the events correlateFailedFires appends. It is
// the only surface the correlation touches — no live backend needed.
class RecordingRunStore implements RunStore {
  readonly appended: RunEventInput[] = [];
  // Configurable getRun result: the guard against reopening an already-ended run
  // (finding 8) reads this. Defaults to null (no recorded run).
  getRunResult: { runId: string; events: RunEventEnvelope[] } | null = null;
  async appendEvent(input: RunEventInput): Promise<WriteOutcome> {
    this.appended.push(input);
    return { outcome: 'committed', id: `id-${this.appended.length}` };
  }
  async getRun() { return this.getRunResult; }
  async listRuns() { return { items: [], cursor: null, partial: false }; }
  async count() { return { committed: 0, queued: 0, partial: false }; }
}

function endedRun(runId: string): { runId: string; events: RunEventEnvelope[] } {
  const end = {
    id: 'e-end',
    workspaceId: 'ws',
    runId,
    kind: 'run-end',
    dedupeKey: 'end',
    data: null,
    agent: null,
    skill: null,
    trigger: null,
    parentRunId: null,
    originTaskId: null,
    correlationId: null,
    source: 'cli',
    pid: null,
    startedAt: null,
    endedAt: 1,
    sanitizedReport: null,
    createdAt: 1,
    seq: 1,
    queued: false,
  } as RunEventEnvelope;
  return { runId, events: [end] };
}

test('per-fire sidecar round-trips via listScheduleRuns (function-scoped)', () => {
  withTmpCwd((cwd) => {
    assert.deepEqual(listScheduleRuns(cwd, 'gtm', 'sdr'), []);
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-abc', 'fidA', 1000);
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-def', 'fidB', 2000);
    const runs = listScheduleRuns(cwd, 'gtm', 'sdr').sort((a, b) => a.firedAt - b.firedAt);
    assert.equal(runs.length, 2, 'both per-fire sidecars coexist (no overwrite)');
    assert.deepEqual(runs.map((r) => r.fireId), ['fidA', 'fidB']);
    assert.equal(runs[0]!.runId, 'run-abc');
    assert.equal(runs[0]!.firedAt, 1000);
    // Cross-function isolation (finding 2): a same-named schedule under another
    // function has its own channel.
    assert.deepEqual(listScheduleRuns(cwd, 'ops', 'sdr'), []);
  });
});

// withTmpCwd is synchronous (its finally rmSyncs before an async body resolves),
// so async tests manage the tmp dir manually.
async function withAsyncTmpCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-correlate-'));
  try {
    await fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('correlateFailedFires: a per-fire non-zero exit emits a correlated error + run-end (idempotent)', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const firedAt = Date.now() - 3_600_000;
    // The fire's sidecar AND its crash `.exit` share the SAME fire id (the wrapper
    // minted it and `run start` recorded it) — an EXACT pairing, no timestamp guess.
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-crashed-123', 'fidX', firedAt);
    writeExit(cwd, 'gtm', 'sdr', '137', new Date(firedAt + 60_000), 'fidX');
    const runs = new RecordingRunStore();

    const out = await correlateFailedFires({ cwd, runs });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.runId, 'run-crashed-123');
    assert.equal(out[0]!.reason, 'failed-exit');
    assert.equal(out[0]!.fireId, 'fidX');

    const error = runs.appended.find((e) => e.kind === 'error');
    const end = runs.appended.find((e) => e.kind === 'run-end');
    assert.ok(error, 'an error event is emitted');
    assert.equal(error!.runId, 'run-crashed-123');
    assert.equal(error!.correlationId, 'sched-error-fidX', 'the fire id IS the deterministic correlation id');
    assert.ok(end, 'a run-end closes the otherwise-forever-running run');
    assert.equal(end!.runId, 'run-crashed-123');

    // Idempotent: a second sync yields the SAME sealed correlation id.
    const out2 = await correlateFailedFires({ cwd, runs });
    assert.equal(out2.length, 1);
    assert.equal(out2[0]!.correlationId, out[0]!.correlationId, 'deterministic correlation id');
  });
});

test('correlateFailedFires (finding 1): overlapping fires — A exit closes A, NEVER the still-running B', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const t0 = Date.now() - 3_600_000;
    // Fire A @09:00, Fire B @09:05 — both still running (no run-end). A crashes
    // @09:10. The OLD shared-`.exit` scheme would attribute A's late exit to the
    // still-running B (09:10 >= B.firedAt). With per-fire ids A's `<fidA>.exit`
    // pairs ONLY with A's `<fidA>.run-id`.
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidA', t0);
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-B', 'fidB', t0 + 5 * 60_000);
    writeExit(cwd, 'gtm', 'sdr', '137', new Date(t0 + 10 * 60_000), 'fidA'); // only A exited
    const runs = new RecordingRunStore(); // getRun → null (neither ended)

    const out = await correlateFailedFires({ cwd, runs });
    assert.equal(out.length, 1, 'only fire A correlates');
    assert.equal(out[0]!.runId, 'run-A');
    assert.equal(out[0]!.fireId, 'fidA');
    assert.ok(runs.appended.every((e) => e.runId === 'run-A'), 'the still-running B is NEVER touched');
    assert.ok(runs.appended.some((e) => e.kind === 'run-end' && e.runId === 'run-A'));
  });
});

test('correlateFailedFires (finding 2): same-named schedules across functions do not cross-correlate', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'nightly', agent: 'sdr', plan: 'cold' }]);
    writeSchedules(cwd, 'ops', [{ name: 'nightly', agent: 'ops', plan: 'sweep' }]);
    const firedAt = Date.now() - 3_600_000;
    // gtm/nightly crashed; ops/nightly is fine (zero exit).
    writeScheduleRunId(cwd, 'gtm', 'nightly', 'run-gtm', 'g1', firedAt);
    writeExit(cwd, 'gtm', 'nightly', '137', new Date(firedAt + 60_000), 'g1');
    writeScheduleRunId(cwd, 'ops', 'nightly', 'run-ops', 'o1', firedAt);
    writeExit(cwd, 'ops', 'nightly', '0', new Date(firedAt + 60_000), 'o1');
    const runs = new RecordingRunStore();

    const out = await correlateFailedFires({ cwd, runs });
    assert.equal(out.length, 1, "only gtm/nightly's crash correlates");
    assert.equal(out[0]!.runId, 'run-gtm');
    assert.ok(runs.appended.every((e) => e.runId === 'run-gtm'), "ops/nightly's run is untouched");
  });
});

test('correlateFailedFires: no recorded fire → nothing to correlate', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '1'); // an exit with no matching run-id sidecar
    const runs = new RecordingRunStore();
    const out = await correlateFailedFires({ cwd, runs });
    assert.equal(out.length, 0);
    assert.equal(runs.appended.length, 0);
  });
});

test('executePendingSync (finding 7): the command correlates a crashed scheduled fire into the run ledger', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    await runSetup({ cwd, backend: 'local', name: 'acme' });
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const firedAt = Date.now() - 3_600_000;
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-crashed-7', 'fidI', firedAt);
    writeExit(cwd, 'gtm', 'sdr', '137', new Date(firedAt + 60_000), 'fidI'); // crashed

    const code = await executePendingSync({ cwd, silent: true, json: false, dryRun: false });
    assert.equal(code, 0);

    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'local');
    if (resolved.state !== 'local') return;
    const run = await resolved.backend.runs.getRun('run-crashed-7');
    assert.ok(run, 'the crashed run now exists in the ledger (was left running forever before)');
    assert.ok(run!.events.some((e) => e.kind === 'error'), 'a correlated error event was appended');
    assert.ok(run!.events.some((e) => e.kind === 'run-end'), 'a run-end closes the crashed run');
  });
});

test('executePendingSync (finding 7): a --dry-run does NOT mutate the run ledger', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    await runSetup({ cwd, backend: 'local', name: 'acme' });
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const firedAt = Date.now() - 3_600_000;
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-dry', 'fidD', firedAt);
    writeExit(cwd, 'gtm', 'sdr', '137', new Date(firedAt + 60_000), 'fidD');
    await executePendingSync({ cwd, silent: true, json: false, dryRun: true });
    const resolved = await resolveOpsBackend(cwd);
    if (resolved.state !== 'local') return;
    assert.equal(await resolved.backend.runs.getRun('run-dry'), null, 'dry-run correlates nothing');
  });
});

// An ACTIVE run: a run-start with NO run-end (the fire is still running).
function startedRun(runId: string): { runId: string; events: RunEventEnvelope[] } {
  const base = endedRun(runId).events[0]!;
  const start = { ...base, id: 'e-start', kind: 'run-start', dedupeKey: 'start', endedAt: null } as RunEventEnvelope;
  return { runId, events: [start] };
}

test("correlateFailedFires: a fire's own crash exit correlates to its run", async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const firedAt = Date.now() - 3_600_000;
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidA', firedAt);
    writeExit(cwd, 'gtm', 'sdr', '137', new Date(firedAt + 60_000), 'fidA');
    const runs = new RecordingRunStore();
    runs.getRunResult = startedRun('run-A');

    const out = await correlateFailedFires({ cwd, runs });
    assert.equal(out.length, 1, "A's own crash exit correlates");
    assert.equal(out[0]!.runId, 'run-A');
    assert.ok(runs.appended.some((e) => e.kind === 'run-end'), 'the crashed run is closed');
  });
});

test('correlateFailedFires (finding 1c): a legacy single-file sidecar (old layout) is not discovered → skipped', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    // The OLD single-file layout wrote logs/cron/sdr.run-id (not function-scoped,
    // not per-fire). The new scanner looks in logs/cron/<fn>/<name>/, so a legacy
    // sidecar is never listed — non-correlatable by construction.
    mkdirSync(join(cwd, 'logs', 'cron'), { recursive: true });
    writeFileSync(
      join(cwd, 'logs', 'cron', 'sdr.run-id'),
      JSON.stringify({ runId: 'run-legacy', firedAt: Date.now() }) + '\n',
      'utf8',
    );
    writeExit(cwd, 'gtm', 'sdr', '137'); // a fresh nonzero exit that WOULD tempt correlation
    const runs = new RecordingRunStore();
    const out = await correlateFailedFires({ cwd, runs });
    assert.equal(out.length, 0, 'a legacy single-file sidecar is skipped');
    assert.equal(runs.appended.length, 0, 'nothing is attributed to a non-correlatable sidecar');
  });
});

test('correlateFailedFires (round-6 finding 2): a sidecar whose OWN window has passed (no exit, no run-end) correlates as stale', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', cron: '0 9 * * 1-5' }]);
    // The recorded fire is Monday 09:00. ITS OWN deadline is the next expected
    // fire (Tue 09:00) + 2h grace = Tue 11:00. At Tue 12:00 with no exit file and
    // no run-end, the fire has vanished → closable.
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-stale', 'fidS', Date.parse('2026-05-18T09:00:00Z'));
    const runs = new RecordingRunStore(); // getRunResult=null → not already ended
    const out = await correlateFailedFires({ cwd, runs, now: new Date('2026-05-19T12:00:00Z') });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.reason, 'stale');
    assert.equal(out[0]!.runId, 'run-stale');
    assert.equal(out[0]!.correlationId, 'sched-stale-fidS', 'per-fire deterministic correlation id');
    assert.ok(runs.appended.some((e) => e.kind === 'run-end'), 'the stale run is closed');
  });
});

test('correlateFailedFires (round-6 finding 2): a fire still inside its OWN window is NOT reported stale', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', cron: '0 9 * * 1-5' }]);
    // The fire fired Mon 11:30; its own deadline is Tue 09:00 + grace. At Mon
    // 12:00 it is squarely inside its window — never its own staleness.
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-fresh', 'fidF', Date.parse('2026-05-18T11:30:00Z'));
    const runs = new RecordingRunStore();
    const out = await correlateFailedFires({ cwd, runs, now: new Date('2026-05-18T12:00:00Z') });
    assert.equal(out.length, 0, 'a fire inside its own window is not stale');
    assert.equal(runs.appended.length, 0);
  });
});

test('correlateFailedFires (round-6 finding 2): overlapping sidecars — ONLY the older stale one is closed, never the fresh one as a proxy', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', cron: '0 9 * * 1-5' }]);
    // Fire A (Mon 09:00) vanished — no exit file, no run-end. Fire B (Tue 09:00)
    // is FRESH and still running. The old schedule-level rule picked the LATEST
    // sidecar (B) as the staleness proxy and closed the fresh run — which later
    // conflicted with B's real `run end`. Per-sidecar evaluation closes A only.
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-A', 'fidA', Date.parse('2026-05-18T09:00:00Z'));
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-B', 'fidB', Date.parse('2026-05-19T09:00:00Z'));
    const runs = new RecordingRunStore();
    // Tue 12:00: A's deadline (Tue 09:00 + 2h grace) has passed; B's (Wed 09:00
    // + grace) has not.
    const out = await correlateFailedFires({ cwd, runs, now: new Date('2026-05-19T12:00:00Z') });
    assert.equal(out.length, 1, 'exactly one sidecar is closable');
    assert.equal(out[0]!.runId, 'run-A', 'the STALE fire is closed');
    assert.equal(out[0]!.fireId, 'fidA');
    assert.ok(runs.appended.every((e) => e.runId === 'run-A'), 'the fresh, still-running B is NEVER touched');
  });
});

test('correlateFailedFires (round-6 finding 2): a sidecar with a ZERO exit file is never closed as stale (its wrapper reported)', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', cron: '0 9 * * 1-5' }]);
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-done', 'fidZ', Date.parse('2026-05-18T09:00:00Z'));
    writeExit(cwd, 'gtm', 'sdr', '0', new Date('2026-05-18T09:30:00Z'), 'fidZ');
    const runs = new RecordingRunStore();
    const out = await correlateFailedFires({ cwd, runs, now: new Date('2026-05-19T12:00:00Z') });
    assert.equal(out.length, 0, 'an exit-reported fire is not a vanished fire');
    assert.equal(runs.appended.length, 0);
  });
});

test('correlateFailedFires (finding 8): a signal does NOT reopen a previously-ended run', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const firedAt = Date.now() - 3_600_000;
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-completed', 'fidC', firedAt);
    writeExit(cwd, 'gtm', 'sdr', '1', new Date(firedAt + 60_000), 'fidC');
    const runs = new RecordingRunStore();
    // The recorded run already has a run-end (it completed successfully earlier).
    runs.getRunResult = endedRun('run-completed');

    const out = await correlateFailedFires({ cwd, runs });
    assert.equal(out.length, 0, 'a completed run is never reopened');
    assert.equal(runs.appended.length, 0, 'no error/run-end appended to the previously-ended run');
  });
});

// ── round-7 finding 8: durable skip via acknowledgement sentinel ─────────────

test('syncPending (round-7 finding 8): a plain rm alone is NOT durable — the item is re-created from the immutable evidence', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '137', undefined, 'fireR');
    const first = syncPending({ cwd });
    assert.equal(first.written.length, 1);
    rmSync(first.written[0]!.path); // the OLD documented skip
    const second = syncPending({ cwd });
    assert.equal(second.written.length, 1, 'unacknowledged evidence re-creates the item (why the sentinel exists)');
  });
});

test('syncPending (round-7 finding 8): an ACKNOWLEDGED item is never re-created; the item body documents the durable skip', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '137', undefined, 'fireS');
    const first = syncPending({ cwd });
    assert.equal(first.written.length, 1);
    const body = readFileSync(first.written[0]!.path, 'utf8');
    assert.match(body, /acknowledged/, 'the Skip action documents the sentinel procedure');
    assert.doesNotMatch(body, /- \*\*Skip\*\* — `rm '/, 'the old bare-rm skip advice is gone');

    // The real skip: sentinel + rm (what `roster review --reject` performs).
    const id = /error-([a-f0-9]{8})\.md$/.exec(first.written[0]!.path)![1]!;
    acknowledgePendingId(cwd, 'gtm', id);
    rmSync(first.written[0]!.path);

    const second = syncPending({ cwd });
    assert.equal(second.written.length, 0, 'an acknowledged item stays skipped');
    assert.ok(second.skipped.some((s) => s.reason === 'acknowledged'));
    // Idempotent acknowledgement (create-only writer tolerates the replay).
    acknowledgePendingId(cwd, 'gtm', id);
    assert.ok(existsSync(acknowledgedPathFor(cwd, 'gtm', id)));
  });
});

test('rejectItem (round-7 finding 8): rejecting an error-class item acknowledges its evidence — the reject sticks across syncs', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    writeExit(cwd, 'gtm', 'sdr', '137', undefined, 'fireT');
    const first = syncPending({ cwd });
    assert.equal(first.written.length, 1);
    const path = first.written[0]!.path;
    const filename = path.split('/').pop()!;
    rejectItem({ function: 'gtm', class: 'error', path, filename, frontMatter: {}, body: '' }, cwd);
    assert.ok(!existsSync(path), 'the item file is deleted');
    const again = syncPending({ cwd });
    assert.equal(again.written.length, 0, 'the rejected item is never resurrected');
    assert.ok(again.skipped.some((s) => s.reason === 'acknowledged'));
  });
});

test('syncPending (round-7 finding 8): a STALE item honors the acknowledgement sentinel too', () => {
  withTmpCwd((cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold', cron: '0 9 * * 1-5' }]);
    writeState(cwd, 'gtm', '2026-05-15T09:05:00Z | gtm/sdr/cold/_demo | success');
    const now = new Date('2026-05-18T12:00:00Z');
    const first = syncPending({ cwd, now });
    assert.equal(first.written.length, 1);
    assert.equal(first.written[0]!.reason, 'stale');
    const id = /error-([a-f0-9]{8})\.md$/.exec(first.written[0]!.path)![1]!;
    acknowledgePendingId(cwd, 'gtm', id);
    rmSync(first.written[0]!.path);
    const second = syncPending({ cwd, now });
    assert.equal(second.written.length, 0, 'the acknowledged stale item stays skipped');
  });
});

// ── round-7 finding 9: malformed exit evidence closes the run (same path as a
// nonzero exit) — no state suppresses everything ─────────────────────────────

test('correlateFailedFires (round-7 finding 9): an EMPTY exit file closes the correlated run with a malformed-exit error', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const firedAt = Date.now() - 3_600_000;
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-mal', 'fidM', firedAt);
    writeExit(cwd, 'gtm', 'sdr', '', new Date(firedAt + 60_000), 'fidM'); // present but empty
    const runs = new RecordingRunStore();

    const out = await correlateFailedFires({ cwd, runs });
    assert.equal(out.length, 1, 'malformed evidence must close the run — before the fix NOTHING could');
    assert.equal(out[0]!.runId, 'run-mal');
    assert.equal(out[0]!.reason, 'malformed-exit');
    assert.equal(out[0]!.correlationId, 'sched-error-fidM', 'same deterministic closure path as a nonzero exit');
    const error = runs.appended.find((e) => e.kind === 'error');
    assert.ok(error);
    assert.match(JSON.stringify(error!.data), /malformed-exit/, 'the error names the malformed-exit signal');
    assert.ok(runs.appended.some((e) => e.kind === 'run-end'), 'the run is CLOSED, not stuck running forever');

    // …and the stale branch is not double-closing it on a later sync.
    const runs2 = new RecordingRunStore();
    runs2.getRunResult = endedRun('run-mal');
    const out2 = await correlateFailedFires({ cwd, runs: runs2 });
    assert.equal(out2.length, 0, 'an already-closed run is never reopened');
  });
});

test('correlateFailedFires (round-7 finding 9): an unparsable exit file also closes the run (not only zero-length)', async () => {
  await withAsyncTmpCwd(async (cwd) => {
    writeSchedules(cwd, 'gtm', [{ name: 'sdr', agent: 'sdr', plan: 'cold' }]);
    const firedAt = Date.now() - 3_600_000;
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-garbled', 'fidG', firedAt);
    writeExit(cwd, 'gtm', 'sdr', 'garbage-bytes', new Date(firedAt + 60_000), 'fidG');
    const runs = new RecordingRunStore();
    const out = await correlateFailedFires({ cwd, runs });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.reason, 'malformed-exit');
    assert.ok(runs.appended.some((e) => e.kind === 'run-end' && e.runId === 'run-garbled'));
  });
});
