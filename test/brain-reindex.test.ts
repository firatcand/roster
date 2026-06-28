import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { mountFile } from '../src/lib/brain/mount.ts';
import { query } from '../src/lib/brain/search.ts';
import { loadConfig } from '../src/lib/brain/config.ts';
import { FakeEmbedder, type Embedder } from '../src/lib/brain/embed.ts';
import { reindexBrain, countReindexTargets } from '../src/lib/brain/reindex.ts';
import { parseBrainArgs } from '../src/lib/brain-args.ts';
import { setConfig } from '../src/lib/brain/config.ts';
import { executeBrainReindex } from '../src/commands/brain.ts';
import { HAS_DB, createFreshDb } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'brain-reindex-'));
}

async function initBrain(url: string): Promise<pg.Pool> {
  const pool = createBrainPool('admin', url);
  await runMigrations(pool);
  return pool;
}

// Mount a file with NO embedder (embedding stays NULL) — the pre-reindex state.
async function mountText(pool: pg.Pool, dir: string, name: string, body: string): Promise<void> {
  const file = join(dir, name);
  writeFileSync(file, body);
  const client = await pool.connect();
  try {
    await mountFile(client, file, null);
  } finally {
    client.release();
  }
}

async function embeddedCount(pool: pg.Pool): Promise<number> {
  const r = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM brain.current_documents WHERE embedding IS NOT NULL`,
  );
  return r.rows[0]!.n;
}

test('parseBrainArgs: reindex rejects --all + --since together', () => {
  const ok = parseBrainArgs(['reindex', '--since', '2026-01-01']);
  assert.equal(ok.kind, 'ok');
  const bad = parseBrainArgs(['reindex', '--all', '--since', '2026-01-01']);
  assert.equal(bad.kind, 'err');
});

test('reindex backfills NULL embeddings for active chunks; query vector arm then works', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    await mountText(pool, dir, 'a.md', 'Apollo handles cold outbound prospecting at scale.');
    await mountText(pool, dir, 'b.md', 'Stripe processes online payments for businesses.');
    assert.equal(await embeddedCount(pool), 0, 'nothing embedded before reindex');

    const r = await reindexBrain(pool, new FakeEmbedder(), {});
    assert.equal(r.targeted, r.embedded, 'all targets embedded');
    assert.equal(r.remaining, 0);
    assert.ok(r.embedded >= 2);
    assert.equal(await embeddedCount(pool), r.embedded, 'embeddings now populated');

    // Vector arm now contributes: exact-content query (FakeEmbedder → distance 0).
    const stored = await pool.query<{ content: string }>(
      `SELECT content FROM brain.current_documents WHERE source_path LIKE '%b.md' LIMIT 1`,
    );
    const cfg = await loadConfig(pool as unknown as pg.PoolClient);
    const client = await pool.connect();
    try {
      const hits = await query(client, stored.rows[0]!.content, { limit: 5 }, new FakeEmbedder(), cfg);
      const top = hits.find((h) => h.type === 'document') as { source_path: string } | undefined;
      assert.match(top!.source_path, /b\.md$/, 'vector arm ranks the exact-content chunk first');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('reindex is idempotent/resumable: a second run embeds nothing', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    await mountText(pool, dir, 'a.md', 'content one');
    await reindexBrain(pool, new FakeEmbedder(), {});
    const second = await reindexBrain(pool, new FakeEmbedder(), {});
    assert.equal(second.targeted, 0, 'nothing left to embed');
    assert.equal(second.embedded, 0);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('reindex re-embeds rows whose model differs', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    await mountText(pool, dir, 'a.md', 'content for model change');
    await reindexBrain(pool, new FakeEmbedder(), {}); // model 'fake-embed'

    const fake2: Embedder = { model: 'fake-embed-2', dims: 1536, embed: (t) => new FakeEmbedder().embed(t) };
    assert.equal(await countReindexTargets(pool as unknown as pg.PoolClient, fake2.model), await embeddedCount(pool), 'all rows stale vs new model');
    const r = await reindexBrain(pool, fake2, {});
    assert.ok(r.embedded >= 1, 'rows re-embedded under the new model');
    const m = await pool.query<{ embedding_model: string }>(`SELECT DISTINCT embedding_model FROM brain.current_documents`);
    assert.deepEqual(m.rows.map((x) => x.embedding_model), ['fake-embed-2']);
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('reindex only touches ACTIVE chunks — superseded chunks stay NULL', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    await mountText(pool, dir, 'f.md', 'first version of the document');
    await mountText(pool, dir, 'f.md', 'second and completely different version of the document body');
    await reindexBrain(pool, new FakeEmbedder(), {});

    const active = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM brain.current_documents WHERE embedding IS NULL`,
    );
    assert.equal(active.rows[0]!.n, 0, 'all active chunks embedded');
    const superseded = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM brain.documents d
        WHERE d.embedding IS NULL
          AND d.id NOT IN (SELECT id FROM brain.current_documents)`,
    );
    assert.ok(superseded.rows[0]!.n >= 1, 'superseded chunk(s) left un-embedded');
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('reindex skips empty/whitespace-content chunks (no infinite loop)', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    await mountText(pool, dir, 'a.md', 'real content to embed');
    // Inject an active chunk with whitespace-only content (defensive edge).
    const m = await pool.query<{ id: string }>(
      `INSERT INTO brain.mounts (source_path, file_hash) VALUES ('/blank.md', 'h') RETURNING id`,
    );
    await pool.query(
      `INSERT INTO brain.documents (source_path, chunk_index, content, content_hash, mount_id) VALUES ('/blank.md', 0, '   ', 'ch', $1)`,
      [m.rows[0]!.id],
    );
    const r = await reindexBrain(pool, new FakeEmbedder(), {}); // must terminate
    assert.ok(r.embedded >= 1, 'real chunk embedded');
    const blank = await pool.query<{ has: boolean }>(
      `SELECT embedding IS NOT NULL AS has FROM brain.documents WHERE source_path = '/blank.md'`,
    );
    assert.equal(blank.rows[0]!.has, false, 'whitespace chunk left un-embedded (excluded from targets)');
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('executeBrainReindex: refuses when embeddings disabled; rejects bad --model', opts, async () => {
  const db = await createFreshDb();
  const pool = await initBrain(db.url);
  try {
    await assert.rejects(
      executeBrainReindex({ json: true, yes: true, adminUrl: db.url }),
      /embeddings are not enabled/i,
    );
    await assert.rejects(
      executeBrainReindex({ json: true, yes: true, model: 'text-embedding-3-large', adminUrl: db.url }),
      /unsupported --model/i,
    );
  } finally {
    await pool.end();
    await db.drop();
  }
});

test('executeBrainReindex preview (no --yes) makes zero paid calls', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  const prevKey = process.env.OPENAI_API_KEY;
  try {
    await mountText(pool, dir, 'a.md', 'content awaiting embedding');
    await pool.connect().then(async (c) => { try { await setConfig(c, 'embeddings.enabled', 'true'); } finally { c.release(); } });
    process.env.OPENAI_API_KEY = 'sk-dummy-not-called'; // resolveEmbedder → OpenAIEmbedder, but preview won't call it

    const code = await executeBrainReindex({ json: true, yes: false, adminUrl: db.url });
    assert.equal(code, 0);
    // No spend: embeddings still NULL (OpenAI was never hit; a real call with the dummy key would have errored).
    const n = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM brain.current_documents WHERE embedding IS NOT NULL`);
    assert.equal(n.rows[0]!.n, 0, 'preview did not embed anything');
  } finally {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('reindex --since scopes by recorded_at', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    await mountText(pool, dir, 'a.md', 'scoped content');
    const future = '2999-01-01T00:00:00Z';
    assert.equal(await countReindexTargets(pool as unknown as pg.PoolClient, 'fake-embed', future), 0, 'future --since → no targets');
    const r = await reindexBrain(pool, new FakeEmbedder(), { since: future });
    assert.equal(r.embedded, 0, 'nothing embedded for a future --since');
    assert.ok((await countReindexTargets(pool as unknown as pg.PoolClient, 'fake-embed')) >= 1, 'rows still pending without the filter');
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});
