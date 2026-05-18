import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve(process.cwd(), 'bin/roster.js');

function withTmpCwd<T>(fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-cli-pendingsync-'));
  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function writeMinimalCodexSchedule(cwd: string) {
  const fnDir = join(cwd, 'roster', 'gtm');
  mkdirSync(fnDir, { recursive: true });
  writeFileSync(
    join(fnDir, 'schedules.yaml'),
    [
      'version: 1',
      'schedules:',
      '  - name: sdr',
      '    agent: sdr',
      '    plan: cold',
      '    project: _demo',
      "    cron: '0 9 * * 1-5'",
      '    tool: codex',
      '    install_mode: via-cron',
      '    status: installed',
      '    subscription_attestation:',
      '      auth_mode: chatgpt',
      '      env_policy: cleared',
      '      codex_home: /Users/x/.codex',
      '',
    ].join('\n'),
    'utf8',
  );
}

function writeExitOne(cwd: string, name: string) {
  mkdirSync(join(cwd, 'logs', 'cron'), { recursive: true });
  writeFileSync(join(cwd, 'logs', 'cron', `${name}.exit`), '1', 'utf8');
}

test('cli: roster pending sync --json --cwd <tmp> on empty workspace → ok, inspected=0', () => {
  withTmpCwd((cwd) => {
    const r = spawnSync(process.execPath, [BIN, 'pending', 'sync', '--json', '--cwd', cwd], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.inspected, 0);
    assert.deepEqual(payload.written, []);
  });
});

test('cli: roster pending sync on failed-exit → writes pending file, exits 0', () => {
  withTmpCwd((cwd) => {
    writeMinimalCodexSchedule(cwd);
    writeExitOne(cwd, 'sdr');
    const r = spawnSync(process.execPath, [BIN, 'pending', 'sync', '--json', '--cwd', cwd], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.written.length, 1);
    assert.equal(payload.written[0].reason, 'failed-exit');
    assert.ok(existsSync(payload.written[0].path));
  });
});

test('cli: roster pending sync --dry-run reports the would-write but no file lands', () => {
  withTmpCwd((cwd) => {
    writeMinimalCodexSchedule(cwd);
    writeExitOne(cwd, 'sdr');
    const r = spawnSync(process.execPath, [BIN, 'pending', 'sync', '--json', '--dry-run', '--cwd', cwd], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.written.length, 1);
    assert.ok(!existsSync(payload.written[0].path), 'dry-run must not write');
  });
});

test('cli: roster pending sync --silent suppresses non-error output', () => {
  withTmpCwd((cwd) => {
    const r = spawnSync(process.execPath, [BIN, 'pending', 'sync', '--silent', '--cwd', cwd], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});

test('cli: roster pending without subcommand → error with hint', () => {
  const r = spawnSync(process.execPath, [BIN, 'pending'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing subcommand/);
});

test('cli: roster pending unknown-sub → error', () => {
  const r = spawnSync(process.execPath, [BIN, 'pending', 'unknown'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown pending subcommand/);
});
