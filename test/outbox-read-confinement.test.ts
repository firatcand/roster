import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LocalOutbox, type DeliverResult, type ObjectDeliverResult, type ObjectTarget, type OutboxRecord, type RemoteTarget } from '../src/lib/persistence/outbox.ts';
import { LocalLedger } from '../src/lib/persistence/local/ledger.ts';
import { InvalidRecordError, sha256Hex } from '../src/lib/persistence/contracts.ts';

// ═════════════════════════════════════════════════════════════════════════════
// ROUND-13 finding 2: the outbox spool + checkpoint readers were missed by the
// round-12 read-confinement sweep.
//
// `spoolBytes`/`readSpool` never confined the `spool/` ANCESTOR and read with a
// raw unbounded readFileSync, so a planted `.roster/ops/<uuid>/spool -> …`
// diverted every queued-artifact read (`run show --allow-partial`, drain) to
// foreign bytes — and `assertRegularFileIfExists` even chmod'd the foreign file.
// `readCheckpointFile` used a blocking readFileSync with no O_NOFOLLOW, so a
// FIFO at `outbox/checkpoint.json` HUNG the next drain after remote delivery and
// a symlink there let a foreign file stand in for derived state.
// ═════════════════════════════════════════════════════════════════════════════

const posixOnly = process.platform === 'win32' ? 'POSIX only (symlinks/mkfifo)' : false;

type Env = { dir: string; opsRoot: string; ws: string; treeDir: string };

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'roster-outbox-confine-'));
  const opsRoot = join(dir, 'ops');
  const ws = randomUUID();
  return { dir, opsRoot, ws, treeDir: join(opsRoot, ws) };
}

function makeOutbox(env: Env): LocalOutbox {
  return new LocalOutbox({ ledger: new LocalLedger({ opsRoot: env.opsRoot, workspaceId: env.ws }) });
}

class CommittingTarget implements RemoteTarget {
  readonly seen: string[] = [];
  async deliver(record: OutboxRecord): Promise<DeliverResult> {
    this.seen.push(record.id);
    return 'committed';
  }
}

class MemoryObjects implements ObjectTarget {
  readonly stored = new Map<string, Buffer>();
  async deliver(digest: string, bytes: Buffer): Promise<ObjectDeliverResult> {
    this.stored.set(digest, Buffer.from(bytes));
    return { outcome: 'stored', objectVersionId: 'v1' };
  }
}

function mkfifo(path: string): void {
  const mk = spawnSync('mkfifo', [path]);
  assert.equal(mk.status, 0, 'mkfifo available on POSIX');
}

// ── spool: the symlinked ANCESTOR ────────────────────────────────────────────

