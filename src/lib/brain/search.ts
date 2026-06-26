import type pg from 'pg';
import { type BrainConfig, DEFAULT_CONFIG } from './config.ts';
import { type Embedder, toVectorLiteral } from './embed.ts';

export type DocumentHit = {
  type: 'document';
  id: string;
  source_path: string;
  chunk_index: number;
  snippet: string;
  score: number;
};

export type EntityHit = {
  type: 'entity';
  id: string;
  kind: string;
  slug: string;
  title: string | null;
  via: 'match' | 'graph';
  score: number;
};

export type QueryHit = DocumentHit | EntityHit;

export type QueryOptions = {
  kind?: string;
  limit?: number;
};

const ARM_LIMIT = 50;

function snippet(content: string | null): string {
  const s = (content ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 197) + '…' : s;
}

// Reciprocal-rank fusion: an item's score is the sum over each ranked list of
// 1/(k + rank). Items missing from a list simply don't contribute that term.
function rrf(lists: string[][], k: number): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const key = list[i]!;
      scores.set(key, (scores.get(key) ?? 0) + 1 / (k + i + 1));
    }
  }
  return scores;
}

export async function query(
  client: pg.PoolClient | pg.Client,
  text: string,
  opts: QueryOptions = {},
  embedder: Embedder | null = null,
  config: BrainConfig = DEFAULT_CONFIG,
): Promise<QueryHit[]> {
  const limit = opts.limit ?? 10;
  if (text.trim().length === 0) return [];
  const docs = new Map<string, DocumentHit>();
  const ents = new Map<string, EntityHit>();
  const lists: string[][] = [];

  // --- keyword arm (documents) ---
  const kw = await client.query<{ id: string; source_path: string; chunk_index: number; content: string | null }>(
    `SELECT id::text AS id, source_path, chunk_index, content,
            ts_rank(tsv, plainto_tsquery('english', $1)) AS rank
       FROM brain.current_documents
      WHERE tsv @@ plainto_tsquery('english', $1)
      ORDER BY rank DESC, id DESC
      LIMIT ${ARM_LIMIT}`,
    [text],
  );
  const kwList: string[] = [];
  for (const r of kw.rows) {
    const key = `doc:${r.id}`;
    kwList.push(key);
    if (!docs.has(key)) {
      docs.set(key, { type: 'document', id: r.id, source_path: r.source_path, chunk_index: r.chunk_index, snippet: snippet(r.content), score: 0 });
    }
  }
  lists.push(kwList);

  // --- vector arm (documents) — only when an embedder is active ---
  // Degrade like mount: a provider error drops the vector arm rather than
  // failing the whole query (keyword + graph still answer).
  let queryVec: number[] | null = null;
  if (embedder) {
    try {
      const [vec] = await embedder.embed([text]);
      queryVec = vec ?? null;
    } catch (e) {
      process.stderr.write(`roster brain query: embedding failed (${(e as Error).message}); using keyword+graph only\n`);
    }
  }
  if (embedder && queryVec) {
    const lit = toVectorLiteral(queryVec);
    const vr = await client.query<{ id: string; source_path: string; chunk_index: number; content: string | null }>(
      `SELECT id::text AS id, source_path, chunk_index, content
         FROM brain.current_documents
        WHERE embedding IS NOT NULL AND embedding_model = $2
        ORDER BY embedding <=> $1::vector
        LIMIT ${ARM_LIMIT}`,
      [lit, embedder.model],
    );
    const vList: string[] = [];
    for (const r of vr.rows) {
      const key = `doc:${r.id}`;
      vList.push(key);
      if (!docs.has(key)) {
        docs.set(key, { type: 'document', id: r.id, source_path: r.source_path, chunk_index: r.chunk_index, snippet: snippet(r.content), score: 0 });
      }
    }
    lists.push(vList);
  }

  // --- entity arm (keyword match on name/slug AND current-fact values, optional --kind) ---
  const entityParams: unknown[] = [text];
  let kindClause = '';
  if (opts.kind !== undefined) {
    entityParams.push(opts.kind);
    kindClause = ` AND e.kind = $2`;
  }
  const em = await client.query<{ id: string; kind: string; slug: string; title: string | null }>(
    `SELECT e.id::text AS id, e.kind, e.slug, e.title
       FROM brain.entities e
      WHERE (e.title ILIKE '%' || $1 || '%'
             OR e.slug ILIKE '%' || $1 || '%'
             OR EXISTS (SELECT 1 FROM brain.current_facts cf
                         WHERE cf.entity_id = e.id AND cf.value::text ILIKE '%' || $1 || '%'))${kindClause}
      ORDER BY e.id DESC
      LIMIT ${ARM_LIMIT}`,
    entityParams,
  );
  const emList: string[] = [];
  const seedIds: string[] = [];
  for (const r of em.rows) {
    const key = `entity:${r.id}`;
    emList.push(key);
    seedIds.push(r.id);
    if (!ents.has(key)) {
      ents.set(key, { type: 'entity', id: r.id, kind: r.kind, slug: r.slug, title: r.title, via: 'match', score: 0 });
    }
  }
  lists.push(emList);

  // --- graph arm: 1-hop over edges from the matched entities (honours --kind) ---
  if (config.graphHops >= 1 && seedIds.length > 0) {
    const graphParams: unknown[] = [seedIds];
    let graphKindClause = '';
    if (opts.kind !== undefined) {
      graphParams.push(opts.kind);
      graphKindClause = ` AND e.kind = $2`;
    }
    const gr = await client.query<{ id: string; kind: string; slug: string; title: string | null }>(
      `SELECT DISTINCT e.id::text AS id, e.kind, e.slug, e.title
         FROM brain.edges g
         JOIN brain.entities e
           ON e.id = CASE WHEN g.src_id = ANY($1::bigint[]) THEN g.dst_id ELSE g.src_id END
        WHERE (g.src_id = ANY($1::bigint[]) OR g.dst_id = ANY($1::bigint[]))${graphKindClause}
        LIMIT ${ARM_LIMIT}`,
      graphParams,
    );
    const gList: string[] = [];
    for (const r of gr.rows) {
      const key = `entity:${r.id}`;
      gList.push(key);
      if (!ents.has(key)) {
        ents.set(key, { type: 'entity', id: r.id, kind: r.kind, slug: r.slug, title: r.title, via: 'graph', score: 0 });
      }
    }
    lists.push(gList);
  }

  // --- RRF fusion across all arms ---
  const scores = rrf(lists, config.rrfK);
  const hits: QueryHit[] = [];
  for (const [key, score] of scores) {
    const hit = docs.get(key) ?? ents.get(key);
    if (hit) hits.push({ ...hit, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
