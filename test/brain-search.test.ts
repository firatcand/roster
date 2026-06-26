import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { saveEntity } from '../src/lib/brain/save.ts';
import { createLink } from '../src/lib/brain/link.ts';
import { mountFile } from '../src/lib/brain/mount.ts';
import { query } from '../src/lib/brain/search.ts';
import { loadConfig, setConfig } from '../src/lib/brain/config.ts';
import { FakeEmbedder } from '../src/lib/brain/embed.ts';
import { runDoctor } from '../src/lib/brain/doctor.ts';
import { exportBrain } from '../src/lib/brain/export.ts';
import { importBrain } from '../src/lib/brain/import.ts';
import { HAS_DB, createFreshDb, runtimeClient } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'brain-search-'));
}

async function initBrain(url: string): Promise<pg.Pool> {
  const pool = createBrainPool('admin', url);
  await runMigrations(pool);
  return pool;
}

async function mountText(pool: pg.Pool, dir: string, name: string, body: string, embed: boolean): Promise<void> {
  const file = join(dir, name);
  writeFileSync(file, body);
  const client = await pool.connect();
  try {
    await mountFile(client, file, embed ? new FakeEmbedder() : null);
  } finally {
    client.release();
  }
}

test('brain query: vector arm ranks an exact-content match first (FakeEmbedder)', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    await mountText(pool, dir, 'a.md', 'Apollo handles cold outbound prospecting at scale.', true);
    await mountText(pool, dir, 'b.md', 'Stripe processes online payments for businesses.', true);
    await mountText(pool, dir, 'c.md', 'Kubernetes orchestrates containers across clusters.', true);

    // Use the exact stored content of b.md as the query → fake embedding matches.
    const stored = await pool.query<{ content: string }>(
      `SELECT content FROM brain.current_documents WHERE source_path LIKE '%b.md' LIMIT 1`,
    );
    const qtext = stored.rows[0]!.content;
    const cfg = await loadConfig(pool as unknown as pg.PoolClient);

    const client = await pool.connect();
    try {
      const hits = await query(client, qtext, { limit: 5 }, new FakeEmbedder(), cfg);
      const docHits = hits.filter((h) => h.type === 'document');
      assert.ok(docHits.length > 0, 'returns document hits');
      assert.match((docHits[0] as { source_path: string }).source_path, /b\.md$/, 'exact-content match ranks first');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('brain query: degrades to keyword+graph with no embedder (no throw)', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    await mountText(pool, dir, 'a.md', 'Apollo handles cold outbound prospecting.', false);
    await mountText(pool, dir, 'b.md', 'Stripe processes online payments.', false);
    const client = await pool.connect();
    try {
      const hits = await query(client, 'payments', { limit: 5 }, null);
      assert.ok(hits.some((h) => h.type === 'document' && /b\.md$/.test(h.source_path)), 'keyword arm finds the match');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('brain mount: embeds at INSERT time when enabled, NULL when not', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    await mountText(pool, dir, 'on.md', 'Embedded content here.', true);
    await mountText(pool, dir, 'off.md', 'Plain content here.', false);
    const on = await pool.query(`SELECT embedding IS NOT NULL AS has, embedding_model FROM brain.documents WHERE source_path LIKE '%on.md'`);
    const off = await pool.query(`SELECT embedding IS NOT NULL AS has FROM brain.documents WHERE source_path LIKE '%off.md'`);
    assert.equal(on.rows[0]!.has, true, 'embedded mount has a vector');
    assert.equal(on.rows[0]!.embedding_model, 'fake-embed');
    assert.equal(off.rows[0]!.has, false, 'non-embedded mount leaves embedding NULL');
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('brain query: graph arm surfaces a 1-hop linked entity; --kind filters', opts, async () => {
  const db = await createFreshDb();
  const dir = tmpDir();
  const pool = await initBrain(db.url);
  try {
    const client = await pool.connect();
    try {
      await saveEntity(client, { kind: 'company', slug: 'acme', title: 'Acme Robotics', fields: [] });
      await saveEntity(client, { kind: 'company', slug: 'globex', title: 'Globex Industrial', fields: [] });
      await saveEntity(client, { kind: 'person', slug: 'jane', title: 'Jane Doe', fields: [] });
      // 'wayland' has no name match for "Acme" — it can only be found via a fact value.
      await saveEntity(client, { kind: 'company', slug: 'wayland', title: 'Wayland Corp', fields: [{ key: 'rival', value: 'Acme Robotics' }] });
      await createLink(client, { srcSlug: 'acme', rel: 'competes_with', dstSlug: 'globex' });
      await createLink(client, { srcSlug: 'acme', rel: 'employs', dstSlug: 'jane' });

      const cfg = await loadConfig(client);
      const hits = await query(client, 'Acme', { limit: 20 }, null, cfg);
      const ents = hits.filter((h) => h.type === 'entity') as { slug: string; via: string }[];
      assert.ok(ents.some((e) => e.slug === 'acme' && e.via === 'match'), 'matched entity present');
      assert.ok(ents.some((e) => e.slug === 'globex' && e.via === 'graph'), 'graph surfaces 1-hop neighbour');
      assert.ok(ents.some((e) => e.slug === 'wayland' && e.via === 'match'), 'fact-value match seeds an entity');

      // --kind company: jane (person) is a graph neighbour of acme but must be filtered out.
      const kinded = await query(client, 'Acme', { kind: 'company', limit: 20 }, null, cfg);
      const kindedEnts = kinded.filter((h) => h.type === 'entity') as { slug: string; kind?: string; via: string }[];
      assert.ok(kindedEnts.some((e) => e.slug === 'globex'), 'kind filter keeps same-kind graph neighbour');
      assert.ok(!kindedEnts.some((e) => e.slug === 'jane'), 'kind filter drops cross-kind graph neighbour');
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  }
});

test('brain query: blank text returns nothing (no paid path)', opts, async () => {
  const db = await createFreshDb();
  const pool = await initBrain(db.url);
  try {
    const client = await pool.connect();
    try {
      // A throwing embedder proves the blank guard short-circuits before any embed call.
      const exploding = { model: 'x', dims: 1536, embed: async () => { throw new Error('should not be called'); } };
      assert.deepEqual(await query(client, '   ', { limit: 5 }, exploding), []);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await db.drop();
  }
});

test('brain config: set/get round-trip + rejects unknown keys and bad values', opts, async () => {
  const db = await createFreshDb();
  const pool = await initBrain(db.url);
  try {
    const client = await pool.connect();
    try {
      await setConfig(client, 'embeddings.enabled', 'true');
      const cfg = await loadConfig(client);
      assert.equal(cfg.embeddingsEnabled, true);

      await assert.rejects(setConfig(client, 'openai.api_key', 'sk-secret'), /unknown config key/i);
      await assert.rejects(setConfig(client, 'embeddings.provider', 'voyage'), /must be 'openai'/i);
      await assert.rejects(setConfig(client, 'embeddings.model', 'text-embedding-3-large'), /must be/i);
      await assert.rejects(setConfig(client, 'embeddings.enabled', 'maybe'), /true\|false/i);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
    await db.drop();
  }
});

test('brain config: runtime role can read config but not write it', opts, async () => {
  const db = await createFreshDb();
  const pool = await initBrain(db.url);
  let role: { created: boolean; password: string | null };
  try {
    role = await pool.connect().then(async (c) => {
      try {
        return await ensureRuntimeRole(c, db.role);
      } finally {
        c.release();
      }
    });
    await pool.query(`INSERT INTO brain_meta.config (key, value) VALUES ('embeddings.enabled', 'true'::jsonb)`);

    const rc = await runtimeClient(db.url, role.password!, db.role);
    try {
      const read = await rc.query(`SELECT value FROM brain_meta.config WHERE key = 'embeddings.enabled'`);
      assert.equal(read.rows[0]!.value, true, 'runtime can SELECT config');
      await assert.rejects(
        rc.query(`INSERT INTO brain_meta.config (key, value) VALUES ('x', '1'::jsonb)`),
        /permission denied/i,
        'runtime cannot write config',
      );
      await assert.rejects(
        rc.query(`SELECT 1 FROM brain_meta.runtime_roles LIMIT 1`),
        /permission denied/i,
        'runtime cannot read other brain_meta tables',
      );
    } finally {
      await rc.end();
    }
  } finally {
    await pool.end();
    await db.drop();
  }
});

test('ROS-141 backup round-trips a brain with pgvector embeddings', opts, async () => {
  const srcDb = await createFreshDb();
  const dstDb = await createFreshDb();
  const dir = tmpDir();
  const src = await initBrain(srcDb.url);
  const dst = await initBrain(dstDb.url);
  try {
    await mountText(src, dir, 'doc.md', 'Vectored content for backup round-trip.', true);
    const embText = async (pool: pg.Pool): Promise<string[]> =>
      (await pool.query<{ e: string | null }>(`SELECT embedding::text AS e FROM brain.documents ORDER BY id`)).rows.map(
        (r) => r.e ?? 'NULL',
      );
    const before = await embText(src);
    assert.ok(before[0] !== 'NULL' && before[0]!.startsWith('['), 'source has a vector');

    await exportBrain(src, { outDir: dir, format: 'jsonl', exportedAt: '2026-06-27T00:00:00.000Z' });
    await importBrain(dst, dir);

    assert.deepEqual(await embText(dst), before, 'embeddings restore identically');
  } finally {
    await src.end();
    await dst.end();
    rmSync(dir, { recursive: true, force: true });
    await srcDb.drop();
    await dstDb.drop();
  }
});

test('brain doctor flags an out-of-band TRUNCATE grant on brain_meta', opts, async () => {
  const db = await createFreshDb();
  const pool = await initBrain(db.url);
  try {
    await pool.connect().then(async (c) => {
      try {
        await ensureRuntimeRole(c, db.role);
      } finally {
        c.release();
      }
    });
    await pool.query(`GRANT TRUNCATE ON brain_meta.schema_migrations TO "${db.role}"`);
    const report = await runDoctor(pool, db.role);
    assert.equal(report.ok, false, 'TRUNCATE on a brain_meta table must be caught');
    const configCheck = report.checks.find((c) => c.name.startsWith('brain-meta-config-read-only'));
    assert.equal(configCheck?.ok, false);
  } finally {
    await pool.end();
    await db.drop();
  }
});

test('brain doctor stays green with the config-read grant', opts, async () => {
  const db = await createFreshDb();
  const pool = await initBrain(db.url);
  try {
    await pool.connect().then(async (c) => {
      try {
        await ensureRuntimeRole(c, db.role);
      } finally {
        c.release();
      }
    });
    const report = await runDoctor(pool, db.role);
    const configCheck = report.checks.find((c) => c.name.startsWith('brain-meta-config-read-only'));
    assert.ok(configCheck?.ok, 'config-read-only invariant holds');
    assert.equal(report.ok, true, 'brain healthy');
  } finally {
    await pool.end();
    await db.drop();
  }
});
