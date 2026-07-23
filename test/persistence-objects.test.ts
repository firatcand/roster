import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  CreateOnlyFileStore,
  S3ObjectTarget,
  OPS_OBJECT_PREFIXES,
  WORKSPACE_MARKER_KEY,
  claimWorkspaceMarker,
  detectObjectLockCapability,
  opsObjectKey,
  verifyBucketVersioning,
  verifyWorkspaceMarker,
  workspaceMarkerBody,
  workspaceMarkerSha256,
} from '../src/lib/persistence/objects.ts';
import { MemoryFileStore, createS3FileStore, type FileStore } from '../src/lib/persistence/s3-core.ts';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  WorkspaceMismatchError,
  sha256Hex,
} from '../src/lib/persistence/contracts.ts';
import { RosterError } from '../src/lib/errors.ts';

// #318 stage 4 section F: create-only object layer. The hermetic section runs
// always over MemoryFileStore; the MinIO section repeats the semantics against
// a real S3 API when ROSTER_TEST_S3_ENDPOINT is set, with restricted-creds
// negatives gated separately on ROSTER_TEST_S3_RESTRICTED_KEY/SECRET.

const WS = { workspaceId: randomUUID(), name: 'acme' };

// ---------------- key construction ----------------

test('objects: opsObjectKey builds prefix/segment keys and rejects everything unsafe', () => {
  assert.equal(opsObjectKey({ prefix: 'artifacts', segments: ['ab12'] }), 'artifacts/ab12');
  assert.equal(opsObjectKey({ prefix: 'hitl', segments: ['fn', 'req.json'] }), 'hitl/fn/req.json');
  assert.deepEqual([...OPS_OBJECT_PREFIXES], ['hitl', 'runs', 'artifacts', 'outbox']);
  assert.throws(() => opsObjectKey({ prefix: 'secrets' as never, segments: ['x'] }), InvalidRecordError);
  assert.throws(() => opsObjectKey({ prefix: 'runs', segments: [] }), InvalidRecordError);
  // '..' traversal, '/' smuggling, empty, non-alnum start, over-long
  for (const bad of ['../up', 'a/b', '', '.dotfile', 'x'.repeat(129)]) {
    assert.throws(
      () => opsObjectKey({ prefix: 'runs', segments: [bad] }),
      RosterError,
      `segment '${bad.slice(0, 20)}' must be rejected`,
    );
  }
});

// ---------------- shared contract (memory + minio) ----------------

function contract(
  name: string,
  makeFiles: () => Promise<FileStore>,
  opts: { skip: string | false } = { skip: false },
): void {
  test(`objects[${name}]: putIfAbsent is create-only — stored, digest replay, conflict`, { skip: opts.skip }, async () => {
    const files = await makeFiles();
    const store = new CreateOnlyFileStore(files);
    const ref = { prefix: 'artifacts', segments: [`k-${randomBytes(6).toString('hex')}`] } as const;
    const bytes = Buffer.from('artifact payload v1');

    const first = await store.putIfAbsent(ref, bytes, { contentType: 'text/plain' });
    assert.equal(first.outcome, 'stored');
    assert.ok(first.etag.length > 0);

    const replay = await store.putIfAbsent(ref, bytes);
    assert.equal(replay.outcome, 'exists');
    assert.equal(replay.etag, first.etag);

    await assert.rejects(store.putIfAbsent(ref, Buffer.from('different bytes')), ConflictError);

    const got = await store.get(ref);
    assert.ok(got);
    assert.deepEqual(got.body, bytes);
    const headed = await store.head(ref);
    assert.ok(headed);
    assert.equal(headed.size, bytes.length);
    assert.equal(await store.get({ prefix: 'artifacts', segments: ['missing-key'] }), null);
    assert.equal(await store.head({ prefix: 'artifacts', segments: ['missing-key'] }), null);
    assert.ok(!('del' in store), 'CreateOnlyObjectStore must not expose del()');
  });

  test(`objects[${name}]: marker claim + resolution-time verification`, { skip: opts.skip }, async () => {
    const files = await makeFiles();
    const store = new CreateOnlyFileStore(files);
    const ws = { workspaceId: randomUUID(), name: `acme-${randomBytes(3).toString('hex')}` };

    const claim = await claimWorkspaceMarker(files, ws);
    assert.equal(claim.created, true);
    assert.equal(claim.markerSha256, workspaceMarkerSha256(ws));

    const resumed = await claimWorkspaceMarker(files, ws);
    assert.equal(resumed.created, false);
    assert.equal(resumed.markerSha256, claim.markerSha256);

    const foreign = { workspaceId: randomUUID(), name: 'intruder' };
    await assert.rejects(claimWorkspaceMarker(files, foreign), (err) => {
      assert.ok(err instanceof WorkspaceMismatchError);
      assert.match(err.message, new RegExp(ws.name));
      assert.match(err.message, new RegExp(ws.workspaceId));
      return true;
    });

    await verifyWorkspaceMarker(store, { workspaceId: ws.workspaceId, markerSha256: claim.markerSha256 });
    await assert.rejects(
      verifyWorkspaceMarker(store, { workspaceId: ws.workspaceId, markerSha256: sha256Hex('not-the-marker') }),
      WorkspaceMismatchError,
    );
  });

  test(`objects[${name}]: S3ObjectTarget delivers content-addressed, idempotent, digest-checked`, { skip: opts.skip }, async () => {
    const files = await makeFiles();
    const store = new CreateOnlyFileStore(files);
    const target = new S3ObjectTarget(store);
    const bytes = Buffer.from(`spooled artifact ${randomBytes(4).toString('hex')}`);
    const digest = sha256Hex(bytes);

    assert.equal(await target.deliver(digest, bytes), 'stored');
    assert.equal(await target.deliver(digest, bytes), 'exists');
    await assert.rejects(target.deliver(sha256Hex('some other content'), bytes), ConflictError);
    await assert.rejects(target.deliver('not-a-digest', bytes), InvalidRecordError);

    const stored = await store.get({ prefix: 'artifacts', segments: [digest] });
    assert.ok(stored);
    assert.deepEqual(stored.body, bytes);
  });
}

