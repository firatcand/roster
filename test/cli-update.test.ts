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

test('update: in a workspace runs install + hooks + upgrade, exit 0', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-'));
  const claudeHome = join(root, '.h-claude');
  const fakeHome = join(root, '.home');
  mkdirSync(claudeHome, { recursive: true }); // makes claude "detected"
  mkdirSync(fakeHome, { recursive: true });
  try {
    // Scaffold a real workspace first.
    assert.equal(runCli(['init', 'tw', '--no-git', '--silent'], root).status, 0);
    const env = { HOME: fakeHome, ROSTER_CLAUDE_HOME: claudeHome };
    const r = runCli(['update'], root, env);
    assert.equal(r.status, 0, r.stderr);
    // Step 1 installed roster's skills project-local (incl. inbox).
    assert.ok(existsSync(join(root, '.claude', 'skills', 'inbox', 'SKILL.md')), 'inbox skill installed project-local');
    // Step 3 ran upgrade → seeded the scaffold manifest.
    assert.ok(existsSync(join(root, '.roster', 'scaffold-manifest.json')), 'upgrade seeded the manifest');
    // Output mentions the three steps + the CLI-bump reminder.
    assert.match(r.stdout, /Skills \+ agents/);
    assert.match(r.stdout, /Scaffold files/);
    assert.match(r.stdout, /npm i -g @firatcand\/roster@latest/);
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
