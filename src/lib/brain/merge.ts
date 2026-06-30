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

// The advisory lock, cycle guard, append-only merge/alias inserts, and the
// canonical-cache refresh all live in the admin-owned SECURITY DEFINER function
// brain.merge_entities (migration 008), so a merge cannot be bypassed by a raw
// entity_merges INSERT (the runtime role no longer holds that grant). This
// wrapper only resolves slugs and shapes the result / cycle message.
export async function mergeEntities(
  client: pg.PoolClient | pg.Client,
  input: MergeInput,
): Promise<MergeResult> {
  const from = await resolveBySlug(client, input.fromSlug, input.kind);
  const into = await resolveBySlug(client, input.intoSlug, input.kind);

  if (from.id === into.id) {
    throw new Error(`cannot merge '${input.fromSlug}' into itself`);
  }

  let r;
  try {
    r = await client.query<{ merge_id: string; aliases_added: number; canonical_id: string }>(
      `SELECT merge_id, aliases_added, canonical_id FROM brain.merge_entities($1, $2, $3)`,
      [from.id, into.id, input.actor ?? null],
    );
  } catch (err) {
    if (err instanceof Error && /would create a cycle/.test(err.message)) {
      throw new Error(`merge '${input.fromSlug}' -> '${input.intoSlug}' would create a cycle`);
    }
    throw err;
  }

  const row = r.rows[0]!;
  return {
    fromId: from.id,
    intoId: into.id,
    canonicalId: row.canonical_id,
    mergeId: row.merge_id,
    aliasesAdded: Number(row.aliases_added),
  };
}