// ---------------- hermetic: MemoryFileStore ----------------

contract('memory', async () => new MemoryFileStore());

test('objects[memory]: marker digest mismatch names the workspace found in the bucket', async () => {
  const files = new MemoryFileStore();
  const store = new CreateOnlyFileStore(files);
  const claim = await claimWorkspaceMarker(files, WS);
  // tamper through the raw (deletable) FileStore — the create-only layer
  // cannot do this, which is exactly the point of the compile-time separation
  const foreign = { workspaceId: randomUUID(), name: 'other-team' };
  await files.del(WORKSPACE_MARKER_KEY);
  await files.put(WORKSPACE_MARKER_KEY, workspaceMarkerBody(foreign));
  await assert.rejects(
    verifyWorkspaceMarker(store, { workspaceId: WS.workspaceId, markerSha256: claim.markerSha256 }),
    (err) => {
      assert.ok(err instanceof WorkspaceMismatchError);
      assert.match(err.message, /other-team/);
      return true;
    },
  );
});

test('objects[memory]: missing marker and unparseable marker refuse', async () => {
  const files = new MemoryFileStore();
  const store = new CreateOnlyFileStore(files);
  await assert.rejects(
    verifyWorkspaceMarker(store, { workspaceId: WS.workspaceId, markerSha256: sha256Hex('x') }),
    WorkspaceMismatchError,
  );
  await files.put(WORKSPACE_MARKER_KEY, Buffer.from('not json at all'));
  await assert.rejects(claimWorkspaceMarker(files, WS), (err) => {
    assert.ok(err instanceof WorkspaceMismatchError);
    assert.match(err.message, /not a roster workspace marker/);
    return true;
  });
});

test('objects[memory]: lost create race with unreadable winner surfaces BackendUnavailable', async () => {
  // A FileStore whose conditional put always loses and whose get returns null:
  // the impossible-window case must not silently succeed.
  const files = new MemoryFileStore();
  const flaky: FileStore = {
    put: async (key, body, opts) => {
      if (opts?.ifNoneMatch === '*') {
        const { ConditionalWriteFailed } = await import('../src/lib/persistence/s3-core.ts');
        throw new ConditionalWriteFailed(key);
      }
      return files.put(key, body, opts);
    },
    get: async () => null,
    head: async () => null,
    del: async () => {},
  };
  const store = new CreateOnlyFileStore(flaky);
  await assert.rejects(
    store.putIfAbsent({ prefix: 'runs', segments: ['x'] }, Buffer.from('y')),
    BackendUnavailableError,
  );
  await assert.rejects(claimWorkspaceMarker(flaky, WS), BackendUnavailableError);
});

test('objects[memory]: marker body is deterministic so its sha is stampable pre-claim', () => {
  const a = workspaceMarkerBody(WS);
  const b = workspaceMarkerBody({ ...WS });
  assert.deepEqual(a, b);
  assert.equal(workspaceMarkerSha256(WS), sha256Hex(a));
  assert.notEqual(workspaceMarkerSha256(WS), workspaceMarkerSha256({ ...WS, name: 'renamed' }));
});

// ---------------- MinIO / real S3 (env-gated) ----------------

const S3_ENDPOINT = process.env.ROSTER_TEST_S3_ENDPOINT ?? '';
const HAS_S3 = S3_ENDPOINT.length > 0;
const s3Skip = HAS_S3 ? false : 'ROSTER_TEST_S3_ENDPOINT not set';
const RESTRICTED_KEY = process.env.ROSTER_TEST_S3_RESTRICTED_KEY ?? '';
const RESTRICTED_SECRET = process.env.ROSTER_TEST_S3_RESTRICTED_SECRET ?? '';
// The bucket the restricted user's policy is scoped to (provisioned together
// with the user: Get/Put on hitl/ runs/ artifacts/ outbox/, GetObject on the
// marker key, nothing else).
const RESTRICTED_BUCKET = process.env.ROSTER_TEST_S3_RESTRICTED_BUCKET ?? '';
const HAS_RESTRICTED =
  HAS_S3 && RESTRICTED_KEY.length > 0 && RESTRICTED_SECRET.length > 0 && RESTRICTED_BUCKET.length > 0;
