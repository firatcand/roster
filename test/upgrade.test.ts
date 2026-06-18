import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeInit } from '../src/commands/init.ts';
import { executeUpgrade, decideUpgradeAction } from '../src/lib/upgrade.ts';
import {
  readScaffoldManifest,
  writeScaffoldManifest,
  scaffoldManifestPath,
} from '../src/lib/scaffold-manifest.ts';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

async function withWorkspace(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-upgrade-'));
  try {
    await executeInit({ cwd, name: 'test-ws', silent: true, noGit: true });
    await fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Rewrite one manifest entry's baseline hash (to simulate a prior template version).
function setBaseline(cwd: string, path: string, hash: string): void {
  const m = readScaffoldManifest(cwd);
  assert.ok(m, 'manifest exists');
  const e = m.files.find((f) => f.path === path);
  assert.ok(e, `manifest entry for ${path}`);
  e.sha256 = hash;
  writeScaffoldManifest(cwd, m);
}

test('decideUpgradeAction: every branch', () => {
  const base = { path: 'x', sha256: 'BASE' };
  assert.equal(decideUpgradeAction({ disk: { kind: 'absent' }, newSha: 'N', manifestEntry: base }), 'create');
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'N' }, newSha: 'N', manifestEntry: base }), 'noop');
  // degraded: no entry, differs
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'D' }, newSha: 'N', manifestEntry: undefined }), 'conflict');
  // template unchanged (newSha == baseline), user edited → noop (nothing to deliver)
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'D' }, newSha: 'BASE', manifestEntry: base }), 'noop');
  // pristine (disk == baseline) + template changed → update
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'BASE' }, newSha: 'N', manifestEntry: base }), 'update');
  // edited (disk != baseline) + template changed → conflict
  assert.equal(decideUpgradeAction({ disk: { kind: 'file', sha: 'D' }, newSha: 'N', manifestEntry: base }), 'conflict');
});

test('init writes a scaffold manifest covering scaffold files', async () => {
  await withWorkspace(async (cwd) => {
    assert.ok(existsSync(scaffoldManifestPath(cwd)));
    const m = readScaffoldManifest(cwd);
    assert.ok(m && m.files.length > 10);
    assert.ok(m.files.some((f) => f.path === 'gtm/EXPERT.md'));
  });
});

test('fresh workspace → upgrade is a noop', async () => {
  await withWorkspace(async (cwd) => {
    const r = executeUpgrade({ cwd, dryRun: false });
    assert.deepEqual([r.created, r.updated, r.conflicts], [[], [], []]);
  });
});

test('pristine file + changed template → auto-update, no .new', async () => {
  await withWorkspace(async (cwd) => {
    const f = join(cwd, 'gtm', 'EXPERT.md');
    writeFileSync(f, 'OLD BASELINE\n');
    setBaseline(cwd, 'gtm/EXPERT.md', sha('OLD BASELINE\n')); // disk == baseline → pristine
    const r = executeUpgrade({ cwd, dryRun: false });
    assert.ok(r.updated.includes('gtm/EXPERT.md'));
    assert.ok(readFileSync(f, 'utf8').includes('GTM Expert')); // restored to current template
    assert.ok(!existsSync(`${f}.new`));
  });
});

test('user-edited file + changed template → .new written, user file untouched', async () => {
  await withWorkspace(async (cwd) => {
    const f = join(cwd, 'gtm', 'EXPERT.md');
    writeFileSync(f, 'MY EDITS\n');
    setBaseline(cwd, 'gtm/EXPERT.md', 'a-different-old-baseline'); // disk != baseline → edited; template != baseline
    const r = executeUpgrade({ cwd, dryRun: false });
    assert.ok(r.conflicts.includes('gtm/EXPERT.md'));
    assert.equal(readFileSync(f, 'utf8'), 'MY EDITS\n'); // never clobbered
    assert.ok(existsSync(`${f}.new`));
    assert.ok(readFileSync(`${f}.new`, 'utf8').includes('GTM Expert'));
  });
});

test('user-edited file + UNCHANGED template → noop (no .new noise)', async () => {
  await withWorkspace(async (cwd) => {
    const f = join(cwd, 'gtm', 'EXPERT.md');
    writeFileSync(f, 'MY EDITS\n'); // manifest baseline left as the real template hash
    const r = executeUpgrade({ cwd, dryRun: false });
    assert.ok(!r.conflicts.includes('gtm/EXPERT.md'));
    assert.ok(!existsSync(`${f}.new`));
  });
});

test('missing file → created', async () => {
  await withWorkspace(async (cwd) => {
    const f = join(cwd, 'gtm', 'EXPERT.md');
    unlinkSync(f);
    const r = executeUpgrade({ cwd, dryRun: false });
    assert.ok(r.created.includes('gtm/EXPERT.md'));
    assert.ok(existsSync(f));
  });
});

