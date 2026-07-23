import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { ConditionalWriteFailed, type FileStore } from '../src/lib/persistence/s3-core.ts';
import {
  acquireSetupLock,
  ensureOpsGitignore,
  runSetup,
  setupLockPath,
  OPS_GITIGNORE_LINE,
  type SetupOptions,
} from '../src/lib/persistence/setup.ts';
import { setupJournalPath, type SetupJournal, type SetupPhase } from '../src/lib/persistence/setup-journal.ts';
import { opsRootFor, resolveOpsBackend } from '../src/lib/persistence/resolve.ts';
import { MemoryFileStore } from '../src/lib/persistence/s3-core.ts';
import { WORKSPACE_MARKER_KEY, workspaceMarkerBody } from '../src/lib/persistence/objects.ts';
import { LocalLedger } from '../src/lib/persistence/local/ledger.ts';
import { LocalOutbox } from '../src/lib/persistence/outbox.ts';
import { loadPersistenceConfig } from '../src/lib/persistence/config-schema.ts';

// #318 stage 5: `roster ops setup` — flag validation, local end-to-end, the
// 7b fault-injection matrix (every phase boundary incl. after-remote-commit-
// before-journal), lock + remote arbitration, the 7d --new-identity fork, and
// 7e gitignore idempotence. PG parts are ROSTER_OPS_TEST_ADMIN_URL-gated.

const BIN = resolve('src/bin/roster.ts');
const ADMIN = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';
const HAS_PG = ADMIN.length > 0;
const pgOpts = { skip: HAS_PG ? false : ('ROSTER_OPS_TEST_ADMIN_URL not set' as const) };

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd: string, env: Record<string, string> = {}): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readJournal(cwd: string): SetupJournal | null {
  const path = setupJournalPath(cwd);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as SetupJournal;
}

function killAt(phase: SetupPhase, moment: 'begin' | 'committed'): SetupOptions['onPhase'] {
  return (p, m) => {
    if (p === phase && m === moment) throw new Error(`abort:${p}:${m}`);
  };
}

// ---------- usage + flag validation ----------

