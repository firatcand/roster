import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { HAS_DB, createFreshDb, runtimeClient, type FreshDb } from './brain-helpers.ts';
import { mergeEntities } from '../src/lib/brain/merge.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

const N = 20000;

type Setup = { fresh: FreshDb; password: string; admin: pg.Client; teardown: () => Promise<void> };

async function provisionLarge(): Promise<Setup> {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  let password: string;
  try {
    await runMigrations(pool);
    const role = await withBrainClient(pool, (c) => ensureRuntimeRole(c, fresh.role));
    password = role.password!;
  } catch (err) {
    await fresh.drop();
    await pool.end();
    throw err;
  } finally {
    await pool.end();
  }

  const admin = new pg.Client({ connectionString: fresh.url });
  await admin.connect();
  // Seed a large brain so the planner prefers indexes over a seq scan. A handful
  // of named entities (org-1..org-10) drive the merge tests; the bulk use diverse
  // md5 slugs (the realistic dedup case — varied names, where the trigram index
  // is actually selective, unlike a shared 'org-N' prefix).
  await admin.query(
    `INSERT INTO brain.entities (kind, slug, title)
       SELECT 'org', 'org-' || g, 'Org ' || g FROM generate_series(1, 10) g`,
  );
  // Diverse slugs + a ~1KB body each so the table is genuinely large (~20MB):
  // at this size the planner prefers the trigram/lower indexes over a seq scan,
  // which is the whole point of the ticket. Real entities carry comparable bulk.
  await admin.query(
    `INSERT INTO brain.entities (kind, slug, body)
       SELECT 'org', md5(g::text), jsonb_build_object('pad', repeat('x', 1000))
         FROM generate_series(1, $1) g`,
    [N],
  );
  await admin.query(
    `INSERT INTO brain.entity_aliases (entity_id, alias)
       SELECT e.id, md5(e.id::text || 'a') FROM brain.entities e WHERE e.kind = 'org'`,
  );
  await admin.query(
    `INSERT INTO brain.facts (entity_id, key, value)
       SELECT e.id, 'hq', to_jsonb('city-' || e.id) FROM brain.entities e WHERE e.kind = 'org'`,
  );
  await admin.query(
    `INSERT INTO brain.events (entity_id, kind, payload)
       SELECT e.id, 'seen', '{}'::jsonb FROM brain.entities e WHERE e.kind = 'org'`,
  );
  await admin.query(
    `INSERT INTO brain.edges (src_id, dst_id, rel)
       SELECT e.id, e.id + 1, 'links'
         FROM brain.entities e
        WHERE e.kind = 'org' AND e.id < (SELECT max(id) FROM brain.entities WHERE kind = 'org')`,
  );

  return {
    fresh,
    password,
    admin,
    teardown: async () => {
      await admin.end().catch(() => {});
      await fresh.drop();
    },
  };
}

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; Plans?: PlanNode[] };

function flatten(node: PlanNode, acc: PlanNode[]): void {
  acc.push(node);
  for (const child of node.Plans ?? []) flatten(child, acc);
}

async function explain(client: pg.Client, sql: string, params: unknown[]): Promise<PlanNode[]> {
  const r = await client.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
    `EXPLAIN (FORMAT JSON) ${sql}`,
    params,
  );
  const nodes: PlanNode[] = [];
  flatten(r.rows[0]!['QUERY PLAN'][0]!.Plan, nodes);
  return nodes;
}

const seqScanOn = (nodes: PlanNode[], rel: string) =>
  nodes.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === rel);
const anyIndexScan = (nodes: PlanNode[]) =>
  nodes.some((n) => /Index Scan|Index Only Scan|Bitmap Index Scan/.test(n['Node Type']));

