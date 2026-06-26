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
  const e = await client.query<{ id: string }>(
    `SELECT id FROM brain.entities WHERE kind = $1 AND slug = $2`,
    [kind, slug],
  );
  if (e.rowCount === 0) {
    return { entity: null, facts: [], events: [], edges: [] };
  }
  const queriedId = e.rows[0]!.id;

  const canon = await client.query<{ id: string; kind: string; slug: string; title: string | null }>(
    `SELECT c.id, c.kind, c.slug, c.title
       FROM brain.entities c
      WHERE c.id = brain.canonical_id($1)`,
    [queriedId],
  );
  const entity = canon.rows[0]!;

  const facts = await client.query<CurrentFact>(
    `SELECT key, value, source, confidence, actor, recorded_at
       FROM brain.resolved_current_facts WHERE canonical_id = $1 ORDER BY key`,
    [entity.id],
  );

  const events = await client.query<TimelineEvent>(
    `SELECT ev.id, ev.kind, ev.payload, ev.actor, ev.recorded_at
       FROM brain.events ev
      WHERE brain.canonical_id(ev.entity_id) = $1
      ORDER BY ev.id DESC LIMIT $2`,
    [entity.id, limit],
  );

  const edges = await client.query<TimelineEdge>(
    `SELECT e.id, e.rel,
            CASE WHEN brain.canonical_id(e.src_id) = $1 THEN 'out' ELSE 'in' END AS direction,
            other.slug AS other_slug, other.kind AS other_kind,
            e.props, e.actor, e.recorded_at
       FROM brain.edges e
       JOIN brain.entities other
         ON other.id = brain.canonical_id(
              CASE WHEN brain.canonical_id(e.src_id) = $1 THEN e.dst_id ELSE e.src_id END)
      WHERE (brain.canonical_id(e.src_id) = $1 OR brain.canonical_id(e.dst_id) = $1)
        AND brain.canonical_id(e.src_id) <> brain.canonical_id(e.dst_id)
      ORDER BY e.id DESC LIMIT $2`,
    [entity.id, limit],
  );

  return {
    entity,
    facts: facts.rows,
    events: events.rows,
    edges: edges.rows,
  };
}
