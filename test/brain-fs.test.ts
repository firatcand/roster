import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole, buildRuntimeUrl } from '../src/lib/brain/roles.ts';
import { setConfig } from '../src/lib/brain/config.ts';
import { MemoryFileStore, type FileStore, type PutOpts } from '../src/lib/brain/s3.ts';
import { executeBrainFs } from '../src/commands/brain.ts';
import {
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
  try {
    await runMigrations(pool);
    const role = await withBrainClient(pool, async (c) => {
      // Configure the file store (non-secret) so loadConfig resolves a bucket.
      await setConfig(c, 'files.bucket', 'test-brain-files');
      await setConfig(c, 'files.prefix', 'ws');
      return ensureRuntimeRole(c, fresh.role);
    });
    return { fresh, password: role.password!, teardown: async () => { await fresh.drop(); } };
  } catch (err) {
    await fresh.drop();
    throw err;
  } finally {
    await pool.end();
  }
}

function tmpFile(name: string, contents: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-fs-'));
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

// ---------- putFile ----------

test('fs put: text file lands in S3, records a ledger row, and is keyword-searchable', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('post.md', '# RRF\nreciprocal rank fusion writeup\n');
  try {
    const res = await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, {
      kind: 'concept', slug: 'rrf', file, actor: 'sdr',
    });
    assert.equal(res.op, 'put');
    assert.equal(res.indexed, true, 'text file indexed');
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

    // Searchable via current_documents (the s3 URI is the source_path).
    const hit = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['reciprocal fusion'],
    );
    assert.ok(hit.rows[0]!.c > 0);
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('fs put: binary file is stored with a pointer row but no chunks', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    const res = await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, {
      kind: 'company', slug: 'acme', file,
    });
    assert.equal(res.indexed, false, 'binary not indexed');
    const docs = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.documents WHERE source_path = $1`,
      [res.sourcePath],
    );
    assert.equal(docs.rows[0]!.c, 0, 'no chunks for a binary');
    const row = await rt.query<{ mount_id: string | null }>(
      `SELECT mount_id FROM brain.current_files WHERE kind='company' AND slug='acme' AND filename='logo.png'`,
    );
    assert.equal(row.rows[0]!.mount_id, null, 'binary pointer row has no mount');
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

test('fs rm: tombstones the ledger, deletes the S3 object, hides chunks; history retained', opts, async () => {
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

    // Chunks hidden from search, but raw history retained.
    const hidden = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['wombatterm'],
    );
    assert.equal(hidden.rows[0]!.c, 0, 'chunk hidden after rm');
    const raw = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.documents WHERE source_path = $1`,
      [put.sourcePath],
    );
    assert.ok(raw.rows[0]!.c > 0, 'raw chunk retained');

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
    assert.equal(cf.rows[0]!.c, 0, 'file removed from view despite the S3 delete failure');
    const hit = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['deltaterm'],
    );
    assert.equal(hit.rows[0]!.c, 0, 'chunks hidden');
    assert.ok(await inner.head(put.s3Key), 'the orphaned S3 object is still present');
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

// ---------- executeBrainFs handler glue ----------

test('executeBrainFs: full put → ls → get → rm cycle via the command handler (injected store)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const runtimeUrl = buildRuntimeUrl(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const makeStore = async () => store;
  const file = tmpFile('post.md', '# RRF\nhandlerterm body\n');
  const outDir = mkdtempSync(join(tmpdir(), 'brain-fs-h-'));
  try {
    const putCode = await executeBrainFs({
      json: true, runtimeUrl, makeStore, op: 'put', kind: 'concept', slug: 'rrf', file,
    });
    assert.equal(putCode, 0);

    const lsCode = await executeBrainFs({ json: true, runtimeUrl, makeStore, op: 'ls' });
    assert.equal(lsCode, 0);

    const getCode = await executeBrainFs({
      json: true, runtimeUrl, makeStore, op: 'get', kind: 'concept', slug: 'rrf',
      filename: 'post.md', out: join(outDir, 'g.md'),
    });
    assert.equal(getCode, 0);
    assert.equal(readFileSync(join(outDir, 'g.md'), 'utf8'), '# RRF\nhandlerterm body\n');

    const rmCode = await executeBrainFs({
      json: true, runtimeUrl, makeStore, op: 'rm', kind: 'concept', slug: 'rrf', filename: 'post.md',
    });
    assert.equal(rmCode, 0);
  } finally {
    rmSync(file, { force: true });
    rmSync(outDir, { recursive: true, force: true });
    await teardown();
  }
});

test('executeBrainFs: throws a setup error when files is not configured', opts, async () => {
  // A brain with NO files.bucket set.
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  let runtimeUrl: string;
  try {
    await runMigrations(pool);
    const role = await withBrainClient(pool, (c) => ensureRuntimeRole(c, fresh.role));
    runtimeUrl = buildRuntimeUrl(fresh.url, role.password!, fresh.role);
  } finally {
    await pool.end();
  }
  try {
    await assert.rejects(
      executeBrainFs({ json: true, runtimeUrl, op: 'put', kind: 'c', slug: 's', file: '/tmp/x.md' }),
      /not configured/i,
    );
  } finally {
    await fresh.drop();
  }
});

test('fs put: overwrite supersedes chunks; rm then re-put resurrects search', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const cfg = { bucket: 'test-brain-files', prefix: 'ws/' };
  try {
    const v1 = tmpFile('post.md', '# Post\nalphaterm original\n');
    await putFile(rt, store, cfg, { kind: 'concept', slug: 'rrf', file: v1 });

    // Overwrite with new content at the same address.
    const v2 = tmpFile('post.md', '# Post\nbetaterm revised\n');
    await putFile(rt, store, cfg, { kind: 'concept', slug: 'rrf', file: v2 });

    const oldGone = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['alphaterm'],
    );
    assert.equal(oldGone.rows[0]!.c, 0, 'old content superseded');
    const newHere = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['betaterm'],
    );
    assert.ok(newHere.rows[0]!.c > 0, 'new content current');

    // rm then re-put the v2 bytes → resurrected.
    await rmFile(rt, store, { kind: 'concept', slug: 'rrf', filename: 'post.md' });
    await putFile(rt, store, cfg, { kind: 'concept', slug: 'rrf', file: v2 });
    const resurrected = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['betaterm'],
    );
    assert.ok(resurrected.rows[0]!.c > 0, 'chunk visible again after re-put');
    rmSync(v1, { force: true });
    rmSync(v2, { force: true });
  } finally {
    await rt.end();
    await teardown();
  }
});
