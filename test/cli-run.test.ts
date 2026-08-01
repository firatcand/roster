import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import pg from 'pg';
import { executeRun, MAX_REPORT_BYTES } from '../src/commands/run.ts';
import { MAX_RECORD_BYTES } from '../src/lib/persistence/local/ledger.ts';
import { MAX_INDEX_TEXT } from '../src/lib/persistence/sanitize-index.ts';
import type { RunOptions } from '../src/lib/run-args.ts';
import { resolveOpsBackend, type ResolvedOpsBackend } from '../src/lib/persistence/resolve.ts';
import { runSetup, type SetupOptions } from '../src/lib/persistence/setup.ts';
import { composeRun } from '../src/lib/persistence/run-compose.ts';
import { MemoryFileStore, type FileStore } from '../src/lib/persistence/s3-core.ts';
import { makeBackendInfo } from '../src/lib/persistence/capabilities.ts';
import { sha256Hex, type ArtifactRecord } from '../src/lib/persistence/contracts.ts';

// #323 section C: the `roster run` CLI. spawnSync covers the argv/usage surface
// and the local-backend happy path end-to-end; injected-deps direct calls cover
// degraded queued-aggregates, the finally pool-close contract, show==compose
// reconstruction, and a two-independent-resolutions cross-machine reproduction
// (PG-gated). Ungated tests run clean with no env.

const BIN = resolve('src/bin/roster.ts');
const ADMIN = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';
const HAS_PG = ADMIN.length > 0;
const pgOpts = { skip: HAS_PG ? false : ('ROSTER_OPS_TEST_ADMIN_URL not set' as const) };

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd: string, envOrInput?: Record<string, string> | string): Run {
  const isInput = typeof envOrInput === 'string';
  const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...(isInput ? {} : (envOrInput ?? {})) },
    stdio: ['pipe', 'pipe', 'pipe'],
    input: isInput ? (envOrInput as string) : '',
    timeout: 30000,
  });
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function setupLocal(cwd: string): void {
  const r = runCli(['ops', 'setup', '--backend', 'local', '--name', 'acme', '--json'], cwd);
  assert.equal(r.status, 0, r.stderr);
}

function options(over: Partial<RunOptions>): RunOptions {
  return {
    cwd: undefined,
    json: true,
    allowPartial: false,
    runId: undefined,
    eventKind: undefined,
    correlationId: undefined,
    data: undefined,
    agent: undefined,
    skill: undefined,
    trigger: undefined,
    parentRun: undefined,
    originTask: undefined,
    schedule: undefined,
    functionName: undefined,
    fireId: undefined,
    file: undefined,
    stdin: false,
    digest: undefined,
    role: undefined,
    filename: undefined,
    artifactType: undefined,
    mediaType: undefined,
    text: undefined,
    external: undefined,
    url: undefined,
    task: undefined,
    limit: undefined,
    fillVersionIds: false,
    yes: false,
    ...over,
  };
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; json: Record<string, unknown> }> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  try {
    const code = await fn();
    return { code, json: JSON.parse(lines.join('\n')) as Record<string, unknown> };
  } finally {
    console.log = orig;
  }
}

// ---------- round-5 findings 1+2+3: per-fire, function-scoped fire sidecar ------

