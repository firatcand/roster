import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { MemoryFileStore, type FileStore, type PutOpts } from '../src/lib/brain/s3.ts';
import { mountBytesTx } from '../src/lib/brain/mount.ts';
import { RosterError } from '../src/lib/errors.ts';
import {
  S3NetworkPolicyError,
  createGuardedLookup,
  type DnsLookupAll,
} from '../src/lib/brain/s3-network-policy.ts';
import {
  brainFilesTarget,
  createBrainFilesStore,
  deriveKey,
  sourceUri,
  assertSafeSegment,
  isIndexableText,
  putFile,
  getFile,
  listFiles,
  rmFile,
} from '../src/lib/brain/fs.ts';
import { HAS_DB, createFreshDb, runtimeClient, type FreshDb } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

// ---------- pure helpers ----------

test('deriveKey: builds files/<kind>/<slug>/<filename> under the prefix', () => {
  assert.equal(deriveKey('', { kind: 'concept', slug: 'rrf', filename: 'post.md' }), 'files/concept/rrf/post.md');
  assert.equal(deriveKey('team/', { kind: 'company', slug: 'acme', filename: 'deck.pdf' }), 'team/files/company/acme/deck.pdf');
});

test('brainFilesTarget: derives bucket + slash-terminated prefix from the tracked namespace', () => {
  assert.deepEqual(
    brainFilesTarget({ bucket: 'ws-vault', region: 'eu-central-1', forcePathStyle: false }),
    { bucket: 'ws-vault', prefix: '' },
  );
  assert.deepEqual(
    brainFilesTarget({ bucket: 'ws-vault', region: 'eu-central-1', forcePathStyle: false, rootPrefix: 'team/a' }),
    { bucket: 'ws-vault', prefix: 'team/a/' },
  );
  assert.equal(
    deriveKey(brainFilesTarget({ bucket: 'b', region: 'r', forcePathStyle: false, rootPrefix: 'team' }).prefix,
      { kind: 'concept', slug: 'rrf', filename: 'post.md' }),
    'team/files/concept/rrf/post.md',
  );
});

test('sourceUri: builds an s3:// URI', () => {
  assert.equal(sourceUri('my-bkt', 'files/concept/rrf/post.md'), 's3://my-bkt/files/concept/rrf/post.md');
});

test('assertSafeSegment: accepts safe segments, rejects traversal and junk', () => {
  assert.doesNotThrow(() => assertSafeSegment('slug', 'rrf-ranking'));
  assert.doesNotThrow(() => assertSafeSegment('filename', 'post.v2.md'));
  assert.throws(() => assertSafeSegment('slug', '../etc'), /slug/);
  assert.throws(() => assertSafeSegment('slug', 'a/b'), /slug/);
  assert.throws(() => assertSafeSegment('slug', '.hidden'), /slug/);
  assert.throws(() => assertSafeSegment('slug', ''), /slug/);
  assert.throws(() => assertSafeSegment('slug', 'x'.repeat(129)), /slug/);
});

