import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runSetup } from '../src/lib/persistence/setup.ts';
import { resolveOpsBackend } from '../src/lib/persistence/resolve.ts';
import { persistenceConfigPath } from '../src/lib/persistence/config-schema.ts';
import { createS3FileStore, type FileStore } from '../src/lib/persistence/s3-core.ts';
import { WORKSPACE_MARKER_KEY } from '../src/lib/persistence/objects.ts';
import { WorkspaceMismatchError, sha256Hex } from '../src/lib/persistence/contracts.ts';

// PLAN-318 7c — the explicit isolation swap test: two fully-populated
// workspaces (two databases, two MinIO buckets); swapping DB URLs or bucket
// tuples between them must refuse EVERY access (WorkspaceMismatch / marker
// mismatch) BEFORE any data is read or written. Gated on both the throwaway
// Postgres and the S3 endpoint.

const ADMIN = process.env.ROSTER_OPS_TEST_ADMIN_URL ?? '';
const S3_ENDPOINT = process.env.ROSTER_TEST_S3_ENDPOINT ?? '';
const HAS_BOTH = ADMIN.length > 0 && S3_ENDPOINT.length > 0;
const gate = { skip: HAS_BOTH ? false : ('ROSTER_OPS_TEST_ADMIN_URL and/or ROSTER_TEST_S3_ENDPOINT not set' as const) };
const S3_REGION = process.env.AWS_REGION ?? 'us-east-1';

function urlForDb(db: string): string {
  const u = new URL(ADMIN);
  u.pathname = '/' + db;
  return u.toString();
}

type Db = { db: string; url: string; suffix: string; roles: string[]; close: () => Promise<void> };