test('spool: a symlinked spool/ is refused — foreign bytes are never read and never chmod-ed', { skip: posixOnly }, () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue({ namespace: 'runs', id: 'seed', kind: 'run-event', payload: { n: 1 } });

    // A foreign blob dir OUTSIDE the ledger tree, holding a file whose name is
    // the digest the reader will ask for, at a deliberately loose mode.
    const bytes = Buffer.from('foreign artifact bytes');
    const digest = sha256Hex(bytes);
    const foreign = join(env.dir, 'foreign-spool');
    mkdirSync(foreign, { recursive: true });
    const foreignFile = join(foreign, digest);
    writeFileSync(foreignFile, bytes);
    chmodSync(foreignFile, 0o666);
    symlinkSync(foreign, join(env.treeDir, 'spool'));

    assert.throws(
      () => outbox.spoolBytes(digest),
      (err: unknown) => err instanceof InvalidRecordError && /symbolic link/.test((err as Error).message),
      'a symlinked spool/ must be refused, never followed to foreign bytes',
    );
    assert.equal(statSync(foreignFile).mode & 0o777, 0o666, 'the foreign file must not be chmod-ed by a READ');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('spool: a drain refuses a symlinked spool/ instead of delivering foreign bytes', { skip: posixOnly }, async () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    const bytes = Buffer.from('real spooled bytes');
    const digest = sha256Hex(bytes);
    outbox.enqueueArtifact({ namespace: 'artifacts', id: 'a1', kind: 'artifact', payload: { digest } }, bytes);

    // Swap the staged spool dir for a link to a foreign copy — the shape an
    // agent can plant between the outage and the heal.
    const real = join(env.treeDir, 'spool');
    const foreign = join(env.dir, 'foreign-spool');
    renameSync(real, foreign);
    symlinkSync(foreign, real);

    const objects = new MemoryObjects();
    await assert.rejects(
      () => outbox.drain(new CommittingTarget(), { objects }),
      (err: unknown) => err instanceof InvalidRecordError && /symbolic link/.test((err as Error).message),
    );
    assert.equal(objects.stored.size, 0, 'nothing is delivered through the link');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('spool: a FIFO at spool/<digest> is refused through the descriptor, never blocking a read', { skip: posixOnly }, () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue({ namespace: 'runs', id: 'seed', kind: 'run-event', payload: { n: 1 } });
    const digest = sha256Hex(Buffer.from('never stored'));
    const spool = join(env.treeDir, 'spool');
    mkdirSync(spool, { recursive: true });
    mkfifo(join(spool, digest));

    assert.throws(
      () => outbox.spoolBytes(digest),
      (err: unknown) => err instanceof InvalidRecordError && /not a regular file/.test((err as Error).message),
    );
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

// ── checkpoint: FIFO must not hang the drain, symlink must not stand in ──────

// The FIFO break is a HANG, so it is reproduced in a CHILD process under a hard
// timeout: an in-process blocking readFileSync would wedge the whole runner.
test('checkpoint: a FIFO at outbox/checkpoint.json never hangs a drain — it degrades to a warning', { skip: posixOnly }, () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue({ namespace: 'runs', id: 'seed', kind: 'run-event', payload: { n: 1 } });
    outbox.checkpoint();
    const cp = join(env.treeDir, 'outbox', 'checkpoint.json');
    rmSync(cp, { force: true });
    mkfifo(cp);

    const script = join(env.dir, 'drain.mjs');
    writeFileSync(
      script,
      [
        `import { LocalLedger } from ${JSON.stringify(resolve('src/lib/persistence/local/ledger.ts'))};`,
        `import { LocalOutbox } from ${JSON.stringify(resolve('src/lib/persistence/outbox.ts'))};`,
        `const ledger = new LocalLedger({ opsRoot: process.argv[2], workspaceId: process.argv[3] });`,
        `const outbox = new LocalOutbox({ ledger });`,
        `outbox.enqueue({ namespace: 'runs', id: 'r2', kind: 'run-event', payload: { n: 2 } });`,
        `const report = await outbox.drain({ async deliver() { return 'committed'; } });`,
        `console.log(JSON.stringify({ delivered: report.namespaces.runs.delivered, warned: report.checkpointWarning !== null }));`,
      ].join('\n'),
      'utf8',
    );
    const out = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', script, env.opsRoot, env.ws],
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    assert.equal(out.signal, null, `the drain must not hang on a FIFO checkpoint (stderr: ${out.stderr})`);
    assert.equal(out.status, 0, out.stderr);
    const report = JSON.parse(out.stdout.trim()) as { delivered: number; warned: boolean };
    assert.equal(report.delivered, 2, 'both records are delivered — the checkpoint is derived state');
    assert.equal(report.warned, true, 'the unusable checkpoint path is a doctor-visible warning');
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});

test('checkpoint: a symlinked checkpoint.json is refused, never adopted as derived state', { skip: posixOnly }, () => {
  const env = makeEnv();
  try {
    const outbox = makeOutbox(env);
    outbox.enqueue({ namespace: 'runs', id: 'seed', kind: 'run-event', payload: { n: 1 } });
    const truth = outbox.checkpoint();
    const cp = join(env.treeDir, 'outbox', 'checkpoint.json');

    // A foreign file holding a byte-identical, checksum-VALID checkpoint: the
    // old reader followed the link, matched the checksum, and skipped the write
    // entirely — foreign state silently accepted as ours.
    const foreign = join(env.dir, 'foreign-checkpoint.json');
    renameSync(cp, foreign);
    symlinkSync(foreign, cp);
    assert.equal((JSON.parse(readFileSync(foreign, 'utf8')) as { checksum: string }).checksum, truth.checksum);

    assert.throws(
      () => outbox.checkpoint(),
      (err: unknown) => err instanceof InvalidRecordError && /symbolic link/.test((err as Error).message),
    );
  } finally {
    rmSync(env.dir, { recursive: true, force: true });
  }
});
