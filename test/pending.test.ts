import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPending, countPending } from '../src/lib/pending.ts';

let workspace = '';

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'roster-pending-test-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(workspace, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

test('scanPending: no roster/ dir → empty', () => {
  assert.deepEqual(scanPending(workspace), []);
});

test('scanPending: roster/ exists but no functions → empty', () => {
  mkdirSync(join(workspace, 'roster'), { recursive: true });
  assert.deepEqual(scanPending(workspace), []);
});

test('scanPending: function dir without pending/ → ignored', () => {
  mkdirSync(join(workspace, 'roster/gtm'), { recursive: true });
  assert.deepEqual(scanPending(workspace), []);
});

test('scanPending: single pending item under one function', () => {
  write(
    'roster/dreamer/pending/lesson-1.md',
    '---\ntarget_on_approve: dreamer/playbook/lesson-1.md\n---\nbody text',
  );
  const items = scanPending(workspace);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.function, 'dreamer');
  assert.equal(item.filename, 'lesson-1.md');
  assert.equal(item.frontMatter.target_on_approve, 'dreamer/playbook/lesson-1.md');
  assert.equal(item.body, 'body text');
});

test('scanPending: multiple functions aggregated', () => {
  write('roster/dreamer/pending/a.md', '---\ntarget_on_approve: x.md\n---\n');
  write('roster/gtm/pending/b.md', '---\ntarget_on_approve: y.md\n---\n');
  write('roster/ops/pending/c.md', '');
  const items = scanPending(workspace);
  assert.equal(items.length, 3);
  const fns = items.map((i) => i.function).sort();
  assert.deepEqual(fns, ['dreamer', 'gtm', 'ops']);
});

test('scanPending: fn filter restricts to one function', () => {
  write('roster/dreamer/pending/a.md', '');
  write('roster/gtm/pending/b.md', '');
  const items = scanPending(workspace, 'gtm');
  assert.equal(items.length, 1);
  assert.equal(items[0]!.function, 'gtm');
});

test('scanPending: fn filter for non-existent function → empty (not an error)', () => {
  write('roster/dreamer/pending/a.md', '');
  assert.deepEqual(scanPending(workspace, 'nonexistent'), []);
});

test('scanPending: non-md files ignored', () => {
  write('roster/gtm/pending/keep.md', '');
  write('roster/gtm/pending/ignore.txt', 'not markdown');
  write('roster/gtm/pending/.gitkeep', '');
  const items = scanPending(workspace);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.filename, 'keep.md');
});

test('scanPending: malformed front-matter does not crash → empty fm + body preserved', () => {
  write('roster/gtm/pending/broken.md', '---\n: bad\n: yaml\n---\nbody');
  const items = scanPending(workspace);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]!.frontMatter, {});
  assert.equal(items[0]!.body, 'body');
});

test('scanPending: items returned sorted by function then filename', () => {
  write('roster/gtm/pending/zz.md', '');
  write('roster/gtm/pending/aa.md', '');
  write('roster/dreamer/pending/zz.md', '');
  write('roster/dreamer/pending/aa.md', '');
  const items = scanPending(workspace);
  assert.deepEqual(
    items.map((i) => `${i.function}/${i.filename}`),
    ['dreamer/aa.md', 'dreamer/zz.md', 'gtm/aa.md', 'gtm/zz.md'],
  );
});

test('countPending: convenience wrapper', () => {
  write('roster/gtm/pending/a.md', '');
  write('roster/gtm/pending/b.md', '');
  write('roster/dreamer/pending/c.md', '');
  assert.equal(countPending(workspace), 3);
});
