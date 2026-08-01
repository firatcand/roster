import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve('src/bin/roster.ts');

type CliResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function runCli(root: string, args: readonly string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function fixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-cli-v2-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function json(result: CliResult): Record<string, unknown> {
  assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout was not JSON: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function init(root: string): void {
  const result = runCli(root, ['init', 'cli-test', '--silent']);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
}

test('spawned CLI dispatches scaffold, discover, and validate with stable JSON envelopes', () => {
  const fx = fixture();
  try {
    init(fx.root);
    const scaffold = runCli(fx.root, ['scaffold', 'function', 'gtm', '--purpose', 'Grow demand.', '--json']);
    assert.equal(scaffold.status, 0, scaffold.stderr);
    assert.deepEqual(
      { ok: json(scaffold)['ok'], status: json(scaffold)['status'] },
      { ok: true, status: 'created' },
    );
    const discover = runCli(fx.root, ['discover', 'gtm', '--kind', 'function', '--exact', '--json']);
    assert.equal(discover.status, 0, discover.stderr);
    const records = json(discover)['records'] as Array<Record<string, unknown>>;
    assert.equal(records[0]?.['qualified_id'], 'gtm');
    const validate = runCli(fx.root, ['validate', '--json']);
    assert.equal(validate.status, 0, `stdout: ${validate.stdout}\nstderr: ${validate.stderr}`);
    assert.equal(json(validate)['ok'], true);
  } finally {
    fx.cleanup();
  }
});

test('spawned CLI emits global JSON failure outside a workspace', () => {
  const fx = fixture();
  try {
    const result = runCli(fx.root, ['discover', '--json']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const envelope = json(result);
    assert.equal(envelope['ok'], false);
    assert.equal(envelope['code'], 'WORKSPACE_NOT_FOUND');
    assert.equal(typeof envelope['details'], 'object');
  } finally {
    fx.cleanup();
  }
});

test('spawned CLI reports invalid scaffold arguments as JSON', () => {
  const fx = fixture();
  try {
    init(fx.root);
    const result = runCli(fx.root, ['scaffold', 'agent', 'social', '--json']);
    assert.equal(result.status, 1);
    const envelope = json(result);
    assert.equal(envelope['ok'], false);
    assert.equal(envelope['code'], 'INVALID_ARGS');
  } finally {
    fx.cleanup();
  }
});

test('spawned doctor rejects unknown arguments with the global JSON envelope', () => {
  const fx = fixture();
  try {
    const result = runCli(fx.root, ['doctor', '--bogus', '--json']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    const envelope = json(result);
    assert.equal(envelope['ok'], false);
    assert.equal(envelope['code'], 'INVALID_ARGS');
    assert.match(String(envelope['message']), /unknown flag '--bogus'/);
  } finally {
    fx.cleanup();
  }
});

test('public help documents ratified v2 aliases without advertising --tool all', () => {
  const fx = fixture();
  try {
    const result = runCli(fx.root, ['--help']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /init \[workspace-id\] \[--name <workspace-id>\]/);
    assert.match(result.stdout, /--function <function-id>/);
    assert.match(result.stdout, /--agent <function\/agent>/);
    assert.doesNotMatch(result.stdout, /alias of --tool all/);
  } finally {
    fx.cleanup();
  }
});

test('spawned exact discovery fails closed on ambiguous bare identities', () => {
  const fx = fixture();
  try {
    init(fx.root);
    for (const functionId of ['gtm', 'support']) {
      assert.equal(runCli(fx.root, ['scaffold', 'function', functionId, '--json']).status, 0);
      assert.equal(runCli(fx.root, [
        'scaffold',
        'agent',
        'manager',
        '--scope',
        `function:${functionId}`,
        '--json',
      ]).status, 0);
    }
    const result = runCli(fx.root, ['discover', 'manager', '--kind', 'agent', '--exact', '--json']);
    assert.equal(result.status, 1);
    const envelope = json(result);
    assert.equal(envelope['code'], 'IDENTITY_AMBIGUOUS');
    assert.equal((envelope['details'] as { candidates: unknown[] }).candidates.length, 2);
  } finally {
    fx.cleanup();
  }
});

test('spawned validate returns nonzero for structural orphan diagnostics', () => {
  const fx = fixture();
  try {
    init(fx.root);
    assert.equal(runCli(fx.root, ['scaffold', 'function', 'gtm', '--json']).status, 0);
    mkdirSync(join(fx.root, 'functions', 'rogue'), { recursive: true });
    const result = runCli(fx.root, ['validate', '--json']);
    assert.equal(result.status, 1);
    const envelope = json(result);
    assert.equal(envelope['ok'], false);
    assert.ok((envelope['diagnostics'] as Array<{ code: string }>).some((entry) => entry.code === 'UNREGISTERED_RECORD'));
  } finally {
    fx.cleanup();
  }
});
