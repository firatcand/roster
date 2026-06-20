import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdateArgs } from '../src/lib/update-args.ts';

test('defaults', () => {
  const p = parseUpdateArgs([]);
  assert.equal(p.kind, 'ok');
  if (p.kind !== 'ok') return;
  assert.deepEqual([p.json, p.cwd, p.excludes], [false, undefined, []]);
});

test('--json --cwd --exclude (comma + repeat)', () => {
  const p = parseUpdateArgs(['--json', '--cwd', '/tmp/ws', '--exclude', 'a,b', '--exclude', 'c']);
  assert.equal(p.kind, 'ok');
  if (p.kind !== 'ok') return;
  assert.equal(p.json, true);
  assert.equal(p.cwd, '/tmp/ws');
  assert.deepEqual(p.excludes, ['a', 'b', 'c']);
});

test('--cwd without value errors', () => {
  assert.equal(parseUpdateArgs(['--cwd']).kind, 'err');
});

test('--exclude without value errors', () => {
  assert.equal(parseUpdateArgs(['--exclude']).kind, 'err');
});

test('unknown flag errors', () => {
  assert.equal(parseUpdateArgs(['--nope']).kind, 'err');
});
