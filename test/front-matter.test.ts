import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter } from '../src/lib/front-matter.ts';

test('parseFrontMatter: well-formed block parses keys + returns body', () => {
  const input = '---\ntarget_on_approve: dreamer/playbook/x.md\nseverity: high\n---\nhello body';
  const { frontMatter, body } = parseFrontMatter(input);
  assert.equal(frontMatter.target_on_approve, 'dreamer/playbook/x.md');
  assert.equal(frontMatter.severity, 'high');
  assert.equal(body, 'hello body');
});

test('parseFrontMatter: no front matter → empty fm + full body', () => {
  const input = 'just a markdown body\nwith two lines';
  const r = parseFrontMatter(input);
  assert.deepEqual(r.frontMatter, {});
  assert.equal(r.body, input);
});

test('parseFrontMatter: opening delim only (no closing) → empty fm + original body', () => {
  const input = '---\ntarget: x\nno closing delim';
  const r = parseFrontMatter(input);
  assert.deepEqual(r.frontMatter, {});
  assert.equal(r.body, input);
});

test('parseFrontMatter: empty front matter block → empty fm + body', () => {
  const input = '---\n---\nbody';
  const r = parseFrontMatter(input);
  assert.deepEqual(r.frontMatter, {});
  assert.equal(r.body, 'body');
});

test('parseFrontMatter: malformed YAML inside delims → empty fm + body preserved', () => {
  const input = '---\n: unbalanced\n  : indent\n---\nthe body';
  const r = parseFrontMatter(input);
  assert.deepEqual(r.frontMatter, {});
  assert.equal(r.body, 'the body');
});

test('parseFrontMatter: multi-line value', () => {
  const input = '---\nnote: |\n  line one\n  line two\n---\nbody';
  const r = parseFrontMatter(input);
  assert.equal(r.frontMatter.note, 'line one\nline two\n');
  assert.equal(r.body, 'body');
});

test('parseFrontMatter: BOM at start of file', () => {
  const input = '﻿---\nkey: val\n---\nbody';
  const r = parseFrontMatter(input);
  assert.equal(r.frontMatter.key, 'val');
  assert.equal(r.body, 'body');
});

test('parseFrontMatter: top-level array in fm → coerced to empty fm', () => {
  const input = '---\n- a\n- b\n---\nbody';
  const r = parseFrontMatter(input);
  assert.deepEqual(r.frontMatter, {});
  assert.equal(r.body, 'body');
});

test('parseFrontMatter: empty input', () => {
  const r = parseFrontMatter('');
  assert.deepEqual(r.frontMatter, {});
  assert.equal(r.body, '');
});

test('parseFrontMatter: body preserves trailing content including newlines', () => {
  const input = '---\nkey: 1\n---\nline1\nline2\n';
  const r = parseFrontMatter(input);
  assert.equal(r.body, 'line1\nline2\n');
});
