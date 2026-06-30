import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrainPool, withBrainClient } from '../src/lib/brain/connect.ts';
import { runMigrations } from '../src/lib/brain/migrate.ts';
import { ensureRuntimeRole } from '../src/lib/brain/roles.ts';
import { HAS_DB, createFreshDb, runtimeClient, type FreshDb } from './brain-helpers.ts';
import { parseBrainArgs } from '../src/lib/brain-args.ts';
import { saveEntity } from '../src/lib/brain/save.ts';
import { getEntity } from '../src/lib/brain/get.ts';
import { createLink } from '../src/lib/brain/link.ts';
import { mergeEntities } from '../src/lib/brain/merge.ts';
import { findCandidates } from '../src/lib/brain/dedup.ts';

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

// ---------- arg parsing ----------

test('parseBrainArgs: merge needs exactly 2 positionals', () => {
  const r = parseBrainArgs(['merge', 'acme-old', 'acme', '--kind', 'org', '--actor', 'bot', '--json']);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok' || r.subcommand !== 'merge') throw new Error('wrong shape');
  assert.equal(r.fromSlug, 'acme-old');
  assert.equal(r.intoSlug, 'acme');
  assert.equal(r.entKind, 'org');
  assert.equal(r.actor, 'bot');
  assert.equal(r.json, true);
  assert.equal(parseBrainArgs(['merge', 'a']).kind, 'err');
  assert.equal(parseBrainArgs(['merge', 'a', 'b', 'c']).kind, 'err');
  assert.equal(parseBrainArgs(['merge', 'a', 'b', '--bogus']).kind, 'err');
});

// ---------- create-safety ----------

test('near-duplicate save returns create_safety=probable with the original in candidates; both still created', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const a = await saveEntity(rt, { kind: 'org', slug: 'acme', title: 'Acme', fields: [] });
    assert.equal(a.created, true);

    const b = await saveEntity(rt, { kind: 'org', slug: 'acme-ai', title: 'Acme AI', fields: [] });
    assert.equal(b.created, true, 'warn-only — the near-dup entity is still created');
    assert.equal(b.create_safety, 'probable');
    assert.ok(
      b.candidates.some((c) => c.slug === 'acme'),
      'the original Acme is surfaced as a candidate',
    );

    const cnt = await rt.query(`SELECT count(*)::int AS c FROM brain.entities WHERE kind='org'`);
    assert.equal(cnt.rows[0]!.c, 2, 'both entities exist — save never blocks');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('exact slug re-save returns create_safety=exists', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'org', slug: 'acme', title: 'Acme', fields: [] });
    const again = await saveEntity(rt, { kind: 'org', slug: 'acme', fields: [{ key: 'note', value: 'x' }] });
    assert.equal(again.created, false);
    assert.equal(again.create_safety, 'exists');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('distinct entity save returns create_safety=unknown', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'org', slug: 'acme', title: 'Acme', fields: [] });
    const z = await saveEntity(rt, { kind: 'org', slug: 'zenith-systems', title: 'Zenith Systems', fields: [] });
    assert.equal(z.created, true);
    assert.equal(z.create_safety, 'unknown');
    assert.equal(z.candidates.length, 0);
  } finally {
    await rt.end();
    await teardown();
  }
});

test('findCandidates matches against captured aliases too', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'org', slug: 'acme-old', title: 'Acme Old', fields: [] });
    await saveEntity(rt, { kind: 'org', slug: 'acme', title: 'Acme', fields: [] });
    await mergeEntities(rt, { fromSlug: 'acme-old', intoSlug: 'acme', kind: 'org' });

    const res = await findCandidates(rt, 'org', 'acme-old');
    assert.equal(res.create_safety, 'exists', 'the merged-away slug is now an alias → exact');
    assert.ok(res.candidates.some((c) => c.slug === 'acme' && c.via === 'alias'));
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- append-only merge ----------