test('cli ops: no subcommand → usage on stderr, exit 1', () => {
  const cwd = tmp('ops-usage-');
  try {
    const r = runCli(['ops'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: roster ops setup/);
    assert.match(r.stderr, /--backend local\|postgres-s3/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli ops: unknown subcommand → usage, exit 1', () => {
  const cwd = tmp('ops-usage2-');
  try {
    const r = runCli(['ops', 'teardown'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /usage: roster ops setup/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli ops setup: missing flags → ONE error listing every missing flag', () => {
  const cwd = tmp('ops-flags-');
  try {
    const bare = runCli(['ops', 'setup'], cwd);
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /--backend local\|postgres-s3/);

    const pgMissing = runCli(['ops', 'setup', '--backend', 'postgres-s3'], cwd);
    assert.equal(pgMissing.status, 1);
    assert.match(pgMissing.stderr, /--database brain\|dedicated/);
    assert.match(pgMissing.stderr, /--bucket <name>/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli ops setup: invalid values and combos refuse', () => {
  const cwd = tmp('ops-invalid-');
  try {
    const badBackend = runCli(['ops', 'setup', '--backend', 'sqlite'], cwd);
    assert.equal(badBackend.status, 1);
    assert.match(badBackend.stderr, /--backend must be 'local' or 'postgres-s3'/);

    const badDb = runCli(['ops', 'setup', '--backend', 'postgres-s3', '--database', 'mysql', '--bucket', 'b-b-b'], cwd);
    assert.equal(badDb.status, 1);
    assert.match(badDb.stderr, /--database must be 'brain' or 'dedicated'/);

    const stray = runCli(['ops', 'setup', '--backend', 'local', '--bucket', 'acme-ops'], cwd);
    assert.equal(stray.status, 1);
    assert.match(stray.stderr, /--bucket only applies to --backend postgres-s3/);

    const unknown = runCli(['ops', 'setup', '--backend', 'local', '--bogus'], cwd);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown flag '--bogus'/);

    const badBucket = runCli(['ops', 'setup', '--backend', 'postgres-s3', '--database', 'dedicated', '--bucket', 'X'], cwd);
    assert.equal(badBucket.status, 1);
    assert.match(badBucket.stderr, /bucket/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli ops setup: postgres-s3 without env URLs → error listing every missing env var', () => {
  const cwd = tmp('ops-env-');
  try {
    const r = runCli(
      ['ops', 'setup', '--backend', 'postgres-s3', '--database', 'dedicated', '--bucket', 'acme-ops'],
      cwd,
      { ROSTER_OPS_ADMIN_URL: '', ROSTER_OPS_URL: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ROSTER_OPS_ADMIN_URL/);
    assert.match(r.stderr, /ROSTER_OPS_URL/);
    assert.match(r.stderr, /AWS_ACCESS_KEY_ID/);
    assert.match(r.stderr, /AWS_SECRET_ACCESS_KEY/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- local end-to-end via the CLI ----------

test('cli ops setup: local end-to-end, --json shape, idempotent revalidate', () => {
  const cwd = tmp('ops-local-');
  try {
    const first = runCli(['ops', 'setup', '--backend', 'local', '--name', 'acme', '--json'], cwd);
    assert.equal(first.status, 0, first.stderr);
    const parsed = JSON.parse(first.stdout) as Record<string, unknown>;
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, 'created');
    assert.equal(parsed.state, 'configured-local');
    assert.equal(parsed.backend, 'local');
    assert.equal(parsed.gitignore, 'appended');
    const ws = parsed.workspace as { id: string; name: string };
    assert.equal(ws.name, 'acme');
    assert.ok((parsed.backendInfo as { components: object }).components);

    const config = loadPersistenceConfig(cwd);
    assert.equal(config.state, 'configured-local');
    assert.equal(config.config?.workspace.id, ws.id);
    assert.ok(existsSync(join(opsRootFor(cwd), ws.id, 'meta.json')), 'per-UUID tree minted');
    assert.ok(!existsSync(setupJournalPath(cwd)), 'journal removed at done');

    const second = runCli(['ops', 'setup', '--backend', 'local', '--name', 'acme', '--json'], cwd);
    assert.equal(second.status, 0, second.stderr);
    const revalidated = JSON.parse(second.stdout) as Record<string, unknown>;
    assert.equal(revalidated.status, 'validated');
    assert.equal((revalidated.workspace as { id: string }).id, ws.id, 'same UUID on re-run');
    assert.equal(revalidated.gitignore, 'present');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('cli ops setup: conflicting flags against an existing config refuse', () => {
  const cwd = tmp('ops-conflict-');
  try {
    assert.equal(runCli(['ops', 'setup', '--backend', 'local', '--name', 'acme'], cwd).status, 0);
    const r = runCli(['ops', 'setup', '--backend', 'local', '--name', 'other'], cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--name conflicts with roster\/persistence\.yaml/);
    const rb = runCli(['ops', 'setup', '--backend', 'postgres-s3', '--database', 'dedicated', '--bucket', 'b-b-b'], cwd);
    assert.equal(rb.status, 1);
    assert.match(rb.stderr, /--backend conflicts with roster\/persistence\.yaml/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- 7e: gitignore idempotence ----------

test('gitignore 7e: template-scaffolded workspace already ships the rule; handcrafted one gains it — nothing appended twice', () => {
  const cwd = tmp('ops-gitignore-');
  const handcrafted = tmp('ops-gitignore-hc-');
  try {
    // An init-scaffolded workspace: the template marker block SHIPS the rule,
    // so ensureOpsGitignore must report 'present' and change nothing.
    const block = readFileSync(resolve('templates/gitignore-defaults.txt'), 'utf8');
    assert.ok(
      block.split('\n').some((l) => l.trim() === OPS_GITIGNORE_LINE),
      'templates/gitignore-defaults.txt ships the /.roster/ops/ rule',
    );
    writeFileSync(join(cwd, '.gitignore'), block);
    assert.equal(ensureOpsGitignore(cwd), 'present');
    const after = readFileSync(join(cwd, '.gitignore'), 'utf8');
    assert.equal(after, block, 'template-derived .gitignore untouched');
    assert.equal(after.split('\n').filter((l) => l.trim() === OPS_GITIGNORE_LINE).length, 1);
    // Full setup on top stays idempotent too.
    assert.equal(runCli(['ops', 'setup', '--backend', 'local', '--name', 'acme'], cwd).status, 0);
    const final = readFileSync(join(cwd, '.gitignore'), 'utf8');
    assert.equal(final.split('\n').filter((l) => l.trim() === OPS_GITIGNORE_LINE).length, 1);

    // A handcrafted .gitignore WITHOUT the rule gains it exactly once.
    writeFileSync(join(handcrafted, '.gitignore'), 'node_modules/\n.env\n');
    assert.equal(ensureOpsGitignore(handcrafted), 'appended');
    const hc = readFileSync(join(handcrafted, '.gitignore'), 'utf8');
    assert.ok(hc.startsWith('node_modules/\n.env\n'), 'existing content preserved');
    assert.equal(hc.split('\n').filter((l) => l.trim() === OPS_GITIGNORE_LINE).length, 1);
    assert.equal(ensureOpsGitignore(handcrafted), 'present');
    assert.equal(readFileSync(join(handcrafted, '.gitignore'), 'utf8'), hc, 'second run appends nothing');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(handcrafted, { recursive: true, force: true });
  }
});

test('gitignore: created from scratch when absent', () => {
  const cwd = tmp('ops-gitignore2-');
  try {
    assert.equal(ensureOpsGitignore(cwd), 'appended');
    assert.equal(readFileSync(join(cwd, '.gitignore'), 'utf8'), `${OPS_GITIGNORE_LINE}\n`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- setup lock ----------

test('setup lock: live holder → loser errors immediately; stale (dead pid) lock is reclaimed', async () => {
  const cwd = tmp('ops-lock-');
  try {
    const lockPath = setupLockPath(cwd);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, cwd, acquiredAt: Date.now() }));
    try {
      await assert.rejects(runSetup({ cwd, backend: 'local', name: 'acme' }), /another ops setup is already running/);
    } finally {
      unlinkSync(lockPath);
    }

    // A finished child's pid is a dead holder: reclaimed, setup proceeds.
    const dead = spawnSync('/bin/sh', ['-c', 'exit 0']);
    writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, cwd, acquiredAt: Date.now() - 60_000 }));
    const result = await runSetup({ cwd, backend: 'local', name: 'acme' });
    assert.equal(result.status, 'created');
    assert.ok(!existsSync(lockPath), 'lock released after setup');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('setup lock: acquire + release round-trip is exclusive', () => {
  const cwd = tmp('ops-lock2-');
  try {
    const lock = acquireSetupLock(cwd);
    assert.throws(() => acquireSetupLock(cwd), /another ops setup is already running/);
    lock.release();
    const again = acquireSetupLock(cwd);
    again.release();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- 7b fault-injection matrix (local, ungated) ----------

const LOCAL_BOUNDARIES: Array<[SetupPhase, 'begin' | 'committed']> = [
  ['intent', 'begin'],
  ['intent', 'committed'],
  ['gitignore-ensured', 'begin'],
  ['gitignore-ensured', 'committed'],
  ['config-written', 'begin'],
  ['config-written', 'committed'],
  ['done', 'begin'],
  ['done', 'committed'],
];

test('fault injection 7b (local): abort at every boundary → roll-forward, same UUID, no strays', async () => {
  const cwd = tmp('ops-fault-local-');
  try {
    let uuid: string | null = null;
    for (const [phase, moment] of LOCAL_BOUNDARIES) {
      await assert.rejects(
        runSetup({ cwd, backend: 'local', name: 'acme', onPhase: killAt(phase, moment) }),
        new RegExp(`abort:${phase}:${moment}`),
      );
      const journal = readJournal(cwd);
      if (journal !== null) {
        if (uuid === null) uuid = journal.workspaceId;
        else assert.equal(journal.workspaceId, uuid, `journal UUID stable at ${phase}:${moment}`);
      }
    }
    // done:committed aborted AFTER completion — the final run validates.
    const final = await runSetup({ cwd, backend: 'local', name: 'acme' });
    assert.equal(final.status, 'validated');
    assert.ok(uuid !== null);
    assert.equal(final.workspace.id, uuid, 'the rightful owner is never refused, identity survives');
    assert.ok(!existsSync(setupJournalPath(cwd)));
    // No stranded per-UUID trees.
    const trees = readdirSync(opsRootFor(cwd)).filter((e) => e !== 'setup-journal.json');
    assert.deepEqual(trees, [uuid]);
    assert.equal((await resolveOpsBackend(cwd)).state, 'local');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- 7d: --new-identity fork (local, ungated) ----------

test('fork 7d (local): fresh empty tree, old queued outbox NOT replayed, old tree preserved', async () => {
  const cwd = tmp('ops-fork-local-');
  try {
    const first = await runSetup({ cwd, backend: 'local', name: 'acme' });
    const oldId = first.workspace.id;
    const oldLedger = new LocalLedger({ opsRoot: opsRootFor(cwd), workspaceId: oldId });
    const oldOutbox = new LocalOutbox({ ledger: oldLedger });
    oldOutbox.enqueue({ namespace: 'runs', id: 'evt-1', kind: 'run-event', payload: { runId: 'r1' } });
    const bytes = randomBytes(48);
    const staged = oldOutbox.enqueueArtifact({ namespace: 'artifacts', id: 'art-1', kind: 'artifact', payload: {} }, bytes);
    assert.equal([...oldOutbox.fold().entries.values()].filter((e) => e.status === 'queued').length, 2);

    const fork = await runSetup({ cwd, backend: 'local', newIdentity: true });
    assert.equal(fork.status, 'forked');
    const newId = fork.workspace.id;
    assert.notEqual(newId, oldId);
    assert.equal(fork.workspace.name, 'acme', 'display name carries over by default');
    assert.equal(fork.orphaned?.workspaceId, oldId);
    assert.equal(fork.orphaned?.database, false);

    // Old tree untouched: queued entries + spool bytes still there.
    const oldFold = new LocalOutbox({ ledger: new LocalLedger({ opsRoot: opsRootFor(cwd), workspaceId: oldId }) }).fold();
    assert.equal([...oldFold.entries.values()].filter((e) => e.status === 'queued').length, 2);
    assert.ok(existsSync(join(opsRootFor(cwd), oldId, 'spool', staged.digest)));

    // Fork starts empty: nothing replayed into the new identity.
    const newFold = new LocalOutbox({ ledger: new LocalLedger({ opsRoot: opsRootFor(cwd), workspaceId: newId }) }).fold();
    assert.equal(newFold.entries.size, 0);
    const resolved = await resolveOpsBackend(cwd);
    assert.equal(resolved.state, 'local');
    if (resolved.state === 'local') {
      assert.equal(resolved.config.workspace.id, newId);
      assert.deepEqual(await resolved.backend.hitl.count(), { committed: 0, queued: 0, partial: false });
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------- PG-gated: full pipeline, remote fault matrix, arbitration, fork ----------

function urlForDb(db: string): string {
  const u = new URL(ADMIN);
  u.pathname = '/' + db;
  return u.toString();
}

type Harness = { db: string; url: string; suffix: string; roles: string[]; close: () => Promise<void> };

async function makeDb(): Promise<Harness> {
  const suffix = randomBytes(6).toString('hex');
  const db = `ops_setup_${suffix}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${db}`);
  } finally {
    await root.end();
  }
  const roles: string[] = [];
  return {
    db,
    url: urlForDb(db),
    suffix,
    roles,
    close: async () => {
      const root2 = new pg.Client({ connectionString: ADMIN });
      await root2.connect();
      try {
        await root2.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [db],
        );
        await root2.query(`DROP DATABASE IF EXISTS ${db}`);
        for (const role of roles) await root2.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
      } finally {
        await root2.end();
      }
    },
  };
}

async function createRuntimeRole(h: Harness, tag = ''): Promise<{ role: string; runtimeUrl: string }> {
  const role = `ops_rt_${tag}${h.suffix}`;
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  try {
    await root.query(
      `CREATE ROLE ${role} LOGIN PASSWORD 'pw-${h.suffix}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
  } finally {
    await root.end();
  }
  h.roles.push(role);
  const u = new URL(h.url);
  u.username = role;
  u.password = `pw-${h.suffix}`;
  return { role, runtimeUrl: u.toString() };
}

async function bindingState(h: Harness): Promise<{ workspaceId: string | null; state: string | null }> {
  const client = new pg.Client({ connectionString: h.url });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT workspace_id::text AS workspace_id, state FROM hitl.meta WHERE singleton`,
    );
    const row = res.rows[0] as { workspace_id: string | null; state: string | null } | undefined;
    return { workspaceId: row?.workspace_id ?? null, state: row?.state ?? null };
  } finally {
    await client.end();
  }
}

function pgSetupOpts(
  cwd: string,
  env: NodeJS.ProcessEnv,
  store: FileStore,
  extra: Partial<SetupOptions> = {},
): SetupOptions {
  return {
    cwd,
    backend: 'postgres-s3',
    database: 'dedicated',
    bucket: 'acme-ops',
    name: 'acme',
    env,
    adminFiles: store,
    validateBucket: async () => ({ objectLock: false }),
    ...extra,
  };
}

const PG_BOUNDARIES: Array<[SetupPhase, 'begin' | 'committed']> = [
  ['intent', 'begin'],
  ['intent', 'committed'],
  ['gitignore-ensured', 'begin'],
  ['gitignore-ensured', 'committed'],
  ['db-stamped-pending', 'begin'],
  ['db-stamped-pending', 'committed'],
  ['bucket-claimed', 'begin'],
  ['bucket-claimed', 'committed'],
  ['db-finalized', 'begin'],
  ['db-finalized', 'committed'],
  ['config-written', 'begin'],
  ['config-written', 'committed'],
  ['done', 'begin'],
];

test('fault injection 7b (postgres-s3): every boundary incl. remote-commit-before-journal rolls forward', pgOpts, async () => {
  const h = await makeDb();
  const cwd = tmp('ops-fault-pg-');
  try {
    const { runtimeUrl } = await createRuntimeRole(h);
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
    const store = new MemoryFileStore();
    let uuid: string | null = null;
    for (const [phase, moment] of PG_BOUNDARIES) {
      await assert.rejects(
        runSetup(pgSetupOpts(cwd, env, store, { onPhase: killAt(phase, moment) })),
        new RegExp(`abort:${phase}:${moment}`),
      );
      const journal = readJournal(cwd);
      if (journal !== null) {
        if (uuid === null) uuid = journal.workspaceId;
        else assert.equal(journal.workspaceId, uuid, `journal UUID stable at ${phase}:${moment}`);
      }
    }
    // Clean run: rolls the rest forward — never refuses the rightful owner.
    const final = await runSetup(pgSetupOpts(cwd, env, store));
    assert.ok(uuid !== null);
    assert.ok(final.status === 'resumed' || final.status === 'validated', final.status);
    assert.equal(final.workspace.id, uuid);
    assert.ok(!existsSync(setupJournalPath(cwd)));

    // No stranded resources: one binding (finalized, our UUID), one marker (ours).
    const binding = await bindingState(h);
    assert.deepEqual(binding, { workspaceId: uuid, state: 'finalized' });
    const marker = await store.get(WORKSPACE_MARKER_KEY);
    assert.ok(marker !== null);
    assert.equal((JSON.parse(marker.body.toString('utf8')) as { workspaceId: string }).workspaceId, uuid);
    const trees = readdirSync(opsRootFor(cwd)).filter((e) => e !== 'setup-journal.json');
    assert.deepEqual(trees, [uuid]);

    const resolved = await resolveOpsBackend(cwd, { env, files: store });
    assert.equal(resolved.state, 'postgres-s3');
    if (resolved.state === 'postgres-s3') {
      assert.equal(resolved.binding.state, 'finalized');
      await resolved.close();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('validate mode (postgres-s3): re-run reports backendInfo + passing role invariants', pgOpts, async () => {
  const h = await makeDb();
  const cwd = tmp('ops-validate-pg-');
  try {
    const { runtimeUrl } = await createRuntimeRole(h);
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
    const store = new MemoryFileStore();
    const first = await runSetup(pgSetupOpts(cwd, env, store));
    assert.equal(first.status, 'created');
    assert.equal(first.roleInvariants?.ok, true, 'the mandatory pre-finalization role gate passed');

    const second = await runSetup(pgSetupOpts(cwd, env, store, { files: store }));
    assert.equal(second.status, 'validated');
    assert.equal(second.workspace.id, first.workspace.id);
    assert.equal(second.backendInfo?.backend, 'postgres-s3');
    assert.equal(second.roleInvariants?.ok, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('concurrent remote arbitration: a second directory can never claim the same DB or bucket', pgOpts, async () => {
  const h = await makeDb();
  const cwdA = tmp('ops-arb-a-');
  const cwdB = tmp('ops-arb-b-');
  const cwdC = tmp('ops-arb-c-');
  try {
    const { runtimeUrl } = await createRuntimeRole(h);
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
    const store = new MemoryFileStore();
    const a = await runSetup(pgSetupOpts(cwdA, env, store));
    const markerBefore = await store.get(WORKSPACE_MARKER_KEY);
    assert.ok(markerBefore !== null);

    // Same tuple, different workspace UUID → DB arbitrates with belongs-to.
    await assert.rejects(runSetup(pgSetupOpts(cwdB, env, store)), /belongs to workspace acme/);
    // Different tuple, different UUID → same refusal; still no second claim.
    await assert.rejects(
      runSetup(pgSetupOpts(cwdC, env, store, { bucket: 'other-ops' })),
      /belongs to workspace acme/,
    );

    const markerAfter = await store.get(WORKSPACE_MARKER_KEY);
    assert.ok(markerAfter !== null && markerAfter.body.equals(markerBefore.body), 'marker untouched');
    const binding = await bindingState(h);
    assert.deepEqual(binding, { workspaceId: a.workspace.id, state: 'finalized' });
  } finally {
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
    rmSync(cwdC, { recursive: true, force: true });
    await h.close();
  }
});

test('same-UUID marker with DIFFERENT bytes (name): setup refuses at bucket-claim, DB never finalized', pgOpts, async () => {
  const h = await makeDb();
  const cwd = tmp('ops-marker-bytes-');
  try {
    const { runtimeUrl } = await createRuntimeRole(h);
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
    const store = new MemoryFileStore();
    const ws = randomUUID();
    // The bucket already holds a marker for the SAME UUID but a DIFFERENT display
    // name (hence different bytes / sha256). An earlier build accepted it and
    // finalized the DB against the requested-name digest — an unusable binding.
    await store.put(WORKSPACE_MARKER_KEY, workspaceMarkerBody({ workspaceId: ws, name: 'different' }), {
      ifNoneMatch: '*',
      contentType: 'application/json',
    });

    await assert.rejects(
      runSetup(pgSetupOpts(cwd, env, store, { name: 'expected', mintId: () => ws })),
      /bytes disagree|marker is immutable/,
    );

    // The DB was stamped pending (db-stamped-pending ran) but NEVER finalized —
    // the refusal fires before recordMarkerEtag/finalize.
    const binding = await bindingState(h);
    assert.equal(binding.workspaceId, ws);
    assert.equal(binding.state, 'pending', 'DB must not be finalized on a marker-bytes disagreement');
    // The foreign-named marker is untouched (create-only, never overwritten).
    const marker = await store.get(WORKSPACE_MARKER_KEY);
    assert.ok(marker !== null);
    assert.equal((JSON.parse(marker.body.toString('utf8')) as { name: string }).name, 'different');
    // No config was written; resolution reports setup-incomplete (journal resumable).
    assert.equal(loadPersistenceConfig(cwd).state, 'legacy-implicit');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('same-UUID resume with a DIFFERENT tuple: DB refuses before any bucket claim', pgOpts, async () => {
  const h = await makeDb();
  const cwd = tmp('ops-tuple-');
  try {
    const { runtimeUrl } = await createRuntimeRole(h);
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
    const store = new MemoryFileStore();
    // Crash after the stamp lands but before the journal knows (worst case).
    await assert.rejects(
      runSetup(pgSetupOpts(cwd, env, store, { onPhase: killAt('db-stamped-pending', 'committed') })),
      /abort:db-stamped-pending:committed/,
    );
    assert.equal(await store.get(WORKSPACE_MARKER_KEY), null, 'no bucket claim before the tuple gate');
    // Re-entry with a different bucket flag conflicts with the journal.
    await assert.rejects(
      runSetup(pgSetupOpts(cwd, env, store, { bucket: 'other-ops' })),
      /--bucket conflicts with the in-progress setup journal/,
    );
    assert.equal(await store.get(WORKSPACE_MARKER_KEY), null, 'still no bucket claimed');
    // Resume with the SAME tuple succeeds (DB stamp discovered, rolled forward).
    const final = await runSetup(pgSetupOpts(cwd, env, store));
    assert.equal(final.status, 'resumed');
    assert.notEqual(await store.get(WORKSPACE_MARKER_KEY), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('fork 7d (postgres-s3): refuses without --yes; --yes forks to fresh resources, old claim untouched', pgOpts, async () => {
  const h1 = await makeDb();
  const h2 = await makeDb();
  const cwd = tmp('ops-fork-pg-');
  try {
    const rt1 = await createRuntimeRole(h1, 'a');
    const env1 = { ROSTER_OPS_ADMIN_URL: h1.url, ROSTER_OPS_URL: rt1.runtimeUrl } as NodeJS.ProcessEnv;
    const store1 = new MemoryFileStore();
    const first = await runSetup(pgSetupOpts(cwd, env1, store1));
    const oldId = first.workspace.id;

    // Queue an offline record under the old identity.
    const oldOutbox = new LocalOutbox({ ledger: new LocalLedger({ opsRoot: opsRootFor(cwd), workspaceId: oldId }) });
    oldOutbox.enqueue({ namespace: 'runs', id: 'old-evt', kind: 'run-event', payload: { runId: 'r-old' } });

    // Refusal without --yes names what would be orphaned.
    await assert.rejects(
      runSetup(pgSetupOpts(cwd, env1, store1, { newIdentity: true })),
      /--new-identity would orphan a claimed backend/,
    );

    // Fork with --yes to a FRESH database + bucket (strict 1:1 binding).
    const rt2 = await createRuntimeRole(h2, 'b');
    const env2 = { ROSTER_OPS_ADMIN_URL: h2.url, ROSTER_OPS_URL: rt2.runtimeUrl } as NodeJS.ProcessEnv;
    const store2 = new MemoryFileStore();
    const fork = await runSetup(pgSetupOpts(cwd, env2, store2, { bucket: 'acme-ops-2', newIdentity: true, yes: true }));
    assert.equal(fork.status, 'forked');
    const newId = fork.workspace.id;
    assert.notEqual(newId, oldId);
    assert.equal(fork.orphaned?.workspaceId, oldId);
    assert.equal(fork.orphaned?.database, true);

    // Old resources stay claimed by the old identity — nothing deleted.
    assert.deepEqual(await bindingState(h1), { workspaceId: oldId, state: 'finalized' });
    const oldMarker = await store1.get(WORKSPACE_MARKER_KEY);
    assert.equal((JSON.parse(oldMarker!.body.toString('utf8')) as { workspaceId: string }).workspaceId, oldId);
    // Old tree (incl. its queued outbox entry) preserved, never replayed.
    const oldFold = new LocalOutbox({ ledger: new LocalLedger({ opsRoot: opsRootFor(cwd), workspaceId: oldId }) }).fold();
    assert.equal([...oldFold.entries.values()].filter((e) => e.status === 'queued').length, 1);

    // The fork resolves healthy against the new resources with an EMPTY queue.
    const resolved = await resolveOpsBackend(cwd, { env: env2, files: store2 });
    assert.equal(resolved.state, 'postgres-s3');
    if (resolved.state === 'postgres-s3') {
      assert.equal(resolved.config.workspace.id, newId);
      assert.equal(resolved.outbox.fold().entries.size, 0, 'old queued outbox never replays into the fork');
      assert.deepEqual(await resolved.backend.runs.count(), { committed: 0, queued: 0, partial: false });
      await resolved.close();
    }
    // The fork also stamped ONLY the new database.
    assert.deepEqual(await bindingState(h2), { workspaceId: newId, state: 'finalized' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h1.close();
    await h2.close();
  }
});

// ---------- symlink containment (a hostile checkout cannot redirect writes) ----------

test('symlink escape: a .roster symlink pointing outside the workspace refuses setup; nothing lands outside', async () => {
  const dir = tmp('ops-symlink-');
  try {
    const cwd = join(dir, 'workspace');
    const outside = join(dir, 'outside');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(cwd, '.roster'));
    await assert.rejects(runSetup({ cwd, backend: 'local', name: 'acme' }), /symbolic link/);
    assert.deepEqual(readdirSync(outside), [], 'no persistence file may land outside the workspace');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 19c: real SIGKILL while holding the setup lock (ungated) ----------

const SETUP_URL = new URL('../src/lib/persistence/setup.ts', import.meta.url).href;

const LOCAL_KILL_CHILD = `
import { runSetup } from ${JSON.stringify(SETUP_URL)};
const [cwd, phase, moment] = process.argv.slice(2);
await runSetup({
  cwd,
  backend: 'local',
  name: 'acme',
  onPhase: (p, m) => {
    if (p === phase && m === moment) process.kill(process.pid, 'SIGKILL');
  },
});
`;

function runSetupChildSync(script: string, args: readonly string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', script, ...args], {
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('fault 19c: child SIGKILLed holding the setup lock — rerun reclaims the stale lock and rolls forward', async () => {
  const cwd = tmp('ops-kill-lock-');
  try {
    const script = join(cwd, 'setup-child.ts');
    writeFileSync(script, LOCAL_KILL_CHILD);
    const r = runSetupChildSync(script, [cwd, 'config-written', 'begin']);
    assert.equal(r.signal, 'SIGKILL');
    assert.ok(existsSync(setupLockPath(cwd)), 'the dead child left its setup lock behind');
    const journal = readJournal(cwd);
    assert.ok(journal !== null && journal.phase === 'gitignore-ensured');
    const final = await runSetup({ cwd, backend: 'local', name: 'acme' });
    assert.equal(final.status, 'resumed');
    assert.equal(final.workspace.id, journal.workspaceId, 'stale-lock recovery never refuses the rightful owner');
    assert.ok(!existsSync(setupLockPath(cwd)), 'lock released after the rerun');
    assert.ok(!existsSync(setupJournalPath(cwd)));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(setupLockPath(cwd), { force: true });
  }
});

// ---------- 19a/b: real SIGKILL in the remote-commit-before-journal windows (PG-gated) ----------

// Disk-backed FileStore so a bucket claim made by a SIGKILLed child process is
// visible to the parent's resumed run (MemoryFileStore is per-process).
class DirFileStore implements FileStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private pathOf(key: string): string {
    return join(this.dir, Buffer.from(key).toString('base64url'));
  }

  async put(key: string, body: Buffer, opts: { ifNoneMatch?: '*'; ifMatch?: string; contentType?: string } = {}) {
    const p = this.pathOf(key);
    if (opts.ifNoneMatch === '*' && existsSync(p)) throw new ConditionalWriteFailed(key);
    if (opts.ifMatch !== undefined) {
      const existing = await this.get(key);
      if (existing === null || existing.etag !== opts.ifMatch) throw new ConditionalWriteFailed(key);
    }
    writeFileSync(p, body);
    return { etag: createHash('md5').update(body).digest('hex') };
  }

  async get(key: string) {
    const p = this.pathOf(key);
    if (!existsSync(p)) return null;
    const body = readFileSync(p);
    return { body, etag: createHash('md5').update(body).digest('hex') };
  }

  async head(key: string) {
    const g = await this.get(key);
    return g === null ? null : { etag: g.etag, size: g.body.length };
  }

  async del(key: string) {
    try {
      unlinkSync(this.pathOf(key));
    } catch {
      // idempotent
    }
  }
}

const S3_CORE_URL = new URL('../src/lib/persistence/s3-core.ts', import.meta.url).href;

const PG_KILL_CHILD = `
import { runSetup } from ${JSON.stringify(SETUP_URL)};
import { ConditionalWriteFailed } from ${JSON.stringify(S3_CORE_URL)};
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
const [cwd, phase, moment, storeDir, adminUrl, runtimeUrl] = process.argv.slice(2);
mkdirSync(storeDir, { recursive: true });
const pathOf = (key) => join(storeDir, Buffer.from(key).toString('base64url'));
const store = {
  async put(key, body, opts = {}) {
    const p = pathOf(key);
    if (opts.ifNoneMatch === '*' && existsSync(p)) throw new ConditionalWriteFailed(key);
    writeFileSync(p, body);
    return { etag: createHash('md5').update(body).digest('hex') };
  },
  async get(key) {
    const p = pathOf(key);
    if (!existsSync(p)) return null;
    const body = readFileSync(p);
    return { body, etag: createHash('md5').update(body).digest('hex') };
  },
  async head(key) {
    const g = await this.get(key);
    return g === null ? null : { etag: g.etag, size: g.body.length };
  },
  async del(key) {
    try { unlinkSync(pathOf(key)); } catch {}
  },
};
await runSetup({
  cwd,
  backend: 'postgres-s3',
  database: 'dedicated',
  bucket: 'acme-ops',
  name: 'acme',
  env: { ROSTER_OPS_ADMIN_URL: adminUrl, ROSTER_OPS_URL: runtimeUrl },
  adminFiles: store,
  files: store,
  validateBucket: async () => ({ objectLock: false }),
  onPhase: (p, m) => {
    if (p === phase && m === moment) process.kill(process.pid, 'SIGKILL');
  },
});
`;

for (const [phase, journalPhaseBefore] of [
  ['db-stamped-pending', 'gitignore-ensured'],
  ['bucket-claimed', 'db-stamped-pending'],
] as const) {
  test(`fault 19a/b: child SIGKILLed after ${phase} committed, before the journal — resume rolls forward`, pgOpts, async () => {
    const h = await makeDb();
    const cwd = tmp('ops-kill-pg-');
    try {
      const { runtimeUrl } = await createRuntimeRole(h);
      const storeDir = join(cwd, 'object-store');
      const script = join(cwd, 'setup-child.ts');
      writeFileSync(script, PG_KILL_CHILD);
      const r = runSetupChildSync(script, [cwd, phase, 'committed', storeDir, h.url, runtimeUrl]);
      assert.equal(r.signal, 'SIGKILL', r.stderr);
      const journal = readJournal(cwd);
      assert.ok(journal !== null, 'journal survives the kill');
      assert.equal(journal.phase, journalPhaseBefore, 'the journal never saw the killed phase commit');
      // The remote commit LANDED even though the journal does not know.
      const bindingAfterKill = await bindingState(h);
      assert.equal(bindingAfterKill.workspaceId, journal.workspaceId);
      assert.equal(bindingAfterKill.state, 'pending');
      if (phase === 'bucket-claimed') {
        assert.ok(existsSync(join(storeDir, Buffer.from(WORKSPACE_MARKER_KEY).toString('base64url'))));
      }
      // Resume in THIS process over the same on-disk store: roll-forward, same
      // UUID, no second claim, no rightful-owner refusal.
      const store = new DirFileStore(storeDir);
      const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
      const final = await runSetup(pgSetupOpts(cwd, env, store, { files: store }));
      assert.equal(final.status, 'resumed');
      assert.equal(final.workspace.id, journal.workspaceId);
      assert.deepEqual(await bindingState(h), { workspaceId: journal.workspaceId, state: 'finalized' });
      const marker = await store.get(WORKSPACE_MARKER_KEY);
      assert.ok(marker !== null);
      assert.equal(
        (JSON.parse(marker.body.toString('utf8')) as { workspaceId: string }).workspaceId,
        journal.workspaceId,
        'exactly one marker, owned by the journal identity',
      );
      assert.ok(!existsSync(setupJournalPath(cwd)));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(setupLockPath(cwd), { force: true });
      await h.close();
    }
  });
}

// ---------- finding: fresh setup must prove the ACTUAL runtime URL ----------

test('runtime-URL proof: a runtime role that cannot log in fails setup actionably; journal resumable; nothing finalized', pgOpts, async () => {
  const h = await makeDb();
  const cwd = tmp('ops-probe-');
  try {
    const role = `ops_nologin_${h.suffix}`;
    h.roles.push(role);
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      await root.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    } finally {
      await root.end();
    }
    const badUrl = new URL(h.url);
    badUrl.username = role;
    badUrl.password = 'irrelevant';
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: badUrl.toString() } as NodeJS.ProcessEnv;
    const store = new MemoryFileStore();
    await assert.rejects(runSetup(pgSetupOpts(cwd, env, store)), /runtime database URL cannot connect/);
    // No finalize: the binding stays pending and the journal stays resumable.
    const binding = await bindingState(h);
    assert.equal(binding.state, 'pending');
    const journal = readJournal(cwd);
    assert.ok(journal !== null && journal.phase === 'bucket-claimed');
    // Fixing the credential (grant LOGIN) lets the SAME setup resume to done.
    const fix = new pg.Client({ connectionString: ADMIN });
    await fix.connect();
    try {
      await fix.query(`ALTER ROLE ${role} LOGIN PASSWORD 'pw-${h.suffix}'`);
    } finally {
      await fix.end();
    }
    badUrl.password = `pw-${h.suffix}`;
    const fixedEnv = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: badUrl.toString() } as NodeJS.ProcessEnv;
    const final = await runSetup(pgSetupOpts(cwd, fixedEnv, store));
    assert.equal(final.status, 'resumed');
    assert.deepEqual(await bindingState(h), { workspaceId: journal.workspaceId, state: 'finalized' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h.close();
  }
});

test('runtime-URL proof: a runtime URL pointing at a DIFFERENT bound database (same role) refuses; admin DB not finalized', pgOpts, async () => {
  const a = await makeDb(); // DB A — the database `ops setup` is configuring (workspace W)
  const b = await makeDb(); // DB B — a DIFFERENT database already bound to workspace X
  const cwdA = tmp('ops-proveA-');
  const cwdB = tmp('ops-proveB-');
  try {
    // ONE cluster-global runtime role, usable against BOTH databases — the exact
    // shape that defeats a bare connect + probe (the role logs in either way).
    const role = `ops_rt_shared_${a.suffix}`;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    try {
      await root.query(
        `CREATE ROLE ${role} LOGIN PASSWORD 'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    } finally {
      await root.end();
    }
    a.roles.push(role); // cluster-global; a.close() drops it

    const runtimeUrlFor = (h: Harness): string => {
      const u = new URL(h.url);
      u.username = role;
      u.password = 'pw';
      return u.toString();
    };
    const runtimeUrlB = runtimeUrlFor(b);

    // Fully set up B (workspace X) with the shared role — B's runtime grants land.
    const storeB = new MemoryFileStore();
    const setupB = await runSetup(
      pgSetupOpts(cwdB, { ROSTER_OPS_ADMIN_URL: b.url, ROSTER_OPS_URL: runtimeUrlB } as NodeJS.ProcessEnv, storeB, {
        bucket: 'bbb-ops',
      }),
    );
    assert.equal(setupB.status, 'created');
    const xId = setupB.workspace.id;

    // Now configure A, but the RUNTIME url points at B (workspace X ≠ A's W).
    const storeA = new MemoryFileStore();
    const envA = { ROSTER_OPS_ADMIN_URL: a.url, ROSTER_OPS_URL: runtimeUrlB } as NodeJS.ProcessEnv;
    await assert.rejects(
      runSetup(pgSetupOpts(cwdA, envA, storeA, { bucket: 'aaa-ops' })),
      (err) => {
        assert.match((err as Error).message, /different workspace|1:1|same database/i);
        return true;
      },
    );
    // A must NOT be finalized — the proof caught the runtime URL's foreign binding.
    assert.equal((await bindingState(a)).state, 'pending', 'DB A must not finalize against a runtime URL for another DB');
    // B is untouched (still its own workspace).
    assert.deepEqual(await bindingState(b), { workspaceId: xId, state: 'finalized' });
  } finally {
    rmSync(cwdA, { recursive: true, force: true });
    rmSync(cwdB, { recursive: true, force: true });
    await a.close();
    await b.close();
  }
});

test('fork: pointing --new-identity --yes at the OLD database is refused by the stamp', pgOpts, async () => {
  const h = await makeDb();
  const cwd = tmp('ops-fork-refuse-');
  try {
    const { runtimeUrl } = await createRuntimeRole(h);
    const env = { ROSTER_OPS_ADMIN_URL: h.url, ROSTER_OPS_URL: runtimeUrl } as NodeJS.ProcessEnv;
    const store = new MemoryFileStore();
    const first = await runSetup(pgSetupOpts(cwd, env, store));
    await assert.rejects(
      runSetup(pgSetupOpts(cwd, env, store, { newIdentity: true, yes: true })),
      /belongs to workspace acme/,
    );
    // The old binding is untouched by the failed fork.
    assert.deepEqual(await bindingState(h), { workspaceId: first.workspace.id, state: 'finalized' });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    await h.close();
  }
});
