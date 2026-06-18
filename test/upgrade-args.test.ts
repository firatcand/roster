import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpgradeArgs } from '../src/lib/upgrade-args.ts';

test('defaults', () => {
  const p = parseUpgradeArgs([]);
  assert.equal(p.kind, 'ok');
  if (p.kind !== 'ok') return;
  assert.deepEqual([p.dryRun, p.json, p.cwd], [false, false, undefined]);
});

test('--dry-run --json --cwd', () => {
  const p = parseUpgradeArgs(['--dry-run', '--json', '--cwd', '/tmp/ws']);
  assert.equal(p.kind, 'ok');
  if (p.kind !== 'ok') return;
  assert.deepEqual([p.dryRun, p.json, p.cwd], [true, true, '/tmp/ws']);
});

test('--cwd without value errors', () => {
  assert.equal(parseUpgradeArgs(['--cwd']).kind, 'err');
});

test('unknown flag errors', () => {
  assert.equal(parseUpgradeArgs(['--nope']).kind, 'err');
});
