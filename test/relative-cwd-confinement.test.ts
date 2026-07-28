import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfinedPath, targetWithinWorkspace, confinedFunctionDir } from '../src/lib/workspace-path.ts';

// ═════════════════════════════════════════════════════════════════════════════
// ROUND-13 finding 1: a RELATIVE --cwd made confinement inspect a path nobody
// would ever open.
//
// resolveConfinedPath resolved a relative TARGET beneath a relative BOUNDARY,
// so with process cwd /parent and `--cwd repo` the caller's already-prefixed
// `repo/roster/…` became `/parent/repo/repo/roster/…`. Confinement inspected
// that phantom path while every caller afterwards opened `/parent/repo/…`:
//   - `run list --cwd repo` reported NO local runs,
//   - `run start --cwd repo` saw meta.json as ABSENT and replaced the tree's
//     producer identity,
//   - a symlinked component on the REAL path was never walked, so the round-12
//     class fix was bypassed entirely under a relative --cwd.
//
// The fix is an INVARIANT, not a patch: every --cwd parse site normalizes to an
// absolute path and workspace-path.ts REFUSES a relative boundary/target
// outright, so double-prefixing is structurally impossible.
// ═════════════════════════════════════════════════════════════════════════════

const BIN = resolve('src/bin/roster.ts');
const posixOnly = process.platform === 'win32' ? 'POSIX only (symlinks)' : false;

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd: string): Run {
  const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

// A codex via-cron entry, so the workspace also owns the per-fire exit channel
// `pending sync` reads.
const SCHEDULES_YAML = `version: 1
schedules:
  - name: gtm-nightly
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: via-cron
    status: installed
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/x/.codex
`;

// A workspace one level BELOW the process cwd the CLI is invoked from, so the
// command runs as `roster … --cwd repo` from /parent.
type Fixture = { parent: string; ws: string; cleanup: () => void };

function makeWorkspace(prefix: string): Fixture {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const ws = join(parent, 'repo');
  mkdirSync(join(ws, 'roster', 'gtm', 'pending'), { recursive: true });
  writeFileSync(join(ws, 'roster', 'gtm', 'schedules.yaml'), SCHEDULES_YAML, 'utf8');
  writeFileSync(
    join(ws, 'roster', 'gtm', 'pending', 'decide-1.md'),
    '---\ntitle: a decision\n---\nbody\n',
    'utf8',
  );
  return { parent, ws, cleanup: () => rmSync(parent, { recursive: true, force: true }) };
}

function makeOpsWorkspace(prefix: string): Fixture {
  const fx = makeWorkspace(prefix);
  const setup = runCli(['ops', 'setup', '--backend', 'local', '--name', 'acme', '--json'], fx.ws);
  assert.equal(setup.status, 0, setup.stderr);
  return fx;
}

function treeDirOf(ws: string): string {
  const opsRoot = join(ws, '.roster', 'ops');
  const entries = readdirSync(opsRoot).filter((e) => !e.startsWith('.'));
  assert.equal(entries.length, 1, `exactly one ledger tree under ${opsRoot}`);
  return join(opsRoot, entries[0]!);
}

// ── the primitive's invariant ────────────────────────────────────────────────

test('workspace-path: a RELATIVE boundary is refused outright, never silently re-prefixed', () => {
  assert.throws(
    () => resolveConfinedPath(join('repo', 'roster'), 'repo'),
    /absolute/,
    'a relative boundary must throw, not resolve the target a second time beneath itself',
  );
  assert.throws(() => targetWithinWorkspace(resolve('repo', 'roster'), 'repo'), /absolute/);
  assert.throws(() => confinedFunctionDir('repo', 'gtm'), /absolute/);
});

test('workspace-path: a RELATIVE target is refused by the primitive (callers pass absolute paths)', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-relcwd-unit-'));
  try {
    assert.throws(() => resolveConfinedPath('roster/gtm', root), /absolute/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── run ledger ───────────────────────────────────────────────────────────────

test('run list --cwd <relative> sees the workspace runs (not a phantom double-prefixed tree)', () => {
  const fx = makeOpsWorkspace('roster-relcwd-list-');
  try {
    assert.equal(runCli(['run', 'start', 'r-abs', '--agent', 'gtm.sdr', '--json'], fx.ws).status, 0);

    const rel = runCli(['run', 'list', '--json', '--cwd', 'repo'], fx.parent);
    assert.equal(rel.status, 0, rel.stderr);
    const runs = (JSON.parse(rel.stdout) as { runs: { runId: string }[] }).runs;
    assert.deepEqual(runs.map((r) => r.runId), ['r-abs'], 'a relative --cwd must list the SAME runs as an absolute one');
  } finally {
    fx.cleanup();
  }
});

test('run start --cwd <relative> PRESERVES the ledger producer identity (never replaces meta.json)', () => {
  const fx = makeOpsWorkspace('roster-relcwd-start-');
  try {
    assert.equal(runCli(['run', 'start', 'r-abs', '--agent', 'gtm.sdr', '--json'], fx.ws).status, 0);
    const metaPath = join(treeDirOf(fx.ws), 'meta.json');
    const before = JSON.parse(readFileSync(metaPath, 'utf8')) as { producerId: string; workspaceId: string };

    const rel = runCli(['run', 'start', 'r-rel', '--agent', 'gtm.sdr', '--json', '--cwd', 'repo'], fx.parent);
    assert.equal(rel.status, 0, rel.stderr);

    const after = JSON.parse(readFileSync(metaPath, 'utf8')) as { producerId: string; workspaceId: string };
    assert.equal(after.producerId, before.producerId, 'the producer identity must survive a relative --cwd');
    assert.equal(after.workspaceId, before.workspaceId);

    // …and the run landed in the SAME ledger, not a second one.
    const list = runCli(['run', 'list', '--json'], fx.ws);
    assert.equal(list.status, 0, list.stderr);
    const ids = (JSON.parse(list.stdout) as { runs: { runId: string }[] }).runs.map((r) => r.runId).sort();
    assert.deepEqual(ids, ['r-abs', 'r-rel']);
    assert.equal(readdirSync(join(fx.ws, '.roster', 'ops')).filter((e) => !e.startsWith('.')).length, 1);
  } finally {
    fx.cleanup();
  }
});

// ── the other --cwd consumers ────────────────────────────────────────────────

test('review --cwd <relative> lists the workspace pending items', () => {
  const fx = makeWorkspace('roster-relcwd-review-');
  try {
    const rel = runCli(['review', '--json', '--cwd', 'repo'], fx.parent);
    assert.equal(rel.status, 0, rel.stderr);
    const items = JSON.parse(rel.stdout) as { function: string; filename: string }[];
    assert.deepEqual(items.map((i) => `${i.function}/${i.filename}`), ['gtm/decide-1.md']);
  } finally {
    fx.cleanup();
  }
});

test('schedule validate --cwd <relative> finds the workspace registries', () => {
  const fx = makeWorkspace('roster-relcwd-validate-');
  try {
    const rel = runCli(['schedule', 'validate', '--json', '--cwd', 'repo'], fx.parent);
    assert.equal(rel.status, 0, rel.stderr);
    const report = JSON.parse(rel.stdout) as { ok: boolean; files: { entryCount: number }[] };
    assert.equal(report.ok, true);
    assert.deepEqual(report.files.map((f) => f.entryCount), [1], 'a relative --cwd must validate the real registry');
  } finally {
    fx.cleanup();
  }
});

test('pending sync --cwd <relative> resolves the workspace, not a phantom sibling', () => {
  const fx = makeWorkspace('roster-relcwd-pending-');
  try {
    const exitDir = join(fx.ws, 'logs', 'cron', 'gtm', 'gtm-nightly');
    mkdirSync(exitDir, { recursive: true });
    writeFileSync(join(exitDir, 'fire1.exit'), '1\n', 'utf8');

    const rel = runCli(['pending', 'sync', '--json', '--cwd', 'repo'], fx.parent);
    assert.equal(rel.status, 0, rel.stderr);
    const report = JSON.parse(rel.stdout) as { written: unknown[] };
    assert.equal(report.written.length, 1, 'the failed fire is synthesized into the REAL workspace');
    assert.equal(readdirSync(join(fx.ws, 'roster', 'gtm', 'pending')).length, 2);
  } finally {
    fx.cleanup();
  }
});

// ── the round-12 class fix must still apply under a relative --cwd ───────────

test(
  'a symlinked component on the REAL path is still refused under a relative --cwd',
  { skip: posixOnly },
  () => {
    const fx = makeWorkspace('roster-relcwd-symlink-');
    try {
      // Divert roster/gtm/pending at an in-workspace directory holding a
      // planted item — the exact round-12 shape, now reached via `--cwd repo`.
      const planted = join(fx.ws, 'archive', 'pending');
      mkdirSync(planted, { recursive: true });
      writeFileSync(join(planted, 'planted.md'), '---\ntitle: planted\n---\n', 'utf8');
      rmSync(join(fx.ws, 'roster', 'gtm', 'pending'), { recursive: true, force: true });
      symlinkSync(planted, join(fx.ws, 'roster', 'gtm', 'pending'));

      const rel = runCli(['review', '--json', '--cwd', 'repo'], fx.parent);
      assert.equal(rel.status, 0, rel.stderr);
      assert.deepEqual(JSON.parse(rel.stdout), [], 'nothing is listed through the symlinked component');
      assert.match(rel.stderr, /symlinked path component/);
    } finally {
      fx.cleanup();
    }
  },
);
