import type pg from 'pg';
import { withBrainClient } from './connect.ts';
import { type Embedder, toVectorLiteral } from './embed.ts';

const BATCH = 96;

export type ReindexOptions = { since?: string };
export type ReindexResult = { targeted: number; embedded: number; remaining: number };

// Active chunks (current_documents — respects ROS-137 supersede) with non-empty
// content whose vector is missing or was produced by a different model than the
// one we're embedding with. Empty/whitespace content is excluded: there's nothing
// to embed, and leaving it in the target set would loop forever (it can never
// transition out of "needs embedding").
function targetPredicate(since: string | undefined): { clause: string; params: (s: string) => unknown[] } {
  const sinceClause = since ? ` AND recorded_at >= $2` : '';
  return {
    clause: `(embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
             AND content IS NOT NULL
             AND length(btrim(content, ' ' || chr(9) || chr(10) || chr(13))) > 0${sinceClause}`,
    params: (model: string) => (since ? [model, since] : [model]),
  };
}

export async function countReindexTargets(
  client: pg.PoolClient | pg.Client,
  model: string,
  since?: string,
): Promise<number> {
  const t = targetPredicate(since);
  const r = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM brain.current_documents WHERE ${t.clause}`,
    t.params(model),
  );
  return r.rows[0]!.n;
}

// Backfill embeddings as the ADMIN role: the embedding/embedding_model columns are a
// derived cache of (unchanged) content, so updating them in place touches no facts,
// content, or audit trail — the append-only guarantee for knowledge is intact.
// Commits per batch → resumable: an interrupt keeps finished batches; re-running
// re-derives "still needs embedding" and continues. Idempotent.
export async function reindexBrain(
  pool: pg.Pool,
  embedder: Embedder,
  opts: ReindexOptions = {},
  onProgress?: (embedded: number, targeted: number) => void,
): Promise<ReindexResult> {
  const model = embedder.model;
  const t = targetPredicate(opts.since);

  // Preflight: prove this connection can UPDATE before any paid embedding call, so
  // a misconfigured (runtime-creds) URL fails fast instead of spending then erroring.
  const priv = await withBrainClient(pool, (c) =>
    c.query<{ can: boolean }>(`SELECT has_table_privilege(current_user, 'brain.documents', 'UPDATE') AS can`),
  );
  if (!priv.rows[0]?.can) {
    throw new Error('reindex requires admin privileges (UPDATE on brain.documents); use the admin URL');
  }

  const targeted = await withBrainClient(pool, (c) => countReindexTargets(c, model, opts.since));
  let embedded = 0;

  for (;;) {
    const client = await pool.connect();
    try {
      const batch = await client.query<{ id: string; content: string | null }>(
        `SELECT id::text AS id, content FROM brain.current_documents
          WHERE ${t.clause}
          ORDER BY id
          LIMIT ${BATCH}`,
        t.params(model),
      );
      if (batch.rowCount === 0) break;

      const vecs = await embedder.embed(batch.rows.map((r) => r.content ?? ''));
      await client.query('BEGIN');
      try {
        let updated = 0;
        for (let i = 0; i < batch.rows.length; i++) {
          // Re-check active + stale inside the UPDATE so a row a concurrent mount
          // superseded (or another reindex already embedded) between SELECT and now
          // is skipped — never touch a non-current chunk. Count only real updates.
          const u = await client.query(
            `UPDATE brain.documents d
                SET embedding = $1::vector, embedding_model = $2
              WHERE d.id = $3
                AND (d.embedding IS NULL OR d.embedding_model IS DISTINCT FROM $2)
                AND EXISTS (SELECT 1 FROM brain.current_documents cd WHERE cd.id = d.id)`,
            [toVectorLiteral(vecs[i]!), model, batch.rows[i]!.id],
          );
          updated += u.rowCount ?? 0;
        }
        await client.query('COMMIT');
        embedded += updated;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      onProgress?.(embedded, targeted);
    } finally {
      client.release();
    }
  }

  const remaining = await withBrainClient(pool, (c) => countReindexTargets(c, model, opts.since));
  return { targeted, embedded, remaining };
}
