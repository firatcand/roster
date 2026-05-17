import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[]): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function makeCwd(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-schedule-cli-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writeSchedules(root: string, fn: string, content: string): void {
  const dir = join(root, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'schedules.yaml'), content, 'utf8');
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
`;

const invalidYaml = `version: 1
schedules:
  - name: bad
    agent: sdr
    plan: cold-outreach
    cron: "0 9 * * 8"
    tool: gemini
    install_mode: via-cron
    status: installed
`;

test('schedule validate: empty cwd → exit 0, "no files" message', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /No roster.*schedules\.yaml files found/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: valid file → exit 0, PASS line', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', validYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /PASS/);
    assert.match(r.stdout, /All schedules valid/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: invalid file → exit 1 with field-level error for tool enum', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', invalidYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL/);
    assert.match(r.stdout, /tool: must be one of 'claude' \| 'codex'/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: invalid file → exit 1 with cron error', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', invalidYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /cron.*day-of-week/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate --json: valid → exit 0 with parseable ok=true', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', validYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root, '--json']);
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; files: { status: string }[] };
    assert.equal(payload.ok, true);
    assert.equal(payload.files.length, 1);
    assert.equal(payload.files[0]!.status, 'pass');
  } finally {
    fix.cleanup();
  }
});

test('schedule validate --json: invalid → exit 1 with ok=false and errors[]', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', invalidYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root, '--json']);
    assert.equal(r.status, 1);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      files: { status: string; errors: { path: string; message: string }[] }[];
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.files[0]!.status, 'fail');
    assert.ok(payload.files[0]!.errors.length >= 2);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate --silent: invalid → exit 1, no stdout', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', invalidYaml);
    const r = runCli(['schedule', 'validate', '--cwd', fix.root, '--silent']);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
  } finally {
    fix.cleanup();
  }
});

test('schedule (no subcommand): exits 1 with helpful message', () => {
  const r = runCli(['schedule']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing subcommand.*schedule/);
  assert.match(r.stderr, /available: validate/);
});

test('schedule garbage: exits 1 with unknown-subcommand error', () => {
  const r = runCli(['schedule', 'frobnicate']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown.*subcommand.*frobnicate/);
});

test('schedule validate --bogus-flag: exits 1', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['schedule', 'validate', '--cwd', fix.root, '--bogus']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag/);
  } finally {
    fix.cleanup();
  }
});

test('schedule validate: --cwd missing path argument errors', () => {
  const r = runCli(['schedule', 'validate', '--cwd']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--cwd requires a path/);
});

test('schedule validate: --cwd=path form is accepted', () => {
  const fix = makeCwd();
  try {
    writeSchedules(fix.root, 'gtm', validYaml);
    const r = runCli(['schedule', 'validate', `--cwd=${fix.root}`]);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  } finally {
    fix.cleanup();
  }
});

test('help text includes schedule validate', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /roster schedule validate/);
});
