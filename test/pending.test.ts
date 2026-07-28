import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
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

// --- lesson class: <function>/<agent>/pending/ and peer <agent>/pending/ -------
// The SessionStart banner has always counted these; scanPending must see them
// too or `roster review` cannot act on what the banner reports.

test('scanPending: lesson item under <function>/<agent>/pending/', () => {
  write('design/design-system-builder/agent.md', '# agent');
  write('design/design-system-builder/pending/lesson-1.md', '---\npriority: high\n---\nbody');
  const items = scanPending(workspace);
  assert.equal(items.length, 1);
  const it = items[0]!;
  assert.equal(it.class, 'lesson');
  assert.equal(it.function, 'design');
  assert.equal(it.agent, 'design/design-system-builder');
  assert.equal(it.frontMatter.priority, 'high');
});

test('scanPending: cross-cutting peer agent at the workspace root', () => {
  write('dreamer/agent.md', '# dreamer');
  write('dreamer/pending/L-1.md', '');
  const items = scanPending(workspace);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.agent, 'dreamer');
  assert.equal(items[0]!.class, 'lesson');
});

test('scanPending: a pending/ dir without an adjacent agent.md is not an agent', () => {
  write('guidelines/pending/not-a-decision.md', '');
  write('docs/whatever/pending/nope.md', '');
  assert.deepEqual(scanPending(workspace), []);
});

test('scanPending: both classes aggregated', () => {
  write('roster/gtm/pending/err.md', '');
  write('design/dsb/agent.md', '');
  write('design/dsb/pending/lesson.md', '');
  const items = scanPending(workspace);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.class).sort(), ['error', 'lesson']);
});

test('scanPending: fn filter spans both surfaces', () => {
  write('roster/gtm/pending/err.md', '');
  write('gtm/sdr/agent.md', '');
  write('gtm/sdr/pending/lesson.md', '');
  write('design/dsb/agent.md', '');
  write('design/dsb/pending/other.md', '');
  const items = scanPending(workspace, 'gtm');
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.function === 'gtm'));
});

test('scanPending: roster/ and dotted dirs are never scanned as lesson agents', () => {
  write('roster/agent.md', '');
  write('roster/pending/x.md', '');
  write('.hidden/agent.md', '');
  write('.hidden/pending/y.md', '');
  assert.deepEqual(scanPending(workspace), []);
});

test('scanPending: agent dir without pending/ is ignored', () => {
  write('gtm/sdr/agent.md', '');
  write('gtm/sdr/playbook/lesson.md', '');
  assert.deepEqual(scanPending(workspace), []);
});

test('scanPending: a symlinked lesson pending/ dir is refused and reported', () => {
  const outside = mkdtempSync(join(tmpdir(), 'roster-lesson-escape-'));
  try {
    writeFileSync(join(outside, 'planted.md'), '---\n---\nplanted', 'utf8');
    write('gtm/sdr/agent.md', '');
    symlinkSync(outside, join(workspace, 'gtm', 'sdr', 'pending'));
    const refused: string[] = [];
    const items = scanPending(workspace, undefined, refused);
    assert.deepEqual(items, [], 'must not list an item reached through a diverted dir');
    assert.equal(refused.length, 1, 'the skip is reported, not silent');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
