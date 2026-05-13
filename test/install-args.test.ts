import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallArgs } from '../src/lib/install-args.ts';

test('no flags → interactive mode, silent/verbose false', () => {
  const r = parseInstallArgs([]);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.silent, false);
  assert.equal(r.verbose, false);
  assert.deepEqual(r.target, { mode: 'interactive' });
});

test('--all → mode all', () => {
  const r = parseInstallArgs(['--all']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'all' });
});

test('--tool codex (space form) → mode tool, key codex', () => {
  const r = parseInstallArgs(['--tool', 'codex']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'tool', key: 'codex' });
});

test('--tool=codex (equals form) → mode tool, key codex', () => {
  const r = parseInstallArgs(['--tool=codex']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'tool', key: 'codex' });
});

test('--tool without a value → err mentioning expected names', () => {
  const r = parseInstallArgs(['--tool']);
  assert.equal(r.kind, 'err');
  if (r.kind !== 'err') return;
  assert.match(r.message, /--tool/);
  assert.match(r.message, /claude/);
  assert.match(r.message, /codex/);
  assert.match(r.message, /gemini/);
});

test('--tool foo (unknown name) → err mentioning the bad value and expected names', () => {
  const r = parseInstallArgs(['--tool', 'foo']);
  assert.equal(r.kind, 'err');
  if (r.kind !== 'err') return;
  assert.match(r.message, /foo/);
  assert.match(r.message, /claude/);
});

test('--all and --tool together → err mentioning mutually exclusive', () => {
  const r = parseInstallArgs(['--all', '--tool', 'claude']);
  assert.equal(r.kind, 'err');
  if (r.kind !== 'err') return;
  assert.match(r.message, /mutually exclusive|cannot be combined|together/i);
});

test('--silent --all → silent true, mode all', () => {
  const r = parseInstallArgs(['--silent', '--all']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.silent, true);
  assert.equal(r.verbose, false);
  assert.deepEqual(r.target, { mode: 'all' });
});

test('--verbose --tool gemini → verbose true, mode tool gemini', () => {
  const r = parseInstallArgs(['--verbose', '--tool', 'gemini']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.verbose, true);
  assert.equal(r.silent, false);
  assert.deepEqual(r.target, { mode: 'tool', key: 'gemini' });
});

test('--tool=claude with --silent → silent true, mode tool claude', () => {
  const r = parseInstallArgs(['--tool=claude', '--silent']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.silent, true);
  assert.deepEqual(r.target, { mode: 'tool', key: 'claude' });
});

test('--tool= (empty value) → err', () => {
  const r = parseInstallArgs(['--tool=']);
  assert.equal(r.kind, 'err');
  if (r.kind !== 'err') return;
  assert.match(r.message, /--tool/);
});

test('unknown flag is ignored (forward-compat)', () => {
  const r = parseInstallArgs(['--futureflag', '--all']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'all' });
});
