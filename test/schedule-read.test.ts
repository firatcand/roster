// Characterization tests for the shared schedule-read helpers (ROS-121).
// Pin the subtle reader divergence consolidated from schedule-list (warns) and
// schedule-resolve (silent + throws on unreadable). Negative control per case noted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { listFunctionDirs, readScheduleEntries } from '../src/lib/schedule-read.ts';

const entry = {
  name: 'sdr-cold-outreach',
  agent: 'sdr',
  plan: 'cold-outreach',
  cron: '0 9 * * 1-5',
  tool: 'claude',
  install_mode: 'ui-handoff',
  status: 'pending-ui-install',
};

function ws(): string {
  return mkdtempSync(join(tmpdir(), 'ros121-'));
}
function seed(cwd: string, fn: string, body: string): void {
  const dir = join(cwd, 'roster', fn);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'schedules.yaml'), body, 'utf8');
}

test('listFunctionDirs: only=<x> short-circuits without touching fs', () => {
  // negative control: passing undefined would enumerate roster/ instead.
  assert.deepEqual(listFunctionDirs('/nonexistent', 'gtm'), ['gtm']);
});

test('listFunctionDirs: missing roster/ → []', () => {
  const cwd = ws();
  try {
    assert.deepEqual(listFunctionDirs(cwd), []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('listFunctionDirs: returns sorted dir names, skips files', () => {
  const cwd = ws();
  try {
    mkdirSync(join(cwd, 'roster', 'gtm'), { recursive: true });
    mkdirSync(join(cwd, 'roster', 'design'), { recursive: true });
    writeFileSync(join(cwd, 'roster', 'README.md'), 'x', 'utf8'); // a file — must be skipped
    // negative control: if files weren't skipped, README.md would appear.
    assert.deepEqual(listFunctionDirs(cwd), ['design', 'gtm']);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('readScheduleEntries: valid file → entries, no warnings collected', () => {
  const cwd = ws();
  try {
    seed(cwd, 'gtm', YAML.stringify({ version: 1, schedules: [entry] }));
    const warnings: string[] = [];
    const out = readScheduleEntries(cwd, 'gtm', warnings);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.name, 'sdr-cold-outreach');
    assert.deepEqual(warnings, []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('readScheduleEntries: missing file → [] (both modes)', () => {
  const cwd = ws();
  try {
    mkdirSync(join(cwd, 'roster', 'gtm'), { recursive: true });
    const warnings: string[] = [];
    assert.deepEqual(readScheduleEntries(cwd, 'gtm', warnings), []);
    assert.deepEqual(readScheduleEntries(cwd, 'gtm'), []);
    assert.deepEqual(warnings, []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('readScheduleEntries: malformed YAML → warns (with array) / silent (without)', () => {
  const cwd = ws();
  try {
    seed(cwd, 'gtm', 'schedules: [\n  unclosed');
    const warnings: string[] = [];
    assert.deepEqual(readScheduleEntries(cwd, 'gtm', warnings), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /malformed/);
    // negative control: schedule-resolve's silent mode collects nothing.
    assert.deepEqual(readScheduleEntries(cwd, 'gtm'), []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("readScheduleEntries: missing 'schedules:' list → warns / silent", () => {
  const cwd = ws();
  try {
    seed(cwd, 'gtm', YAML.stringify({ version: 1 }));
    const warnings: string[] = [];
    assert.deepEqual(readScheduleEntries(cwd, 'gtm', warnings), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /missing 'schedules:' list/);
    assert.deepEqual(readScheduleEntries(cwd, 'gtm'), []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('readScheduleEntries: per-entry invalid → keeps valid, warns on bad (with array only)', () => {
  const cwd = ws();
  try {
    seed(cwd, 'gtm', YAML.stringify({ version: 1, schedules: [entry, { name: 'bad' }] }));
    const warnings: string[] = [];
    const out = readScheduleEntries(cwd, 'gtm', warnings);
    assert.equal(out.length, 1); // only the valid entry survives
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /\[1\]: invalid/);
    // silent mode: same valid result, no warnings
    assert.equal(readScheduleEntries(cwd, 'gtm').length, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('readScheduleEntries: unreadable existing path → throws (silent) / warns+[] (with array)', () => {
  const cwd = ws();
  try {
    // Make schedules.yaml a DIRECTORY: existsSync true, readFileSync throws EISDIR.
    mkdirSync(join(cwd, 'roster', 'gtm', 'schedules.yaml'), { recursive: true });
    // schedule-resolve behavior: no warnings array → error propagates.
    assert.throws(() => readScheduleEntries(cwd, 'gtm'));
    // schedule-list behavior: warnings array → caught, reported, []
    const warnings: string[] = [];
    assert.deepEqual(readScheduleEntries(cwd, 'gtm', warnings), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /cannot read/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
