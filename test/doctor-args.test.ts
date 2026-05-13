import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoctorArgs } from '../src/lib/doctor-args.ts';

test('no flags → json false, silent false', () => {
  const r = parseDoctorArgs([]);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.json, false);
  assert.equal(r.silent, false);
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
});

test('unknown flag ignored (forward-compat)', () => {
  const r = parseDoctorArgs(['--futureflag', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.json, true);
});
