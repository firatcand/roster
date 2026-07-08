import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { setConfig } from '../src/lib/brain/config.ts';
import { MemoryFileStore } from '../src/lib/brain/s3.ts';
import { checkFileDrift } from '../src/lib/brain/doctor.ts';
import { putFile } from '../src/lib/brain/fs.ts';
import { HAS_DB, createFreshDb, runtimeClient, type FreshDb } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

type Setup = { fresh: FreshDb; password: string; teardown: () => Promise<void> };

async function provision(withBucket: boolean): Promise<Setup> {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await runMigrations(pool);
    const role = await withBrainClient(pool, async (c) => {
      if (withBucket) {
        await setConfig(c, 'files.bucket', 'test-brain-files');
        await setConfig(c, 'files.prefix', 'ws');
      }
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

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-fsd-'));
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

// checkFileDrift takes an ADMIN client, but the fs verbs need the runtime role;
// this helper runs the check against an admin connection to the fresh DB.
async function driftCheck(fresh: FreshDb, store: MemoryFileStore) {
  const pool = createBrainPool('admin', fresh.url);
  try {
    return await withBrainClient(pool, (c) => checkFileDrift(c, { fileStore: async () => store }));
  } finally {
    await pool.end();
  }
}

test('checkFileDrift: skips (ok) when files.bucket is not configured', opts, async () => {
  const { fresh, teardown } = await provision(false);
  try {
    const store = new MemoryFileStore();
    const res = await driftCheck(fresh, store);
    assert.equal(res.ok, true);
    assert.match(res.detail, /skip|not configured/i);
  } finally {
    await teardown();
  }
});

test('checkFileDrift: clean brain (object present, etag matches) passes', opts, async () => {
  const { fresh, password, teardown } = await provision(true);
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('post.md', '# ok\nclean\n');
  try {
    await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, { kind: 'concept', slug: 'ok', file });
    const res = await driftCheck(fresh, store);
    assert.equal(res.ok, true, res.detail);
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('checkFileDrift: a missing S3 object fails', opts, async () => {
  const { fresh, password, teardown } = await provision(true);
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('post.md', '# gone\nbody\n');
  try {
    const put = await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, { kind: 'concept', slug: 'gone', file });
    // Delete the object behind the brain's back.
    await store.del(put.s3Key);
    const res = await driftCheck(fresh, store);
    assert.equal(res.ok, false);
    assert.match(res.detail, /missing/i);
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('checkFileDrift: an etag mismatch (out-of-band edit) fails', opts, async () => {
  const { fresh, password, teardown } = await provision(true);
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('post.md', '# v1\noriginal\n');
  try {
    const put = await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, { kind: 'concept', slug: 'edited', file });
    // Overwrite the object out of band → new etag, ledger still records the old one.
    await store.put(put.s3Key, Buffer.from('# tampered\ndifferent bytes\n'));
    const res = await driftCheck(fresh, store);
    assert.equal(res.ok, false);
    assert.match(res.detail, /etag|drift/i);
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('checkFileDrift: a prefix change orphans the old object even though the address is re-put', opts, async () => {
  const { fresh, password, teardown } = await provision(true);
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('post.md', '# doc\nbody\n');
  try {
    // Put at prefix ws/, then re-put the SAME address at prefix ws2/ (same
    // bucket) — the config-change guard tombstones the old ws/ URI and leaves its
    // object behind. The address' latest event is now a 'put' at ws2/.
    const v1 = await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, { kind: 'concept', slug: 'moved', file });
    await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws2/' }, { kind: 'concept', slug: 'moved', file });

    assert.ok(await store.head(v1.s3Key), 'the old-prefix object is still in S3 (orphan)');

    const res = await driftCheck(fresh, store);
    assert.equal(res.ok, false, 'the orphaned old-prefix object is flagged');
    assert.match(res.detail, new RegExp(v1.s3Key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

test('checkFileDrift: an object left behind after rm (orphan) fails', opts, async () => {
  const { fresh, password, teardown } = await provision(true);
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const store = new MemoryFileStore();
  const file = tmpFile('post.md', '# rm\nbody\n');
  try {
    const put = await putFile(rt, store, { bucket: 'test-brain-files', prefix: 'ws/' }, { kind: 'concept', slug: 'orphan', file });
    // Tombstone in the ledger directly, but leave the S3 object in place (a
    // failed delete). Doctor must flag the orphan.
    await rt.query(
      `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key)
       VALUES ('concept','orphan','post.md','rm',$1,'test-brain-files',$2)`,
      [put.sourcePath, put.s3Key],
    );
    const res = await driftCheck(fresh, store);
    assert.equal(res.ok, false);
    assert.match(res.detail, /orphan/i);
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});
