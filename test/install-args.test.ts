import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstallArgs } from '../src/lib/install-args.ts';

test('no flags → interactive mode, all booleans false, scope null', () => {
  const r = parseInstallArgs([]);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.silent, false);
  assert.equal(r.verbose, false);
  assert.equal(r.yes, false);
  assert.equal(r.scope, null);
  assert.deepEqual(r.target, { mode: 'interactive' });
});

test('--all → mode all', () => {
  const r = parseInstallArgs(['--all']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'all' });
});

test('--tool codex (space form) → mode tools, keys [codex]', () => {
  const r = parseInstallArgs(['--tool', 'codex']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'tools', keys: ['codex'] });
});

test('--tool=codex (equals form) → mode tools, keys [codex]', () => {
  const r = parseInstallArgs(['--tool=codex']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'tools', keys: ['codex'] });
});

test('--tool claude,codex → keys [claude, codex] preserving order', () => {
  const r = parseInstallArgs(['--tool', 'claude,codex']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'tools', keys: ['claude', 'codex'] });
});

test('--tool=claude,codex,gemini → all three keys in order', () => {
  const r = parseInstallArgs(['--tool=claude,codex,gemini']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'tools', keys: ['claude', 'codex', 'gemini'] });
});

test('--tool claude, codex (whitespace around comma) → keys parsed correctly', () => {
  const r = parseInstallArgs(['--tool', 'claude, codex']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'tools', keys: ['claude', 'codex'] });
});

test('--tool claude,claude → dedupes to keys [claude]', () => {
  const r = parseInstallArgs(['--tool', 'claude,claude']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'tools', keys: ['claude'] });
});

test('--tool claude,foo (one invalid in list) → err mentioning the bad value', () => {
  const r = parseInstallArgs(['--tool', 'claude,foo']);
  assert.equal(r.kind, 'err');
  if (r.kind !== 'err') return;
  assert.match(r.message, /foo/);
  assert.match(r.message, /claude/);
});

test('--tool claude,,codex (stray comma) → err mentioning empty value', () => {
  const r = parseInstallArgs(['--tool', 'claude,,codex']);
  assert.equal(r.kind, 'err');
  if (r.kind !== 'err') return;
  assert.match(r.message, /empty value|stray comma/i);
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

test('--verbose --tool gemini → verbose true, mode tools [gemini]', () => {
  const r = parseInstallArgs(['--verbose', '--tool', 'gemini']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.verbose, true);
  assert.equal(r.silent, false);
  assert.deepEqual(r.target, { mode: 'tools', keys: ['gemini'] });
});

test('--tool=claude with --silent → silent true, mode tools [claude]', () => {
  const r = parseInstallArgs(['--tool=claude', '--silent']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.silent, true);
  assert.deepEqual(r.target, { mode: 'tools', keys: ['claude'] });
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

// --scope tests
test('--scope project → scope project', () => {
  const r = parseInstallArgs(['--scope', 'project']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.scope, 'project');
  assert.deepEqual(r.target, { mode: 'interactive' });
});

test('--scope user → scope user', () => {
  const r = parseInstallArgs(['--scope', 'user']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.scope, 'user');
});

test('--scope=project (equals form) → scope project', () => {
  const r = parseInstallArgs(['--scope=project']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.scope, 'project');
});

test('--scope without a value → err', () => {
  const r = parseInstallArgs(['--scope']);
  assert.equal(r.kind, 'err');
  if (r.kind !== 'err') return;
  assert.match(r.message, /--scope/);
  assert.match(r.message, /project/);
  assert.match(r.message, /user/);
});

test('--scope= (empty value) → err', () => {
  const r = parseInstallArgs(['--scope=']);
  assert.equal(r.kind, 'err');
  if (r.kind !== 'err') return;
  assert.match(r.message, /--scope/);
});

test('--scope foo (invalid value) → err mentioning bad value and valid options', () => {
  const r = parseInstallArgs(['--scope', 'foo']);
  assert.equal(r.kind, 'err');
  if (r.kind !== 'err') return;
  assert.match(r.message, /foo/);
  assert.match(r.message, /project/);
  assert.match(r.message, /user/);
});

// --yes tests
test('--yes → yes true', () => {
  const r = parseInstallArgs(['--yes']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.yes, true);
});

test('-y (short form) → yes true', () => {
  const r = parseInstallArgs(['-y']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.yes, true);
});

test('--yes does not affect scope or tool defaults at parse time', () => {
  // Safe-default resolution happens in runInstall; parse should report exactly
  // what the user passed (yes: true, scope: null, target: interactive).
  const r = parseInstallArgs(['--yes']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.scope, null);
  assert.deepEqual(r.target, { mode: 'interactive' });
});

// Combinations
test('--all --scope user --yes → all three flags coexist (no conflict)', () => {
  const r = parseInstallArgs(['--all', '--scope', 'user', '--yes']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'all' });
  assert.equal(r.scope, 'user');
  assert.equal(r.yes, true);
});

test('--tool claude,codex --scope project → both flags set', () => {
  const r = parseInstallArgs(['--tool', 'claude,codex', '--scope', 'project']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.target, { mode: 'tools', keys: ['claude', 'codex'] });
  assert.equal(r.scope, 'project');
});
