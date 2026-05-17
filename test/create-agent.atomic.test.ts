// ROS-55 — atomic-write rollback test.
//
// Simulates a write failure on plans/<plan>.yaml (Step 5 of the SKILL.md
// transaction, file #7 in the canonical write order). Asserts the rollback
// walk leaves the in-memory filesystem clean and the rollback list is
// complete (including silent intermediate ancestor dirs, per
// docs/learnings/2026-Q2/mkdir-p-hides-ancestors-from-rollback-walker.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atomicWrite, type AtomicFs } from '../src/lib/create-agent/atomic-write.ts';
import { loadFixture } from '../src/lib/create-agent/fixture-loader.ts';
import { render, type RenderOutput } from '../src/lib/create-agent/render.ts';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
const FIXTURE_PATH = join(repoRoot, 'test/fixtures/guided-content-agent.yaml');

interface FakeFsEvent {
  op: 'mkdir' | 'writeFile' | 'unlink' | 'rmdir';
  path: string;
  ok: boolean;
}

interface FakeFs extends AtomicFs {
  files: Map<string, string>;
  dirs: Set<string>;
  events: FakeFsEvent[];
}

// Builds an in-memory fs that records every operation. `throwOn` lets the
// test inject a failure at a specific write target.
function makeFakeFs(
  opts: {
    throwOnWrite?: (path: string) => Error | null;
    throwOnMkdir?: (path: string) => Error | null;
  } = {},
): FakeFs {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const events: FakeFsEvent[] = [];

  const fs: FakeFs = {
    files,
    dirs,
    events,

    async mkdir(path) {
      const err = opts.throwOnMkdir?.(path);
      if (err) {
        events.push({ op: 'mkdir', path, ok: false });
        throw err;
      }
      if (dirs.has(path)) {
        events.push({ op: 'mkdir', path, ok: true });
        return { created: false };
      }
      dirs.add(path);
      events.push({ op: 'mkdir', path, ok: true });
      return { created: true };
    },

    async writeFile(path, content) {
      const err = opts.throwOnWrite?.(path);
      if (err) {
        events.push({ op: 'writeFile', path, ok: false });
        throw err;
      }
      files.set(path, content);
      events.push({ op: 'writeFile', path, ok: true });
    },

    async unlink(path) {
      if (!files.has(path)) {
        events.push({ op: 'unlink', path, ok: false });
        const enoent = new Error(`ENOENT: ${path}`) as Error & { code: string };
        enoent.code = 'ENOENT';
        throw enoent;
      }
      files.delete(path);
      events.push({ op: 'unlink', path, ok: true });
    },

    async rmdir(path) {
      if (!dirs.has(path)) {
        events.push({ op: 'rmdir', path, ok: false });
        const enoent = new Error(`ENOENT: ${path}`) as Error & { code: string };
        enoent.code = 'ENOENT';
        throw enoent;
      }
      dirs.delete(path);
      events.push({ op: 'rmdir', path, ok: true });
    },
  };

  return fs;
}

function happyPathOutput(): RenderOutput {
  const fixture = loadFixture(FIXTURE_PATH);
  return render({ fixture, expert: null });
}

test('happy path: every file written, no rollback', async () => {
  const output = happyPathOutput();
  const fs = makeFakeFs();
  const result = await atomicWrite(output, fs);
  assert.equal(result.outcome, 'success');
  assert.equal(result.residual.length, 0);
  // Every rendered file landed in the fake fs.
  for (const path of output.files.keys()) {
    assert.ok(fs.files.has(path), `file ${path} should have been written`);
  }
  // Slash command was written too (outside rollback root).
  assert.ok(fs.files.has(output.slashCommand.path));
});

test('rollback: writeFile failure on plans/<plan>.yaml leaves zero files under <fn>/<agent>/', async () => {
  const output = happyPathOutput();
  // Find the plan path so we can target it and assert against the agent root.
  let planPath = '';
  for (const path of output.files.keys()) {
    if (path.match(/\/plans\/[^/]+\.yaml$/)) {
      planPath = path;
      break;
    }
  }
  assert.ok(planPath, 'fixture must include a starter plan');

  const fs = makeFakeFs({
    throwOnWrite: (path) => {
      if (path === planPath) {
        const err = new Error('ENOSPC: simulated no-space') as Error & { code: string };
        err.code = 'ENOSPC';
        return err;
      }
      return null;
    },
  });

  const result = await atomicWrite(output, fs);

  assert.equal(result.outcome, 'rollback', 'outcome must be rollback');
  assert.equal(result.failureAt, planPath, 'failureAt points at the plan file');
  assert.equal(result.residual.length, 0, 'no residual paths — every newly-created path was cleaned');

  // Zero files exist under the agent root after rollback.
  const agentRoot = output.dirs[0]; // first dir is <fn>/<agent>/
  for (const p of fs.files.keys()) {
    assert.ok(
      !p.startsWith(`${agentRoot}/`) && p !== agentRoot,
      `file ${p} should NOT exist under ${agentRoot}/ after rollback`,
    );
  }
  // Zero directories exist under the agent root either — including silent
  // intermediate ancestors (per mkdir-p learning). All 15 dirs from agentDirs()
  // were tracked and removed.
  for (const d of fs.dirs) {
    assert.ok(
      !d.startsWith(`${agentRoot}/`) && d !== agentRoot,
      `dir ${d} should NOT exist under ${agentRoot}/ after rollback`,
    );
  }
});

