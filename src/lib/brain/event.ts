import type pg from 'pg';

export type EventInput = {
  kind: string;
  slug?: string;
  payload?: unknown;
  actor?: string;
};

export type EventResult = {
  eventId: string;
  entityId: string | null;
};

async function resolveEntityId(
  client: pg.PoolClient | pg.Client,
  slug: string,
): Promise<string> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM brain.entities WHERE slug = $1`,
    [slug],
  );
  if (r.rowCount === 0) throw new Error(`entity with slug '${slug}' not found`);
  if ((r.rowCount ?? 0) > 1) throw new Error(`slug '${slug}' is ambiguous across kinds`);
  return r.rows[0]!.id;
}

export async function appendEvent(
  client: pg.PoolClient | pg.Client,
  input: EventInput,
): Promise<EventResult> {
  const entityId = input.slug ? await resolveEntityId(client, input.slug) : null;
  const r = await client.query<{ id: string }>(
    `INSERT INTO brain.events (entity_id, kind, payload, actor)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING id`,
    [entityId, input.kind, JSON.stringify(input.payload ?? null), input.actor ?? null],
  );
  return { eventId: r.rows[0]!.id, entityId };
}
