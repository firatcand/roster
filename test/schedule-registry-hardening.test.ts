import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readExistingSchedulesDoc } from '../src/lib/schedule-yaml.ts';
import { validateSchedulesInCwd } from '../src/lib/schedule-validate.ts';
import { scanPending } from '../src/lib/pending.ts';

// Round-9 finding 1: the round-8 hardened-reader sweep left three SIBLING
// readers of roster/<fn>/schedules.yaml on a plain, symlink-following,
// unbounded readFileSync — schedule-yaml.ts (schedule install/remove),
// doctor.ts (prompt-leak entry listing), and schedule-validate.ts. The registry
// lives in the workspace a sandboxed agent can write, so a planted FIFO BLOCKED
// `roster schedule install` and `roster doctor` FOREVER instead of reporting
// malformed evidence, and a symlink diverted the read past the no-follow policy
// the rest of the sweep enforces.
//
// Every test here spawns with a TIMEOUT and asserts `signal === null`: a hang
// fails as a hang, not merely as a wrong message.

const BIN = resolve('src/bin/roster.ts');
const posixOnly = process.platform === 'win32' ? 'POSIX only (mkfifo)' : false;

type Run = { status: number; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd?: string, env: Record<string, string> = {}): Run {
  const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ROSTER_PLATFORM: 'darwin', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return { status: out.status ?? -1, signal: out.signal, stdout: out.stdout, stderr: out.stderr };
}

// doctor has no --cwd flag: it audits process.cwd(), and it only reaches the
// workspace sections once at least one tool config root is detected.
function doctorInWorkspace(root: string): Run {
  const homes = mkdtempSync(join(tmpdir(), 'roster-registry-homes-'));
  try {
    mkdirSync(join(homes, 'claude'), { recursive: true });
    return runCli(['doctor'], root, {
      ROSTER_CLAUDE_HOME: join(homes, 'claude'),
      ROSTER_CODEX_HOME: join(homes, 'codex'),
      ROSTER_GEMINI_HOME: join(homes, 'gemini'),
    });
  } finally {
    rmSync(homes, { recursive: true, force: true });
  }
}

function makeCwd(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-registry-hard-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function plantFifo(path: string): void {
  const mk = spawnSync('mkfifo', [path]);
  assert.equal(mk.status, 0, 'mkfifo available on POSIX');
}

const validYaml = `version: 1
schedules:
  - name: cold-outreach-daily
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 1-5"
    tool: codex
    install_mode: via-cron
    status: installed
    subscription_attestation:
      auth_mode: chatgpt
      env_policy: cleared
      codex_home: /Users/test/.codex
`;

const installArgs = (root: string): string[] => [
  'schedule',
  'install',
  'gtm/sdr',
  'cold-outreach',
  '--cron',
  '0 9 * * 1-5',
  '--tool',
  'claude',
  '--cwd',
  root,
];

function assertNoHang(r: Run, what: string): void {
  assert.equal(r.signal, null, `${what}: must fail fast — a hostile registry shape may never block the reader`);
}

// ── FIFO ────────────────────────────────────────────────────────────────────

test('schedule install: a FIFO at schedules.yaml fails fast with its OWN actionable error', { timeout: 30000, skip: posixOnly }, () => {
  const fix = makeCwd();
  try {
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    plantFifo(join(fix.root, 'roster', 'gtm', 'schedules.yaml'));
    const r = runCli(installArgs(fix.root));
    assertNoHang(r, 'schedule install');
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /cannot read existing schedules\.yaml/);
    assert.match(r.stderr, /not a regular file|not-a-regular-file/);
  } finally {
    fix.cleanup();
  }
});

