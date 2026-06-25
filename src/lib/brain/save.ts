import type pg from 'pg';

export type FactInput = {
  key: string;
  value: unknown;
};

export type SaveInput = {
  kind: string;
  slug: string;
  title?: string;
  fields: FactInput[];
  source?: string;
  confidence?: number;
  actor?: string;
};

export type SaveResult = {
  entityId: string;
  created: boolean;
  factIds: string[];
};

export async function resolveOrCreateEntity(
  client: pg.PoolClient | pg.Client,
  kind: string,
  slug: string,
  title?: string,
): Promise<{ id: string; created: boolean }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO brain.entities (kind, slug, title) VALUES ($1, $2, $3)
       ON CONFLICT (kind, slug) DO NOTHING
       RETURNING id`,
    [kind, slug, title ?? null],
  );
  if (inserted.rowCount && inserted.rowCount > 0) {
    return { id: inserted.rows[0]!.id, created: true };
  }
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM brain.entities WHERE kind = $1 AND slug = $2`,
    [kind, slug],
  );
  if (existing.rowCount === 0) {
    throw new Error(`entity ${kind}/${slug} not found after upsert`);
  }
  return { id: existing.rows[0]!.id, created: false };
}

export async function saveEntity(
  client: pg.PoolClient | pg.Client,
  input: SaveInput,
): Promise<SaveResult> {
  const { id, created } = await resolveOrCreateEntity(client, input.kind, input.slug, input.title);
  const factIds: string[] = [];
  for (const field of input.fields) {
    const r = await client.query<{ id: string }>(
      `INSERT INTO brain.facts (entity_id, key, value, source, confidence, actor)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6)
         RETURNING id`,
      [
        id,
        field.key,
        JSON.stringify(field.value ?? null),
        input.source ?? null,
        input.confidence ?? null,
        input.actor ?? null,
      ],
    );
    factIds.push(r.rows[0]!.id);
  }
  return { entityId: id, created, factIds };
}
