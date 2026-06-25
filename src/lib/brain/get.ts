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
  const e = await client.query<{ id: string; kind: string; slug: string; title: string | null }>(
    `SELECT id, kind, slug, title FROM brain.entities WHERE kind = $1 AND slug = $2`,
    [kind, slug],
  );
  if (e.rowCount === 0) {
    return { entity: null, facts: [], events: [], edges: [] };
  }
  const entity = e.rows[0]!;

  const facts = await client.query<CurrentFact>(
    `SELECT key, value, source, confidence, actor, recorded_at
       FROM brain.current_facts WHERE entity_id = $1 ORDER BY key`,
    [entity.id],
  );

  const events = await client.query<TimelineEvent>(
    `SELECT id, kind, payload, actor, recorded_at
       FROM brain.events WHERE entity_id = $1 ORDER BY id DESC LIMIT $2`,
    [entity.id, limit],
  );

  const edges = await client.query<TimelineEdge>(
    `SELECT e.id, e.rel,
            CASE WHEN e.src_id = $1 THEN 'out' ELSE 'in' END AS direction,
            other.slug AS other_slug, other.kind AS other_kind,
            e.props, e.actor, e.recorded_at
       FROM brain.edges e
       JOIN brain.entities other
         ON other.id = CASE WHEN e.src_id = $1 THEN e.dst_id ELSE e.src_id END
      WHERE e.src_id = $1 OR e.dst_id = $1
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