test('merge is append-only: facts/edges unified at read, no rows deleted, slug captured as alias', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    // A and B each get facts; A and B each get an outbound edge to a neighbor.
    await saveEntity(rt, { kind: 'org', slug: 'acme-old', title: 'Acme Old', fields: [{ key: 'hq', value: 'SF' }] });
    await saveEntity(rt, { kind: 'org', slug: 'acme', title: 'Acme', fields: [{ key: 'ceo', value: 'Jane' }] });
    await saveEntity(rt, { kind: 'person', slug: 'paul', fields: [] });
    await saveEntity(rt, { kind: 'person', slug: 'quinn', fields: [] });
    await createLink(rt, { srcSlug: 'paul', rel: 'works_at', dstSlug: 'acme-old', kindSrc: 'person', kindDst: 'org' });
    await createLink(rt, { srcSlug: 'quinn', rel: 'works_at', dstSlug: 'acme', kindSrc: 'person', kindDst: 'org' });

    const before = await rawCounts(rt);

    const merge = await mergeEntities(rt, { fromSlug: 'acme-old', intoSlug: 'acme', kind: 'org' });

    // get on the merged-away slug resolves to the canonical entity (B = acme).
    const viaOld = await getEntity(rt, 'org', 'acme-old');
    assert.equal(viaOld.entity!.slug, 'acme', 'get on A resolves to B');
    assert.equal(viaOld.entity!.id, merge.canonicalId);

    // B's compiled truth unifies facts from BOTH entities.
    const viaInto = await getEntity(rt, 'org', 'acme');
    const facts = new Map(viaInto.facts.map((f) => [f.key, f.value]));
    assert.equal(facts.get('hq'), 'SF', 'fact from A surfaces on canonical');
    assert.equal(facts.get('ceo'), 'Jane', 'fact from B surfaces on canonical');

    // edges from BOTH entities surface on the canonical, with endpoints resolved.
    const edgeSlugs = viaInto.edges.map((e) => `${e.rel}:${e.other_slug}`).sort();
    assert.deepEqual(edgeSlugs, ['works_at:paul', 'works_at:quinn']);

    // A's slug + title captured as aliases on B.
    const aliases = await rt.query<{ alias: string }>(
      `SELECT alias FROM brain.entity_aliases WHERE entity_id = $1 ORDER BY alias`,
      [merge.intoId],
    );
    const aliasSet = new Set(aliases.rows.map((r) => r.alias));
    assert.ok(aliasSet.has('acme-old'), "A's slug captured as alias");
    assert.ok(aliasSet.has('Acme Old'), "A's title captured as alias");

    // NO rows deleted or moved — raw counts unchanged for entities/facts/edges.
    const after = await rawCounts(rt);
    assert.equal(after.entities, before.entities, 'no entity row removed');
    assert.equal(after.facts, before.facts, 'no fact row removed or added');
    assert.equal(after.edges, before.edges, 'no edge row removed or added');

    // facts/edges still physically belong to their original entity_id.
    const aFacts = await rt.query(
      `SELECT count(*)::int AS c FROM brain.facts WHERE entity_id = $1`, [merge.fromId]);
    assert.equal(aFacts.rows[0]!.c, 1, "A's fact row stays put (not moved)");
  } finally {
    await rt.end();
    await teardown();
  }
});

test('merge suppresses edges between the two merged entities (no canonical self-loop)', opts, async () => {
  // Regression (Codex ROS-140 2nd-pass, improvement): an edge whose endpoints both
  // canonicalize to the queried entity is merged-internal noise, not a real self-edge.
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'org', slug: 'acme-old', fields: [] });
    await saveEntity(rt, { kind: 'org', slug: 'acme', fields: [] });
    await saveEntity(rt, { kind: 'person', slug: 'paul', fields: [] });
    // An edge directly between the two soon-to-be-merged entities, plus a real external edge.
    await createLink(rt, { srcSlug: 'acme-old', rel: 'rebrand_of', dstSlug: 'acme', kindSrc: 'org', kindDst: 'org' });
    await createLink(rt, { srcSlug: 'paul', rel: 'works_at', dstSlug: 'acme', kindSrc: 'person', kindDst: 'org' });

    await mergeEntities(rt, { fromSlug: 'acme-old', intoSlug: 'acme', kind: 'org' });

    const truth = await getEntity(rt, 'org', 'acme');
    const rels = truth.edges.map((e) => e.rel).sort();
    assert.deepEqual(rels, ['works_at'], 'internal rebrand_of edge suppressed; external edge kept');
    assert.ok(truth.edges.every((e) => e.other_slug !== 'acme'), 'no self-loop to the canonical entity');
  } finally {
    await rt.end();
    await teardown();
  }
});

async function rawCounts(rt: import('pg').Client) {
  const r = await rt.query<{ entities: number; facts: number; edges: number }>(
    `SELECT
       (SELECT count(*)::int FROM brain.entities) AS entities,
       (SELECT count(*)::int FROM brain.facts) AS facts,
       (SELECT count(*)::int FROM brain.edges) AS edges`,
  );
  return r.rows[0]!;
}

// ---------- transitive resolution ----------