test('isIndexableText: text extensions with clean bytes are indexable; binaries are not', () => {
  assert.equal(isIndexableText('note.md', Buffer.from('# hi')), true);
  assert.equal(isIndexableText('data.csv', Buffer.from('a,b,c')), true);
  assert.equal(isIndexableText('readme.txt', Buffer.from('plain')), true);
  assert.equal(isIndexableText('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])), false, 'binary extension');
  // A .md with a NUL byte is treated as binary (not indexed).
  assert.equal(isIndexableText('weird.md', Buffer.from([0x23, 0x00, 0x41])), false, 'NUL byte → binary');
});

// ---------- verb setup ----------

type Setup = { fresh: FreshDb; password: string; teardown: () => Promise<void> };

async function provision(): Promise<Setup> {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  let provisioned = false;
  try {
    await runMigrations(pool);
    // #383: the namespace comes from the tracked registry, never brain_meta.config;
    // every call below passes its FilesTarget explicitly.
    const role = await withBrainClient(pool, (c) => ensureRuntimeRole(c, fresh.role));
    provisioned = true;
    return { fresh, password: role.password!, teardown: async () => { await fresh.drop(); } };
  } finally {
    // pg rejects a second end(), so the pool is closed on exactly one
    // path — and always BEFORE the drop, whose pg_terminate_backend cuts
    // every backend still attached to the database. An idle pooled client
    // cut that way reports on the Pool, not to any caller (#383).
    await pool.end();
    if (!provisioned) await fresh.drop();
  }
}

function tmpFile(name: string, contents: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-fs-'));
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

// ---------- putFile ----------

// #383 §7.4: `fs put` is a LEDGER + object write and nothing else. Extraction
// and indexing moved to `roster brain ingest` (the 012 pipeline), which cites an
// immutable source version, so a put must create no brain.mounts and no
// brain.documents rows.
test('fs put: text file lands in the object store and records a ledger row, with no indexing', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('post.md', '# RRF\nreciprocal rank fusion writeup\n');
  try {
    const res = await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, {
      kind: 'concept', slug: 'rrf', file, actor: 'sdr',
    });
    assert.equal(res.op, 'put');
    assert.equal(res.s3Key, 'ws/files/concept/rrf/post.md');
    assert.equal(res.sourcePath, 's3://test-brain-files/ws/files/concept/rrf/post.md');

    // Object is in the store.
    const head = await store.head(res.s3Key);
    assert.ok(head, 'object exists in S3');

    // Ledger row is current.
    const cf = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_files WHERE kind='concept' AND slug='rrf' AND filename='post.md'`,
    );
    assert.equal(cf.rows[0]!.c, 1);

    // No indexing side effects: no mount, no chunks, and a NULL mount_id.
    const mounts = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.mounts WHERE source_path = $1`,
      [res.sourcePath],
    );
    assert.equal(mounts.rows[0]!.c, 0, 'fs put creates no brain.mounts row');
    const docs = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.documents WHERE source_path = $1`,
      [res.sourcePath],
    );
    assert.equal(docs.rows[0]!.c, 0, 'fs put creates no brain.documents row');
    const mountId = await rt.query<{ mount_id: string | null }>(
      `SELECT mount_id FROM brain.current_files WHERE kind='concept' AND slug='rrf' AND filename='post.md'`,
    );
    assert.equal(mountId.rows[0]!.mount_id, null, 'ledger row carries no mount');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('fs put: a binary file is stored with a pointer row and, like every put, no chunks', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    const res = await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, {
      kind: 'company', slug: 'acme', file,
    });
    const docs = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.documents WHERE source_path = $1`,
      [res.sourcePath],
    );
    assert.equal(docs.rows[0]!.c, 0, 'no chunks for a binary');
    const row = await rt.query<{ mount_id: string | null }>(
      `SELECT mount_id FROM brain.current_files WHERE kind='company' AND slug='acme' AND filename='logo.png'`,
    );
    assert.equal(row.rows[0]!.mount_id, null, 'pointer row has no mount');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('fs put: entity-missing is a warning, not an error (file still stored)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('n.md', '# note\nbody\n');
  try {
    const res = await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, {
      kind: 'concept', slug: 'no-such-entity', file,
    });
    assert.equal(res.entityExists, false, 'flags the missing entity');
    assert.ok(await store.head(res.s3Key), 'file stored despite missing entity');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

// ---------- getFile ----------

test('fs get: round-trips bytes to a local path and verifies the hash', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('post.md', '# RRF\nbody bytes\n');
  const outDir = mkdtempSync(join(tmpdir(), 'brain-fs-out-'));
  const outPath = join(outDir, 'fetched.md');
  try {
    await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, { kind: 'concept', slug: 'rrf', file });
    const res = await getFile(rt, store, { kind: 'concept', slug: 'rrf', filename: 'post.md', out: outPath });
    assert.equal(res.hashMatches, true);
    assert.equal(readFileSync(outPath, 'utf8'), '# RRF\nbody bytes\n', 'bytes match');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    rmSync(outDir, { recursive: true, force: true });
    await teardown();
  }
});

test('fs get: a ledger row under a foreign bucket is refused without naming it', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('post.md', '# RRF\nforeign namespace\n');
  try {
    await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, { kind: 'concept', slug: 'rrf', file });
    await assert.rejects(
      getFile(rt, store, {
        kind: 'concept', slug: 'rrf', filename: 'post.md', expectedBucket: 'tracked-namespace',
      }),
      (error: unknown) => {
        assert.ok(error instanceof RosterError);
        assert.equal(error.code, 'BRAIN_FS_FOREIGN_BUCKET');
        assert.deepEqual(error.details, { kind: 'concept', slug: 'rrf', filename: 'post.md' });
        assert.doesNotMatch(`${error.header}${error.body}${error.remedy}`, /test-brain-files/u);
        return true;
      },
    );
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('fs get: a missing file errors (points at doctor)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  try {
    await assert.rejects(
      getFile(rt, store, { kind: 'concept', slug: 'nope', filename: 'ghost.md' }),
      /not found|no current file/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- listFiles ----------

test('fs ls: lists current files, filterable by kind/slug, hides tombstones', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const cfg = { bucket: 'test-brain-files', prefix: 'ws/' };
  const a = tmpFile('a.md', '# a\n');
  const b = tmpFile('b.md', '# b\n');
  try {
    await putFile(rt, store, cfg, { kind: 'concept', slug: 'rrf', file: a });
    await putFile(rt, store, cfg, { kind: 'company', slug: 'acme', file: b });

    const all = await listFiles(rt, {});
    assert.equal(all.length, 2);

    const onlyConcept = await listFiles(rt, { kind: 'concept' });
    assert.equal(onlyConcept.length, 1);
    assert.equal(onlyConcept[0]!.filename, 'a.md');

    // Remove one → it drops out of ls.
    await rmFile(rt, store, { kind: 'concept', slug: 'rrf', filename: 'a.md' });
    const afterRm = await listFiles(rt, {});
    assert.equal(afterRm.length, 1);
    assert.equal(afterRm[0]!.filename, 'b.md');
  } finally {
    await rt.end();
    rmSync(a, { force: true });
    rmSync(b, { force: true });
    await teardown();
  }
});

// ---------- rmFile ----------

test('fs rm: tombstones the ledger and deletes the object; ledger history retained', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const cfg = { bucket: 'test-brain-files', prefix: 'ws/' };
  const file = tmpFile('post.md', '# Post\nwombatterm content\n');
  try {
    const put = await putFile(rt, store, cfg, { kind: 'concept', slug: 'rrf', file });
    assert.ok(await store.head(put.s3Key), 'object present after put');

    const res = await rmFile(rt, store, { kind: 'concept', slug: 'rrf', filename: 'post.md', actor: 'ops' });
    assert.equal(res.s3Deleted, true);
    assert.equal(await store.head(put.s3Key), null, 'S3 object deleted');

    // Ledger keeps both events.
    const ops = await rt.query<{ op: string }>(
      `SELECT op FROM brain.files WHERE kind='concept' AND slug='rrf' AND filename='post.md' ORDER BY id`,
    );
    assert.deepEqual(ops.rows.map((r) => r.op), ['put', 'rm'], 'put + rm both in the ledger');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('fs rm: removing a nonexistent file errors', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  try {
    await assert.rejects(
      rmFile(rt, store, { kind: 'concept', slug: 'nope', filename: 'ghost.md' }),
      /not found|no current file/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- overwrite + resurrect end-to-end ----------

// ---------- put/rm concurrency ----------

// A store that stalls put/del so a missing advisory lock would let a concurrent
// put and rm interleave (put overwrites S3 → rm deletes the new bytes → put
// commits a head pointing at nothing). With the lock they serialize.
class DelayedStore implements FileStore {
  private readonly inner: MemoryFileStore;
  constructor(inner: MemoryFileStore) {
    this.inner = inner;
  }
  private async stall(): Promise<void> {
    await new Promise((r) => setTimeout(r, 25));
  }
  async put(key: string, body: Buffer, o?: PutOpts) {
    await this.stall();
    return this.inner.put(key, body, o);
  }
  async del(key: string) {
    await this.stall();
    return this.inner.del(key);
  }
  get(key: string) {
    return this.inner.get(key);
  }
  head(key: string) {
    return this.inner.head(key);
  }
}

test('fs put/rm concurrency: the current head never points at deleted S3 bytes', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const connA = await runtimeClient(fresh.url, password, fresh.role);
  const connB = await runtimeClient(fresh.url, password, fresh.role);
  const store = new DelayedStore(new MemoryFileStore());
  const cfg = { bucket: 'test-brain-files', prefix: 'ws/' };
  const v1 = tmpFile('post.md', '# v1\nalpha\n');
  const v2 = tmpFile('post.md', '# v2\nbeta bytes\n');
  try {
    await putFile(connA, store, cfg, { kind: 'concept', slug: 'race', file: v1 });

    // Race an overwrite (conn A) against a remove (conn B) on the same address.
    await Promise.allSettled([
      putFile(connA, store, cfg, { kind: 'concept', slug: 'race', file: v2 }),
      rmFile(connB, store, { kind: 'concept', slug: 'race', filename: 'post.md' }),
    ]);

    // Invariant: whatever the outcome, if a current head exists it must point at
    // an S3 object that is actually present with matching bytes.
    const head = await connA.query<{ s3_key: string; content_hash: string; op: string }>(
      `SELECT s3_key, content_hash FROM brain.current_files
        WHERE kind='concept' AND slug='race' AND filename='post.md'`,
    );
    if (head.rowCount !== 0) {
      const obj = await store.get(head.rows[0]!.s3_key);
      assert.ok(obj, 'a current head must point at bytes that exist in S3');
    } else {
      // Tombstoned outcome: the object must be gone.
      const key = deriveKey('ws/', { kind: 'concept', slug: 'race', filename: 'post.md' });
      assert.equal(await store.head(key), null, 'a removed file must have its S3 object deleted');
    }
  } finally {
    await connA.end();
    await connB.end();
    rmSync(v1, { force: true });
    rmSync(v2, { force: true });
    await teardown();
  }
});

test('fs rm: a failed S3 delete still leaves a durable tombstone (removed from view)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const inner = new MemoryFileStore();
  // A store whose del() always throws — stands in for a crash/failure during the
  // delete phase. The tombstone (committed in phase 1) must survive regardless.
  const store: FileStore = {
    put: (k, b, o) => inner.put(k, b, o),
    get: (k) => inner.get(k),
    head: (k) => inner.head(k),
    del: async () => {
      throw new Error('simulated S3 delete failure');
    },
  };
  const cfg = { bucket: 'test-brain-files', prefix: 'ws/' };
  const file = tmpFile('post.md', '# doc\ndeltaterm body\n');
  try {
    const put = await putFile(rt, store, cfg, { kind: 'concept', slug: 'crash', file });

    const res = await rmFile(rt, store, { kind: 'concept', slug: 'crash', filename: 'post.md' });
    assert.equal(res.s3Deleted, false, 'delete failed');

    // Tombstone is durable: gone from current_files + search, even though the S3
    // object is orphaned (doctor will flag it, a re-run retries the delete).
    const cf = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_files WHERE kind='concept' AND slug='crash'`,
    );
    assert.equal(cf.rows[0]!.c, 0, 'file removed from view despite the object delete failure');
    assert.ok(await inner.head(put.s3Key), 'the orphaned object is still present');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('fs get/rm concurrency: a get racing an rm never reports false drift', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const connA = await runtimeClient(fresh.url, password, fresh.role);
  const connB = await runtimeClient(fresh.url, password, fresh.role);
  const store = new DelayedStore(new MemoryFileStore());
  const cfg = { bucket: 'test-brain-files', prefix: 'ws/' };
  const file = tmpFile('post.md', '# doc\ngamma bytes\n');
  const outDir = mkdtempSync(join(tmpdir(), 'brain-fs-getrm-'));
  try {
    await putFile(connA, store, cfg, { kind: 'concept', slug: 'grrace', file });

    // Race a get (conn A) against an rm (conn B).
    const [get] = await Promise.allSettled([
      getFile(connA, store, { kind: 'concept', slug: 'grrace', filename: 'post.md', out: join(outDir, 'g.md') }),
      rmFile(connB, store, { kind: 'concept', slug: 'grrace', filename: 'post.md' }),
    ]);

    // The get either succeeded (won the lock, fetched real bytes) or failed with
    // the clean "no current file" — NEVER the "drift / run doctor" error, which
    // must be reserved for genuine out-of-band deletion.
    if (get.status === 'rejected') {
      assert.match(String(get.reason?.message ?? get.reason), /no current file/i, 'clean not-found, not drift');
      assert.doesNotMatch(String(get.reason?.message ?? get.reason), /run.*doctor/i, 'no false drift');
    } else {
      assert.equal(get.value.hashMatches, true, 'fetched bytes are intact');
    }
  } finally {
    await connA.end();
    await connB.end();
    rmSync(file, { force: true });
    rmSync(outDir, { recursive: true, force: true });
    await teardown();
  }
});

test('fs put: overwrite supersedes the ledger head; rm then re-put restores it', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const cfg = { bucket: 'test-brain-files', prefix: 'ws/' };
  try {
    const v1 = tmpFile('post.md', '# Post\nalphaterm original\n');
    const first = await putFile(rt, store, cfg, { kind: 'concept', slug: 'rrf', file: v1 });

    const v2 = tmpFile('post.md', '# Post\nbetaterm revised\n');
    const second = await putFile(rt, store, cfg, { kind: 'concept', slug: 'rrf', file: v2 });
    assert.notEqual(second.contentHash, first.contentHash, 'new bytes recorded');

    const head = await rt.query<{ content_hash: string }>(
      `SELECT content_hash FROM brain.current_files WHERE kind='concept' AND slug='rrf' AND filename='post.md'`,
    );
    assert.equal(head.rows[0]!.content_hash, second.contentHash, 'ledger head is the overwrite');

    await rmFile(rt, store, { kind: 'concept', slug: 'rrf', filename: 'post.md' });
    const gone = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_files WHERE kind='concept' AND slug='rrf'`,
    );
    assert.equal(gone.rows[0]!.c, 0, 'tombstoned out of the current view');

    await putFile(rt, store, cfg, { kind: 'concept', slug: 'rrf', file: v2 });
    const restored = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_files WHERE kind='concept' AND slug='rrf'`,
    );
    assert.equal(restored.rows[0]!.c, 1, 'visible again after re-put');
    rmSync(v1, { force: true });
    rmSync(v2, { force: true });
  } finally {
    await rt.end();
    await teardown();
  }
});

// The chunk supersede/resurrect lifecycle is `mountBytesTx`'s, not `fs put`'s.
// Exercised directly so the coverage survives the #383 decoupling; the whole
// mount module is deleted by #363.
test('mountBytesTx: a re-mount supersedes the previous chunks for the same source', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const uri = 's3://test-brain-files/ws/files/concept/rrf/post.md';
    await rt.query('BEGIN');
    await mountBytesTx(rt, uri, Buffer.from('# Post\nalphaterm original\n'), null);
    await rt.query('COMMIT');
    const first = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['alphaterm'],
    );
    assert.ok(first.rows[0]!.c > 0, 'first mount is current');

    await rt.query('BEGIN');
    await mountBytesTx(rt, uri, Buffer.from('# Post\nbetaterm revised\n'), null);
    await rt.query('COMMIT');
    const superseded = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['alphaterm'],
    );
    assert.equal(superseded.rows[0]!.c, 0, 'old chunks superseded');
    const current = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['betaterm'],
    );
    assert.ok(current.rows[0]!.c > 0, 'new chunks current');
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- registry-derived store: the exact-origin network boundary --------

// #383 B3: the tracked brain.storage namespace must be dialed through the SAME
// boundary the content-addressed object store uses. deriveS3Origin fails closed
// on a plaintext or userinfo-bearing endpoint and on a missing region; the
// guarded lookup refuses a non-global or rebinding DNS answer.
test('createBrainFilesStore refuses a plaintext, userinfo, or rebinding endpoint', async () => {
  const base = { bucket: 'ws-vault', region: 'eu-central-1', forcePathStyle: false };
  await assert.rejects(
    createBrainFilesStore({ ...base, endpoint: 'http://objects.example.test' }),
    S3NetworkPolicyError,
  );
  await assert.rejects(
    createBrainFilesStore({ ...base, endpoint: 'https://user:pw@objects.example.test' }),
    S3NetworkPolicyError,
  );
  await assert.rejects(
    createBrainFilesStore({ ...base, region: '' }),
    S3NetworkPolicyError,
  );

  let calls = 0;
  const rebinding: DnsLookupAll = (_hostname, _options, callback) => {
    calls += 1;
    callback(null, calls === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '169.254.169.254', family: 4 }]);
  };
  const store = await createBrainFilesStore(
    { ...base, endpoint: 'https://objects.example.test' },
    { lookupAll: rebinding },
  );
  assert.equal(typeof store.head, 'function');
  const guarded = createGuardedLookup('objects.example.test', { lookupAll: rebinding });
  const resolve = (): Promise<unknown> => new Promise((ok, fail) => {
    guarded('objects.example.test', { all: true }, (error, address) => {
      if (error !== null) fail(error);
      else ok(address);
    });
  });
  await resolve();
  await assert.rejects(resolve(), S3NetworkPolicyError);
});
