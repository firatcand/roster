// Characterization tests for loadSchedules (ROS-123). Pins the sort flag,
// filter predicate, and skip paths consolidated from the 3 copies in
// doctor-scheduling-drift.ts and pending-sync.ts. End-to-end behavior is also
// covered by doctor-scheduling-drift.test.ts and the pending-sync suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { loadSchedules } from '../src/lib/schedule-read.ts';

const base = {
  name: 'x',
  agent: 'sdr',
  plan: 'p',
  cron: '0 9 * * 1-5',
  tool: 'claude',
  install_mode: 'ui-handoff',
  status: 'pending-ui-install',
};
function ws(): string { return mkdtempSync(join(tmpdir(), 'ros123-')); }
function seed(cwd: string, fn: string, entries: unknown[]): void {
  const dir = join(cwd, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'schedules.yaml'), YAML.stringify({ version: 1, schedules: entries }), 'utf8');
}

test('loadSchedules: root missing → []', () => {
  const cwd = ws();
  try { assert.deepEqual(loadSchedules(cwd), []); }
  finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('loadSchedules: collects {entry, functionName} across function dirs', () => {
  const cwd = ws();
  try {
    seed(cwd, 'gtm', [{ ...base, name: 'a' }]);
    const out = loadSchedules(cwd);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.functionName, 'gtm');
    assert.equal(out[0]!.entry.name, 'a');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('loadSchedules: sort:true visits function dirs in sorted order', () => {
  const cwd = ws();
  try {
    seed(cwd, 'zeta', [{ ...base, name: 'z' }]);
    seed(cwd, 'alpha', [{ ...base, name: 'a' }]);
    // negative control: without sort, order is raw readdir (not guaranteed alpha-first).
    const sorted = loadSchedules(cwd, { sort: true }).map((s) => s.functionName);
    assert.deepEqual(sorted, ['alpha', 'zeta']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('loadSchedules: filter narrows entries', () => {
  // The production codex/via-cron predicate is covered end-to-end by
  // doctor-scheduling-drift.test.ts ("ui-handoff entries are ignored"); here we
  // pin the filter MECHANISM on schema-valid entries.
  const cwd = ws();
  try {
    seed(cwd, 'gtm', [{ ...base, name: 'keep' }, { ...base, name: 'drop' }]);
    const out = loadSchedules(cwd, { filter: (e) => e.name === 'keep' });
    // negative control: without the filter, both entries return.
    assert.equal(out.length, 1);
    assert.equal(out[0]!.entry.name, 'keep');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('loadSchedules: skips missing/unreadable/malformed/invalid files silently', () => {
  const cwd = ws();
  try {
    seed(cwd, 'good', [{ ...base, name: 'ok' }]);
    mkdirSync(join(cwd, 'roster', 'no-yaml'), { recursive: true });             // no schedules.yaml
    writeFileSync(join(cwd, 'roster', 'stray.txt'), 'x', 'utf8');               // a file, not a dir
    mkdirSync(join(cwd, 'roster', 'malformed'), { recursive: true });
    writeFileSync(join(cwd, 'roster', 'malformed', 'schedules.yaml'), 'a: [\n unclosed', 'utf8'); // malformed YAML
    mkdirSync(join(cwd, 'roster', 'badversion'), { recursive: true });
    writeFileSync(join(cwd, 'roster', 'badversion', 'schedules.yaml'), YAML.stringify({ version: 99, schedules: [base] }), 'utf8'); // schema-invalid version
    const out = loadSchedules(cwd, { sort: true });
    // only 'good' contributes
    assert.deepEqual(out.map((s) => s.functionName), ['good']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
