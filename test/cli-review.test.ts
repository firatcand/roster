import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd: string): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function makeCwd(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-review-cli-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function writePending(root: string, fn: string, filename: string, content: string): string {
  const dir = join(root, 'roster', fn, 'pending');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  writeFileSync(path, content, 'utf8');
  return path;
}

test('review: empty workspace → exit 0 with "no pending" message', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['review'], fix.root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No unread decisions/);
  } finally {
    fix.cleanup();
  }
});

test('review <fn>: function exists but empty → exit 0 with "no pending for fn" message', () => {
  const fix = makeCwd();
  try {
    mkdirSync(join(fix.root, 'roster', 'gtm'), { recursive: true });
    const r = runCli(['review', 'gtm'], fix.root);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /No unread decisions for gtm/);
  } finally {
    fix.cleanup();
  }
});

test('review <fn>: unknown function → exit 1 with invalidFunctionError', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['review', 'nonexistent'], fix.root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown function 'nonexistent'/);
  } finally {
    fix.cleanup();
  }
});

test('review --json: lists pending items as JSON on non-TTY', () => {
  const fix = makeCwd();
  try {
    writePending(fix.root, 'gtm', 'a.md', '---\ntarget_on_approve: gtm/approved/a.md\n---\nbody a');
    writePending(fix.root, 'dreamer', 'b.md', '---\ntarget_on_approve: dreamer/playbook/b.md\n---\nbody b');
    const r = runCli(['review', '--json'], fix.root);
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout) as Array<{ function: string; filename: string; path: string; id: string }>;
    assert.equal(payload.length, 2);
    assert.deepEqual(
      payload.map((p) => `${p.function}/${p.filename}`).sort(),
      ['dreamer/b.md', 'gtm/a.md'],
    );
    // Paths are workspace-relative; each item carries a stable 8-hex id.
    for (const item of payload) {
      assert.ok(!item.path.startsWith('/'), `expected workspace-relative path, got: ${item.path}`);
      assert.match(item.id, /^[a-f0-9]{8}$/);
    }
  } finally {
    fix.cleanup();
  }
});

test('review --json <fn>: scoped to one function', () => {
  const fix = makeCwd();
  try {
    writePending(fix.root, 'gtm', 'a.md', '');
    writePending(fix.root, 'dreamer', 'b.md', '');
    const r = runCli(['review', 'gtm', '--json'], fix.root);
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout) as Array<{ function: string }>;
    assert.equal(payload.length, 1);
    assert.equal(payload[0]!.function, 'gtm');
  } finally {
    fix.cleanup();
  }
});

test('review: non-TTY with items but no --json → exit 1 with TTY error', () => {
  const fix = makeCwd();
  try {
    writePending(fix.root, 'gtm', 'a.md', '---\ntarget_on_approve: gtm/x.md\n---\n');
    const r = runCli(['review'], fix.root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /requires an interactive terminal/);
  } finally {
    fix.cleanup();
  }
});

test('review: unknown flag → exit 1', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['review', '--bogus'], fix.root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag for review/);
  } finally {
    fix.cleanup();
  }
});

test('review: invalid function name (uppercase) → exit 1', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['review', 'BadName'], fix.root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /invalid function name 'BadName'/);
  } finally {
    fix.cleanup();
  }
});

test('review: too many positional args → exit 1', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['review', 'gtm', 'extra'], fix.root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /at most one function name/);
  } finally {
    fix.cleanup();
  }
});

function idOf(root: string, fn: string): string {
  const r = runCli(['review', '--json'], root);
  const payload = JSON.parse(r.stdout) as Array<{ function: string; id: string }>;
  return payload.find((p) => p.function === fn)!.id;
}

test('review --approve <id>: moves item to target_on_approve, exit 0', () => {
  const fix = makeCwd();
  try {
    const src = writePending(fix.root, 'gtm', 'a.md', '---\ntarget_on_approve: gtm/approved/a.md\n---\nbody');
    const r = runCli(['review', '--approve', idOf(fix.root, 'gtm'), '--json'], fix.root);
    assert.equal(r.status, 0);
    assert.ok(!existsSync(src));
    assert.ok(existsSync(join(fix.root, 'gtm', 'approved', 'a.md')));
  } finally {
    fix.cleanup();
  }
});

test('review --reject <id>: deletes item, exit 0', () => {
  const fix = makeCwd();
  try {
    const src = writePending(fix.root, 'gtm', 'a.md', '---\ntarget_on_approve: gtm/x.md\n---\n');
    const r = runCli(['review', '--reject', idOf(fix.root, 'gtm'), '--json'], fix.root);
    assert.equal(r.status, 0);
    assert.ok(!existsSync(src));
  } finally {
    fix.cleanup();
  }
});

test('review --approve <unknown id> → exit 1 not-found, JSON error', () => {
  const fix = makeCwd();
  try {
    writePending(fix.root, 'gtm', 'a.md', '---\ntarget_on_approve: gtm/x.md\n---\n');
    const r = runCli(['review', '--approve', 'deadbeef', '--json'], fix.root);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /"reason": "not-found"/);
  } finally {
    fix.cleanup();
  }
});

test('review --approve <id> with no target_on_approve → exit 1, file untouched', () => {
  const fix = makeCwd();
  try {
    const src = writePending(fix.root, 'gtm', 'a.md', '---\ntype: note\n---\nno target');
    const r = runCli(['review', '--approve', idOf(fix.root, 'gtm'), '--json'], fix.root);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /missing target_on_approve/);
    assert.ok(existsSync(src), 'file must NOT be moved or deleted on failed approve');
  } finally {
    fix.cleanup();
  }
});

test('review --approve <id> with target_on_approve escaping workspace → exit 1, file untouched', () => {
  const fix = makeCwd();
  try {
    const src = writePending(fix.root, 'gtm', 'a.md', '---\ntarget_on_approve: ../escape.md\n---\n');
    const r = runCli(['review', '--approve', idOf(fix.root, 'gtm'), '--json'], fix.root);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /escapes workspace/);
    assert.ok(existsSync(src));
    assert.ok(!existsSync(join(fix.root, '..', 'escape.md')));
  } finally {
    fix.cleanup();
  }
});

test('review --approve twice: second call → exit 1 not-found (idempotent)', () => {
  const fix = makeCwd();
  try {
    writePending(fix.root, 'gtm', 'a.md', '---\ntarget_on_approve: gtm/approved/a.md\n---\n');
    const id = idOf(fix.root, 'gtm');
    assert.equal(runCli(['review', '--approve', id, '--json'], fix.root).status, 0);
    assert.equal(runCli(['review', '--approve', id, '--json'], fix.root).status, 1);
  } finally {
    fix.cleanup();
  }
});

test('review --approve + --reject together → exit 1 arg error', () => {
  const fix = makeCwd();
  try {
    const r = runCli(['review', '--approve', 'x', '--reject', 'y'], fix.root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutually exclusive/);
  } finally {
    fix.cleanup();
  }
});
