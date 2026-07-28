import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PendingItem } from '../src/lib/pending.ts';
import {
  computeItemId,
  resolveItemBySelector,
  approveItem,
  rejectItem,
  resolveApproveTarget,
} from '../src/lib/pending-apply.ts';
import { resolveWorkspaceRelativePath, targetWithinWorkspace, workspaceRelative } from '../src/lib/workspace-path.ts';

// Round-13 finding 1: a front-matter `target_on_approve` is the ONE
// caller-authored WORKSPACE-RELATIVE input, so it is probed through the explicit
// relative flavor; targetWithinWorkspace itself now requires an absolute path.
function relativeTargetRefused(target: string, root: string): boolean {
  return resolveWorkspaceRelativePath(target, root).status === 'refused';
}

// Error class — roster/<function>/pending/, needs an explicit target_on_approve.
function item(root: string, fn: string, filename: string, frontMatter: Record<string, unknown>): PendingItem {
  const dir = join(root, 'roster', fn, 'pending');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, '---\n---\nbody', 'utf8');
  return { function: fn, class: 'error', path, filename, frontMatter, body: 'body' };
}

// Lesson class — <agentDir>/pending/, target derived from the agent dir.
function lessonItem(
  root: string,
  agentDir: string,
  filename: string,
  frontMatter: Record<string, unknown> = {},
): PendingItem {
  const dir = join(root, agentDir, 'pending');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, '---\n---\nbody', 'utf8');
  return {
    function: agentDir.split('/')[0]!,
    agent: agentDir,
    class: 'lesson',
    path,
    filename,
    frontMatter,
    body: 'body',
  };
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
    assert.equal(relativeTargetRefused('../x', root), true);
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

test('Codex 2nd-pass: approve refuses a target under a symlinked dir escaping the workspace', () => {
  const escape = mkdtempSync(join(tmpdir(), 'roster-escape-'));
  try {
    withRoot((root) => {
      // gtm/approved is a symlink pointing OUTSIDE the workspace.
      mkdirSync(join(root, 'gtm'), { recursive: true });
      symlinkSync(escape, join(root, 'gtm', 'approved'));
      const a = item(root, 'gtm', 'a.md', { target_on_approve: 'gtm/approved/a.md' });
      const res = approveItem(a, root);
      assert.ok(!res.ok, 'must refuse to move through a symlinked dir');
      assert.ok(existsSync(a.path), 'source untouched');
      assert.ok(!existsSync(join(escape, 'a.md')), 'nothing written into the escape target');
      assert.equal(relativeTargetRefused('gtm/approved/a.md', root), true);
    });
  } finally {
    rmSync(escape, { recursive: true, force: true });
  }
});

test('rejectItem: deletes the file', () => {
  withRoot((root) => {
    const a = item(root, 'gtm', 'a.md', {});
    rejectItem(a, root);
    assert.ok(!existsSync(a.path));
  });
});

test('rejectItem (round-7 finding 8): an error-class item leaves an acknowledgement sentinel so sync cannot resurrect it', () => {
  withRoot((root) => {
    const a = item(root, 'gtm', 'error-deadbeef.md', {});
    rejectItem(a, root);
    assert.ok(!existsSync(a.path));
    assert.ok(
      existsSync(join(root, 'roster', 'gtm', 'pending', 'acknowledged', 'error-deadbeef')),
      'the sentinel marks the evidence as acknowledged',
    );
    // A non-error item leaves no sentinel.
    const b = item(root, 'gtm', 'manual-note.md', {});
    rejectItem(b, root);
    assert.ok(!existsSync(join(root, 'roster', 'gtm', 'pending', 'acknowledged', 'manual-note')));
  });
});

// --- lesson class: derived approve target -------------------------------------

test('lesson class: approve target derived as <agent>/playbook/<filename>', () => {
  withRoot((root) => {
    const l = lessonItem(root, 'design/design-system-builder', 'lesson-1.md');
    assert.equal(resolveApproveTarget(l), 'design/design-system-builder/playbook/lesson-1.md');
    const res = approveItem(l, root);
    assert.ok(res.ok, 'approve should succeed without target_on_approve');
    assert.ok(!existsSync(l.path));
    assert.ok(existsSync(join(root, 'design/design-system-builder/playbook/lesson-1.md')));
  });
});

test('lesson class: cross-cutting peer agent at the workspace root', () => {
  withRoot((root) => {
    const l = lessonItem(root, 'dreamer', 'L-2026-01-01-001.md');
    assert.equal(resolveApproveTarget(l), 'dreamer/playbook/L-2026-01-01-001.md');
    assert.ok(approveItem(l, root).ok);
    assert.ok(existsSync(join(root, 'dreamer/playbook/L-2026-01-01-001.md')));
  });
});

test('lesson class: explicit target_on_approve still wins over the derived one', () => {
  withRoot((root) => {
    const l = lessonItem(root, 'gtm/sdr', 'x.md', { target_on_approve: 'gtm/sdr/elsewhere/x.md' });
    assert.equal(resolveApproveTarget(l), 'gtm/sdr/elsewhere/x.md');
    assert.ok(approveItem(l, root).ok);
    assert.ok(existsSync(join(root, 'gtm/sdr/elsewhere/x.md')));
    assert.ok(!existsSync(join(root, 'gtm/sdr/playbook/x.md')));
  });
});

test('error class without target_on_approve still cannot be approved', () => {
  withRoot((root) => {
    const a = item(root, 'gtm', 'a.md', {});
    assert.equal(resolveApproveTarget(a), null);
    assert.ok(!approveItem(a, root).ok);
    assert.ok(existsSync(a.path));
  });
});

test('ids do not collide across surfaces sharing a name and filename', () => {
  withRoot((root) => {
    const err = item(root, 'dreamer', 'x.md', {});
    const lesson = lessonItem(root, 'dreamer', 'x.md');
    assert.notEqual(computeItemId(err), computeItemId(lesson));
    const hit = resolveItemBySelector([err, lesson], computeItemId(lesson), root);
    assert.ok(hit.ok && hit.item === lesson);
  });
});

test('lesson class: derived target through an escaping symlink is refused', () => {
  const escape = mkdtempSync(join(tmpdir(), 'roster-escape-lesson-'));
  try {
    withRoot((root) => {
      const l = lessonItem(root, 'gtm/sdr', 'L-1.md');
      // <agent>/playbook is a symlink pointing OUTSIDE the workspace — the derived
      // target must be confined exactly like an explicit one.
      symlinkSync(escape, join(root, 'gtm', 'sdr', 'playbook'));
      const res = approveItem(l, root);
      assert.ok(!res.ok, 'must refuse a derived target that escapes');
      assert.ok(existsSync(l.path), 'source untouched');
      assert.ok(!existsSync(join(escape, 'L-1.md')), 'nothing written outside the workspace');
    });
  } finally {
    rmSync(escape, { recursive: true, force: true });
  }
});