test('rollback: every dir from output.dirs is in the rollback list', async () => {
  const output = happyPathOutput();
  let planPath = '';
  for (const path of output.files.keys()) {
    if (path.match(/\/plans\/[^/]+\.yaml$/)) {
      planPath = path;
      break;
    }
  }
  const fs = makeFakeFs({
    throwOnWrite: (path) => {
      if (path === planPath) {
        const err = new Error('ENOSPC') as Error & { code: string };
        err.code = 'ENOSPC';
        return err;
      }
      return null;
    },
  });

  const result = await atomicWrite(output, fs);
  assert.equal(result.outcome, 'rollback');

  // All 15 dirs from agentDirs() are present in rollback (silent ancestors
  // like .claude/, projects/_template/log/ — covered).
  const rollbackSet = new Set(result.rollback);
  for (const dir of output.dirs) {
    assert.ok(rollbackSet.has(dir), `dir ${dir} must be in rollback list`);
  }
});

test('rollback: the failure-point file is in the rollback list (appended before the write attempt)', async () => {
  const output = happyPathOutput();
  let planPath = '';
  for (const path of output.files.keys()) {
    if (path.match(/\/plans\/[^/]+\.yaml$/)) {
      planPath = path;
      break;
    }
  }
  const fs = makeFakeFs({
    throwOnWrite: (path) => {
      if (path === planPath) {
        const err = new Error('ENOSPC') as Error & { code: string };
        err.code = 'ENOSPC';
        return err;
      }
      return null;
    },
  });

  const result = await atomicWrite(output, fs);
  assert.ok(
    result.rollback.includes(planPath),
    'failureAt path must be in rollback list — append-before-write semantics from SKILL.md',
  );
});

test('rollback: walk order is strictly reverse-creation', async () => {
  const output = happyPathOutput();
  let planPath = '';
  for (const path of output.files.keys()) {
    if (path.match(/\/plans\/[^/]+\.yaml$/)) {
      planPath = path;
      break;
    }
  }
  const fs = makeFakeFs({
    throwOnWrite: (path) => {
      if (path === planPath) {
        const err = new Error('ENOSPC') as Error & { code: string };
        err.code = 'ENOSPC';
        return err;
      }
      return null;
    },
  });

  const result = await atomicWrite(output, fs);
  assert.equal(result.outcome, 'rollback');

  // Extract the sequence of unlink/rmdir operations from the event log.
  const cleanupOps = fs.events
    .filter((e) => e.op === 'unlink' || e.op === 'rmdir')
    .map((e) => e.path);

  // The reverse of the rollback list should match the order of cleanup ops.
  const expected = [...result.rollback].reverse();
  assert.deepEqual(cleanupOps, expected, 'cleanup walk must follow reverse-creation order');
});

test('partial-slash-failure: writeFile fails on slash command path, agent tree preserved', async () => {
  const output = happyPathOutput();
  const fs = makeFakeFs({
    throwOnWrite: (path) => {
      if (path === output.slashCommand.path) {
        const err = new Error('EPERM') as Error & { code: string };
        err.code = 'EPERM';
        return err;
      }
      return null;
    },
  });

  const result = await atomicWrite(output, fs);
  assert.equal(result.outcome, 'partial-slash-failure');
  assert.equal(result.failureAt, output.slashCommand.path);
  assert.equal(result.residual.length, 0);

  // Agent tree is canonical — every file from output.files still exists.
  for (const path of output.files.keys()) {
    assert.ok(fs.files.has(path), `agent-tree file ${path} should remain after slash failure`);
  }
  // Slash command not written.
  assert.equal(fs.files.has(output.slashCommand.path), false);
});

test('opts.skipSlashCommand: success without writing the slash file', async () => {
  const output = happyPathOutput();
  const fs = makeFakeFs();
  const result = await atomicWrite(output, fs, { skipSlashCommand: true });
  assert.equal(result.outcome, 'success');
  assert.equal(fs.files.has(output.slashCommand.path), false);
});

test('rollback: mkdir failure sets failureAt to the failing dir', async () => {
  // pr-toolkit review (ROS-55): the mkdir failure path used to leave
  // failureAt undefined, mirroring it to the file-write path.
  const output = happyPathOutput();
  // Fail on the 3rd dir (after agent root + subagents/ are created).
  const targetDir = output.dirs[2];
  const fs = makeFakeFs({
    throwOnMkdir: (path) => {
      if (path === targetDir) {
        const err = new Error('EACCES') as Error & { code: string };
        err.code = 'EACCES';
        return err;
      }
      return null;
    },
  });
  const result = await atomicWrite(output, fs);
  assert.equal(result.outcome, 'rollback');
  assert.equal(result.failureAt, targetDir, 'mkdir failure path must set failureAt');
  // The two successfully-created ancestors are in the rollback list AND
  // were cleaned up.
  assert.ok(result.rollback.includes(output.dirs[0]));
  assert.ok(result.rollback.includes(output.dirs[1]));
  // The failed dir is NOT in the rollback list (mkdir reported failure,
  // not success).
  assert.ok(!result.rollback.includes(targetDir));
});

test('rollback: invariant failure (Step 1) aborts before any fs operation', async () => {
  const output = happyPathOutput();
  // Drop a subagent file to trip invariant 1 — atomicWrite should throw
  // BEFORE any mkdir/writeFile call.
  for (const path of output.files.keys()) {
    if (path.endsWith('/subagents/critic.md')) {
      output.files.delete(path);
      break;
    }
  }
  const fs = makeFakeFs();
  await assert.rejects(
    () => atomicWrite(output, fs),
    /Invariant 1/,
  );
  assert.equal(fs.events.length, 0, 'no fs operations should have run');
  assert.equal(fs.dirs.size, 0);
  assert.equal(fs.files.size, 0);
});
