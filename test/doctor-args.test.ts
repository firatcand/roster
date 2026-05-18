import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoctorArgs } from '../src/lib/doctor-args.ts';

test('no flags → json false, silent false, fix false', () => {
  const r = parseDoctorArgs([]);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.json, false);
  assert.equal(r.silent, false);
  assert.equal(r.fix, false);
});

test('--json → json true', () => {
  const r = parseDoctorArgs(['--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.json, true);
  assert.equal(r.silent, false);
});

test('--silent --json → both true', () => {
  const r = parseDoctorArgs(['--silent', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.silent, true);
  assert.equal(r.json, true);
  assert.equal(r.fix, false);
});

test('--fix → fix true, others default', () => {
  const r = parseDoctorArgs(['--fix']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.fix, true);
  assert.equal(r.json, false);
  assert.equal(r.silent, false);
});

test('--fix --json → both true', () => {
  const r = parseDoctorArgs(['--fix', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.fix, true);
  assert.equal(r.json, true);
});

test('unknown flag ignored (forward-compat)', () => {
  const r = parseDoctorArgs(['--futureflag', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.json, true);
});

test('--dry-run → dryRun true (ROS-45)', () => {
  const r = parseDoctorArgs(['--dry-run']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.dryRun, true);
  assert.equal(r.json, false);
});

test('no --dry-run → dryRun false', () => {
  const r = parseDoctorArgs([]);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.dryRun, false);
});

test('--fix --dry-run → both true (ROS-45 + ROS-38 integration)', () => {
  const r = parseDoctorArgs(['--fix', '--dry-run']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.fix, true);
  assert.equal(r.dryRun, true);
});
