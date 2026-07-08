import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBrainArgs } from '../src/lib/brain-args.ts';

// ---------- fs put ----------

test('parseFs: put requires --kind, --slug and a file', () => {
  const r = parseBrainArgs(['fs', 'put', '--kind', 'concept', '--slug', 'rrf', './post.md', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'fs' || r.op !== 'put') throw new Error('wrong shape');
  assert.equal(r.entKind, 'concept');
  assert.equal(r.slug, 'rrf');
  assert.equal(r.file, './post.md');
  assert.equal(r.json, true);

  assert.equal(parseBrainArgs(['fs', 'put', '--slug', 'rrf', './x.md']).kind, 'err', 'missing --kind');
  assert.equal(parseBrainArgs(['fs', 'put', '--kind', 'concept', './x.md']).kind, 'err', 'missing --slug');
  assert.equal(parseBrainArgs(['fs', 'put', '--kind', 'c', '--slug', 's']).kind, 'err', 'missing file');
  assert.equal(
    parseBrainArgs(['fs', 'put', '--kind', 'c', '--slug', 's', 'a.md', 'b.md']).kind,
    'err',
    'two positionals',
  );
});

test('parseFs: put accepts optional --filename and --actor', () => {
  const r = parseBrainArgs([
    'fs', 'put', '--kind', 'concept', '--slug', 'rrf', './local.md',
    '--filename', 'renamed.md', '--actor', 'sdr',
  ]);
  if (r.kind !== 'ok' || r.subcommand !== 'fs' || r.op !== 'put') throw new Error('wrong shape');
  assert.equal(r.filename, 'renamed.md');
  assert.equal(r.actor, 'sdr');
});

// ---------- fs get ----------

test('parseFs: get requires --kind, --slug and a filename; --out optional', () => {
  const r = parseBrainArgs(['fs', 'get', '--kind', 'concept', '--slug', 'rrf', 'post.md', '--out', '/tmp/p.md']);
  if (r.kind !== 'ok' || r.subcommand !== 'fs' || r.op !== 'get') throw new Error('wrong shape');
  assert.equal(r.entKind, 'concept');
  assert.equal(r.slug, 'rrf');
  assert.equal(r.filename, 'post.md');
  assert.equal(r.out, '/tmp/p.md');

  assert.equal(parseBrainArgs(['fs', 'get', '--kind', 'c', '--slug', 's']).kind, 'err', 'missing filename');
  assert.equal(parseBrainArgs(['fs', 'get', '--slug', 's', 'f.md']).kind, 'err', 'missing --kind');
});

// ---------- fs ls ----------

test('parseFs: ls takes optional --kind/--slug; --slug alone is an error', () => {
  const all = parseBrainArgs(['fs', 'ls', '--json']);
  if (all.kind !== 'ok' || all.subcommand !== 'fs' || all.op !== 'ls') throw new Error('wrong shape');
  assert.equal(all.entKind, undefined);
  assert.equal(all.slug, undefined);

  const byKind = parseBrainArgs(['fs', 'ls', '--kind', 'concept']);
  if (byKind.kind !== 'ok' || byKind.subcommand !== 'fs' || byKind.op !== 'ls') throw new Error('wrong shape');
  assert.equal(byKind.entKind, 'concept');

  const byBoth = parseBrainArgs(['fs', 'ls', '--kind', 'concept', '--slug', 'rrf']);
  if (byBoth.kind !== 'ok' || byBoth.subcommand !== 'fs' || byBoth.op !== 'ls') throw new Error('wrong shape');
  assert.equal(byBoth.slug, 'rrf');

  assert.equal(parseBrainArgs(['fs', 'ls', '--slug', 'rrf']).kind, 'err', '--slug without --kind');
  assert.equal(parseBrainArgs(['fs', 'ls', 'stray']).kind, 'err', 'no positionals for ls');
});

// ---------- fs rm ----------

test('parseFs: rm requires --kind, --slug and a filename', () => {
  const r = parseBrainArgs(['fs', 'rm', '--kind', 'concept', '--slug', 'rrf', 'post.md', '--actor', 'ops']);
  if (r.kind !== 'ok' || r.subcommand !== 'fs' || r.op !== 'rm') throw new Error('wrong shape');
  assert.equal(r.entKind, 'concept');
  assert.equal(r.slug, 'rrf');
  assert.equal(r.filename, 'post.md');
  assert.equal(r.actor, 'ops');

  assert.equal(parseBrainArgs(['fs', 'rm', '--kind', 'c', '--slug', 's']).kind, 'err', 'missing filename');
});

// ---------- fs op routing ----------

test('parseFs: missing or unknown op is an error', () => {
  assert.equal(parseBrainArgs(['fs']).kind, 'err', 'no op');
  assert.equal(parseBrainArgs(['fs', 'wat', '--kind', 'c', '--slug', 's', 'f']).kind, 'err', 'unknown op');
});
