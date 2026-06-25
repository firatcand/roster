import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { HAS_DB, createFreshDb, runtimeClient, type FreshDb } from './brain-helpers.ts';
import { parseBrainArgs } from '../src/lib/brain-args.ts';
import { mountFile, chunkFile } from '../src/lib/brain/mount.ts';

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

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'brain-mount-'));
  const p = join(dir, name);
  writeFileSync(p, contents);
  return p;
}

// ---------- arg parsing ----------

test('parseBrainArgs: mount requires a file', () => {
  const r = parseBrainArgs(['mount', '/tmp/x.md', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'mount') throw new Error('wrong shape');
  assert.equal(r.file, '/tmp/x.md');
  assert.equal(r.json, true);

  assert.equal(parseBrainArgs(['mount']).kind, 'err');
  assert.equal(parseBrainArgs(['mount', 'a', 'b']).kind, 'err');
});

// ---------- chunking (pure) ----------

test('chunkFile: multi-heading markdown yields one chunk per section, each keeps its heading', () => {
  const md = [
    '---',
    'title: Doc',
    'level: 2',
    '---',
    '# Alpha',
    'alpha body',
    '## Beta',
    'beta body',
    '## Gamma',
    'gamma body',
  ].join('\n');
  const { chunks, frontmatter } = chunkFile('/x/doc.md', md);
  assert.deepEqual(frontmatter, { title: 'Doc', level: 2 });
  assert.equal(chunks.length, 3);
  assert.match(chunks[0]!.content, /^# Alpha/);
  assert.match(chunks[0]!.content, /alpha body/);
  assert.match(chunks[1]!.content, /^## Beta/);
  assert.match(chunks[2]!.content, /^## Gamma/);
});

test('chunkFile: a section longer than ~1500 chars is sub-split', () => {
  const big = 'x'.repeat(4000);
  const md = `# Big\n${big}`;
  const { chunks } = chunkFile('/x/big.md', md);
  assert.ok(chunks.length > 1, 'long section sub-split into multiple chunks');
  for (const c of chunks) assert.ok(c.content.length <= 1600, 'each chunk near the window size');
});

test('chunkFile: non-markdown uses fixed windows and empty frontmatter', () => {
  const csv = 'a,b,c\n'.repeat(600);
  const { chunks, frontmatter } = chunkFile('/x/data.csv', csv);
  assert.deepEqual(frontmatter, {});
  assert.ok(chunks.length > 1);
});

// ---------- dedup idempotency ----------

test('mount: second mount of unchanged file inserts 0 new rows (no-op)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const file = tmpFile('note.md', '# Title\nbody one\n## Sub\nbody two\n');
  try {
    const first = await mountFile(rt, file);
    assert.equal(first.mounted, true);
    assert.ok(first.chunks > 0);

    const before = await rt.query(`SELECT count(*)::int AS c FROM brain.documents`);

    const second = await mountFile(rt, file);
    assert.equal(second.mounted, false);
    assert.equal(second.reason, 'unchanged');
    assert.equal(second.chunks, 0);

    const after = await rt.query(`SELECT count(*)::int AS c FROM brain.documents`);
    assert.equal(after.rows[0]!.c, before.rows[0]!.c, 'no new rows inserted on unchanged re-mount');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

// ---------- chunk boundary correctness via DB ----------

test('mount: multi-heading markdown produces the expected chunk count + headings in DB', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const file = tmpFile('doc.md', '# One\nfirst\n## Two\nsecond\n## Three\nthird\n');
  try {
    const res = await mountFile(rt, file);
    assert.equal(res.chunks, 3);

    const rows = await rt.query<{ chunk_index: number; content: string }>(
      `SELECT chunk_index, content FROM brain.documents WHERE source_path = $1 ORDER BY chunk_index`,
      [resolve(file)],
    );
    assert.equal(rows.rowCount, 3);
    assert.match(rows.rows[0]!.content, /# One/);
    assert.match(rows.rows[1]!.content, /## Two/);
    assert.match(rows.rows[2]!.content, /## Three/);
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

// ---------- tsv populated + keyword search ----------

test('mount: tsv is auto-populated and keyword search over current_documents finds a mounted term', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const file = tmpFile('kw.md', '# Heading\nthe quick brown fox jumps over the lazy dog\n');
  try {
    await mountFile(rt, file);

    const tsv = await rt.query<{ has: boolean }>(
      `SELECT (tsv IS NOT NULL) AS has FROM brain.documents WHERE source_path = $1 LIMIT 1`,
      [resolve(file)],
    );
    assert.equal(tsv.rows[0]!.has, true, 'generated tsv is populated');

    const hit = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE tsv @@ plainto_tsquery('english', $1)`,
      ['brown fox'],
    );
    assert.ok(hit.rows[0]!.c > 0, 'keyword search finds the mounted term');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

// ---------- supersession ----------

test('mount: edit + re-mount supersedes old chunks in current_documents and keyword search, but keeps them in raw documents', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const file = tmpFile('evolving.md', '# Doc\noriginalterm content here\n');
  try {
    const first = await mountFile(rt, file);
    assert.equal(first.mounted, true);
    const firstHash = first.fileHash;

    const sp = resolve(file);
    const firstMount = await rt.query<{ id: string }>(
      `SELECT id FROM brain.mounts WHERE source_path = $1 ORDER BY id DESC LIMIT 1`,
      [sp],
    );
    const firstMountId = firstMount.rows[0]!.id;

    // Edit the file: replace the searchable term.
    writeFileSync(file, '# Doc\nsupersededterm content here\n');
    const second = await mountFile(rt, file);
    assert.equal(second.mounted, true);
    assert.notEqual(second.fileHash, firstHash, 'edited file has a new file_hash');

    const secondMount = await rt.query<{ id: string }>(
      `SELECT id FROM brain.mounts WHERE source_path = $1 ORDER BY id DESC LIMIT 1`,
      [sp],
    );
    const secondMountId = secondMount.rows[0]!.id;
    assert.notEqual(secondMountId, firstMountId, 'edited file gets a new mount id');

    // current_documents shows only the NEW mount's chunks.
    const cur = await rt.query<{ mount_id: string; content: string }>(
      `SELECT mount_id, content FROM brain.current_documents WHERE source_path = $1`,
      [sp],
    );
    assert.ok(cur.rowCount! > 0);
    for (const row of cur.rows) {
      assert.equal(row.mount_id, secondMountId, 'current view only carries the latest mount');
    }
    const curText = cur.rows.map((r) => r.content).join('\n');
    assert.match(curText, /supersededterm/);
    assert.doesNotMatch(curText, /originalterm/, 'old chunk absent from current_documents');

    // Keyword search over the view: old term gone, new term present.
    const oldHit = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE source_path = $1 AND tsv @@ plainto_tsquery('english', 'originalterm')`,
      [sp],
    );
    assert.equal(oldHit.rows[0]!.c, 0, 'superseded term not found via current_documents keyword search');

    const newHit = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.current_documents
        WHERE source_path = $1 AND tsv @@ plainto_tsquery('english', 'supersededterm')`,
      [sp],
    );
    assert.ok(newHit.rows[0]!.c > 0, 'new term found via current_documents keyword search');

    // Raw documents still hold the old chunks as immutable history.
    const rawOld = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.documents WHERE source_path = $1 AND mount_id = $2`,
      [sp, firstMountId],
    );
    assert.ok(rawOld.rows[0]!.c > 0, 'old chunks remain in raw documents as history');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

// ---------- A -> B -> A supersession by mount id ----------

test('mount: A -> B -> A makes only the latest A mount current (no duplicate A chunks)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const file = tmpFile('aba.md', '# A\nalphacontent here\n');
  const sp = resolve(file);
  const A = '# A\nalphacontent here\n';
  const B = '# B\nbetacontent here\n';
  try {
    // Mount A.
    writeFileSync(file, A);
    const a1 = await mountFile(rt, file);
    assert.equal(a1.mounted, true);
    const aChunks = a1.chunks;

    // Mount B.
    writeFileSync(file, B);
    const b = await mountFile(rt, file);
    assert.equal(b.mounted, true);

    // Mount A again (same content as the first A => new mount, new mount_id).
    writeFileSync(file, A);
    const a2 = await mountFile(rt, file);
    assert.equal(a2.mounted, true);
    assert.equal(a2.fileHash, a1.fileHash, 'A re-mount has the same file_hash as the first A');

    // Three mount rows exist for this path.
    const mounts = await rt.query<{ id: string; file_hash: string }>(
      `SELECT id, file_hash FROM brain.mounts WHERE source_path = $1 ORDER BY id`,
      [sp],
    );
    assert.equal(mounts.rowCount, 3, 'A, B, A each recorded a distinct mount');
    const latestMountId = mounts.rows[2]!.id;

    // current_documents must carry ONLY the third (latest A) mount's chunks.
    const cur = await rt.query<{ mount_id: string; content: string }>(
      `SELECT mount_id, content FROM brain.current_documents WHERE source_path = $1`,
      [sp],
    );
    const distinctMountIds = new Set(cur.rows.map((r) => r.mount_id));
    assert.equal(distinctMountIds.size, 1, 'exactly one mount_id is current');
    assert.equal([...distinctMountIds][0], latestMountId, 'the latest A mount is current');
    assert.equal(cur.rowCount, aChunks, 'current chunk count == chunks of A (no duplicate A chunks)');

    const curText = cur.rows.map((r) => r.content).join('\n');
    assert.match(curText, /alphacontent/, 'current view shows A content');
    assert.doesNotMatch(curText, /betacontent/, 'B content is not current');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

// ---------- atomicity: a failed mount cements nothing ----------

test('mount: a mount that errors mid-way leaves no rows and is repairable', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const file = tmpFile('atomic.md', '# Atom\nfirstcontent here\n');
  const sp = resolve(file);
  try {
    // Establish a valid first mount.
    const first = await mountFile(rt, file);
    assert.equal(first.mounted, true);
    const baselineDocs = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.documents WHERE source_path = $1`,
      [sp],
    );
    const baselineMounts = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.mounts WHERE source_path = $1`,
      [sp],
    );

    // Simulate a mount that fails after the mounts row but before/within chunks:
    // run the exact transaction body and force a ROLLBACK instead of COMMIT.
    writeFileSync(file, '# Atom\nsecondcontent here\n');
    await rt.query('BEGIN');
    await rt.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sp]);
    const m = await rt.query<{ id: string }>(
      `INSERT INTO brain.mounts (source_path, file_hash) VALUES ($1, $2) RETURNING id`,
      [sp, 'deadbeef'],
    );
    await rt.query(
      `INSERT INTO brain.documents (source_path, chunk_index, content, content_hash, mount_id, frontmatter)
         VALUES ($1, 0, 'partial', 'h', $2, '{}'::jsonb)`,
      [sp, m.rows[0]!.id],
    );
    await rt.query('ROLLBACK');

    // Nothing cemented: counts unchanged, view unchanged.
    const afterDocs = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.documents WHERE source_path = $1`,
      [sp],
    );
    const afterMounts = await rt.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.mounts WHERE source_path = $1`,
      [sp],
    );
    assert.equal(afterDocs.rows[0]!.c, baselineDocs.rows[0]!.c, 'no partial document rows survive');
    assert.equal(afterMounts.rows[0]!.c, baselineMounts.rows[0]!.c, 'no partial mount row survives');

    const cur = await rt.query<{ content: string }>(
      `SELECT content FROM brain.current_documents WHERE source_path = $1`,
      [sp],
    );
    const curText = cur.rows.map((r) => r.content).join('\n');
    assert.match(curText, /firstcontent/, 'current view still the original mount');
    assert.doesNotMatch(curText, /secondcontent|partial/, 'failed attempt not visible');

    // A subsequent valid re-mount succeeds (the path is not cemented/broken).
    const repair = await mountFile(rt, file);
    assert.equal(repair.mounted, true, 'a valid re-mount after the failure succeeds');
    const repaired = await rt.query<{ content: string }>(
      `SELECT content FROM brain.current_documents WHERE source_path = $1`,
      [sp],
    );
    const repairedText = repaired.rows.map((r) => r.content).join('\n');
    assert.match(repairedText, /secondcontent/, 're-mount becomes current');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

// ---------- concurrent same-path safety (advisory lock) ----------

test('mount: concurrent same-content mounts of one path never expose a mixed current set', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const file = tmpFile('concurrent.md', '# Conc\nconcurrentterm content here\n');
  const sp = resolve(file);
  const N = 6;
  const clients = await Promise.all(
    Array.from({ length: N }, () => runtimeClient(fresh.url, password, fresh.role)),
  );
  try {
    const results = await Promise.all(clients.map((c) => mountFile(c, file)));
    const mountedCount = results.filter((r) => r.mounted).length;
    assert.ok(mountedCount >= 1, 'at least one mount wins');

    // All chunks share one file_hash (same content), so the current set must be
    // a single mount's worth of chunks with exactly one mount_id.
    const reader = clients[0]!;
    const cur = await reader.query<{ mount_id: string; content: string }>(
      `SELECT mount_id, content FROM brain.current_documents WHERE source_path = $1`,
      [sp],
    );
    const distinct = new Set(cur.rows.map((r) => r.mount_id));
    assert.equal(distinct.size, 1, 'current set is exactly one mount (no mixed/duplicate current)');
    const curText = cur.rows.map((r) => r.content).join('\n');
    assert.match(curText, /concurrentterm/);

    // Mount-row count never exceeds the number of mounts that actually ran;
    // the advisory lock serializes them, so dedup collapses identical content
    // to a single row after the first winner.
    const mounts = await reader.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM brain.mounts WHERE source_path = $1`,
      [sp],
    );
    assert.equal(mounts.rows[0]!.c, mountedCount, 'one mount row per content-changing mount');
    assert.ok(mounts.rows[0]!.c >= 1 && mounts.rows[0]!.c <= N);
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    rmSync(file, { force: true });
    await teardown();
  }
});

test('mount: concurrent different-content mounts never expose a mixed current set', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const sp = resolve(tmpFile('conc-diff.md', 'seed'));
  const N = 6;
  const clients = await Promise.all(
    Array.from({ length: N }, () => runtimeClient(fresh.url, password, fresh.role)),
  );
  try {
    // Each client writes distinct content to the SAME path then mounts it.
    const contents = Array.from({ length: N }, (_, i) => `# C${i}\ndiffterm${i} body here\n`);
    await Promise.all(
      clients.map(async (c, i) => {
        writeFileSync(sp, contents[i]!);
        return mountFile(c, sp);
      }),
    );

    const reader = clients[0]!;
    // current set must be exactly one mount_id (no interleaving of two mounts).
    const cur = await reader.query<{ mount_id: string }>(
      `SELECT mount_id FROM brain.current_documents WHERE source_path = $1`,
      [sp],
    );
    const distinct = new Set(cur.rows.map((r) => r.mount_id));
    assert.equal(distinct.size, 1, 'current set is exactly one mount, never a mix');

    // And that one current mount_id is the max mount id for the path.
    const maxMount = await reader.query<{ id: string }>(
      `SELECT id FROM brain.mounts WHERE source_path = $1 ORDER BY id DESC LIMIT 1`,
      [sp],
    );
    assert.equal([...distinct][0], maxMount.rows[0]!.id, 'current mount is the latest mount');
  } finally {
    await Promise.all(clients.map((c) => c.end()));
    rmSync(sp, { force: true });
    await teardown();
  }
});

// ---------- runtime grant boundary ----------

test('mount: runtime can INSERT document chunks but cannot set tsv/id/recorded_at', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const file = tmpFile('grant.md', '# G\ngranttest body\n');
  try {
    // The normal mount path (omitting tsv) must succeed under the runtime role.
    const res = await mountFile(rt, file);
    assert.equal(res.mounted, true);

    // Explicitly attempting to write the generated tsv column is denied.
    await assert.rejects(
      rt.query(
        `INSERT INTO brain.documents (source_path, chunk_index, content, content_hash, mount_id, tsv)
           VALUES ('/x', 0, 'c', 'h', 1, to_tsvector('english','c'))`,
      ),
      /permission denied|cannot insert a non-DEFAULT value/i,
    );

    // id / recorded_at are also off-limits.
    await assert.rejects(
      rt.query(`INSERT INTO brain.documents (id, source_path, content) VALUES (1, '/x', 'c')`),
      /permission denied|cannot insert/i,
    );
    await assert.rejects(
      rt.query(
        `INSERT INTO brain.documents (recorded_at, source_path, content) VALUES (now(), '/x', 'c')`,
      ),
      /permission denied/i,
    );
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});

// ---------- schema integrity ----------

test('mount: documents.mount_id FK rejects a dangling mount reference', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await assert.rejects(
      rt.query(
        `INSERT INTO brain.documents (source_path, chunk_index, content, content_hash, mount_id, frontmatter)
           VALUES ('/x', 0, 'orphan', 'h', 999999, '{}'::jsonb)`,
      ),
      /violates foreign key constraint|is not present in table/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('mount: an empty mount row does not hide the previous current set', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  const file = tmpFile('empty.md', '# E\nkeepterm content here\n');
  const sp = resolve(file);
  try {
    const first = await mountFile(rt, file);
    assert.equal(first.mounted, true);

    // A later mount row for the same path with NO chunks (buggy/partial writer)
    // must NOT become the current set.
    await rt.query(
      `INSERT INTO brain.mounts (source_path, file_hash) VALUES ($1, 'empties')`,
      [sp],
    );

    const cur = await rt.query<{ content: string }>(
      `SELECT content FROM brain.current_documents WHERE source_path = $1`,
      [sp],
    );
    const curText = cur.rows.map((r) => r.content).join('\n');
    assert.ok(cur.rows.length > 0, 'current set is not empty');
    assert.match(curText, /keepterm/, 'the prior real mount stays current despite a later empty mount');
  } finally {
    await rt.end();
    rmSync(file, { force: true });
    await teardown();
  }
});
