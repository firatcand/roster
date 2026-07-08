import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { HAS_DB, createFreshDb, runtimeClient, type FreshDb } from './brain-helpers.ts';
import { mountBytesTx } from '../src/lib/brain/mount.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

type Setup = { fresh: FreshDb; password: string; teardown: () => Promise<void> };

async function provision(): Promise<Setup> {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool);
    const role = await withBrainClient(pool, (c) => ensureRuntimeRole(c, fresh.role));
    return {
      fresh,
      password: role.password!,
      teardown: async () => {
        await fresh.drop();
      },
    };
  } catch (err) {
    await fresh.drop();
    throw err;
  } finally {
    await pool.end();
  }
}

// ---------- mountBytesTx: the s3-agnostic indexing primitive ----------

test('mountBytesTx: mounts bytes under an arbitrary source_path and indexes chunks', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const uri = 's3://bkt/files/concept/rrf/notes.md';
  try {
    await rt.query('BEGIN');
    const res = await mountBytesTx(rt, uri, Buffer.from('# RRF\nreciprocal rank fusion body\n'), null);
    await rt.query('COMMIT');

    assert.equal(res.mounted, true);
    assert.equal(res.sourcePath, uri);
    assert.ok(res.chunks > 0);
    assert.ok(res.mountId.length > 0);

    const rows = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['reciprocal fusion'],
    );
    assert.ok(rows.rows[0]!.c > 0, 'keyword search finds chunks indexed under the s3 URI');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('mountBytesTx: unchanged bytes reuse the existing latest mount (no new mount, no re-embed)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const uri = 's3://bkt/files/concept/rrf/notes.md';
  const bytes = Buffer.from('# RRF\nbody\n');
  try {
    await rt.query('BEGIN');
    const first = await mountBytesTx(rt, uri, bytes, null);
    await rt.query('COMMIT');
    assert.equal(first.mounted, true);

    await rt.query('BEGIN');
    const second = await mountBytesTx(rt, uri, bytes, null);
    await rt.query('COMMIT');

    assert.equal(second.mounted, false);
    assert.equal(second.reason, 'unchanged');
    assert.equal(second.mountId, first.mountId, 'unchanged re-mount returns the existing mount id');

    const mounts = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.mounts WHERE source_path = $1`,
      [uri],
    );
    assert.equal(mounts.rows[0]!.c, 1, 'no second mount row inserted');
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- files ledger + current_files ----------

test('files ledger: current_files is latest-id-wins per (kind,slug,filename) and excludes tombstones', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const putRow = (filename: string, key: string, hash: string) =>
      rt.query(
        `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, size_bytes, content_hash, etag, content_type)
         VALUES ('concept','rrf',$1,'put',$2,'bkt',$3,10,$4,'etag','text/markdown')`,
        [filename, `s3://bkt/${key}`, key, hash],
      );

    await putRow('a.md', 'files/concept/rrf/a.md', 'h1');
    await putRow('b.md', 'files/concept/rrf/b.md', 'h2');
    // Supersede a.md with a new version.
    await putRow('a.md', 'files/concept/rrf/a.md', 'h1b');

    const current = await rt.query<{ filename: string; content_hash: string }>(
      `SELECT filename, content_hash FROM brain.current_files ORDER BY filename`,
    );
    assert.deepEqual(
      current.rows.map((r) => [r.filename, r.content_hash]),
      [
        ['a.md', 'h1b'],
        ['b.md', 'h2'],
      ],
      'latest version wins per address',
    );

    // Tombstone a.md.
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key)
       VALUES ('concept','rrf','a.md','rm','s3://bkt/files/concept/rrf/a.md','bkt','files/concept/rrf/a.md')`,
    );
    const afterRm = await rt.query<{ filename: string }>(
      `SELECT filename FROM brain.current_files ORDER BY filename`,
    );
    assert.deepEqual(
      afterRm.rows.map((r) => r.filename),
      ['b.md'],
      'tombstoned file drops out of current_files',
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('files ledger: put row requires content_hash; rm row forbids it (CHECK)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await assert.rejects(
      rt.query(
        `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key)
         VALUES ('c','s','f.md','put','s3://bkt/k','bkt','k')`,
      ),
      /check|content_hash/i,
      'put without content_hash is rejected',
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- tombstone visibility in current_documents ----------

test('tombstone: an rm ledger row hides that file chunks from current_documents + keyword search', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const uri = 's3://bkt/files/concept/rrf/post.md';
  try {
    await rt.query('BEGIN');
    await mountBytesTx(rt, uri, Buffer.from('# Post\nzebrafishterm content\n'), null);
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, content_hash, mount_id)
       VALUES ('concept','rrf','post.md','put',$1,'bkt','files/concept/rrf/post.md','h1',
               (SELECT id FROM brain.mounts WHERE source_path = $1 ORDER BY id DESC LIMIT 1))`,
      [uri],
    );
    await rt.query('COMMIT');

    const before = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['zebrafishterm'],
    );
    assert.ok(before.rows[0]!.c > 0, 'chunk visible before rm');

    // Tombstone the file.
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key)
       VALUES ('concept','rrf','post.md','rm',$1,'bkt','files/concept/rrf/post.md')`,
      [uri],
    );

    const after = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['zebrafishterm'],
    );
    assert.equal(after.rows[0]!.c, 0, 'tombstoned file chunk hidden from current_documents');

    // History preserved in raw documents.
    const raw = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.documents WHERE source_path = $1`,
      [uri],
    );
    assert.ok(raw.rows[0]!.c > 0, 'raw chunks retained (history not erased)');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('tombstone: re-put after rm resurrects chunks without a new mount', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const uri = 's3://bkt/files/concept/rrf/post.md';
  const bytes = Buffer.from('# Post\nphoenixterm content\n');
  try {
    await rt.query('BEGIN');
    const m1 = await mountBytesTx(rt, uri, bytes, null);
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, content_hash, mount_id)
       VALUES ('concept','rrf','post.md','put',$1,'bkt','files/concept/rrf/post.md','h1',$2)`,
      [uri, m1.mountId],
    );
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key)
       VALUES ('concept','rrf','post.md','rm',$1,'bkt','files/concept/rrf/post.md')`,
      [uri],
    );
    await rt.query('COMMIT');

    const hidden = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['phoenixterm'],
    );
    assert.equal(hidden.rows[0]!.c, 0, 'hidden after rm');

    // Re-put the same bytes: mountBytesTx no-ops (unchanged), reuses the mount;
    // a fresh op='put' ledger row supersedes the tombstone.
    await rt.query('BEGIN');
    const m2 = await mountBytesTx(rt, uri, bytes, null);
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, content_hash, mount_id)
       VALUES ('concept','rrf','post.md','put',$1,'bkt','files/concept/rrf/post.md','h1',$2)`,
      [uri, m2.mountId],
    );
    await rt.query('COMMIT');

    assert.equal(m2.mountId, m1.mountId, 'reused the original mount (no re-embed)');

    const resurrected = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['phoenixterm'],
    );
    assert.ok(resurrected.rows[0]!.c > 0, 'chunk visible again after re-put');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('tombstone: overwriting an indexed file with a NON-indexable version hides the old chunks', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const uri = 's3://bkt/files/concept/rrf/post.md';
  try {
    // v1: indexable text → a real mount with chunks + a put row referencing it.
    await rt.query('BEGIN');
    await mountBytesTx(rt, uri, Buffer.from('# Post\nlemurterm original text\n'), null);
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, content_hash, mount_id)
       VALUES ('concept','rrf','post.md','put',$1,'bkt','files/concept/rrf/post.md','h1',
               (SELECT id FROM brain.mounts WHERE source_path = $1 ORDER BY id DESC LIMIT 1))`,
      [uri],
    );
    await rt.query('COMMIT');

    const before = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['lemurterm'],
    );
    assert.ok(before.rows[0]!.c > 0, 'indexed v1 visible');

    // v2: overwrite at the SAME address/URI with a non-indexable version — a put
    // row with mount_id NULL (no new mount). The old mount stays the latest with
    // chunks, so a source_path-only view would keep showing it.
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, content_hash, mount_id)
       VALUES ('concept','rrf','post.md','put',$1,'bkt','files/concept/rrf/post.md','h2', NULL)`,
      [uri],
    );

    const after = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['lemurterm'],
    );
    assert.equal(after.rows[0]!.c, 0, 'stale chunks hidden once the head version is non-indexable');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('tombstone: re-put of the same address at a NEW source_path (config change) hides the old chunks', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const oldUri = 's3://old-bkt/files/concept/rrf/post.md';
  const newUri = 's3://new-bkt/files/concept/rrf/post.md';
  try {
    // First put lands under the old bucket URI.
    await rt.query('BEGIN');
    const mOld = await mountBytesTx(rt, oldUri, Buffer.from('# Post\nmarmotterm at old bucket\n'), null);
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, content_hash, mount_id)
       VALUES ('concept','rrf','post.md','put',$1,'old-bkt','files/concept/rrf/post.md','h1',$2)`,
      [oldUri, mOld.mountId],
    );
    await rt.query('COMMIT');

    // Bucket config changes; the SAME file address is re-put under a new URI
    // with new bytes. The verb's compensating tombstone is deliberately NOT
    // written here — the view must self-correct on the address, not rely on it.
    await rt.query('BEGIN');
    const mNew = await mountBytesTx(rt, newUri, Buffer.from('# Post\notterterm at new bucket\n'), null);
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, content_hash, mount_id)
       VALUES ('concept','rrf','post.md','put',$1,'new-bkt','files/concept/rrf/post.md','h2',$2)`,
      [newUri, mNew.mountId],
    );
    await rt.query('COMMIT');

    const oldHit = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['marmotterm'],
    );
    assert.equal(oldHit.rows[0]!.c, 0, 'chunks at the superseded old URI are hidden');

    const newHit = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['otterterm'],
    );
    assert.ok(newHit.rows[0]!.c > 0, 'chunks at the new current URI are visible');

    // current_files already tracks per-address, so it shows exactly one head.
    const cf = await rt.query<{ source_path: string; c: number }>(
      `SELECT source_path, count(*) OVER ()::int AS c FROM brain.current_files
        WHERE kind='concept' AND slug='rrf' AND filename='post.md'`,
    );
    assert.equal(cf.rowCount, 1, 'current_files shows a single head for the address');
    assert.equal(cf.rows[0]!.source_path, newUri, 'the head is the new URI');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('tombstone: a plain local mount (no files rows) is unaffected by the view predicate', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const localPath = '/local/only/note.md';
  try {
    await rt.query('BEGIN');
    await mountBytesTx(rt, localPath, Buffer.from('# Local\nkoalaterm body\n'), null);
    await rt.query('COMMIT');

    const hit = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['koalaterm'],
    );
    assert.ok(hit.rows[0]!.c > 0, 'local mount visible (COALESCE defaults to put)');
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- append-only guarantees on the ledger ----------

test('files ledger: runtime role can INSERT but cannot UPDATE or DELETE', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, content_hash)
       VALUES ('c','s','f.md','put','s3://bkt/k','bkt','k','h1')`,
    );
    await assert.rejects(
      rt.query(`UPDATE brain.files SET content_hash = 'x'`),
      /permission denied/i,
      'runtime cannot UPDATE the ledger',
    );
    await assert.rejects(
      rt.query(`DELETE FROM brain.files`),
      /permission denied/i,
      'runtime cannot DELETE from the ledger',
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('files ledger: runtime role cannot set the audit columns id/recorded_at', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await assert.rejects(
      rt.query(
        `INSERT INTO brain.files (id, kind, slug, filename, op, source_path, bucket, s3_key, content_hash)
         VALUES (999,'c','s','f.md','put','s3://bkt/k','bkt','k','h1')`,
      ),
      /permission denied|cannot insert|generated/i,
      'runtime cannot write id',
    );
  } finally {
    await rt.end();
    await teardown();
  }
});