test('cli run start --schedule: writes a per-fire, function-scoped JSON sidecar (runId + firedAt + fireId)', () => {
  const cwd = tmp('run-schedule-');
  try {
    setupLocal(cwd);
    const r = runCli(
      [
        'run', 'start', 'run-fire-1',
        '--agent', 'gtm.sdr', '--trigger', 'schedule',
        '--schedule', 'sdr', '--function', 'gtm', '--fire-id', 'abc123def456', '--json',
      ],
      cwd,
    );
    assert.equal(r.status, 0, r.stderr);
    const rec = JSON.parse(
      readFileSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'abc123def456.run-id'), 'utf8'),
    ) as { runId: string; firedAt: number; fireId: string };
    assert.equal(rec.runId, 'run-fire-1', 'the sidecar records the fire identity');
    assert.equal(rec.fireId, 'abc123def456', 'the sidecar records the per-fire id');
    assert.equal(typeof rec.firedAt, 'number', 'AND a fire timestamp');
    assert.ok(rec.firedAt > 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule: fire id comes from ROSTER_FIRE_ID when --fire-id is omitted', () => {
  const cwd = tmp('run-fireenv-');
  try {
    setupLocal(cwd);
    const r = runCli(
      ['run', 'start', 'run-env', '--agent', 'gtm.sdr', '--schedule', 'sdr', '--function', 'gtm', '--json'],
      cwd,
      { ROSTER_FIRE_ID: 'envfire99' },
    );
    assert.equal(r.status, 0, r.stderr);
    const rec = JSON.parse(readFileSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'envfire99.run-id'), 'utf8')) as {
      runId: string;
      fireId: string;
    };
    assert.equal(rec.runId, 'run-env');
    assert.equal(rec.fireId, 'envfire99');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule: the fire timestamp comes from the injectable clock seam', async () => {
  const cwd = tmp('run-sched-clock-');
  try {
    setupLocal(cwd);
    const fixed = 1_700_000_000_000;
    const { code } = await capture(() =>
      executeRun(
        'start',
        options({ cwd, runId: 'run-x', agent: 'gtm.sdr', schedule: 'sdr', functionName: 'gtm', fireId: 'clockfire' }),
        { now: () => fixed },
      ),
    );
    assert.equal(code, 0);
    const rec = JSON.parse(readFileSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'clockfire.run-id'), 'utf8')) as {
      runId: string;
      firedAt: number;
    };
    assert.equal(rec.runId, 'run-x');
    assert.equal(rec.firedAt, fixed, 'firedAt is stamped from deps.now');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule WITHOUT --function is a usage error AND writes NO run (finding 3)', async () => {
  const cwd = tmp('run-nofn-');
  try {
    setupLocal(cwd);
    await assert.rejects(
      () => capture(() => executeRun('start', options({ cwd, runId: 'run-z', schedule: 'sdr', fireId: 'f1' }), {})),
      /--function/,
    );
    // Validate-before-mutate: the rejected start left NO phantom running run.
    const { code, json } = await capture(() => executeRun('show', options({ cwd, runId: 'run-z' }), {}));
    assert.equal(code, 1);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'not-found');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule with a traversal schedule/function name is refused + writes NO run (finding 3)', async () => {
  const cwd = tmp('run-traversal-');
  try {
    setupLocal(cwd);
    await assert.rejects(
      () =>
        capture(() =>
          executeRun(
            'start',
            options({ cwd, runId: 'run-t', schedule: '../../../important', functionName: 'gtm', fireId: 'f1' }),
            {},
          ),
        ),
    );
    // Nothing escaped the workspace.
    assert.equal(existsSync(join(cwd, '..', '..', '..', 'important.run-id')), false);
    // AND the run-start event was NEVER appended (no phantom running run that
    // crash-correlation would later have to close).
    const { code, json } = await capture(() => executeRun('show', options({ cwd, runId: 'run-t' }), {}));
    assert.equal(code, 1);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'not-found');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule: a VALID scheduled start creates BOTH the run and the sidecar (finding 3)', async () => {
  const cwd = tmp('run-valid-sched-');
  try {
    setupLocal(cwd);
    const start = await capture(() =>
      executeRun('start', options({ cwd, runId: 'run-ok', agent: 'gtm.sdr', schedule: 'sdr', functionName: 'gtm', fireId: 'okfire' }), {}),
    );
    assert.equal(start.code, 0);
    // Sidecar written.
    assert.ok(existsSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'okfire.run-id')));
    // AND the run-start event is present.
    const show = await capture(() => executeRun('show', options({ cwd, runId: 'run-ok' }), {}));
    assert.equal(show.code, 0);
    assert.equal(show.json.ok, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start WITHOUT --schedule: no sidecar is written', async () => {
  const cwd = tmp('run-noched-');
  try {
    setupLocal(cwd);
    await capture(() => executeRun('start', options({ cwd, runId: 'run-y', agent: 'gtm.sdr' }), {}));
    assert.equal(existsSync(join(cwd, 'logs', 'cron', 'gtm')), false, 'no --schedule → no sidecar side effect');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── round-6 finding 6: ledger append FIRST, sidecar SECOND ──────────────────

test('run start --schedule (round-6 finding 6): a FAILED ledger append leaves NO sidecar (no orphan correlating a nonexistent run)', async () => {
  const cwd = tmp('run-append-fails-');
  try {
    const { BackendUnavailableError } = await import('../src/lib/persistence/contracts.ts');
    const failing = {
      state: 'local',
      backend: {
        runs: {
          async appendEvent() {
            throw new BackendUnavailableError('injected: ledger append failed');
          },
        },
        artifacts: {},
        hitl: {},
      },
    } as unknown as ResolvedOpsBackend;
    const { code, json } = await capture(() =>
      executeRun(
        'start',
        options({ cwd, runId: 'run-orphan', agent: 'gtm.sdr', schedule: 'sdr', functionName: 'gtm', fireId: 'orphanfire' }),
        { resolveBackend: async () => failing },
      ),
    );
    assert.equal(code, 1);
    assert.equal(json.ok, false);
    assert.equal(
      existsSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'orphanfire.run-id')),
      false,
      'no sidecar may exist when the run-start event never landed — a later .exit would close a phantom run',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── round-7 finding 4: the complete run-event is validated BEFORE any mutation ──
//
// A scheduled start touches two stores (the ledger + the per-fire sidecar). If
// any part of the event is only validated at append time, a rejected start can
// still leave a `<fireId>.run-id` behind — and pending-sync would later append
// error/run-end for a run that has no run-start (an end-without-start run).
// Every caller-supplied field is now sealed up front, so a bad event mutates
// NOTHING; the recorded order (append, then sidecar) is round-6 finding 6's and
// is unchanged — a sidecar still never precedes the run it names.

test('run start --schedule (round-7 finding 4): malformed --data rejects with NO sidecar and NO run', async () => {
  const cwd = tmp('run-prevalidate-data-');
  try {
    setupLocal(cwd);
    // Through the real binary: a usage-class rejection is an exit-1 error, and
    // it must leave both stores untouched.
    const r = runCli(
      ['run', 'start', 'run-BAD', '--schedule', 'sdr', '--function', 'gtm', '--fire-id', 'badfire', '--data', '{"phase": '],
      cwd,
    );
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--data is not valid JSON/);
    assert.equal(
      existsSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'badfire.run-id')),
      false,
      'a rejected start writes no fire sidecar',
    );
    const show = await capture(() => executeRun('show', options({ cwd, runId: 'run-BAD' }), {}));
    assert.equal(show.code, 1, 'and no run exists');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule (round-7 finding 4): an invalid EVENT FIELD (agent charset) rejects with NO sidecar and NO run', async () => {
  const cwd = tmp('run-prevalidate-field-');
  try {
    setupLocal(cwd);
    const { code, json } = await capture(() =>
      executeRun(
        'start',
        options({ cwd, runId: 'run-BADFIELD', schedule: 'sdr', functionName: 'gtm', fireId: 'fieldfire', agent: 'bad agent!' }),
        {},
      ),
    );
    assert.equal(code, 1);
    assert.equal(json.ok, false);
    assert.equal(
      existsSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'fieldfire.run-id')),
      false,
      'the sidecar is not written for an event that cannot be sealed',
    );
    const show = await capture(() => executeRun('show', options({ cwd, runId: 'run-BADFIELD' }), {}));
    assert.equal(show.code, 1, 'and no run exists');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule (round-7 finding 4): a fully valid scheduled start creates BOTH the sidecar and the run', async () => {
  const cwd = tmp('run-prevalidate-ok-');
  try {
    setupLocal(cwd);
    const { code } = await capture(() =>
      executeRun(
        'start',
        options({ cwd, runId: 'run-OK', schedule: 'sdr', functionName: 'gtm', fireId: 'okfire', agent: 'gtm.sdr', data: '{"phase":"x"}' }),
        {},
      ),
    );
    assert.equal(code, 0);
    const rec = JSON.parse(readFileSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'okfire.run-id'), 'utf8')) as { runId: string };
    assert.equal(rec.runId, 'run-OK');
    const show = await capture(() => executeRun('show', options({ cwd, runId: 'run-OK' }), {}));
    assert.equal(show.code, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule (round-7 finding 2): a fire id already bound to ANOTHER run is a HARD error — non-zero exit, no silent commit, run closed', async () => {
  const cwd = tmp('run-sidecar-conflict-');
  try {
    setupLocal(cwd);
    // Pre-bind the fire id to ANOTHER run: the create-only sidecar writer then
    // refuses the rebind (round-6 finding 5). Round-7 finding 2: this deliberate
    // identity conflict must NOT take the warn-and-exit-0 availability path —
    // run B would commit while the sidecar stays bound to A (A's `.exit` then
    // closes against B's work; B stays uncorrelated).
    const { writeScheduleRunId } = await import('../src/lib/schedule-state.ts');
    writeScheduleRunId(cwd, 'gtm', 'sdr', 'run-FIRST', 'dupfire', 1_000);
    const { code, json } = await capture(() =>
      executeRun(
        'start',
        options({ cwd, runId: 'run-SECOND', agent: 'gtm.sdr', schedule: 'sdr', functionName: 'gtm', fireId: 'dupfire' }),
        {},
      ),
    );
    assert.equal(code, 1, 'a different-run fire binding must fail HARD, never exit 0');
    assert.equal(json.ok, false);
    assert.equal(json.error, 'ConflictError');
    assert.match(String(json.message), /run-FIRST/, 'the error names the run the fire id is bound to');
    // The original binding survives untouched.
    const rec = JSON.parse(readFileSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr', 'dupfire.run-id'), 'utf8')) as { runId: string };
    assert.equal(rec.runId, 'run-FIRST', 'the sidecar was never rebound');
    // The already-appended run-start for B is COMPENSATED: a fire-conflict error
    // + run-end, so no run is left stuck 'running' forever.
    const show = await capture(() => executeRun('show', options({ cwd, runId: 'run-SECOND' }), {}));
    assert.equal(show.code, 0, 'the run-start was already appended (ledger-first)');
    const composed = show.json.run as { lifecycle: { status: string }; errors: unknown[] };
    assert.notEqual(composed.lifecycle.status, 'running', 'the conflicted run is CLOSED, not stuck');
    assert.ok(composed.errors.length >= 1, 'the closure carries a correlated fire-conflict error event');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule (round-7 finding 2): an IDENTICAL same-run replay of the same fire id stays a clean exit-0 no-op', async () => {
  const cwd = tmp('run-sidecar-replay-');
  try {
    setupLocal(cwd);
    const first = await capture(() =>
      executeRun('start', options({ cwd, runId: 'run-SAME', agent: 'gtm.sdr', schedule: 'sdr', functionName: 'gtm', fireId: 'replayfire' }), {}),
    );
    assert.equal(first.code, 0);
    const second = await capture(() =>
      executeRun('start', options({ cwd, runId: 'run-SAME', agent: 'gtm.sdr', schedule: 'sdr', functionName: 'gtm', fireId: 'replayfire' }), {}),
    );
    assert.equal(second.code, 0, 'the idempotent replay is not a conflict');
    assert.equal(second.json.ok, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run start --schedule (round-6 finding 6): a GENUINE sidecar I/O failure after a successful append warns + exits 0 (correlation degraded, run recorded)', async () => {
  const cwd = tmp('run-sidecar-io-');
  try {
    setupLocal(cwd);
    // Make the channel path unusable: a FILE where the schedule dir must go →
    // ensureOwnedDir fails with a non-Conflict error (availability class).
    mkdirSync(join(cwd, 'logs', 'cron', 'gtm'), { recursive: true });
    writeFileSync(join(cwd, 'logs', 'cron', 'gtm', 'sdr'), 'not a dir', 'utf8');
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => {
      errs.push(args.map(String).join(' '));
    };
    let code: number;
    let json: Record<string, unknown>;
    try {
      ({ code, json } = await capture(() =>
        executeRun(
          'start',
          options({ cwd, runId: 'run-IO', agent: 'gtm.sdr', schedule: 'sdr', functionName: 'gtm', fireId: 'iofire' }),
          {},
        ),
      ));
    } finally {
      console.error = origErr;
    }
    assert.equal(code, 0, 'availability failures keep the warn-and-continue path');
    assert.equal(json.ok, true);
    assert.ok(errs.some((l) => /crash correlation .* degraded/.test(l)), `expected a degradation warning, got: ${errs.join('\n')}`);
    const show = await capture(() => executeRun('show', options({ cwd, runId: 'run-IO' }), {}));
    assert.equal(show.code, 0, 'the run itself was recorded');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- usage / parse ----------

test('cli run: no verb → usage on stderr, exit 1', () => {
  const cwd = tmp('run-usage-');
  try {
    const r = runCli(['run'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: roster run/);
    assert.match(r.stderr, /declare-artifact/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run: unknown flag refuses', () => {
  const cwd = tmp('run-badflag-');
  try {
    const r = runCli(['run', 'start', 'r1', '--bogus'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag '--bogus'/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run: not configured → actionable exit 1 (both human + --json)', () => {
  const cwd = tmp('run-notcfg-');
  try {
    const human = runCli(['run', 'start', 'r1'], cwd);
    assert.equal(human.status, 1);
    assert.match(human.stderr, /operations backend is not configured/);
    assert.match(human.stderr, /roster ops setup/);
    // Machine mode uses the global stable error envelope on stdout.
    const j = runCli(['run', 'list', '--json'], cwd);
    assert.equal(j.status, 1);
    assert.equal(j.stderr, '');
    const payload = JSON.parse(j.stdout) as { ok: boolean; message: string; remedy: string };
    assert.equal(payload.ok, false);
    assert.match(payload.message, /not configured/);
    assert.match(payload.remedy, /roster ops setup/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run event: refuses a lifecycle kind via the generic verb (--json envelope, exit 1)', () => {
  const cwd = tmp('run-badkind-');
  try {
    setupLocal(cwd);
    const r = runCli(['run', 'event', '--run', 'r1', '--kind', 'run-start', '--correlation-id', 'x', '--json'], cwd);
    assert.equal(r.status, 1);
    const j = JSON.parse(r.stdout) as { ok: boolean; message: string };
    assert.equal(j.ok, false);
    assert.match(j.message, /not emittable via the generic 'run event' verb/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run event --stdin (finding 6): reads the JSON data payload from stdin (injection-safe path)', () => {
  const cwd = tmp('run-event-stdin-');
  try {
    setupLocal(cwd);
    runCli(['run', 'start', 'run-e', '--json'], cwd);
    // A subagent status containing a single quote AND a double quote — piping
    // valid JSON via stdin cannot corrupt the JSON or become shell syntax.
    const payload = JSON.stringify({ detail: `it's "broken" now` });
    const r = runCli(['run', 'event', '--run', 'run-e', '--kind', 'error', '--correlation-id', 'e1', '--stdin', '--json'], cwd, payload);
    assert.equal(r.status, 0, r.stderr);
    const show = runCli(['run', 'show', 'run-e', '--json'], cwd);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /broken/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run event: --data and --stdin are mutually exclusive', () => {
  const cwd = tmp('run-event-excl-');
  try {
    setupLocal(cwd);
    const r = runCli(['run', 'event', '--run', 'r1', '--kind', 'error', '--correlation-id', 'x', '--data', '{}', '--stdin'], cwd, '{}');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutually exclusive/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run event --stdin: invalid JSON on stdin is rejected', () => {
  const cwd = tmp('run-event-badjson-');
  try {
    setupLocal(cwd);
    const r = runCli(['run', 'event', '--run', 'r1', '--kind', 'error', '--correlation-id', 'x', '--stdin'], cwd, 'not json');
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run event: an unknown kind is rejected', () => {
  const cwd = tmp('run-unknownkind-');
  try {
    setupLocal(cwd);
    const r = runCli(['run', 'event', '--run', 'r1', '--kind', 'nonsense', '--correlation-id', 'x'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /is not a run-event kind/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run report: --file and --stdin are mutually exclusive', () => {
  const cwd = tmp('run-excl-');
  try {
    setupLocal(cwd);
    const f = join(cwd, 'r.txt');
    writeFileSync(f, 'hi');
    const r = runCli(['run', 'report', '--run', 'r1', '--file', f, '--stdin'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutually exclusive/);
    const none = runCli(['run', 'report', '--run', 'r1'], cwd);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /requires --file <path> or --stdin/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run declare-artifact: a --digest that disagrees with the bytes is rejected', () => {
  const cwd = tmp('run-digest-');
  try {
    setupLocal(cwd);
    const f = join(cwd, 'a.bin');
    writeFileSync(f, 'real-bytes');
    const wrong = 'f'.repeat(64);
    const r = runCli(['run', 'declare-artifact', '--run', 'r1', '--agent', 'a1', '--digest', wrong, '--file', f], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not match the file's sha256/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run declare-artifact (finding 14): an invalid --role errors with NO blob/declaration written (local)', async () => {
  const cwd = tmp('run-role-');
  try {
    setupLocal(cwd);
    const f = join(cwd, 'a.bin');
    writeFileSync(f, 'role-bytes');
    const digest = sha256Hex(Buffer.from('role-bytes'));
    const r = runCli(['run', 'declare-artifact', '--run', 'r1', '--agent', 'a1', '--digest', digest, '--file', f, '--role', 'nope'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /role/i);
    // Declaration validation ran BEFORE the blob write, so nothing is orphaned.
    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'local');
    if (resolved.state !== 'local') return;
    assert.equal((await resolved.backend.artifacts.getByRun('r1')).length, 0, 'no orphaned declaration');
    assert.equal(await resolved.backend.artifacts.head(digest), null, 'no orphaned blob');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- local happy path end-to-end (spawnSync) ----------

test('cli run: local end-to-end — start, report (redacted), declare internal+external, event, end, show, list', () => {
  const cwd = tmp('run-e2e-');
  try {
    setupLocal(cwd);
    assert.equal(runCli(['run', 'start', 'run-x', '--agent', 'gtm.sdr', '--origin-task', 'T-9', '--json'], cwd).status, 0);

    // report with a planted secret → the sanitized projection redacts it.
    const rep = runCli(['run', 'report', '--run', 'run-x', '--agent', 'gtm.sdr', '--stdin'], cwd, 'body api_key=sk-live-PLANTEDSECRET1234 end');
    assert.equal(rep.status, 0, rep.stderr);

    const f = join(cwd, 'out.txt');
    writeFileSync(f, 'artifact-content');
    const digest = sha256Hex(Buffer.from('artifact-content'));
    const di = runCli(['run', 'declare-artifact', '--run', 'run-x', '--agent', 'gtm.sdr', '--digest', digest, '--file', f, '--type', 'report', '--role', 'produced', '--json'], cwd);
    assert.equal(di.status, 0, di.stderr);
    assert.equal((JSON.parse(di.stdout) as { digest: string }).digest, digest);

    const de = runCli(['run', 'declare-artifact', '--run', 'run-x', '--agent', 'gtm.sdr', '--external', 'notion:pg-1', '--url', 'https://notion.so/pg-1', '--json'], cwd);
    assert.equal(de.status, 0, de.stderr);

    assert.equal(runCli(['run', 'event', '--run', 'run-x', '--kind', 'retry', '--correlation-id', 'try-1', '--json'], cwd).status, 0);
    assert.equal(runCli(['run', 'end', 'run-x', '--json'], cwd).status, 0);

    const show = runCli(['run', 'show', 'run-x', '--json'], cwd);
    assert.equal(show.status, 0, show.stderr);
    const composed = (JSON.parse(show.stdout) as { run: Record<string, unknown> }).run;
    assert.equal(composed.runId, 'run-x');
    assert.equal((composed.lifecycle as { status: string }).status, 'completed');
    // secret never surfaces in the sanitized projection; raw prose stays in data.
    const report = composed.report as { sanitizedText: string; verified: boolean };
    assert.match(report.sanitizedText, /\[REDACTED\]/);
    assert.ok(!report.sanitizedText.includes('sk-live-PLANTEDSECRET1234'));
    assert.equal(report.verified, false);
    assert.equal((composed.artifacts as unknown[]).length, 2);

    // list, then filter by agent + a miss.
    const list = runCli(['run', 'list', '--json'], cwd);
    const runs = (JSON.parse(list.stdout) as { runs: { runId: string; agent: string; originTaskId: string }[] }).runs;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.agent, 'gtm.sdr');
    assert.equal(runs[0]!.originTaskId, 'T-9');
    assert.equal((JSON.parse(runCli(['run', 'list', '--agent', 'nobody', '--json'], cwd).stdout) as { runs: unknown[] }).runs.length, 0);
    assert.equal((JSON.parse(runCli(['run', 'list', '--task', 'T-9', '--json'], cwd).stdout) as { runs: unknown[] }).runs.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli run list (finding 9): a filtered match far beyond a --limit 1 output page is returned (not silently truncated)', async () => {
  const cwd = tmp('run-list-deep-');
  try {
    setupLocal(cwd);
    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'local');
    if (resolved.state !== 'local') return;
    // 59 non-matching runs, then the 60th carries the TARGET task — the match is
    // far beyond a --limit 1 output page. Before the fix, the per-limit page + a
    // 50-page cap stopped traversal before reaching it and returned none.
    for (let i = 0; i < 59; i++) {
      await resolved.backend.runs.appendEvent({ runId: `r-${i}`, kind: 'run-start', data: null, agent: 'a', originTaskId: 'OTHER' });
    }
    await resolved.backend.runs.appendEvent({ runId: 'r-target', kind: 'run-start', data: null, agent: 'a', originTaskId: 'TARGET' });

    const { code, json } = await capture(() => executeRun('list', options({ cwd, task: 'TARGET', limit: 1, json: true })));
    assert.equal(code, 0);
    const runs = json.runs as { runId: string; originTaskId: string }[];
    assert.equal(runs.length, 1, 'the deep match is returned despite --limit 1');
    assert.equal(runs[0]!.runId, 'r-target');
    assert.equal(json.truncated, false, 'the store was fully scanned — not truncated');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- show == composeRun (reconstruction fixture) ----------

test('cli run show: JSON reconstruction equals a direct composeRun over the same reads', async () => {
  const cwd = tmp('run-fixture-');
  try {
    setupLocal(cwd);
    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'local');
    if (resolved.state !== 'local') return;
    const b = resolved.backend;
    await b.runs.appendEvent({ runId: 'rc', kind: 'run-start', data: null, agent: 'gtm.sdr', startedAt: 1000 });
    await b.runs.appendEvent({ runId: 'rc', kind: 'report', data: 'a report' });
    const bytes = Buffer.from('blobbytes');
    await b.artifacts.putArtifact({ filename: 'x', contentType: 'text/plain', runId: 'rc' }, bytes, {
      runId: 'rc',
      declaringAgent: 'gtm.sdr',
      role: 'produced',
    });
    await b.artifacts.putExternal({ runId: 'rc', declaringAgent: 'gtm.sdr', role: 'used', provider: 'gh', externalId: 'pr-1' });
    await b.runs.appendEvent({ runId: 'rc', kind: 'run-end', data: null, endedAt: 1500 });

    const run = await b.runs.getRun('rc');
    const decls = await b.artifacts.getByRun('rc');
    const blobResolver = async (digest: string): Promise<ArtifactRecord | null> => await b.artifacts.head(digest);
    const expected = await composeRun('rc', run?.events ?? [], decls, blobResolver);

    const { code, json } = await capture(() => executeRun('show', options({ runId: 'rc', cwd, json: true })));
    assert.equal(code, 0);
    assert.deepEqual(json.run, JSON.parse(JSON.stringify(expected)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- degraded: writes queue, reads refuse without --allow-partial ----------

function writePgConfig(cwd: string, ws: { id: string; name: string }): void {
  mkdirSync(join(cwd, 'roster'), { recursive: true });
  writeFileSync(
    join(cwd, 'roster', 'persistence.yaml'),
    [
      'version: 1',
      'workspace:',
      `  id: ${ws.id}`,
      `  name: ${ws.name}`,
      'backend: postgres-s3',
      'postgres:',
      '  database: dedicated',
      'objects:',
      '  bucket: acme-ops',
      '  region: null',
      '  endpoint: null',
      '  force_path_style: false',
    ].join('\n') + '\n',
  );
}

test('cli run: degraded backend queues writes and reports the queued aggregate', async () => {
  const cwd = tmp('run-degraded-');
  try {
    const ws = { id: randomUUID(), name: 'acme' };
    writePgConfig(cwd, ws);
    const deps = {
      resolveOpts: { env: { ROSTER_OPS_URL: 'postgresql://nobody:x@127.0.0.1:1/nope' } as NodeJS.ProcessEnv, files: new MemoryFileStore() },
    };

    const start = await capture(() => executeRun('start', options({ runId: 'r1', cwd, agent: 'gtm.sdr' }), deps));
    assert.equal(start.code, 0);
    assert.equal(start.json.outcome, 'queued');

    const bytes = randomBytes(32);
    const digest = sha256Hex(bytes);
    const f = join(cwd, 'blob.bin');
    writeFileSync(f, bytes);
    const decl = await capture(() =>
      executeRun('declare-artifact', options({ runId: 'r1', cwd, agent: 'gtm.sdr', digest, file: f }), deps),
    );
    assert.equal(decl.code, 0);
    assert.equal(decl.json.outcome, 'queued');
    assert.equal(decl.json.digest, digest);
    // A declaration id is still derived for the queued blob (converges on drain).
    assert.ok(typeof decl.json.declarationId === 'string');

    // Reads refuse without --allow-partial, serve the overlay with it.
    const refused = await capture(() => executeRun('show', options({ runId: 'r1', cwd, json: true }), deps));
    assert.equal(refused.code, 1);
    assert.equal(refused.json.ok, false);

    const partial = await capture(() => executeRun('show', options({ runId: 'r1', cwd, json: true, allowPartial: true }), deps));
    assert.equal(partial.code, 0);
    assert.equal((partial.json.run as { runId: string }).runId, 'r1');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- finally: the Postgres pool is closed on success AND on error ----------

function fakePgResolved(closeSpy: { n: number }, throwOnList: boolean): ResolvedOpsBackend {
  const backend = {
    backend: 'postgres-s3' as const,
    workspaceId: 'ws',
    runs: {
      async listRuns() {
        if (throwOnList) {
          const { BackendUnavailableError } = await import('../src/lib/persistence/contracts.ts');
          throw new BackendUnavailableError('boom');
        }
        return { items: [], cursor: null, partial: false };
      },
      async getRun() {
        return null;
      },
      async appendEvent() {
        return { outcome: 'committed' as const, id: 'x' };
      },
      async count() {
        return { committed: 0, queued: 0, partial: false };
      },
    },
    artifacts: {},
    hitl: {},
  };
  return {
    state: 'postgres-s3',
    close: async () => {
      closeSpy.n += 1;
    },
    backend,
    config: { workspace: { id: 'ws', name: 'acme' } },
  } as unknown as ResolvedOpsBackend;
}

test('cli run: the Postgres pool is closed in finally — on success and on error', async () => {
  const okSpy = { n: 0 };
  const ok = await capture(() =>
    executeRun('list', options({ json: true }), { resolveBackend: async () => fakePgResolved(okSpy, false) }),
  );
  assert.equal(ok.code, 0);
  assert.equal(okSpy.n, 1, 'pool closed after a successful read');

  const errSpy = { n: 0 };
  const err = await capture(() =>
    executeRun('list', options({ json: true }), { resolveBackend: async () => fakePgResolved(errSpy, true) }),
  );
  assert.equal(err.code, 1);
  assert.equal(err.json.ok, false);
  assert.equal(errSpy.n, 1, 'pool still closed when the read throws');
});

// ---------- setup-incomplete → exit 1 ----------

test('cli run: an aborted setup surfaces as exit 1', async () => {
  const cwd = tmp('run-incomplete-');
  try {
    await assert.rejects(
      runSetup({
        cwd,
        backend: 'local',
        name: 'acme',
        onPhase: (p, m) => {
          if (p === 'config-written' && m === 'begin') throw new Error('abort');
        },
      }),
      /abort/,
    );
    const r = runCli(['run', 'list'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /setup is incomplete|re-run 'roster ops setup'/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- PG-gated: two independent resolutions reproduce one composed run ----------

function urlForDb(db: string): string {
  const u = new URL(ADMIN);
  u.pathname = '/' + db;
  return u.toString();
}

type Harness = { url: string; suffix: string; roles: string[]; close: () => Promise<void> };

async function makeDb(): Promise<Harness> {
  const suffix = randomBytes(6).toString('hex');
  const db = `run_recon_${suffix}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${db}`);
  } finally {
    await root.end();
  }
  const roles: string[] = [];
  return {
    url: urlForDb(db),
    suffix,
    roles,
    close: async () => {
      const r = new pg.Client({ connectionString: ADMIN });
      await r.connect();
      try {
        await r.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [db]);
        await r.query(`DROP DATABASE IF EXISTS ${db}`);
        for (const role of roles) await r.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      } finally {
        await r.end();
      }
    },
  };
}

async function createRuntimeRole(h: Harness): Promise<string> {
  const role = `run_rt_${h.suffix}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  try {
    await root.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw-${h.suffix}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  } finally {
    await root.end();
  }
  h.roles.push(role);
  const u = new URL(h.url);
  u.username = role;
  u.password = `pw-${h.suffix}`;
  return u.toString();
}

function pgSetupOpts(cwd: string, env: NodeJS.ProcessEnv, store: FileStore): SetupOptions {
  return {
    cwd,
    backend: 'postgres-s3',
    database: 'dedicated',
    bucket: 'acme-ops',
    name: 'acme',
    env,
    adminFiles: store,
    validateBucket: async () => ({ objectLock: false }),
  };
}

test('cli run: two independently-resolved workspace dirs on the same PG+object binding reproduce an identical composed run', pgOpts, async () => {
  const h = await makeDb();
  const cwdA = tmp('run-reconA-');
  const cwdB = tmp('run-reconB-');
  const store = new MemoryFileStore(); // stands in for the shared S3/MinIO bucket
  try {
    const runtimeUrl = await createRuntimeRole(h);
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;

    // Dir A runs setup; dir B points at the SAME database + bucket (copied config).
    await runSetup(pgSetupOpts(cwdA, env, store));
    mkdirSync(join(cwdB, 'roster'), { recursive: true });
    copyFileSync(join(cwdA, 'roster', 'persistence.yaml'), join(cwdB, 'roster', 'persistence.yaml'));

    const a = await resolveOpsBackend(cwdA, { env, files: store });
    const b = await resolveOpsBackend(cwdB, { env, files: store });
    assert.equal(a.state, 'postgres-s3');
    assert.equal(b.state, 'postgres-s3');
    if (a.state !== 'postgres-s3' || b.state !== 'postgres-s3') return;
    try {
      // Write the whole run through A (its own outbox/tree).
      await a.backend.runs.appendEvent({ runId: 'shared', kind: 'run-start', data: null, agent: 'gtm.sdr', startedAt: 2000 });
      await a.backend.runs.appendEvent({ runId: 'shared', kind: 'report', data: 'the report' });
      const bytes = randomBytes(40);
      await a.backend.artifacts.putArtifact({ filename: 'o', contentType: 'application/octet-stream', runId: 'shared' }, bytes, {
        runId: 'shared',
        declaringAgent: 'gtm.sdr',
        role: 'produced',
      });
      await a.backend.runs.appendEvent({ runId: 'shared', kind: 'run-end', data: null, endedAt: 2400 });

      // Reconstruct from A and from B — a different local tree/outbox, same binding.
      const compose = async (backend: typeof a.backend) => {
        const run = await backend.runs.getRun('shared');
        const decls = await backend.artifacts.getByRun('shared');
        return await composeRun('shared', run?.events ?? [], decls, (d) => backend.artifacts.head(d));
      };
      const fromA = await compose(a.backend);
      const fromB = await compose(b.backend);
      assert.deepEqual(JSON.parse(JSON.stringify(fromB)), JSON.parse(JSON.stringify(fromA)));
      assert.equal(fromB.lifecycle.status, 'completed');
      assert.equal(fromB.durationDerived, 400);
      assert.equal(fromB.artifacts.length, 1);
      assert.equal(fromB.artifacts[0]!.state, 'resolved');
    } finally {
      await a.close();
      await b.close();
    }
  } finally {
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
    await h.close();
  }
});

test('cli run doctor + repair: real resolveObjectAdmin + admin-pool wiring fills a missing object version', pgOpts, async () => {
  const h = await makeDb();
  const cwd = tmp('run-doctor-');
  const store = new MemoryFileStore();
  try {
    const runtimeUrl = await createRuntimeRole(h);
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
    await runSetup(pgSetupOpts(cwd, env, store));

    // Put an internal artifact through the outbox path → its object lands in the
    // store AND the drain threads the delivered version onto the blob row
    // (finding: VersionId discarded on queued writes — the row must NOT be NULL).
    const a = await resolveOpsBackend(cwd, { env, files: store });
    assert.equal(a.state, 'postgres-s3');
    if (a.state !== 'postgres-s3') return;
    const bytes = randomBytes(24);
    const digest = sha256Hex(bytes);
    await a.backend.artifacts.putArtifact({ filename: 'o', contentType: 'application/octet-stream', runId: 'r1' }, bytes, {
      runId: 'r1',
      declaringAgent: 'gtm.sdr',
      role: 'produced',
    });
    await a.close();

    // The drain recorded the object version id on the blob row (finding 5), then
    // simulate a LEGACY (pre-#323) blob whose version was never captured so the
    // doctor/repair CLI wiring has something to detect + fill. Admin SQL runs over
    // a throwaway superuser client on the test db (the Harness exposes no pool).
    const admin = new pg.Client({ connectionString: h.url });
    await admin.connect();
    try {
      const drainedRow = (
        await admin.query(`SELECT object_version_id FROM roster_ops.artifacts WHERE digest = $1`, [digest])
      ).rows[0] as { object_version_id: string | null } | undefined;
      assert.ok(drainedRow?.object_version_id, 'a queued artifact write records its object version id once drained (not NULL)');
      await admin.query(`UPDATE roster_ops.artifacts SET object_version_id = NULL WHERE digest = $1`, [digest]);
      await admin.query(`UPDATE roster_ops.artifact_declarations SET version_state = 'unverified' WHERE digest = $1`, [digest]);
    } finally {
      await admin.end();
    }

    // resolveOpts carries env (admin URL for the repair pool) + the shared store
    // (real resolveObjectAdmin returns a list-capable CreateOnlyFileStore over it).
    const deps = { resolveOpts: { env, files: store } };

    const doctor1 = await capture(() => executeRun('doctor', options({ cwd, json: true }), deps));
    assert.equal(doctor1.code, 1, 'findings → exit 1');
    const findings1 = doctor1.json.findings as { kind: string }[];
    assert.ok(findings1.some((f) => f.kind === 'missing-object-version'));

    const repair = await capture(() => executeRun('repair', options({ cwd, json: true, fillVersionIds: true }), deps));
    assert.equal(repair.code, 0, JSON.stringify(repair.json));
    assert.equal((repair.json.filled as unknown[]).length, 1);

    const doctor2 = await capture(() => executeRun('doctor', options({ cwd, json: true }), deps));
    assert.equal(doctor2.code, 0, JSON.stringify(doctor2.json));
    assert.deepEqual(doctor2.json.findings, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h.close();
  }
});

// ── finding 13: run list filters BEFORE the limit (pages until N matches) ─────

test('cli run list: --agent B --limit 100 finds B even when B is the 101st run (filter before limit)', async () => {
  const cwd = tmp('run-list-filter-');
  try {
    setupLocal(cwd);
    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'local');
    if (resolved.state !== 'local') return;
    const b = resolved.backend;
    // 100 runs by agent A, then one run by agent B (the 101st, highest seq → last
    // in the default ordering). The old code sliced the first `limit` rows and
    // filtered after, dropping B.
    for (let i = 0; i < 100; i++) {
      await b.runs.appendEvent({ runId: `a-${String(i).padStart(3, '0')}`, kind: 'run-start', data: null, agent: 'A' });
    }
    await b.runs.appendEvent({ runId: 'the-b-run', kind: 'run-start', data: null, agent: 'B' });

    const { code, json } = await capture(() => executeRun('list', options({ cwd, json: true, agent: 'B', limit: 100 })));
    assert.equal(code, 0);
    const runs = json.runs as Array<{ runId: string; agent: string }>;
    assert.equal(runs.length, 1, 'exactly the one B run is returned');
    assert.equal(runs[0]!.runId, 'the-b-run');
    assert.equal(runs[0]!.agent, 'B');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── round-8 finding 1: the fire-sidecar conflict arbitration is a HARDENED read ──
//
// `roster run start --schedule` appends the run-start event FIRST and stamps the
// sidecar second. When the create-only publish loses (EEXIST) it arbitrates by
// reading the existing sidecar — and that read used an unbounded, symlink-
// following readFileSync. The channel dir is agent-writable, so a FIFO planted at
// `<fireId>.run-id` blocked that read forever: the CLI hung AFTER the append, the
// run stayed active and the cron fire wedged. A symlink diverted the arbitration
// to a foreign file. Both are now refused through the same bounded, O_NOFOLLOW,
// regular-file-verified reader the exit/evidence path uses.

function runCliTimed(args: readonly string[], cwd: string, timeoutMs: number): Run & { signal: NodeJS.Signals | null } {
  const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    input: '',
    timeout: timeoutMs,
  });
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr, signal: out.signal };
}

test(
  'run start --schedule (round-8 finding 1): a FIFO planted at the fire sidecar fails FAST — never a blocking read',
  { skip: process.platform === 'win32' ? 'POSIX only' : false },
  () => {
    const cwd = tmp('run-sidecar-fifo-');
    try {
      setupLocal(cwd);
      // A first real fire creates + owns the channel dir the way the CLI does.
      const seed = runCli(
        ['run', 'start', 'run-seed', '--agent', 'gtm.sdr', '--schedule', 'sdr', '--function', 'gtm', '--fire-id', 'seedfire', '--json'],
        cwd,
      );
      assert.equal(seed.status, 0, seed.stderr);
      const dir = join(cwd, 'logs', 'cron', 'gtm', 'sdr');
      const mk = spawnSync('mkfifo', [join(dir, 'fifofire.run-id')]);
      assert.equal(mk.status, 0, 'mkfifo available on POSIX');

      const startedAt = Date.now();
      const r = runCliTimed(
        ['run', 'start', 'run-fifo', '--agent', 'gtm.sdr', '--schedule', 'sdr', '--function', 'gtm', '--fire-id', 'fifofire', '--json'],
        cwd,
        10_000,
      );
      // Pre-fix this process never returns: spawnSync has to kill it at the
      // timeout (signal SIGTERM, status -1).
      assert.equal(r.signal, null, 'the CLI must not have to be killed — a FIFO sidecar never blocks the arbitration read');
      assert.ok(Date.now() - startedAt < 10_000, 'and it fails fast');
      assert.equal(r.status, 1, r.stdout + r.stderr);
      const env = JSON.parse(r.stdout.trim()) as { ok: boolean; error: string; message: string };
      assert.equal(env.ok, false);
      assert.equal(env.error, 'ConflictError', 'a squatted channel is an identity refusal, not a degraded warning');
      assert.match(env.message, /not a regular file/, 'the error names the hostile shape');
      assert.match(env.message, /fifofire/);

      // Round-7 finding 2's compensating close still applies: the run-start was
      // already appended, so the refused run is CLOSED rather than left active.
      const show = runCli(['run', 'show', 'run-fifo', '--json'], cwd);
      const composed = JSON.parse(show.stdout) as { run: { lifecycle: { status: string } } };
      assert.notEqual(composed.run.lifecycle.status, 'running', 'the refused run is not left active');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  'run start --schedule (round-8 finding 1): a SYMLINK planted at the fire sidecar is refused, never followed',
  { skip: process.platform === 'win32' ? 'POSIX only' : false },
  () => {
    const cwd = tmp('run-sidecar-symlink-');
    try {
      setupLocal(cwd);
      const seed = runCli(
        ['run', 'start', 'run-seed', '--agent', 'gtm.sdr', '--schedule', 'sdr', '--function', 'gtm', '--fire-id', 'seedfire', '--json'],
        cwd,
      );
      assert.equal(seed.status, 0, seed.stderr);
      const dir = join(cwd, 'logs', 'cron', 'gtm', 'sdr');
      // The victim carries a VALID-looking binding: if the reader followed the
      // link it would arbitrate against foreign content (and, with a matching run
      // id, silently return "already bound" for a fire it never wrote).
      const victim = join(cwd, 'victim.json');
      writeFileSync(victim, JSON.stringify({ runId: 'run-link', firedAt: 1, fireId: 'linkfire' }) + '\n');
      symlinkSync(victim, join(dir, 'linkfire.run-id'));

      const r = runCliTimed(
        ['run', 'start', 'run-link', '--agent', 'gtm.sdr', '--schedule', 'sdr', '--function', 'gtm', '--fire-id', 'linkfire', '--json'],
        cwd,
        10_000,
      );
      assert.equal(r.signal, null);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      const env = JSON.parse(r.stdout.trim()) as { ok: boolean; error: string; message: string };
      assert.equal(env.error, 'ConflictError');
      assert.match(env.message, /not a regular file/);
      assert.equal(
        readFileSync(victim, 'utf8'),
        JSON.stringify({ runId: 'run-link', firedAt: 1, fireId: 'linkfire' }) + '\n',
        'the symlink target is neither written nor adopted',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

// ── round-8 finding 3: local head() applies getArtifact's integrity standard ──
//
// head() only statSync'd the digest path, so after a valid declaration a blob
// replaced by corrupt bytes / a directory / a symlink still reconstructed as
// `state=resolved` in `roster run show` — while getArtifact rejected the very
// same content. Reconstruction must never claim a resolved artifact it has not
// validated.

async function declaredArtifactWorkspace(cwd: string): Promise<{ digest: string; blobPath: string }> {
  setupLocal(cwd);
  const start = runCli(['run', 'start', 'r-art', '--agent', 'gtm.sdr', '--json'], cwd);
  assert.equal(start.status, 0, start.stderr);
  const payload = join(cwd, 'payload.txt');
  const bytes = Buffer.from('the produced artifact bytes');
  writeFileSync(payload, bytes);
  const digest = sha256Hex(bytes);
  const decl = runCli(
    ['run', 'declare-artifact', '--run', 'r-art', '--agent', 'gtm.sdr', '--role', 'produced', '--file', payload, '--digest', digest, '--json'],
    cwd,
  );
  assert.equal(decl.status, 0, decl.stderr);

  const show = runCli(['run', 'show', 'r-art', '--json'], cwd);
  assert.equal(show.status, 0, show.stderr);
  const composed = JSON.parse(show.stdout) as { run: { artifacts: { state: string }[] } };
  assert.equal(composed.run.artifacts[0]!.state, 'resolved', 'the healthy declaration reconstructs as resolved');

  const resolved = await resolveOpsBackend(cwd);
  assert.equal(resolved.state, 'local');
  if (resolved.state !== 'local') throw new Error('expected a local backend');
  return { digest, blobPath: join(resolved.ledger.treeDir, 'artifacts', digest) };
}

function assertShowRefusesArtifact(cwd: string, what: string): void {
  const show = runCli(['run', 'show', 'r-art', '--json'], cwd);
  assert.equal(show.status, 1, `${what}: run show must not succeed (${show.stdout}${show.stderr})`);
  const env = JSON.parse(show.stdout.trim()) as { ok: boolean; error: string };
  assert.equal(env.ok, false, what);
  assert.equal(env.error, 'InvalidRecordError', what);
  assert.equal(/"state": *"resolved"/.test(show.stdout), false, `${what}: never reported resolved`);
}

test('run show (round-8 finding 3): a blob replaced by CORRUPT bytes is not reported resolved', async () => {
  const cwd = tmp('run-blob-corrupt-');
  try {
    const { blobPath } = await declaredArtifactWorkspace(cwd);
    writeFileSync(blobPath, 'tampered bytes that do not hash to the digest');
    assertShowRefusesArtifact(cwd, 'corrupt bytes');
    // …and getArtifact rejects the identical content, so the two agree.
    const resolved = await resolveOpsBackend(cwd);
    if (resolved.state !== 'local') throw new Error('expected a local backend');
    const digest = basename(blobPath);
    await assert.rejects(resolved.backend.artifacts.getArtifact(digest), /do not match their digest/);
    await assert.rejects(resolved.backend.artifacts.head(digest), /do not match their digest/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run show (round-8 finding 3): a blob replaced by a DIRECTORY is not reported resolved', async () => {
  const cwd = tmp('run-blob-dir-');
  try {
    const { blobPath } = await declaredArtifactWorkspace(cwd);
    rmSync(blobPath);
    mkdirSync(blobPath);
    assertShowRefusesArtifact(cwd, 'directory');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test(
  'run show (round-8 finding 3): a blob replaced by a SYMLINK is not reported resolved (never followed)',
  { skip: process.platform === 'win32' ? 'POSIX only' : false },
  async () => {
    const cwd = tmp('run-blob-symlink-');
    try {
      const { blobPath } = await declaredArtifactWorkspace(cwd);
      const decoy = join(cwd, 'decoy.bin');
      writeFileSync(decoy, readFileSync(blobPath)); // byte-identical: only the SHAPE is hostile
      rmSync(blobPath);
      symlinkSync(decoy, blobPath);
      assertShowRefusesArtifact(cwd, 'symlink');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

// ── round-8 finding 4: run doctor/repair are capability-gated ────────────────
//
// requirePostgres only checked backend STATE; PgRunLedgerSource then ran v2-only
// declaration/version SQL. Against a supported v1 postgres-s3 backend both verbs
// emitted a raw missing-relation database error instead of the actionable
// VersionSkewError every other run-ledger operation gives. The gate now runs
// BEFORE any admin resource is resolved and before any SQL is issued.

function fakeV1PgResolved(closeSpy: { n: number }): ResolvedOpsBackend {
  return {
    state: 'postgres-s3',
    close: async () => {
      closeSpy.n += 1;
    },
    backend: { backend: 'postgres-s3' as const, workspaceId: 'ws', runs: {}, artifacts: {}, hitl: {} },
    config: { workspace: { id: 'ws', name: 'acme' }, postgres: { database: 'ops' } },
    pool: {},
    info: makeBackendInfo('postgres-s3', {
      roster_ops: { version: 1, capabilities: ['runs', 'artifacts', 'outbox', 'checkpoint'] },
      hitl: { version: 1, capabilities: ['requests', 'decisions'] },
      objects: { version: 1, capabilities: ['content-addressed', 'create-only'] },
    }),
  } as unknown as ResolvedOpsBackend;
}

test('cli run doctor/repair (round-8 finding 4): a v1 backend refuses with VersionSkewError BEFORE any admin resource is resolved', async () => {
  for (const [verb, over] of [
    ['doctor', {}],
    ['repair', { fillVersionIds: true }],
  ] as const) {
    const closeSpy = { n: 0 };
    const touched = { objectAdmin: 0, adminPool: 0 };
    const { code, json } = await capture(() =>
      executeRun(verb, options({ json: true, ...over }), {
        resolveBackend: async () => fakeV1PgResolved(closeSpy),
        objectAdmin: async () => {
          touched.objectAdmin += 1;
          throw new Error('unreachable');
        },
        adminPool: async () => {
          touched.adminPool += 1;
          throw new Error('unreachable');
        },
      }),
    );
    assert.equal(code, 1, `${verb} must refuse`);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'VersionSkewError', `${verb}: actionable skew error, not a SQL error`);
    assert.match(String(json.message), /run-ledger|version-id|list-prefix/);
    assert.equal(touched.objectAdmin, 0, `${verb}: the admin object store is never resolved`);
    assert.equal(touched.adminPool, 0, `${verb}: the admin pool is never opened`);
    assert.equal(closeSpy.n, 1, `${verb}: the pool is still closed in finally`);
  }
});

test('cli run doctor/repair (round-8 finding 4): a REAL v1 postgres-s3 database yields VersionSkewError, not a SQL error', pgOpts, async () => {
  const h = await makeDb();
  const cwd = tmp('run-v1-gate-');
  const store = new MemoryFileStore();
  try {
    const runtimeUrl = await createRuntimeRole(h);
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
    await runSetup(pgSetupOpts(cwd, env, store));

    // Roll the database back to a genuine v1 shape: the v2 declaration table is
    // gone and the meta reports #318's v1 component versions/capabilities.
    const admin = new pg.Client({ connectionString: h.url });
    await admin.connect();
    try {
      await admin.query('DROP TABLE IF EXISTS roster_ops.artifact_declarations CASCADE');
      await admin.query(
        `UPDATE roster_ops.meta SET component_version = 1,
           capabilities = '["runs","artifacts","outbox","checkpoint"]'::jsonb,
           objects_component_version = 1,
           objects_capabilities = '["content-addressed","create-only"]'::jsonb`,
      );
    } finally {
      await admin.end();
    }

    const deps = { resolveOpts: { env, files: store } };
    for (const [verb, over] of [
      ['doctor', {}],
      ['repair', { fillVersionIds: true }],
    ] as const) {
      const { code, json } = await capture(() => executeRun(verb, options({ cwd, json: true, ...over }), deps));
      assert.equal(code, 1, `${verb} must refuse on a v1 database`);
      assert.equal(json.error, 'VersionSkewError', `${verb}: got ${JSON.stringify(json)}`);
      assert.match(String(json.message), /run-ledger|version-id|list-prefix/);
      assert.equal(
        /relation|column|does not exist/i.test(String(json.message)),
        false,
        `${verb}: never a raw SQL error`,
      );
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h.close();
  }
});

// ---------- round-9 finding 2: the report/event cap bounds the READ ----------
//
// The 1 MiB cap used to be enforced only AFTER the input was fully in memory:
// `--file` went through readFileSync (which for a >2 GiB log throws its own
// buffer-limit error long before the cap check, so the CLI reported an
// unreadable file instead of the documented cap) and `--stdin` accumulated the
// whole pipe. Both inputs are now read through the bounded reader, which stops
// at MAX_REPORT_BYTES + 1. declare-artifact keeps its separate policy.

// Round-10 finding 2: the advertised cap is now the PORTABLE one — a raw input
// that every backend can actually store, not one the strictest backend rejects
// downstream. Imported (not re-declared) so the assertions can never drift from
// the shipped constant.
const REPORT_CAP = MAX_REPORT_BYTES;

test('run report --file: a 3 GiB (sparse) log returns the documented CAP error, never a whole-file read', () => {
  const cwd = tmp('run-cap-file-');
  try {
    setupLocal(cwd);
    const p = join(cwd, 'huge.log');
    const size = 3 * 1024 * 1024 * 1024;
    const fd = openSync(p, 'w');
    try {
      ftruncateSync(fd, size);
    } finally {
      closeSync(fd);
    }
    const r = runCli(['run', 'report', '--run', 'run-cap', '--file', p], cwd);
    assert.equal(r.status, 1, `stdout: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(`is ${size} bytes; the cap is ${REPORT_CAP}`));
    assert.match(r.stderr, /declare-artifact/);
    assert.doesNotMatch(r.stderr, /cannot read report file/, 'the cap verdict, not a read failure');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run report --file: one byte over the cap is refused; at-or-under the cap passes the reader', () => {
  const cwd = tmp('run-cap-edge-');
  try {
    setupLocal(cwd);
    const over = join(cwd, 'over.md');
    writeFileSync(over, 'x'.repeat(REPORT_CAP + 1), 'utf8');
    const bad = runCli(['run', 'report', '--run', 'run-edge', '--file', over], cwd);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, new RegExp(`the cap is ${REPORT_CAP}`));

    const under = join(cwd, 'under.md');
    writeFileSync(under, 'y'.repeat(4096), 'utf8');
    const ok = runCli(['run', 'report', '--run', 'run-edge', '--file', under, '--json'], cwd);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /"bytes":4096/);

    // Exactly at the cap is accepted BY THE READER. A distinct run id — one
    // report per run is the sealed identity, and a second differing report on
    // the same run is (correctly) a ConflictError.
    const exact = join(cwd, 'exact.md');
    writeFileSync(exact, 'z'.repeat(REPORT_CAP), 'utf8');
    const atCap = runCli(['run', 'report', '--run', 'run-edge-at-cap', '--file', exact, '--json'], cwd);
    assert.equal(atCap.status, 0, `${atCap.stdout}${atCap.stderr}`);
    assert.match(atCap.stdout, new RegExp(`"bytes":${REPORT_CAP}`));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── round-10 finding 2: the advertised cap must be ACHIEVABLE end-to-end ─────
//
// The reader used to accept exactly 1 MiB while the local JSONL ledger applied
// the SAME 1 MiB limit to the entire serialized record — envelope, sanitized
// index projection, and JSON escaping included — so a report that passed the
// documented cap was rejected downstream by a differently-worded error, and a
// quote-heavy report failed well below the advertised number. The cap is now
// derived from what the strictest backend can store, and this test pins the
// guarantee for the WORST-CASE byte sequences, not just for benign prose.
const WORST_CASE_PAYLOADS: ReadonlyArray<{ name: string; byte: number }> = [
  // 6× expansion: every byte escapes to \u00XX — the true JSON worst case.
  { name: 'nul-bytes', byte: 0x00 },
  // 2× expansion, and the case the review called out by name.
  { name: 'quotes', byte: 0x22 },
  // 2× expansion via backslash escaping.
  { name: 'backslashes', byte: 0x5c },
];

for (const payload of WORST_CASE_PAYLOADS) {
  test(`run report --file: a ${payload.name} report at EXACTLY the advertised cap is accepted by the reader AND stored by the local ledger`, () => {
    const cwd = tmp(`run-cap-e2e-${payload.name}-`);
    try {
      setupLocal(cwd);
      const p = join(cwd, 'worst.md');
      writeFileSync(p, Buffer.alloc(REPORT_CAP, payload.byte));

      const r = runCli(['run', 'report', '--run', 'run-e2e', '--file', p, '--json'], cwd);
      assert.equal(r.status, 0, `the advertised cap must be storable: ${r.stdout}${r.stderr}`);
      const out = JSON.parse(r.stdout) as { ok: boolean; bytes: number; outcome: string };
      assert.equal(out.ok, true);
      assert.equal(out.bytes, REPORT_CAP, 'the whole raw report was read');
      assert.equal(out.outcome, 'committed', 'and COMMITTED — not rejected by the record limit');
      assert.doesNotMatch(r.stderr, /record limit/, 'never the ledger record-limit refusal');

      // And the run really carries it: show reconstructs the event, and its
      // (large) --json payload survives the pipe intact — process.exit() used to
      // discard the tail of an async stdout write, delivering invalid JSON.
      const show = runCli(['run', 'show', 'run-e2e', '--json'], cwd);
      assert.equal(show.status, 0, show.stderr);
      const composed = JSON.parse(show.stdout) as { run: { report: { data: string } | null } };
      assert.equal(
        Buffer.byteLength(composed.run.report?.data ?? '', 'utf8'),
        REPORT_CAP,
        'the stored report reads back whole — every byte of the advertised cap',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

// The derivation itself, machine-checked against the two constants it depends
// on — so raising MAX_INDEX_TEXT or lowering MAX_RECORD_BYTES fails HERE rather
// than silently re-opening the mismatch.
test('the advertised report cap provably fits the strictest backend record limit', () => {
  const JSON_ESCAPE_WORST_CASE = 6;
  const envelopeAndChain = 8 * 1024; // ids, hash chain, kind, producer, timestamps
  const worstCaseRecord =
    JSON_ESCAPE_WORST_CASE * MAX_REPORT_BYTES + JSON_ESCAPE_WORST_CASE * MAX_INDEX_TEXT + envelopeAndChain;
  assert.ok(
    worstCaseRecord <= MAX_RECORD_BYTES,
    `worst-case record ${worstCaseRecord} B must fit the ${MAX_RECORD_BYTES} B ledger limit`,
  );
});

test('run report --stdin: the cap is pushed DOWN into the reader (bounded), and over-cap fails', async () => {
  const cwd = tmp('run-cap-stdin-');
  try {
    setupLocal(cwd);
    let askedFor: number | undefined = -1;
    await assert.rejects(
      () =>
        executeRun('report', options({ cwd, runId: 'run-stdin', stdin: true }), {
          readStdin: async (maxBytes?: number) => {
            askedFor = maxBytes;
            // What a bounded reader returns for an endless pipe: one byte past
            // the cap. A pre-fix caller asked for (and buffered) everything.
            return Buffer.alloc((maxBytes ?? REPORT_CAP) + 1, 0x61);
          },
        }),
      new RegExp(`exceeds the ${REPORT_CAP}-byte cap`),
    );
    assert.equal(askedFor, REPORT_CAP, 'the reader is told the cap BEFORE it buffers');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('run event --stdin: the cap is pushed DOWN into the reader (bounded), and over-cap fails', async () => {
  const cwd = tmp('run-cap-event-');
  try {
    setupLocal(cwd);
    let askedFor: number | undefined = -1;
    await assert.rejects(
      () =>
        executeRun(
          'event',
          options({ cwd, runId: 'run-ev', eventKind: 'error', correlationId: 'c1', stdin: true }),
          {
            readStdin: async (maxBytes?: number) => {
              askedFor = maxBytes;
              return Buffer.alloc((maxBytes ?? REPORT_CAP) + 1, 0x61);
            },
          },
        ),
      new RegExp(`exceeds the ${REPORT_CAP}-byte cap`),
    );
    assert.equal(askedFor, REPORT_CAP, 'the reader is told the cap BEFORE it buffers');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('declare-artifact --stdin: artifact bytes keep their own UNBOUNDED policy (no report cap pushed down)', async () => {
  const cwd = tmp('run-cap-artifact-');
  try {
    setupLocal(cwd);
    const bytes = Buffer.from('artifact bytes past no cap', 'utf8');
    let askedFor: number | undefined = -1;
    const { code } = await capture(() =>
      executeRun(
        'declare-artifact',
        options({ cwd, runId: 'run-art', agent: 'gtm.sdr', digest: sha256Hex(bytes), stdin: true, json: true }),
        {
          readStdin: async (maxBytes?: number) => {
            askedFor = maxBytes;
            return bytes;
          },
        },
      ),
    );
    assert.equal(code, 0);
    assert.equal(askedFor, undefined, 'declare-artifact must NOT inherit the report cap');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
