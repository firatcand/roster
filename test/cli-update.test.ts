import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd: string, env: Record<string, string> = {}): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

test('update: in a v2 workspace synchronizes only enabled generated activation', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-'));
  const claudeHome = join(root, '.h-claude');
  const fakeHome = join(root, '.home');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  try {
    // Scaffold a real workspace first.
    assert.equal(runCli(['init', 'tw', '--silent'], root).status, 0);
    const env = { HOME: fakeHome, ROSTER_CLAUDE_HOME: claudeHome };
    const install = runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], root, env);
    assert.equal(install.status, 0, install.stderr);
    rmSync(join(root, '.claude', 'CLAUDE.md'));
    const r = runCli(['update'], root, env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(root, '.claude', 'CLAUDE.md')), 'missing generated activation is recreated');
    assert.ok(existsSync(join(root, '.roster', 'generated-manifest.json')), 'portable generated manifest exists');
    assert.equal(existsSync(join(root, '.roster', 'scaffold-manifest.json')), false);
    assert.equal(existsSync(join(root, '.claude', 'skills', 'inbox', 'SKILL.md')), false);
    assert.match(r.stdout, /v2 generated activation/);
    assert.doesNotMatch(r.stdout, /Founder skills|Scaffold files|hooks/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: outside a workspace → refuses (non-zero)', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-bare-'));
  try {
    const r = runCli(['update'], root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires a roster workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: unknown flag → exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-flag-'));
  try {
    const r = runCli(['update', '--bogus'], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: removed --exclude flag fails loudly instead of becoming a no-op', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-exclude-'));
  try {
    const r = runCli(['update', '--exclude', 'guidelines'], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag '--exclude'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