test('transitive merge A->B then B->C: get A resolves to C; facts unify', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'org', slug: 'a', title: 'A', fields: [{ key: 'fa', value: 1 }] });
    await saveEntity(rt, { kind: 'org', slug: 'b', title: 'B', fields: [{ key: 'fb', value: 2 }] });
    await saveEntity(rt, { kind: 'org', slug: 'c', title: 'C', fields: [{ key: 'fc', value: 3 }] });

    await mergeEntities(rt, { fromSlug: 'a', intoSlug: 'b', kind: 'org' });
    await mergeEntities(rt, { fromSlug: 'b', intoSlug: 'c', kind: 'org' });

    const viaA = await getEntity(rt, 'org', 'a');
    assert.equal(viaA.entity!.slug, 'c', 'A resolves transitively to C');

    const facts = new Map(viaA.facts.map((f) => [f.key, f.value]));
    assert.equal(facts.get('fa'), 1);
    assert.equal(facts.get('fb'), 2);
    assert.equal(facts.get('fc'), 3);
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- canonical_id correctness ----------

test('canonical_id resolves each node on a chain to the terminal node', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const a = await saveEntity(rt, { kind: 'org', slug: 'a', fields: [] });
    const b = await saveEntity(rt, { kind: 'org', slug: 'b', fields: [] });
    const c = await saveEntity(rt, { kind: 'org', slug: 'c', fields: [] });

    await mergeEntities(rt, { fromSlug: 'a', intoSlug: 'b', kind: 'org' });
    await mergeEntities(rt, { fromSlug: 'b', intoSlug: 'c', kind: 'org' });

    const canon = async (id: string) =>
      (await rt.query<{ id: string }>(`SELECT brain.canonical_id($1) AS id`, [id])).rows[0]!.id;

    assert.equal(await canon(a.entityId), c.entityId, 'A -> C');
    assert.equal(await canon(b.entityId), c.entityId, 'B -> C');
    assert.equal(await canon(c.entityId), c.entityId, 'C -> C (terminal)');
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- cycle guard ----------

test('cycle guard: merge A->B then B->A is rejected', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'org', slug: 'a', fields: [] });
    await saveEntity(rt, { kind: 'org', slug: 'b', fields: [] });
    await mergeEntities(rt, { fromSlug: 'a', intoSlug: 'b', kind: 'org' });
    await assert.rejects(
      mergeEntities(rt, { fromSlug: 'b', intoSlug: 'a', kind: 'org' }),
      /cycle/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('cycle guard: C->A after A->B->C is rejected (would close the chain)', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'org', slug: 'a', fields: [] });
    await saveEntity(rt, { kind: 'org', slug: 'b', fields: [] });
    await saveEntity(rt, { kind: 'org', slug: 'c', fields: [] });
    await mergeEntities(rt, { fromSlug: 'a', intoSlug: 'b', kind: 'org' });
    await mergeEntities(rt, { fromSlug: 'b', intoSlug: 'c', kind: 'org' });
    // C currently resolves to C. Merging C into A would make A->B->C->A — a cycle,
    // because A already resolves to C. canonical_id(A) == C, so into=A resolves to C == from=C.
    await assert.rejects(
      mergeEntities(rt, { fromSlug: 'c', intoSlug: 'a', kind: 'org' }),
      /cycle/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('cycle guard: reparenting an intermediate node closes a cycle and is rejected', opts, async () => {
  // Regression (Codex ROS-140 2nd-pass, block): the guard must reject when `from`
  // sits ANYWHERE on into's canonical chain, not only when it is the terminal root.
  // Repro: f->x, then i->f (chain i->f->x), then merge f->i. canonical_id(i) == x
  // (not f), so a terminal-only guard lets it through — but f's latest row flips to
  // f->i, closing the cycle f<->i. The map is no longer a forest.
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'org', slug: 'f', fields: [] });
    await saveEntity(rt, { kind: 'org', slug: 'x', fields: [] });
    await saveEntity(rt, { kind: 'org', slug: 'i', fields: [] });
    await mergeEntities(rt, { fromSlug: 'f', intoSlug: 'x', kind: 'org' });
    await mergeEntities(rt, { fromSlug: 'i', intoSlug: 'f', kind: 'org' });
    await assert.rejects(
      mergeEntities(rt, { fromSlug: 'f', intoSlug: 'i', kind: 'org' }),
      /cycle/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('concurrent reciprocal merges cannot both commit (guard+insert serialized)', opts, async () => {
  // Regression (Codex ROS-140 2nd-pass, block): the cycle guard must be atomic with
  // the insert. Two connections race merge(a->b) and merge(b->a); a global advisory
  // lock serializes them, so the second sees the first's committed row and is
  // rejected. Exactly one commits; the map stays a forest (single canonical root).
  const { fresh, password, teardown } = await provision();
  const rtA = await runtimeClient(fresh.url, password, fresh.role);
  const rtB = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rtA, { kind: 'org', slug: 'a', fields: [] });
    await saveEntity(rtA, { kind: 'org', slug: 'b', fields: [] });

    const results = await Promise.allSettled([
      mergeEntities(rtA, { fromSlug: 'a', intoSlug: 'b', kind: 'org' }),
      mergeEntities(rtB, { fromSlug: 'b', intoSlug: 'a', kind: 'org' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one merge commits');
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1, 'the other is rejected');

    const canon = async (slug: string) =>
      (await rtA.query<{ id: string }>(
        `SELECT brain.canonical_id((SELECT id FROM brain.entities WHERE kind='org' AND slug=$1)) AS id`,
        [slug],
      )).rows[0]!.id;
    assert.equal(await canon('a'), await canon('b'), 'a and b share one canonical root — no cycle');
  } finally {
    await rtA.end();
    await rtB.end();
    await teardown();
  }
});

test('self-merge is rejected', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    await saveEntity(rt, { kind: 'org', slug: 'a', fields: [] });
    await assert.rejects(
      mergeEntities(rt, { fromSlug: 'a', intoSlug: 'a', kind: 'org' }),
      /itself/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

test('merge broker rejects cross-kind ids called directly by the runtime role', opts, async () => {
  // ROS-146: brain.merge_entities is the runtime-callable SECURITY DEFINER
  // boundary; a direct call with raw ids must not forge a cross-kind canonical
  // chain even though the TS wrapper resolves both slugs with one kind.
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const org = await saveEntity(rt, { kind: 'org', slug: 'acme', fields: [] });
    const person = await saveEntity(rt, { kind: 'person', slug: 'acme', fields: [] });
    await assert.rejects(
      rt.query(`SELECT brain.merge_entities($1, $2, NULL)`, [org.entityId, person.entityId]),
      /different kinds/i,
    );
  } finally {
    await rt.end();
    await teardown();
  }
});

// ---------- runtime grants (append-only invariant) ----------

test('runtime role merges only via the broker: SELECT yes, raw INSERT/UPDATE/DELETE no', opts, async () => {
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const a = await saveEntity(rt, { kind: 'org', slug: 'a', fields: [] });
    const b = await saveEntity(rt, { kind: 'org', slug: 'b', fields: [] });
    await mergeEntities(rt, { fromSlug: 'a', intoSlug: 'b', kind: 'org' });

    // ROS-146: the broker (brain.merge_entities) is the only write path. The
    // runtime role can no longer raw-INSERT entity_merges/entity_aliases, so the
    // cycle guard + canonical cache cannot be bypassed.
    await assert.rejects(
      rt.query(`INSERT INTO brain.entity_merges (from_id, into_id) VALUES ($1, $2)`, [a.entityId, b.entityId]),
      /permission denied/i,
    );
    await assert.rejects(
      rt.query(`INSERT INTO brain.entity_aliases (entity_id, alias) VALUES ($1, 'x')`, [b.entityId]),
      /permission denied/i,
    );
    await assert.rejects(rt.query(`UPDATE brain.entity_merges SET into_id = into_id`), /permission denied/i);
    await assert.rejects(rt.query(`DELETE FROM brain.entity_merges`), /permission denied/i);
    await assert.rejects(rt.query(`UPDATE brain.entity_aliases SET alias = 'x'`), /permission denied/i);
    await assert.rejects(rt.query(`DELETE FROM brain.entity_aliases`), /permission denied/i);

    const m = await rt.query(`SELECT count(*)::int AS c FROM brain.entity_merges`);
    assert.ok(m.rows[0]!.c >= 1, 'runtime can SELECT entity_merges');
  } finally {
    await rt.end();
    await teardown();
  }
});

test('the C->A cycle-guard case where into resolves to from is the real loop closure', opts, async () => {
  // sanity: ensure canonical chain is what we think before the guard fires
  const { fresh, password, teardown } = await provision();
  const rt = await runtimeClient(fresh.url, password, fresh.role);
  try {
    const a = await saveEntity(rt, { kind: 'org', slug: 'a', fields: [] });
    const c = await saveEntity(rt, { kind: 'org', slug: 'c', fields: [] });
    await saveEntity(rt, { kind: 'org', slug: 'b', fields: [] });
    await mergeEntities(rt, { fromSlug: 'a', intoSlug: 'b', kind: 'org' });
    await mergeEntities(rt, { fromSlug: 'b', intoSlug: 'c', kind: 'org' });
    const canonA = (await rt.query<{ id: string }>(`SELECT brain.canonical_id($1) AS id`, [a.entityId])).rows[0]!.id;
    assert.equal(canonA, c.entityId);
  } finally {
    await rt.end();
    await teardown();
  }
});