test('large brain: dedup + canonicalized get use indexes, not Seq Scans', opts, async () => {
  const { fresh, password, admin, teardown } = await provisionLarge();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    // A real merge so canonical resolution is non-trivial and the cache is exercised.
    await mergeEntities(rt, { fromSlug: 'org-1', intoSlug: 'org-2', kind: 'org' });

    await admin.query('ANALYZE brain.entities');
    await admin.query('ANALYZE brain.entity_aliases');
    await admin.query('ANALYZE brain.facts');
    await admin.query('ANALYZE brain.events');
    await admin.query('ANALYZE brain.edges');
    await admin.query('ANALYZE brain.entity_merges');

    const canon = (
      await admin.query<{ canonical_id: string }>(
        `SELECT canonical_id FROM brain.entities WHERE kind = 'org' AND slug = 'org-2'`,
      )
    ).rows[0]!.canonical_id;

    // (1) dedup candidate lookup — must use the trigram / lower() indexes, not a seq scan.
    const probe = (
      await admin.query<{ slug: string }>(
        `SELECT slug FROM brain.entities WHERE kind = 'org' AND slug ~ '^[0-9a-f]{32}$' LIMIT 1`,
      )
    ).rows[0]!.slug;
    await admin.query('BEGIN');
    await admin.query(`SET LOCAL pg_trgm.similarity_threshold = 0.3`);
    const dedupNodes = await explain(
      admin,
      `SELECT e.id FROM brain.entities e
        WHERE e.kind = $1
          AND (e.slug % $2 OR e.title % $3
               OR lower(e.slug) = lower($2) OR lower(e.title) = lower($3))`,
      ['org', probe, probe],
    );
    await admin.query('COMMIT');
    assert.ok(!seqScanOn(dedupNodes, 'entities'), 'dedup must not Seq Scan brain.entities');
    assert.ok(anyIndexScan(dedupNodes), 'dedup must use an index scan');

    // (2) canonicalized facts read.
    const factNodes = await explain(
      admin,
      `SELECT DISTINCT ON (f.key) f.key
         FROM brain.facts f JOIN brain.entities en ON en.id = f.entity_id
        WHERE en.canonical_id = $1 ORDER BY f.key, f.id DESC`,
      [canon],
    );
    assert.ok(!seqScanOn(factNodes, 'facts'), 'facts read must not Seq Scan brain.facts');
    assert.ok(!seqScanOn(factNodes, 'entities'), 'facts read must not Seq Scan brain.entities');

    // (3) canonicalized events read.
    const eventNodes = await explain(
      admin,
      `SELECT ev.id FROM brain.events ev JOIN brain.entities en ON en.id = ev.entity_id
        WHERE en.canonical_id = $1 ORDER BY ev.id DESC LIMIT 50`,
      [canon],
    );
    assert.ok(!seqScanOn(eventNodes, 'events'), 'events read must not Seq Scan brain.events');

    // (4) canonicalized edges read — the UNION form used by getEntity.
    const edgeNodes = await explain(
      admin,
      `WITH hits AS (
         SELECT e.id, e.dst_id AS other_id FROM brain.edges e
           JOIN brain.entities se ON se.id = e.src_id WHERE se.canonical_id = $1
         UNION ALL
         SELECT e.id, e.src_id AS other_id FROM brain.edges e
           JOIN brain.entities de ON de.id = e.dst_id WHERE de.canonical_id = $1
       )
       SELECT h.id FROM hits h
         JOIN brain.entities oe ON oe.id = h.other_id
         JOIN brain.entities other ON other.id = oe.canonical_id
        WHERE oe.canonical_id <> $1 ORDER BY h.id DESC LIMIT 50`,
      [canon],
    );
    assert.ok(!seqScanOn(edgeNodes, 'edges'), 'edges read must not Seq Scan brain.edges');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('large brain: canonical cache is append-only-safe and never drifts after a merge', opts, async () => {
  const { fresh, password, admin, teardown } = await provisionLarge();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    // Transitive + reparenting merges exercise the reverse-reachability refresh.
    await mergeEntities(rt, { fromSlug: 'org-3', intoSlug: 'org-4', kind: 'org' });
    await mergeEntities(rt, { fromSlug: 'org-4', intoSlug: 'org-5', kind: 'org' });
    await mergeEntities(rt, { fromSlug: 'org-6', intoSlug: 'org-3', kind: 'org' });

    // The runtime role can never write the derived column directly.
    await assert.rejects(
      rt.query(`UPDATE brain.entities SET canonical_id = id`),
      /permission denied/i,
    );

    const drift = await admin.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM brain.entities
        WHERE canonical_id IS DISTINCT FROM brain.canonical_id(id)`,
    );
    assert.equal(drift.rows[0]!.c, '0', 'materialized canonical_id matches the merge map for every row');
  } finally {
    await rt.end();
    await teardown();
  }
});
