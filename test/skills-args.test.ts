import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillsArgs } from '../src/lib/skills-args.ts';

test('parses sync with flags', () => {
  const p = parseSkillsArgs(['sync', '--json', '--cwd', '/tmp/ws']);
  assert.equal(p.kind, 'ok');
  if (p.kind !== 'ok' || p.subcommand !== 'sync') throw new Error('bad parse');
  assert.equal(p.json, true);
  assert.equal(p.cwd, '/tmp/ws');
});

test('parses update --latest', () => {
  const p = parseSkillsArgs(['update', '--latest']);
  assert.equal(p.kind, 'ok');
  if (p.kind !== 'ok' || p.subcommand !== 'update') throw new Error('bad parse');
  assert.equal(p.latest, true);
});

test('--latest is rejected on sync', () => {
  const p = parseSkillsArgs(['sync', '--latest']);
  assert.equal(p.kind, 'err');
});

test('missing subcommand errors', () => {
  assert.equal(parseSkillsArgs([]).kind, 'err');
});

test('unknown subcommand errors', () => {
  assert.equal(parseSkillsArgs(['frobnicate']).kind, 'err');
});

test('unknown flag errors', () => {
  assert.equal(parseSkillsArgs(['sync', '--nope']).kind, 'err');
});

test('--cwd without a value errors', () => {
  assert.equal(parseSkillsArgs(['sync', '--cwd']).kind, 'err');
});
