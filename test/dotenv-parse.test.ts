import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvFile, parseEnvKeys } from '../src/lib/dotenv-parse.ts';

test('parseEnvFile: KEY=value literal', () => {
  const m = parseEnvFile('A=1\nB=two\nC_D=3');
  assert.equal(m.size, 3);
  assert.equal(m.get('A'), '1');
  assert.equal(m.get('B'), 'two');
  assert.equal(m.get('C_D'), '3');
});

test('parseEnvFile: KEY="quoted" strips double quotes', () => {
  const m = parseEnvFile('A="hello world"');
  assert.equal(m.get('A'), 'hello world');
});

test("parseEnvFile: KEY='single' strips single quotes", () => {
  const m = parseEnvFile("A='hello world'");
  assert.equal(m.get('A'), 'hello world');
});

test('parseEnvFile: double-quoted interprets \\n \\t \\" \\\\ escapes', () => {
  const m = parseEnvFile('A="line1\\nline2\\ttab\\"q\\\\b"');
  assert.equal(m.get('A'), 'line1\nline2\ttab"q\\b');
});

test('parseEnvFile: single-quoted escapes are literal', () => {
  const m = parseEnvFile("A='line1\\nline2'");
  assert.equal(m.get('A'), 'line1\\nline2');
});

test('parseEnvFile: KEY= produces empty-string value', () => {
  const m = parseEnvFile('A=\nB=value');
  assert.equal(m.get('A'), '');
  assert.equal(m.get('B'), 'value');
});

test('parseEnvFile: # comment lines ignored', () => {
  const m = parseEnvFile('# top\nA=1\n  # indented\nB=2');
  assert.deepEqual(Array.from(m.entries()), [
    ['A', '1'],
    ['B', '2'],
  ]);
});

test('parseEnvFile: inline # comment stripped from unquoted (ws-preceded)', () => {
  const m = parseEnvFile('A=value # comment\nB=plain');
  assert.equal(m.get('A'), 'value');
  assert.equal(m.get('B'), 'plain');
});

test('parseEnvFile: # in unquoted value without preceding ws is literal', () => {
  const m = parseEnvFile('A=a#b');
  assert.equal(m.get('A'), 'a#b');
});

test('parseEnvFile: # literal inside double-quotes', () => {
  const m = parseEnvFile('A="hash # in value"');
  assert.equal(m.get('A'), 'hash # in value');
});

test('parseEnvFile: # literal inside single-quotes', () => {
  const m = parseEnvFile("A='hash # in value'");
  assert.equal(m.get('A'), 'hash # in value');
});

test('parseEnvFile: export prefix supported (single and double space)', () => {
  const m = parseEnvFile('export A=1\nexport  B=two');
  assert.equal(m.get('A'), '1');
  assert.equal(m.get('B'), 'two');
});

test('parseEnvFile: duplicate keys last-wins', () => {
  const m = parseEnvFile('A=1\nA=2\nA=3');
  assert.equal(m.get('A'), '3');
});

test('parseEnvFile: CRLF line endings supported', () => {
  const m = parseEnvFile('A=1\r\nB=2\r\n');
  assert.equal(m.get('A'), '1');
  assert.equal(m.get('B'), '2');
});

test('parseEnvFile: UTF-8 BOM stripped', () => {
  const m = parseEnvFile('﻿A=1');
  assert.equal(m.get('A'), '1');
});

test('parseEnvFile: malformed lines (numeric/leading-= /leading-dash) silently skipped', () => {
  const m = parseEnvFile('1=foo\n=bar\n-B=v\nA=ok');
  assert.equal(m.size, 1);
  assert.equal(m.get('A'), 'ok');
});

test('parseEnvFile: unterminated double-quote → key dropped silently', () => {
  const m = parseEnvFile('A="unterminated\nB=ok');
  assert.equal(m.size, 1);
  assert.equal(m.get('B'), 'ok');
});

test('parseEnvFile: garbage after closing quote → key dropped silently', () => {
  const m = parseEnvFile('A="value"garbage\nB=ok');
  assert.equal(m.size, 1);
  assert.equal(m.get('B'), 'ok');
});

test('parseEnvKeys: returns keys in insertion order', () => {
  const keys = parseEnvKeys('A=1\nB=2\nC=3');
  assert.deepEqual(keys, ['A', 'B', 'C']);
});

test('parseEnvKeys: dedupes via last-wins (single entry per key)', () => {
  const keys = parseEnvKeys('A=1\nB=2\nA=3');
  assert.deepEqual(keys, ['A', 'B']);
});
