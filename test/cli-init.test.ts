import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

function runCli(
  args: readonly string[],
  cwd: string,
  envOverrides: Record<string, string> = {},
): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, ...envOverrides, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

test('roster init in a dir with existing CLAUDE.md and closed stdin exits 2 with "Nothing written."', () => {
  // With stdin: 'ignore', inquirer's confirm() rejects → executeInit returns
  // status: 'cancelled' → runner renders userCancelledInit() → exit 2.
  const cwd = mkdtempSync(join(tmpdir(), 'roster-cli-init-cancel-'));
  try {
    writeFileSync(join(cwd, 'CLAUDE.md'), '# pre-existing\n', 'utf8');
    const r = runCli(['init', 'foo', '--silent', '--no-git'], cwd);
    assert.equal(r.status, 2, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stderr, /Nothing written\./);
    // No stack trace without --debug.
    assert.doesNotMatch(r.stderr, /\bat\s+.+:\d+:\d+\)/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('roster init --debug on cancellation includes a stack trace', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-cli-init-cancel-debug-'));
  try {
    writeFileSync(join(cwd, 'CLAUDE.md'), '# pre-existing\n', 'utf8');
    const r = runCli(['init', 'foo', '--silent', '--no-git', '--debug'], cwd);
    assert.equal(r.status, 2, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stderr, /Nothing written\./);
    assert.match(r.stderr, /\bat\s+.+:\d+:\d+\)/, 'stack frame present with --debug');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
