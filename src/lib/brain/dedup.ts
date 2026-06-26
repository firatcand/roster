import type pg from 'pg';

export type CreateSafety = 'exists' | 'probable' | 'unknown';

export type Candidate = {
  id: string;
  kind: string;
  slug: string;
  title: string | null;
  similarity: number;
  via: 'slug' | 'title' | 'alias';
};

export type DedupResult = {
  create_safety: CreateSafety;
  candidates: Candidate[];
};

export const EXISTS_THRESHOLD = 0.8;
export const PROBABLE_THRESHOLD = 0.4;

const MAX_CANDIDATES = 10;

export async function findCandidates(
  client: pg.PoolClient | pg.Client,
  kind: string,
  slug: string,
  title?: string,
  excludeId?: string,
): Promise<DedupResult> {
  const probe = title && title.length > 0 ? title : slug;
  const exclude = excludeId ?? null;

  const r = await client.query<{
    id: string;
    kind: string;
    slug: string;
    title: string | null;
    similarity: string;
    via: 'slug' | 'title' | 'alias';
    exact: boolean;
  }>(
    `WITH ranked AS (
       SELECT e.id, e.kind, e.slug, e.title,
              GREATEST(
                similarity(e.slug, $2),
                similarity(coalesce(e.title, ''), $3)
              ) AS similarity,
              CASE WHEN similarity(e.slug, $2) >= similarity(coalesce(e.title, ''), $3)
                   THEN 'slug' ELSE 'title' END AS via,
              (lower(e.slug) = lower($2)
               OR (e.kind = $1 AND e.slug = $2)
               OR lower(coalesce(e.title, '')) = lower($3)) AS exact
         FROM brain.entities e
        WHERE e.kind = $1 AND ($6::bigint IS NULL OR e.id <> $6)
       UNION ALL
       SELECT a.entity_id AS id, e.kind, e.slug, e.title,
              GREATEST(similarity(a.alias, $2), similarity(a.alias, $3)) AS similarity,
              'alias' AS via,
              (lower(a.alias) = lower($2) OR lower(a.alias) = lower($3)) AS exact
         FROM brain.entity_aliases a
         JOIN brain.entities e ON e.id = a.entity_id
        WHERE e.kind = $1 AND ($6::bigint IS NULL OR e.id <> $6)
     ),
     best AS (
       SELECT DISTINCT ON (id) id, kind, slug, title, similarity, via, exact
         FROM ranked
        ORDER BY id, exact DESC, similarity DESC
     )
     SELECT id, kind, slug, title, similarity::text AS similarity, via, exact
       FROM best
      WHERE exact OR similarity >= $4
      ORDER BY exact DESC, similarity DESC
      LIMIT $5`,
    [kind, slug, probe, PROBABLE_THRESHOLD, MAX_CANDIDATES, exclude],
  );

  const candidates: Candidate[] = r.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    slug: row.slug,
    title: row.title,
    similarity: Number(row.similarity),
    via: row.via,
  }));

  let create_safety: CreateSafety = 'unknown';
  const exact = r.rows.some((row) => row.exact);
  const top = candidates[0]?.similarity ?? 0;
  if (exact || top >= EXISTS_THRESHOLD) {
    create_safety = 'exists';
  } else if (top >= PROBABLE_THRESHOLD) {
    create_safety = 'probable';
  }

  return { create_safety, candidates };
}
