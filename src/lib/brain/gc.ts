import type pg from 'pg';

// Session-scoped advisory lock so two concurrent gc runs can't interleave
// batches and early-exit each other's drain loop. Distinct from migrate.ts's
// 8135135 key.
const GC_ADVISORY_LOCK_KEY = 8135136;

export const DEFAULT_RETENTION = '730d';
const BATCH_SIZE = 5000;

// GC prunes superseded VERSIONS, never history and never anything current:
// facts (older rows per (entity_id, key)) and document chunks (rows of
// non-latest with-chunks mounts per source_path). Edges are deliberately
// excluded — `brain get` renders raw edge rows as the entity timeline, so
// superseded edge versions are user-visible history (ROS-153 design pass).
// Events, merge-map, entities, and mounts rows are never touched.
export const GC_TABLES = ['facts', 'documents'] as const;
export type GcTable = (typeof GC_TABLES)[number];

export type GcCounts = Record<GcTable, number>;

export type GcReport = {
  mode: 'preview' | 'delete';
  retention: string;
  eligible: GcCounts;
  deleted: GcCounts;
};

// A row is eligible only when BOTH it and its IMMEDIATE replacement (next
// version by id / next with-chunks mount by id) are older than the retention
// window. The replacement-age arm gives the recoverability guarantee (a
// 3-year-old fact replaced yesterday survives); the own-age arm makes
// eligibility stable across runs: a deleted row was necessarily old, so a
// predecessor's anchor condition was already satisfied through it, and a
// recent row can never be deleted, so a recent anchor never disappears —
// re-ranking after deletions (or an interrupted run) can never widen the set
// even under non-monotonic recorded_at (Codex rounds 1-2).
const ELIGIBLE_SQL: Record<GcTable, string> = {
  facts: `
    WITH ranked AS (
      SELECT id, recorded_at,
             LEAD(recorded_at) OVER (PARTITION BY entity_id, key ORDER BY id) AS superseded_at
        FROM brain.facts
    )
    SELECT id FROM ranked
     WHERE superseded_at IS NOT NULL
       AND superseded_at < now() - $1::interval
       AND recorded_at < now() - $1::interval`,
  // Documents need a third arm: mounts.recorded_at and documents.recorded_at
  // are independent (imports, manual SQL), and the stability induction anchors
  // on with-chunks MOUNTS — a mount only stops bearing chunks when all its
  // chunks are deleted, so requiring the row's OWN mount to be old guarantees
  // a recent anchor mount can never disappear between runs (Codex round-3).
  documents: `
    SELECT d.id
      FROM brain.documents d
      JOIN brain.mounts mo ON mo.id = d.mount_id
      JOIN LATERAL (
        SELECT m.recorded_at AS superseded_at
          FROM brain.mounts m
         WHERE m.source_path = d.source_path
           AND m.id > d.mount_id
           AND EXISTS (SELECT 1 FROM brain.documents dm WHERE dm.mount_id = m.id)
         ORDER BY m.id
         LIMIT 1
      ) s ON true
     WHERE s.superseded_at < now() - $1::interval
       AND d.recorded_at < now() - $1::interval
       AND mo.recorded_at < now() - $1::interval`,
};

const DURATION_RE = /^(\d+)(d|mo|y)$/;

export function parseRetention(raw: string): string {
  const m = DURATION_RE.exec(raw.trim());
  if (m === null) {
    throw new Error(`invalid retention '${raw}' — use <N>d, <N>mo, or <N>y (e.g. 730d, 18mo, 2y)`);
  }
  const n = Number(m[1]);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new Error(`invalid retention '${raw}' — must be a whole number of at least 1`);
  }
  const unit = m[2] === 'd' ? 'days' : m[2] === 'mo' ? 'months' : 'years';
  return `${n} ${unit}`;
}

export async function resolveRetention(
  client: pg.PoolClient | pg.Client,
  flag?: string,
): Promise<{ raw: string; interval: string }> {
  if (flag !== undefined) return { raw: flag, interval: parseRetention(flag) };
  const r = await client.query<{ value: unknown }>(
    `SELECT value FROM brain_meta.config WHERE key = 'gc.retention'`,
  );
  const configured = r.rows[0]?.value;
  if (typeof configured === 'string') {
    return { raw: configured, interval: parseRetention(configured) };
  }
  return { raw: DEFAULT_RETENTION, interval: parseRetention(DEFAULT_RETENTION) };
}

