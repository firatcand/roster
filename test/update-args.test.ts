import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdateArgs } from '../src/lib/update-args.ts';

test('defaults', () => {
  const p = parseUpdateArgs([]);
  assert.equal(p.kind, 'ok');
  if (p.kind !== 'ok') return;
  assert.deepEqual([p.json, p.cwd], [false, undefined]);
});

test('--json and --cwd are the complete v2 update grammar', () => {
  const p = parseUpdateArgs(['--json', '--cwd', '/tmp/ws']);
  assert.equal(p.kind, 'ok');
  if (p.kind !== 'ok') return;
  assert.equal(p.json, true);
  assert.equal(p.cwd, '/tmp/ws');
});

test('--cwd without value errors', () => {
  assert.equal(parseUpdateArgs(['--cwd']).kind, 'err');
});

test('--exclude is rejected because v2 update never touches authored records', () => {
  const parsed = parseUpdateArgs(['--exclude', 'guidelines']);
  assert.equal(parsed.kind, 'err');
  if (parsed.kind === 'err') assert.match(parsed.message, /unknown flag '--exclude'/);
});

test('unknown flag errors', () => {
  assert.equal(parseUpdateArgs(['--nope']).kind, 'err');
});
