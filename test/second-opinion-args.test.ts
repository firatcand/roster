import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSecondOpinionArgs } from '../src/lib/second-opinion-args.ts';

test('args: files only → ok with defaults', () => {
  const r = parseSecondOpinionArgs(['README.md', 'docs/plan.md']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.deepEqual(r.files, ['README.md', 'docs/plan.md']);
  assert.equal(r.host, undefined);
  assert.equal(r.stdin, false);
  assert.equal(r.diff, undefined);
  assert.equal(r.json, false);
  assert.equal(r.timeoutSec, 180);
});

test('args: --host codex accepted', () => {
  const r = parseSecondOpinionArgs(['a.md', '--host', 'codex']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.host, 'codex');
});

test('args: unknown --host rejected', () => {
  const r = parseSecondOpinionArgs(['a.md', '--host', 'gpt5']);
  assert.equal(r.kind, 'err');
  if (r.kind === 'err') assert.match(r.message, /--host must be one of/);
});

test('args: --host without value rejected', () => {
  const r = parseSecondOpinionArgs(['a.md', '--host']);
  assert.equal(r.kind, 'err');
});

test('args: no input source at all → err (NO_INPUT precondition)', () => {
  const r = parseSecondOpinionArgs([]);
  assert.equal(r.kind, 'err');
  if (r.kind === 'err') assert.match(r.message, /at least one input/i);
});

test('args: --stdin alone is a valid input source', () => {
  const r = parseSecondOpinionArgs(['--stdin']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.stdin, true);
});

test('args: --diff alone is a valid input source (defaults to HEAD)', () => {
  const r = parseSecondOpinionArgs(['--diff']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.diff, 'HEAD');
});

test('args: --diff with explicit ref', () => {
  const r = parseSecondOpinionArgs(['--diff', 'origin/main...HEAD']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.diff, 'origin/main...HEAD');
});

test('args: --diff followed by a flag keeps default ref', () => {
  const r = parseSecondOpinionArgs(['--diff', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.diff, 'HEAD');
    assert.equal(r.json, true);
  }
});

test('args: --message captured', () => {
  const r = parseSecondOpinionArgs(['a.md', '--message', 'focus on the intro']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.message, 'focus on the intro');
});

test('args: --message requires a value', () => {
  const r = parseSecondOpinionArgs(['a.md', '--message']);
  assert.equal(r.kind, 'err');
});

test('args: --timeout parses seconds', () => {
  const r = parseSecondOpinionArgs(['a.md', '--timeout', '60']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.timeoutSec, 60);
});

test('args: --timeout rejects non-numeric / non-positive', () => {
  assert.equal(parseSecondOpinionArgs(['a.md', '--timeout', 'abc']).kind, 'err');
  assert.equal(parseSecondOpinionArgs(['a.md', '--timeout', '0']).kind, 'err');
  assert.equal(parseSecondOpinionArgs(['a.md', '--timeout', '-5']).kind, 'err');
});

test('args: unknown flag rejected', () => {
  const r = parseSecondOpinionArgs(['a.md', '--frobnicate']);
  assert.equal(r.kind, 'err');
  if (r.kind === 'err') assert.match(r.message, /unknown flag/);
});

test('args: --json flag', () => {
  const r = parseSecondOpinionArgs(['a.md', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.equal(r.json, true);
});

test('args: files + stdin + diff can combine', () => {
  const r = parseSecondOpinionArgs(['a.md', '--stdin', '--diff', 'HEAD~3']);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.deepEqual(r.files, ['a.md']);
    assert.equal(r.stdin, true);
    assert.equal(r.diff, 'HEAD~3');
  }
});