test('symlinked dest → skipped, not overwritten', async () => {
  await withWorkspace(async (cwd) => {
    const f = join(cwd, 'gtm', 'EXPERT.md');
    unlinkSync(f);
    symlinkSync(join(cwd, 'conventions.md'), f);
    setBaseline(cwd, 'gtm/EXPERT.md', 'old'); // force a would-be change
    const r = executeUpgrade({ cwd, dryRun: false });
    assert.ok(r.symlinkSkipped.includes('gtm/EXPERT.md'));
    assert.ok(!existsSync(`${f}.new`));
  });
});

test('template dropped a file → kept, reported, never deleted', async () => {
  await withWorkspace(async (cwd) => {
    const ghost = join(cwd, 'gtm', 'GHOST.md');
    writeFileSync(ghost, 'user content\n');
    const m = readScaffoldManifest(cwd)!;
    m.files.push({ path: 'gtm/GHOST.md', sha256: sha('user content\n') });
    writeScaffoldManifest(cwd, m);
    const r = executeUpgrade({ cwd, dryRun: false });
    assert.ok(r.droppedKept.includes('gtm/GHOST.md'));
    assert.ok(existsSync(ghost));
  });
});

test('no manifest → degraded safe mode + re-seeds a baseline', async () => {
  await withWorkspace(async (cwd) => {
    const f = join(cwd, 'gtm', 'EXPERT.md');
    writeFileSync(f, 'EDITED\n');
    unlinkSync(scaffoldManifestPath(cwd));
    const r = executeUpgrade({ cwd, dryRun: false });
    assert.equal(r.hadManifest, false);
    assert.ok(r.conflicts.includes('gtm/EXPERT.md'));
    assert.equal(readFileSync(f, 'utf8'), 'EDITED\n'); // not clobbered
    assert.ok(existsSync(scaffoldManifestPath(cwd))); // seeded for next time
  });
});

test('Codex 2nd-pass: an unresolved conflict persists across consecutive upgrades', async () => {
  await withWorkspace(async (cwd) => {
    const f = join(cwd, 'gtm', 'EXPERT.md');
    writeFileSync(f, 'MY EDITS\n');
    setBaseline(cwd, 'gtm/EXPERT.md', 'old-divergent-baseline'); // edited + template changed
    const r1 = executeUpgrade({ cwd, dryRun: false });
    assert.ok(r1.conflicts.includes('gtm/EXPERT.md'));
    rmSync(`${f}.new`); // user deletes the .new without merging
    // Second run, nothing else changed: the conflict must NOT silently become a noop.
    const r2 = executeUpgrade({ cwd, dryRun: false });
    assert.ok(r2.conflicts.includes('gtm/EXPERT.md'), 'conflict still flagged on re-run');
    assert.ok(existsSync(`${f}.new`), '.new regenerated');
    assert.equal(readFileSync(f, 'utf8'), 'MY EDITS\n'); // never auto-clobbered
  });
});

test('Codex 2nd-pass: refuses to write through a symlinked parent dir (escape)', async () => {
  await withWorkspace(async (cwd) => {
    const escapeTarget = mkdtempSync(join(tmpdir(), 'roster-escape-'));
    try {
      // Replace gtm/ with a symlink pointing outside the workspace.
      rmSync(join(cwd, 'gtm'), { recursive: true, force: true });
      symlinkSync(escapeTarget, join(cwd, 'gtm'));
      setBaseline(cwd, 'gtm/EXPERT.md', 'old'); // would-be change
      const r = executeUpgrade({ cwd, dryRun: false });
      assert.ok(r.symlinkSkipped.includes('gtm/EXPERT.md'));
      // Nothing written into the escape target.
      assert.ok(!existsSync(join(escapeTarget, 'EXPERT.md')));
      assert.ok(!existsSync(join(escapeTarget, 'EXPERT.md.new')));
    } finally {
      rmSync(escapeTarget, { recursive: true, force: true });
    }
  });
});

test('--dry-run reports but writes nothing', async () => {
  await withWorkspace(async (cwd) => {
    const f = join(cwd, 'gtm', 'EXPERT.md');
    writeFileSync(f, 'OLD\n');
    setBaseline(cwd, 'gtm/EXPERT.md', sha('OLD\n'));
    const before = readFileSync(scaffoldManifestPath(cwd), 'utf8');
    const r = executeUpgrade({ cwd, dryRun: true });
    assert.ok(r.updated.includes('gtm/EXPERT.md'));
    assert.equal(readFileSync(f, 'utf8'), 'OLD\n'); // unchanged
    assert.equal(readFileSync(scaffoldManifestPath(cwd), 'utf8'), before); // manifest untouched
  });
});

test('refuses outside a workspace', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-noupgrade-'));
  try {
    assert.throws(() => executeUpgrade({ cwd, dryRun: false }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
