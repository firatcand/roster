import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  MemoryFileStore,
  ConditionalWriteFailed,
  createS3FileStore,
  type FileStore,
} from '../src/lib/brain/s3.ts';

// One contract, two backends. MemoryFileStore runs always (hermetic); the real
// S3FileStore runs against a MinIO/S3 endpoint when ROSTER_TEST_S3_ENDPOINT is
// set (CI). Both must satisfy identical put/get/head/del + conditional-write
// semantics, so a value the fake produces compares equal to one S3 produces.
function contract(name: string, makeStore: () => Promise<FileStore>, opts: { skip?: string | false } = {}) {
  const o = { skip: opts.skip ?? false };
  const key = () => `contract/${randomBytes(6).toString('hex')}.bin`;

  test(`${name}: put → get → head round-trips bytes + etag`, o, async () => {
    const store = await makeStore();
    const k = key();
    const body = Buffer.from('hello ledger world');
    const { etag } = await store.put(k, body, { contentType: 'text/plain' });
    assert.ok(etag.length > 0);

    const got = await store.get(k);
    assert.ok(got);
    assert.deepEqual(got!.body, body, 'bytes round-trip exactly');
    assert.equal(got!.etag, etag, 'get etag matches put etag');

    const head = await store.head(k);
    assert.ok(head);
    assert.equal(head!.size, body.length);
    assert.equal(head!.etag, etag, 'head etag matches put etag');

    await store.del(k);
  });

  test(`${name}: get/head of a missing key return null`, o, async () => {
    const store = await makeStore();
    assert.equal(await store.get(key()), null);
    assert.equal(await store.head(key()), null);
  });

  test(`${name}: binary payload survives round-trip`, o, async () => {
    const store = await makeStore();
    const k = key();
    const body = randomBytes(4096);
    await store.put(k, body);
    const got = await store.get(k);
    assert.deepEqual(got!.body, body, 'random binary is byte-identical');
    await store.del(k);
  });

  test(`${name}: del is idempotent (deleting a missing key is not an error)`, o, async () => {
    const store = await makeStore();
    await store.del(key()); // must not throw
  });

  test(`${name}: ifNoneMatch:'*' rejects a write to an existing key`, o, async () => {
    const store = await makeStore();
    const k = key();
    await store.put(k, Buffer.from('first'), { ifNoneMatch: '*' });
    await assert.rejects(
      store.put(k, Buffer.from('second'), { ifNoneMatch: '*' }),
      (e) => e instanceof ConditionalWriteFailed,
      'create-only put fails when the key exists',
    );
    const got = await store.get(k);
    assert.deepEqual(got!.body, Buffer.from('first'), 'original bytes preserved');
    await store.del(k);
  });

  test(`${name}: ifMatch against a missing key fails as ConditionalWriteFailed`, o, async () => {
    const store = await makeStore();
    await assert.rejects(
      store.put(key(), Buffer.from('x'), { ifMatch: 'ffffffffffffffffffffffffffffffff' }),
      (e) => e instanceof ConditionalWriteFailed,
      'CAS against a nonexistent object is a conditional failure, not a raw error',
    );
  });

  test(`${name}: ifMatch enforces compare-and-swap`, o, async () => {
    const store = await makeStore();
    const k = key();
    const first = await store.put(k, Buffer.from('v1'));
    // Correct etag → succeeds.
    await store.put(k, Buffer.from('v2'), { ifMatch: first.etag });
    // Stale etag → fails.
    await assert.rejects(
      store.put(k, Buffer.from('v3'), { ifMatch: first.etag }),
      (e) => e instanceof ConditionalWriteFailed,
      'CAS with a stale etag fails',
    );
    const got = await store.get(k);
    assert.deepEqual(got!.body, Buffer.from('v2'), 'the losing write did not land');
    await store.del(k);
  });
}

// ---- MemoryFileStore: always ----
contract('MemoryFileStore', async () => new MemoryFileStore());

// ---- S3FileStore: MinIO/S3-gated ----
const S3_ENDPOINT = process.env.ROSTER_TEST_S3_ENDPOINT ?? '';
const HAS_S3 = S3_ENDPOINT.length > 0;

let s3Store: FileStore | null = null;
async function makeS3Store(): Promise<FileStore> {
  if (s3Store) return s3Store;
  const bucket = `roster-fs-test-${randomBytes(6).toString('hex')}`;
  const region = process.env.AWS_REGION ?? 'us-east-1';
  // Create the bucket up front via the raw SDK, then hand the store its config.
  const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  s3Store = await createS3FileStore({
    bucket,
    region,
    endpoint: S3_ENDPOINT,
    prefix: '',
    forcePathStyle: true,
  });
  return s3Store;
}

contract('S3FileStore', makeS3Store, { skip: HAS_S3 ? false : 'ROSTER_TEST_S3_ENDPOINT not set' });
