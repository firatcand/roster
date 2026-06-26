import type pg from 'pg';

export type MergeInput = {
  fromSlug: string;
  intoSlug: string;
  kind?: string;
  actor?: string;
};

export type MergeResult = {
  fromId: string;
  intoId: string;
  canonicalId: string;
  mergeId: string;
  aliasesAdded: number;
};

async function resolveBySlug(
  client: pg.PoolClient | pg.Client,
  slug: string,
  kind?: string,
): Promise<{ id: string; slug: string; title: string | null }> {
  const params: unknown[] = [slug];
  let where = `slug = $1`;
  if (kind !== undefined) {
    where += ` AND kind = $2`;
    params.push(kind);
  }
  const r = await client.query<{ id: string; slug: string; title: string | null }>(
    `SELECT id, slug, title FROM brain.entities WHERE ${where}`,
    params,
  );
  if (r.rowCount === 0) throw new Error(`entity '${slug}' not found`);
  if ((r.rowCount ?? 0) > 1) throw new Error(`slug '${slug}' is ambiguous; pass a kind`);
  return r.rows[0]!;
}

async function canonicalId(client: pg.PoolClient | pg.Client, id: string): Promise<string> {
  const r = await client.query<{ canonical_id: string }>(
    `SELECT brain.canonical_id($1) AS canonical_id`,
    [id],
  );
  return r.rows[0]!.canonical_id;
}

// Serialize every merge under one global transaction-scoped advisory lock so the
// cycle-guard read and the merge insert are atomic w.r.t. other merges. Sibling of
// migrate's ADVISORY_LOCK_KEY (8135135); distinct value avoids cross-purpose waits.
const MERGE_LOCK_KEY = 8135140;

export async function mergeEntities(
  client: pg.PoolClient | pg.Client,
  input: MergeInput,
): Promise<MergeResult> {
  await client.query('BEGIN');
  try {
    // Without this lock two concurrent cycle-closing merges (A->B and B->A) can
    // each pass the guard before either commits, landing a cycle. The lock holds
    // for the whole txn and auto-releases at COMMIT/ROLLBACK; callable by the
    // runtime role (same as mount/migrate).
    await client.query('SELECT pg_advisory_xact_lock($1)', [MERGE_LOCK_KEY]);

    const from = await resolveBySlug(client, input.fromSlug, input.kind);
    const into = await resolveBySlug(client, input.intoSlug, input.kind);

    if (from.id === into.id) {
      throw new Error(`cannot merge '${input.fromSlug}' into itself`);
    }

    // Cycle guard: recording from->into makes `from`'s latest-row successor `into`.
    // That closes a loop iff `from` already lies anywhere on into's canonical chain
    // (not only at its terminal root — a previously-merged `from` can be reparented
    // into its own descendant). Walk into's latest-row chain and reject if it reaches
    // `from`. canonical_id is cycle-safe at read time, but we reject the write so the
    // map stays a forest. The depth cap mirrors canonical_id's and bounds the walk.
    const reach = await client.query<{ reaches: boolean }>(
      `WITH RECURSIVE chain AS (
         SELECT $1::bigint AS node, 0 AS depth
         UNION ALL
         SELECT m.into_id, c.depth + 1
           FROM chain c
           JOIN LATERAL (
             SELECT into_id FROM brain.entity_merges
              WHERE from_id = c.node ORDER BY id DESC LIMIT 1
           ) m ON true
          WHERE c.depth < 10000
       )
       SELECT bool_or(node = $2) AS reaches FROM chain`,
      [into.id, from.id],
    );
    if (reach.rows[0]?.reaches) {
      throw new Error(
        `merge '${input.fromSlug}' -> '${input.intoSlug}' would create a cycle`,
      );
    }

    const merge = await client.query<{ id: string }>(
      `INSERT INTO brain.entity_merges (from_id, into_id, actor) VALUES ($1, $2, $3) RETURNING id`,
      [from.id, into.id, input.actor ?? null],
    );

    let aliasesAdded = 0;
    const aliasValues = [from.slug, from.title].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    for (const alias of aliasValues) {
      await client.query(
        `INSERT INTO brain.entity_aliases (entity_id, alias, source, actor) VALUES ($1, $2, $3, $4)`,
        [into.id, alias, 'merge', input.actor ?? null],
      );
      aliasesAdded++;
    }

    const canonicalForFrom = await canonicalId(client, from.id);
    await client.query('COMMIT');
    return {
      fromId: from.id,
      intoId: into.id,
      canonicalId: canonicalForFrom,
      mergeId: merge.rows[0]!.id,
      aliasesAdded,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
