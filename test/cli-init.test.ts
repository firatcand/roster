import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd: string): Run {
  const output = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );
  return {
    status: output.status ?? -1,
    stdout: output.stdout,
    stderr: output.stderr,
  };
}

function temporaryWorkspace(prefix: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('roster init creates only the sparse v2 files', () => {
  const { root, cleanup } = temporaryWorkspace('roster-cli-init');
  try {
    const result = runCli(['init', 'acme', '--silent'], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.deepEqual(readdirSync(root).sort(), ['ROSTER.md', 'roster.yaml']);
    assert.match(readFileSync(join(root, 'roster.yaml'), 'utf8'), /^workspace_id: acme$/m);
  } finally {
    cleanup();
  }
});

test('roster init accepts matching positional and --name identities', () => {
  const { root, cleanup } = temporaryWorkspace('roster-cli-name');
  try {
    const result = runCli(['init', 'acme', '--name', 'acme', '--silent'], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(readFileSync(join(root, 'roster.yaml'), 'utf8'), /^workspace_id: acme$/m);
  } finally {
    cleanup();
  }
});

test('roster init rejects disagreeing positional and --name identities before writing', () => {
  const { root, cleanup } = temporaryWorkspace('roster-cli-name-conflict');
  try {
    const result = runCli(['init', 'first', '--name', 'second', '--silent'], root);
    assert.equal(result.status, 1, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stderr, /identity arguments disagree/i);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    cleanup();
  }
});

test('roster init preserves unrelated repository files', () => {
  const { root, cleanup } = temporaryWorkspace('roster-cli-existing');
  try {
    writeFileSync(join(root, 'README.md'), '# existing\n');
    const result = runCli(['init', 'acme', '--silent'], root);
    assert.equal(result.status, 0, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), '# existing\n');
    assert.deepEqual(readdirSync(root).sort(), ['README.md', 'ROSTER.md', 'roster.yaml']);
  } finally {
    cleanup();
  }
});

test('roster init refuses a legacy workspace with migration guidance and exit 1', () => {
  const { root, cleanup } = temporaryWorkspace('roster-cli-legacy');
  try {
    mkdirSync(join(root, 'config'));
    writeFileSync(join(root, 'config', 'project.yaml'), 'name: legacy\n');
    const result = runCli(['init', 'acme', '--silent'], root);
    assert.equal(result.status, 1, `stderr: ${result.stderr}\nstdout: ${result.stdout}`);
    assert.match(result.stderr, /Roster v1 workspace/i);
    assert.match(result.stderr, /#363/);
    assert.ok(!readdirSync(root).includes('roster.yaml'));
  } finally {
    cleanup();
  }
});

test('removed eager-init flags fail instead of enabling overwrite or migration behavior', () => {
  for (const flag of ['--force', '--migrate', '--no-git', '--skip-git']) {
    const { root, cleanup } = temporaryWorkspace('roster-cli-removed-flag');
    try {
      const result = runCli(['init', 'acme', flag, '--silent'], root);
      assert.equal(result.status, 1, `${flag}: stderr: ${result.stderr}\nstdout: ${result.stdout}`);
      assert.match(result.stderr, /unsupported.*init|unknown.*flag|usage/i);
      assert.deepEqual(readdirSync(root), []);
    } finally {
      cleanup();
    }
  }
});
