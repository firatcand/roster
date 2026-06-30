import type pg from 'pg';

export type CurrentFact = {
  key: string;
  value: unknown;
  source: string | null;
  confidence: number | null;
  actor: string | null;
  recorded_at: string;
};

export type TimelineEvent = {
  id: string;
  kind: string;
  payload: unknown;
  actor: string | null;
  recorded_at: string;
};

export type TimelineEdge = {
  id: string;
  rel: string;
  direction: 'out' | 'in';
  other_slug: string;
  other_kind: string;
  props: unknown;
  actor: string | null;
  recorded_at: string;
};

export type CompiledTruth = {
  entity: { id: string; kind: string; slug: string; title: string | null } | null;
  facts: CurrentFact[];
  events: TimelineEvent[];
  edges: TimelineEdge[];
};

const DEFAULT_LIMIT = 50;

export async function getEntity(
  client: pg.PoolClient | pg.Client,
  kind: string,
  slug: string,
  limit: number = DEFAULT_LIMIT,
): Promise<CompiledTruth> {
  // Resolve the queried entity to its canonical via the materialized,
  // indexed canonical_id column (migration 008) instead of the STABLE
  // brain.canonical_id() function, which cannot back an index.
  const e = await client.query<{ id: string; canonical_id: string }>(
    `SELECT id, canonical_id FROM brain.entities WHERE kind = $1 AND slug = $2`,
    [kind, slug],
  );
  if (e.rowCount === 0) {
    return { entity: null, facts: [], events: [], edges: [] };
  }
  const canonicalId = e.rows[0]!.canonical_id;

  const canon = await client.query<{ id: string; kind: string; slug: string; title: string | null }>(
    `SELECT id, kind, slug, title FROM brain.entities WHERE id = $1`,
    [canonicalId],
  );
  const entity = canon.rows[0]!;

  const facts = await client.query<CurrentFact>(
    `SELECT DISTINCT ON (f.key)
            f.key, f.value, f.source, f.confidence, f.actor, f.recorded_at
       FROM brain.facts f
       JOIN brain.entities en ON en.id = f.entity_id
      WHERE en.canonical_id = $1
      ORDER BY f.key, f.id DESC`,
    [entity.id],
  );

  const events = await client.query<TimelineEvent>(
    `SELECT ev.id, ev.kind, ev.payload, ev.actor, ev.recorded_at
       FROM brain.events ev
       JOIN brain.entities en ON en.id = ev.entity_id
      WHERE en.canonical_id = $1
      ORDER BY ev.id DESC LIMIT $2`,
    [entity.id, limit],
  );

  // Split the "src or dst resolves to the canonical" filter into a UNION so each
  // arm drives an index (entities.canonical_id -> edges.src_id/dst_id); an OR
  // across the two joins forces a seq scan on large brains. A self-loop edge
  // (both endpoints resolve to the canonical) appears in both arms but its other
  // endpoint also resolves to $1, so the `oe.canonical_id <> $1` guard drops it.
  const edges = await client.query<TimelineEdge>(
    `WITH hits AS (
       SELECT e.id, e.rel, 'out'::text AS direction, e.dst_id AS other_id,
              e.props, e.actor, e.recorded_at
         FROM brain.edges e
         JOIN brain.entities se ON se.id = e.src_id
        WHERE se.canonical_id = $1
       UNION ALL
       SELECT e.id, e.rel, 'in'::text AS direction, e.src_id AS other_id,
              e.props, e.actor, e.recorded_at
         FROM brain.edges e
         JOIN brain.entities de ON de.id = e.dst_id
        WHERE de.canonical_id = $1
     )
     SELECT h.id, h.rel, h.direction,
            other.slug AS other_slug, other.kind AS other_kind,
            h.props, h.actor, h.recorded_at
       FROM hits h
       JOIN brain.entities oe ON oe.id = h.other_id
       JOIN brain.entities other ON other.id = oe.canonical_id
      WHERE oe.canonical_id <> $1
      ORDER BY h.id DESC LIMIT $2`,
    [entity.id, limit],
  );

  return {
    entity,
    facts: facts.rows,
    events: events.rows,
    edges: edges.rows,
  };
}