test('doctor: a FIFO at schedules.yaml fails fast with its OWN actionable error', { timeout: 30000, skip: posixOnly }, () => {
  const fix = makeCwd();
  try {
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    plantFifo(join(fix.root, 'roster', 'gtm', 'schedules.yaml'));
    const r = doctorInWorkspace(fix.root);
    assertNoHang(r, 'doctor');
    assert.match(r.stdout, /roster\/gtm\/schedules\.yaml/);
    assert.match(r.stdout, /FAIL/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: a FIFO at schedules.yaml fails fast with its OWN actionable error', { timeout: 30000, skip: posixOnly }, () => {
  const fix = makeCwd();
  try {
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    plantFifo(join(fix.root, 'roster', 'gtm', 'schedules.yaml'));
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assertNoHang(r, 'schedule validate');
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /FAIL/);
    assert.match(r.stdout, /regular file/);
  } finally {
    fix.cleanup();
  }
});

// ── symlink ─────────────────────────────────────────────────────────────────

test('schedule install: a SYMLINKED schedules.yaml is refused (no-follow policy)', { timeout: 30000, skip: posixOnly }, () => {
  const fix = makeCwd();
  try {
    const real = join(fix.root, 'elsewhere.yaml');
    writeFileSync(real, validYaml, 'utf8');
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    symlinkSync(real, join(fix.root, 'roster', 'gtm', 'schedules.yaml'));
    const r = runCli(installArgs(fix.root));
    assertNoHang(r, 'schedule install');
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /cannot read existing schedules\.yaml/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: a SYMLINKED schedules.yaml is refused (no-follow policy)', { timeout: 30000, skip: posixOnly }, () => {
  const fix = makeCwd();
  try {
    const real = join(fix.root, 'elsewhere.yaml');
    writeFileSync(real, validYaml, 'utf8');
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    symlinkSync(real, join(fix.root, 'roster', 'gtm', 'schedules.yaml'));
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assertNoHang(r, 'schedule validate');
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /FAIL/);
  } finally {
    fix.cleanup();
  }
});

test('doctor: a SYMLINKED schedules.yaml is refused (no-follow policy)', { timeout: 30000, skip: posixOnly }, () => {
  const fix = makeCwd();
  try {
    const real = join(fix.root, 'elsewhere.yaml');
    writeFileSync(real, validYaml, 'utf8');
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    symlinkSync(real, join(fix.root, 'roster', 'gtm', 'schedules.yaml'));
    const r = doctorInWorkspace(fix.root);
    assertNoHang(r, 'doctor');
    assert.match(r.stdout, /roster\/gtm\/schedules\.yaml/);
    assert.match(r.stdout, /FAIL/);
  } finally {
    fix.cleanup();
  }
});

// ── unit level: each caller keeps its own error semantics ───────────────────

test('readExistingSchedulesDoc: an OVERSIZED registry is refused, not loaded', () => {
  const fix = makeCwd();
  try {
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    const path = join(fix.root, 'roster', 'gtm', 'schedules.yaml');
    writeFileSync(path, 'x'.repeat(1024 * 1024 + 10), 'utf8');
    assert.throws(
      () => readExistingSchedulesDoc(path, fix.root),
      (err: Error) => /cannot read existing schedules\.yaml/.test(String((err as { header?: string }).header ?? err.message)),
    );
  } finally {
    fix.cleanup();
  }
});

test('validateSchedulesInCwd: an OVERSIZED registry reports a per-file read error (never loaded)', () => {
  const fix = makeCwd();
  try {
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    writeFileSync(join(fix.root, 'roster', 'gtm', 'schedules.yaml'), 'y'.repeat(1024 * 1024 + 10), 'utf8');
    const report = validateSchedulesInCwd(fix.root);
    assert.equal(report.ok, false);
    assert.equal(report.files[0]!.status, 'fail');
    assert.match(report.files[0]!.errors[0]!.message, /cannot read file: oversized/);
  } finally {
    fix.cleanup();
  }
});

// Pending items are the other agent-writable evidence class read by the CLI
// (the SessionStart banner counts them on every chat start). Bound that read
// too — an oversized item is skipped exactly like today's unreadable one,
// instead of being pulled wholly into memory.
test('scanPending: an OVERSIZED pending item is skipped, never loaded whole', () => {
  const fix = makeCwd();
  try {
    const dir = join(fix.root, 'roster', 'gtm', 'pending');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ok.md'), '---\nid: a\n---\nbody\n', 'utf8');
    writeFileSync(join(dir, 'huge.md'), 'z'.repeat(4 * 1024 * 1024 + 10), 'utf8');
    const items = scanPending(fix.root);
    assert.deepEqual(
      items.map((i) => i.filename),
      ['ok.md'],
    );
  } finally {
    fix.cleanup();
  }
});