export type GcPreflight = { ok: true } | { ok: false; reason: 'runtime-url' | 'missing-schema' | 'missing-delete'; detail: string };

export async function preflightGc(client: pg.PoolClient | pg.Client): Promise<GcPreflight> {
  const schema = await client.query<{ t: string | null }>(
    `SELECT to_regclass('brain.facts')::text AS t`,
  );
  if (!schema.rows[0]?.t) {
    return { ok: false, reason: 'missing-schema', detail: 'brain schema not found — run roster brain init first' };
  }
  // A registered runtime role cannot read brain_meta.runtime_roles at all —
  // a permission failure on this lookup IS the runtime-URL signal.
  let isRuntime = false;
  try {
    const r = await client.query(
      `SELECT 1 FROM brain_meta.runtime_roles WHERE rolname = current_user`,
    );
    isRuntime = (r.rowCount ?? 0) > 0;
  } catch {
    isRuntime = true;
  }
  if (isRuntime) {
    return { ok: false, reason: 'runtime-url', detail: 'connected as the append-only runtime role' };
  }
  // Require DELETE on EVERY target table before touching data — per-batch
  // commits must not let a partially privileged role delete facts and then
  // fail on documents.
  const missing = await client.query<{ tbl: string }>(
    `SELECT tbl FROM unnest($1::text[]) AS tbl
      WHERE NOT has_table_privilege(current_user, 'brain.' || tbl, 'DELETE')`,
    [GC_TABLES as unknown as string[]],
  );
  if ((missing.rowCount ?? 0) > 0) {
    return {
      ok: false,
      reason: 'missing-delete',
      detail: `role lacks DELETE on brain.${missing.rows.map((r) => r.tbl).join(', brain.')}`,
    };
  }
  return { ok: true };
}

export async function countEligible(
  client: pg.PoolClient | pg.Client,
  interval: string,
): Promise<GcCounts> {
  const counts = { facts: 0, documents: 0 } as GcCounts;
  for (const table of GC_TABLES) {
    const r = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM (${ELIGIBLE_SQL[table]}) q`,
      [interval],
    );
    counts[table] = Number(r.rows[0]?.n ?? 0);
  }
  return counts;
}

export type RunGcOptions = {
  interval: string;
  batchSize?: number;
  onProgress?: (table: GcTable, deleted: number) => void;
};

// One client for the whole run: the advisory lock is session-scoped, and each
// batched DELETE autocommits — an interrupted run is resumable and a re-run
// is a no-op once nothing else qualifies.
export async function runGc(pool: pg.Pool, opts: RunGcOptions): Promise<GcCounts> {
  const batch = opts.batchSize ?? BATCH_SIZE;
  const client = await pool.connect();
  try {
    const lock = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS ok`,
      [GC_ADVISORY_LOCK_KEY],
    );
    if (lock.rows[0]?.ok !== true) {
      throw new Error('another brain gc run holds the lock — retry once it finishes');
    }
    try {
      const deleted = { facts: 0, documents: 0 } as GcCounts;
      for (const table of GC_TABLES) {
        // Snapshot eligibility ONCE per run and delete only that frozen id-set.
        // Recomputing between batches can re-attribute supersession to an OLDER
        // row once an intermediate eligible version is deleted — under
        // non-monotonic recorded_at (imports, manual SQL) that widens the
        // delete set beyond the "replacement older than retention" contract.
        const snapshot = await client.query<{ id: string }>(ELIGIBLE_SQL[table], [opts.interval]);
        const ids = snapshot.rows.map((r) => r.id);
        for (let i = 0; i < ids.length; i += batch) {
          const slice = ids.slice(i, i + batch);
          const r = await client.query(
            `DELETE FROM brain.${table} WHERE id = ANY($1::bigint[])`,
            [slice],
          );
          deleted[table] += r.rowCount ?? 0;
          opts.onProgress?.(table, deleted[table]);
        }
      }
      return deleted;
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [GC_ADVISORY_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