async function makeDb(): Promise<Db> {
  const suffix = randomBytes(6).toString('hex');
  const db = `ops_swap_${suffix}`;
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

async function createRuntimeRole(h: Db): Promise<{ role: string; runtimeUrl: string }> {
  const role = `ops_swap_rt_${h.suffix}`;
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

async function makeBucket(): Promise<string> {
  const bucket = `roster-ops-swap-${randomBytes(6).toString('hex')}`;
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  try {
    await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
  } finally {
    client.destroy();
  }
  return bucket;
}

async function rootStore(bucket: string): Promise<FileStore> {
  return await createS3FileStore({ bucket, region: S3_REGION, endpoint: S3_ENDPOINT, forcePathStyle: true });
}

type Workspace = {
  cwd: string;
  bucket: string;
  env: NodeJS.ProcessEnv;
  workspaceId: string;
  requestId: string;
  artifactDigest: string;
  artifactBytes: Buffer;
  db: Db;
};

async function ledgerCount(db: Db): Promise<number> {
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    const res = await client.query(`SELECT count(*)::int AS n FROM roster_ops.delivery_ledger`);
    return (res.rows[0] as { n: number }).n;
  } finally {
    await client.end();
  }
}

async function setupWorkspace(name: string): Promise<Workspace> {
  const db = await makeDb();
  const cwd = mkdtempSync(join(tmpdir(), `roster-swap-${name}-`));
  const { runtimeUrl } = await createRuntimeRole(db);
  const bucket = await makeBucket();
  const env = {
    ...process.env,
    ROSTER_OPS_ADMIN_URL: db.url,
    ROSTER_OPS_URL: runtimeUrl,
  } as NodeJS.ProcessEnv;
  const adminFiles = await rootStore(bucket);
  const setup = await runSetup({
    cwd,
    backend: 'postgres-s3',
    database: 'dedicated',
    bucket,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    name,
    env,
    adminFiles,
    files: adminFiles,
    validateBucket: async () => ({ objectLock: false }),
  });
  assert.equal(setup.status, 'created');

  // Populate: HITL request, run events, artifact — all committed.
  const resolved = await resolveOpsBackend(cwd, { env });
  assert.equal(resolved.state, 'postgres-s3');
  if (resolved.state !== 'postgres-s3') throw new Error('unreachable');
  const artifactBytes = randomBytes(96);
  let requestId = '';
  let artifactDigest = '';
  try {
    const req = await resolved.backend.hitl.createRequest({
      functionName: 'growth',
      title: `post for ${name}`,
      action: 'publish-post',
      target: `${name}/launch.md`,
      contentHash: sha256Hex(`${name}-draft`),
      body: 'body',
      expiresAt: null,
    });
    assert.equal(req.outcome, 'committed');
    requestId = req.id;
    for (let i = 1; i <= 2; i++) {
      const appended: import('../src/lib/persistence/contracts.ts').WriteOutcome =
        await resolved.backend.runs.appendEvent({
          runId: `run-${name}`,
          dedupeKey: `step-${i}`,
          type: 'step',
          data: { i },
        });
      assert.equal(appended.outcome, 'committed');
    }
    const art = await resolved.backend.artifacts.putArtifact(
      { filename: `${name}.bin`, contentType: 'application/octet-stream', runId: `run-${name}` },
      artifactBytes,
    );
    assert.equal(art.outcome, 'committed');
    artifactDigest = art.digest;
  } finally {
    await resolved.close();
  }
  return { cwd, bucket, env, workspaceId: setup.workspace.id, requestId, artifactDigest, artifactBytes, db };
}

test('7c isolation swap: two populated workspaces — swapped DB URLs and bucket tuples refuse before any data I/O', gate, async () => {
  const a = await setupWorkspace('alpha');
  const b = await setupWorkspace('beta');
  try {
    const ledgerBeforeA = await ledgerCount(a.db);
    const ledgerBeforeB = await ledgerCount(b.db);
    assert.equal(ledgerBeforeA, 4, 'alpha fully populated (1 request + 2 events + 1 artifact)');
    assert.equal(ledgerBeforeB, 4, 'beta fully populated');

    // (1) DB URLs swapped — both directions refuse at the binding.
    const aEnvWithBDb = {
      ...a.env,
      ROSTER_OPS_URL: b.env.ROSTER_OPS_URL,
      ROSTER_OPS_ADMIN_URL: b.env.ROSTER_OPS_ADMIN_URL,
    } as NodeJS.ProcessEnv;
    await assert.rejects(resolveOpsBackend(a.cwd, { env: aEnvWithBDb }), (err) => {
      assert.ok(err instanceof WorkspaceMismatchError);
      assert.match(err.message, /belongs to workspace beta/);
      return true;
    });
    const bEnvWithADb = {
      ...b.env,
      ROSTER_OPS_URL: a.env.ROSTER_OPS_URL,
      ROSTER_OPS_ADMIN_URL: a.env.ROSTER_OPS_ADMIN_URL,
    } as NodeJS.ProcessEnv;
    await assert.rejects(resolveOpsBackend(b.cwd, { env: bEnvWithADb }), (err) => {
      assert.ok(err instanceof WorkspaceMismatchError);
      assert.match(err.message, /belongs to workspace alpha/);
      return true;
    });

    // (2) Bucket tuples swapped in config — refused by the DB-stamped tuple
    // BEFORE the foreign bucket is ever touched.
    const aConfigPath = persistenceConfigPath(a.cwd);
    const aOriginalConfig = readFileSync(aConfigPath, 'utf8');
    writeFileSync(aConfigPath, aOriginalConfig.replace(`bucket: ${a.bucket}`, `bucket: ${b.bucket}`));
    await assert.rejects(resolveOpsBackend(a.cwd, { env: a.env }), (err) => {
      assert.ok(err instanceof WorkspaceMismatchError);
      assert.match(err.message, /does not match the tuple stamped in the database/);
      return true;
    });
    writeFileSync(aConfigPath, aOriginalConfig);

    // (3) Markers swapped at the bucket — the digest tripwire refuses.
    const aStore = await rootStore(a.bucket);
    const bStore = await rootStore(b.bucket);
    const aMarker = await aStore.get(WORKSPACE_MARKER_KEY);
    const bMarker = await bStore.get(WORKSPACE_MARKER_KEY);
    assert.ok(aMarker !== null && bMarker !== null);
    await aStore.del(WORKSPACE_MARKER_KEY);
    await aStore.put(WORKSPACE_MARKER_KEY, bMarker.body);
    await assert.rejects(resolveOpsBackend(a.cwd, { env: a.env }), (err) => {
      assert.ok(err instanceof WorkspaceMismatchError);
      assert.match(err.message, /marker/);
      return true;
    });
    await aStore.del(WORKSPACE_MARKER_KEY);
    await aStore.put(WORKSPACE_MARKER_KEY, aMarker.body);

    // Nothing was read or written across the boundary: ledgers unchanged,
    // nothing queued toward a foreign target.
    assert.equal(await ledgerCount(a.db), ledgerBeforeA);
    assert.equal(await ledgerCount(b.db), ledgerBeforeB);

    // Both workspaces still resolve healthy and read their OWN data.
    for (const w of [a, b]) {
      const resolved = await resolveOpsBackend(w.cwd, { env: w.env });
      assert.equal(resolved.state, 'postgres-s3');
      if (resolved.state !== 'postgres-s3') continue;
      try {
        assert.equal(
          [...resolved.outbox.fold().entries.values()].filter((e) => e.status === 'queued').length,
          0,
          'the refusals queued nothing',
        );
        const req = await resolved.backend.hitl.getRequest(w.requestId);
        assert.ok(req !== null && req.workspaceId === w.workspaceId);
        const art = await resolved.backend.artifacts.getArtifact(w.artifactDigest);
        assert.ok(art !== null && art.bytes.equals(w.artifactBytes));
      } finally {
        await resolved.close();
      }
    }
  } finally {
    rmSync(a.cwd, { recursive: true, force: true });
    rmSync(b.cwd, { recursive: true, force: true });
    await a.db.close();
    await b.db.close();
  }
});
