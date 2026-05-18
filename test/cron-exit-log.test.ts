import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readExitRecord,
  scanExitRecords,
  exitPathFor,
  logPathFor,
  eventsPathFor,
} from '../src/lib/cron-exit-log.ts';

function withTmpCwd<T>(fn: (cwd: string) => T): T {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-exitlog-'));
  try {
    return fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function makeExit(cwd: string, name: string, content: string): string {
  mkdirSync(join(cwd, 'logs', 'cron'), { recursive: true });
  const p = exitPathFor(cwd, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ── path helpers ──────────────────────────────────────────────────────────

test('exitPathFor: composes <cwd>/logs/cron/<name>.exit', () => {
  assert.equal(exitPathFor('/work', 'sdr'), '/work/logs/cron/sdr.exit');
});

test('logPathFor: composes <cwd>/logs/cron/<name>.log', () => {
  assert.equal(logPathFor('/work', 'sdr'), '/work/logs/cron/sdr.log');
});

test('eventsPathFor: composes <cwd>/logs/cron/<name>.events.jsonl', () => {
  assert.equal(eventsPathFor('/work', 'sdr'), '/work/logs/cron/sdr.events.jsonl');
});

// ── readExitRecord ────────────────────────────────────────────────────────

test('readExitRecord: missing file → null', () => {
  withTmpCwd((cwd) => {
    const r = readExitRecord(exitPathFor(cwd, 'nope'));
    assert.equal(r, null);
  });
});

test('readExitRecord: "0" → exitCode 0', () => {
  withTmpCwd((cwd) => {
    const p = makeExit(cwd, 'sdr', '0');
    const r = readExitRecord(p);
    assert.ok(r);
    assert.equal(r.exitCode, 0);
    assert.equal(r.scheduleName, 'sdr');
    assert.equal(r.exitPath, p);
    assert.ok(r.mtimeMs > 0);
  });
});

test('readExitRecord: "137" → exitCode 137 (SIGKILL — codex OOM)', () => {
  withTmpCwd((cwd) => {
    const p = makeExit(cwd, 'sdr-cold', '137');
    const r = readExitRecord(p);
    assert.equal(r?.exitCode, 137);
  });
});

test('readExitRecord: trailing newline tolerated', () => {
  withTmpCwd((cwd) => {
    const p = makeExit(cwd, 'sdr', '1\n');
    const r = readExitRecord(p);
    assert.equal(r?.exitCode, 1);
  });
});

test('readExitRecord: empty file → exitCode null (race with writer)', () => {
  withTmpCwd((cwd) => {
    const p = makeExit(cwd, 'sdr', '');
    const r = readExitRecord(p);
    assert.ok(r);
    assert.equal(r.exitCode, null);
  });
});

test('readExitRecord: non-numeric content → exitCode null', () => {
  withTmpCwd((cwd) => {
    const p = makeExit(cwd, 'sdr', 'oops');
    const r = readExitRecord(p);
    assert.equal(r?.exitCode, null);
  });
});

test('readExitRecord: out-of-range integer → exitCode null', () => {
  withTmpCwd((cwd) => {
    const p = makeExit(cwd, 'sdr', '999');
    const r = readExitRecord(p);
    assert.equal(r?.exitCode, null);
  });
});

test('readExitRecord: filename without .exit suffix → null', () => {
  withTmpCwd((cwd) => {
    mkdirSync(join(cwd, 'logs', 'cron'), { recursive: true });
    const p = join(cwd, 'logs', 'cron', 'sdr.log');
    writeFileSync(p, '0', 'utf8');
    const r = readExitRecord(p);
    assert.equal(r, null);
  });
});

// ── scanExitRecords ───────────────────────────────────────────────────────

test('scanExitRecords: empty cwd → empty records', () => {
  withTmpCwd((cwd) => {
    const r = scanExitRecords(cwd);
    assert.equal(r.records.length, 0);
    assert.equal(r.dir, join(cwd, 'logs', 'cron'));
  });
});

test('scanExitRecords: missing logs/cron dir → empty', () => {
  withTmpCwd((cwd) => {
    mkdirSync(join(cwd, 'logs'), { recursive: true });
    const r = scanExitRecords(cwd);
    assert.equal(r.records.length, 0);
  });
});

test('scanExitRecords: multiple .exit files → all returned, sorted by name', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'beta', '1');
    makeExit(cwd, 'alpha', '0');
    makeExit(cwd, 'gamma', '2');
    const r = scanExitRecords(cwd);
    assert.equal(r.records.length, 3);
    assert.deepEqual(r.records.map((x) => x.scheduleName), ['alpha', 'beta', 'gamma']);
    assert.deepEqual(r.records.map((x) => x.exitCode), [0, 1, 2]);
  });
});

test('scanExitRecords: .log siblings ignored', () => {
  withTmpCwd((cwd) => {
    mkdirSync(join(cwd, 'logs', 'cron'), { recursive: true });
    writeFileSync(join(cwd, 'logs', 'cron', 'sdr.log'), 'log content', 'utf8');
    makeExit(cwd, 'sdr', '0');
    const r = scanExitRecords(cwd);
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0]!.scheduleName, 'sdr');
  });
});

test('scanExitRecords: malformed exit file included as exitCode=null', () => {
  withTmpCwd((cwd) => {
    makeExit(cwd, 'sdr', 'garbage');
    const r = scanExitRecords(cwd);
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0]!.exitCode, null);
  });
});
