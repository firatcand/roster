import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingItem } from '../src/lib/pending.ts';
import {
  computeItemId,
  resolveItemBySelector,
  approveItem,
  rejectItem,
  targetWithinWorkspace,
  workspaceRelative,
} from '../src/lib/pending-apply.ts';

function item(root: string, fn: string, filename: string, frontMatter: Record<string, unknown>): PendingItem {
  const dir = join(root, 'roster', fn, 'pending');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, '---\n---\nbody', 'utf8');
  return { function: fn, path, filename, frontMatter, body: 'body' };
}

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'roster-apply-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('computeItemId is stable 8-hex and varies by coordinate', () => {
  withRoot((root) => {
    const a = item(root, 'gtm', 'a.md', {});
    assert.match(computeItemId(a), /^[a-f0-9]{8}$/);
    assert.equal(computeItemId(a), computeItemId({ ...a }));
    const b = item(root, 'gtm', 'b.md', {});
    assert.notEqual(computeItemId(a), computeItemId(b));
  });
});

test('resolveItemBySelector: by id, by relative path, not-found', () => {
  withRoot((root) => {
    const a = item(root, 'gtm', 'a.md', {});
    const b = item(root, 'dreamer', 'b.md', {});
    const items = [a, b];
    const byId = resolveItemBySelector(items, computeItemId(b), root);
    assert.ok(byId.ok && byId.item === b);
    const byPath = resolveItemBySelector(items, workspaceRelative(a.path, root), root);
    assert.ok(byPath.ok && byPath.item === a);
    const miss = resolveItemBySelector(items, 'deadbeef', root);
    assert.ok(!miss.ok && miss.reason === 'not-found');
  });
});

test('approveItem: moves to target_on_approve', () => {
  withRoot((root) => {
    const a = item(root, 'gtm', 'a.md', { target_on_approve: 'gtm/approved/a.md' });
    const res = approveItem(a, root);
    assert.ok(res.ok && res.target === 'gtm/approved/a.md');
    assert.ok(!existsSync(a.path));
    assert.ok(existsSync(join(root, 'gtm', 'approved', 'a.md')));
  });
});

test('approveItem: missing target → fail, file untouched', () => {
  withRoot((root) => {
    const a = item(root, 'gtm', 'a.md', {});
    const res = approveItem(a, root);
    assert.ok(!res.ok && /missing target_on_approve/.test(res.reason));
    assert.ok(existsSync(a.path));
  });
});

test('approveItem: target escapes workspace (../ and absolute) → fail, untouched', () => {
  withRoot((root) => {
    for (const bad of ['../escape.md', '/etc/passwd', '..']) {
      const a = item(root, 'gtm', `x-${bad.replace(/[^a-z]/gi, '')}.md`, { target_on_approve: bad });
      const res = approveItem(a, root);
      assert.ok(!res.ok, `expected refusal for ${bad}`);
      assert.ok(existsSync(a.path));
    }
    assert.equal(targetWithinWorkspace('../x', root), null);
    assert.equal(targetWithinWorkspace('/x', root), null);
  });
});

test('approveItem: target already exists → fail, no clobber', () => {
  withRoot((root) => {
    mkdirSync(join(root, 'gtm', 'approved'), { recursive: true });
    writeFileSync(join(root, 'gtm', 'approved', 'a.md'), 'EXISTING', 'utf8');
    const a = item(root, 'gtm', 'a.md', { target_on_approve: 'gtm/approved/a.md' });
    const res = approveItem(a, root);
    assert.ok(!res.ok && /already exists/.test(res.reason));
    assert.equal(readFileSync(join(root, 'gtm', 'approved', 'a.md'), 'utf8'), 'EXISTING');
    assert.ok(existsSync(a.path));
  });
});

test('rejectItem: deletes the file', () => {
  withRoot((root) => {
    const a = item(root, 'gtm', 'a.md', {});
    rejectItem(a);
    assert.ok(!existsSync(a.path));
  });
});