const restrictedSkip = HAS_RESTRICTED
  ? false
  : 'ROSTER_TEST_S3_RESTRICTED_KEY/SECRET/BUCKET not set';

const S3_REGION = process.env.AWS_REGION ?? 'us-east-1';

async function s3Sdk() {
  return await import('@aws-sdk/client-s3');
}

async function makeBucket(): Promise<string> {
  const bucket = `roster-ops-test-${randomBytes(6).toString('hex')}`;
  const sdk = await s3Sdk();
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

function s3Config(bucket: string) {
  return { bucket, region: S3_REGION, endpoint: S3_ENDPOINT, forcePathStyle: true };
}

// Fresh bucket per call: the marker protocol claims the bucket root, so tests
// sharing a bucket would collide on the marker (dedicated bucket by design).
async function makeS3Files(): Promise<FileStore> {
  const bucket = await makeBucket();
  return await createS3FileStore(s3Config(bucket));
}

contract('minio', makeS3Files, { skip: s3Skip });

test('objects[minio]: bucket versioning validation — refuses unversioned, passes once enabled', { skip: s3Skip }, async () => {
  const bucket = await makeBucket();
  await assert.rejects(verifyBucketVersioning(s3Config(bucket)), (err) => {
    assert.ok(err instanceof RosterError);
    assert.match(err.message, /versioning/i);
    assert.match(err.remedy, /put-bucket-versioning/);
    return true;
  });
  const sdk = await s3Sdk();
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
    await client.send(
      new sdk.PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
  } finally {
    client.destroy();
  }
  await verifyBucketVersioning(s3Config(bucket));
  assert.equal(await detectObjectLockCapability(s3Config(bucket)), false);
});

function restrictedEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: RESTRICTED_KEY,
    AWS_SECRET_ACCESS_KEY: RESTRICTED_SECRET,
  };
}

// Admin store over the pre-provisioned restricted bucket; ensures a marker
// exists there (tolerating one claimed on an earlier run of a persistent MinIO).
async function restrictedAdminFiles(): Promise<FileStore> {
  const admin = await createS3FileStore(s3Config(RESTRICTED_BUCKET));
  const existing = await admin.get(WORKSPACE_MARKER_KEY);
  if (existing === null) {
    await claimWorkspaceMarker(admin, { workspaceId: randomUUID(), name: 'restricted-ws' });
  }
  return admin;
}

// IAM matrix negatives (section F): the restricted runtime identity must not
// overwrite the marker, delete anything, write at the bucket root, or reach a
// foreign bucket — while marker READ succeeds. Requires the CI/minio operator
// to provision a user limited to Get/Put on the four data prefixes plus
// GetObject on the marker key inside ROSTER_TEST_S3_RESTRICTED_BUCKET;
// skipped granularly otherwise.
test('objects[minio-restricted]: marker overwrite is denied', { skip: restrictedSkip }, async () => {
  await restrictedAdminFiles();
  const runtime = await createS3FileStore(s3Config(RESTRICTED_BUCKET), restrictedEnv());
  await assert.rejects(
    runtime.put(WORKSPACE_MARKER_KEY, workspaceMarkerBody({ workspaceId: randomUUID(), name: 'evil' })),
  );
});

test('objects[minio-restricted]: delete is denied everywhere', { skip: restrictedSkip }, async () => {
  const admin = await restrictedAdminFiles();
  const key = `runs/deltest-${randomBytes(4).toString('hex')}`;
  await admin.put(key, Buffer.from('x'));
  const runtime = await createS3FileStore(s3Config(RESTRICTED_BUCKET), restrictedEnv());
  await assert.rejects(runtime.del(key));
  assert.ok(await admin.get(key), 'object must survive the denied delete');
});

test('objects[minio-restricted]: root-key writes are denied, prefix writes allowed', { skip: restrictedSkip }, async () => {
  await restrictedAdminFiles();
  const runtime = await createS3FileStore(s3Config(RESTRICTED_BUCKET), restrictedEnv());
  await assert.rejects(runtime.put(`rogue-root-${randomBytes(4).toString('hex')}.json`, Buffer.from('x')));
  const allowed = `artifacts/allowed-${randomBytes(4).toString('hex')}`;
  await runtime.put(allowed, Buffer.from('payload'));
  const got = await runtime.get(allowed);
  assert.ok(got);
});

test('objects[minio-restricted]: foreign bucket access is denied, marker read succeeds', { skip: restrictedSkip }, async () => {
  await restrictedAdminFiles();
  const foreignBucket = await makeBucket();
  const foreignRuntime = await createS3FileStore(s3Config(foreignBucket), restrictedEnv());
  await assert.rejects(foreignRuntime.put('artifacts/x', Buffer.from('x')));
  const runtime = await createS3FileStore(s3Config(RESTRICTED_BUCKET), restrictedEnv());
  const marker = await runtime.get(WORKSPACE_MARKER_KEY);
  assert.ok(marker, 'runtime creds must be able to READ the exact marker key');
});
