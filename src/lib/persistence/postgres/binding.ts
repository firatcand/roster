import pg from 'pg';
import {
  ConflictError,
  InvalidRecordError,
  NotConfiguredError,
  WorkspaceMismatchError,
} from '../contracts.ts';
import { isUuidV4 } from '../config-schema.ts';

// Strict 1:1 workspace↔database binding (#318 section E, owner decision 5).
// Setup stamps both schemas' meta rows `pending` in ONE transaction — together
// with the canonical object-store tuple (section F), so two same-UUID setups
// with different bucket tuples arbitrate at the DB before any bucket is
// claimed. Every new physical connection then verifies the finalized stamp
// before its first query. Nothing here ever unclaims: roll-forward only.

export const OPS_SCHEMAS = ['hitl', 'roster_ops'] as const;
export type OpsSchema = (typeof OPS_SCHEMAS)[number];

export type PgQueryable = {
  query: (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
};

export type CanonicalObjectTuple = {
  bucket: string;
  region: string | null;
  endpoint: string | null;
  forcePathStyle: boolean;
  // sha256 of the deterministic marker body {workspaceId, name} — computable
  // BEFORE the bucket claim, which is what lets the tuple live in the initial
  // pending transaction. A changed workspace name changes the sha and is a
  // tuple mismatch by design (exact-equality resume).
  markerSha256: string;
};

export type BindingRecord = {
  workspaceId: string | null;
  workspaceName: string | null;
  state: 'pending' | 'finalized' | null;
  tuple: (CanonicalObjectTuple & { markerEtag: string | null }) | null;
};

function isMissingRelation(err: unknown): boolean {
  return (err as { code?: string }).code === '42P01';
}

function rowToRecord(schema: OpsSchema, row: Record<string, unknown> | undefined): BindingRecord {
  if (row === undefined) {
    throw new InvalidRecordError(`${schema}.meta has no singleton row — the schema migration is incomplete`);
  }
  const workspaceId = (row.workspace_id as string | null) ?? null;
  const bucket = (row.bucket as string | null) ?? null;
  if (bucket !== null && typeof row.force_path_style !== 'boolean') {
    // NULL here is corrupt metadata, never coerced to false — the tuple was
    // stamped in one transaction and force_path_style is NOT NULL by protocol.
    throw new InvalidRecordError(
      `${schema}.meta has an object tuple with force_path_style ${row.force_path_style === null ? 'NULL' : `'${String(row.force_path_style)}'`} — the binding row is corrupt; this database was modified out-of-band`,
    );
  }
  return {
    workspaceId,
    workspaceName: (row.workspace_name as string | null) ?? null,
    state: (row.state as 'pending' | 'finalized' | null) ?? null,
    tuple:
      bucket === null
        ? null
        : {
            bucket,
            region: (row.region as string | null) ?? null,
            endpoint: (row.endpoint as string | null) ?? null,
            forcePathStyle: row.force_path_style as boolean,
            markerSha256: (row.marker_sha256 as string | null) ?? '',
            markerEtag: (row.marker_etag as string | null) ?? null,
          },
  };
}

async function readBindingRow(q: PgQueryable, schema: OpsSchema, forUpdate: boolean): Promise<BindingRecord> {
  try {
    const res = await q.query(
      `SELECT workspace_id::text AS workspace_id, workspace_name, state,
              bucket, region, endpoint, force_path_style, marker_sha256, marker_etag
         FROM ${schema}.meta WHERE singleton${forUpdate ? ' FOR UPDATE' : ''}`,
    );
    return rowToRecord(schema, res.rows[0] as Record<string, unknown> | undefined);
  } catch (err) {
    if (isMissingRelation(err)) {
      throw new NotConfiguredError(
        `${schema}.meta does not exist — the ops schemas are not migrated on this database (run 'roster ops setup')`,
      );
    }
    throw err;
  }
}

function describeRecord(rec: BindingRecord): string {
  const tuple =
    rec.tuple === null
      ? 'tuple=(none)'
      : `bucket=${rec.tuple.bucket} region=${rec.tuple.region ?? '-'} endpoint=${rec.tuple.endpoint ?? '-'} force_path_style=${rec.tuple.forcePathStyle} marker_sha256=${rec.tuple.markerSha256} marker_etag=${rec.tuple.markerEtag ?? '-'}`;
  return `workspace=${rec.workspaceId ?? '-'} name=${rec.workspaceName ?? '-'} state=${rec.state ?? '-'} ${tuple}`;
}

// The two meta rows are always written in one transaction, so ANY field
// diverging — identity, state, or the full object tuple — means the trust
// root was modified out-of-band. Fail hard naming both rows.
function assertNoDivergence(a: BindingRecord, b: BindingRecord): void {
  const tuplesDiverge =
    (a.tuple === null) !== (b.tuple === null) ||
    (a.tuple !== null &&
      b.tuple !== null &&
      (!tupleEquals(a.tuple, b.tuple) || a.tuple.markerEtag !== b.tuple.markerEtag));
  if (
    a.workspaceId !== b.workspaceId ||
    a.workspaceName !== b.workspaceName ||
    a.state !== b.state ||
    tuplesDiverge
  ) {
    throw new InvalidRecordError(
      `hitl.meta and roster_ops.meta binding rows diverge — both are always written in one transaction; this database was modified out-of-band\n  hitl:       ${describeRecord(a)}\n  roster_ops: ${describeRecord(b)}`,
    );
  }
}

function tupleEquals(a: CanonicalObjectTuple, b: CanonicalObjectTuple): boolean {
  return (
    a.bucket === b.bucket &&
    a.region === b.region &&
    a.endpoint === b.endpoint &&
    a.forcePathStyle === b.forcePathStyle &&
    a.markerSha256 === b.markerSha256
  );
}

function describeTuple(t: CanonicalObjectTuple): string {
  return `bucket=${t.bucket} region=${t.region ?? '-'} endpoint=${t.endpoint ?? '-'} force_path_style=${t.forcePathStyle} marker_sha256=${t.markerSha256}`;
}

function belongsToError(rec: BindingRecord): WorkspaceMismatchError {
  return new WorkspaceMismatchError(
    `this database belongs to workspace ${rec.workspaceName ?? '(unnamed)'} (${rec.workspaceId})`,
  );
}

function stalePendingError(rec: BindingRecord): WorkspaceMismatchError {
  return new WorkspaceMismatchError(
    `a setup for workspace ${rec.workspaceName ?? '(unnamed)'} (${rec.workspaceId}) is stamped 'pending' on this database — finish that workspace's setup, or have an admin clear the stale stamp manually; roster never auto-unclaims a database (strict 1:1 binding)`,
  );
}

export type StampInput = {
  workspaceId: string;
  workspaceName: string;
  objects: CanonicalObjectTuple;
};

export type StampResult = { resumed: boolean; state: 'pending' | 'finalized' };

async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// One transaction, both schemas, tuple included. Refusal rules (section E/F):
// different UUID finalized → belongs-to; different UUID pending → stale-setup
// remedy; same UUID with a different canonical tuple → refuse BEFORE any
// bucket claim; same UUID with the exact tuple → resumable.
export async function stampPending(pool: pg.Pool, input: StampInput): Promise<StampResult> {
  if (!isUuidV4(input.workspaceId)) {
    throw new InvalidRecordError(`workspace id must be a UUID v4 (got '${input.workspaceId}')`);
  }
  return await withTransaction(pool, async (client) => {
    const hitl = await readBindingRow(client, 'hitl', true);
    const rosterOps = await readBindingRow(client, 'roster_ops', true);
    assertNoDivergence(hitl, rosterOps);
    if (hitl.workspaceId !== null) {
      if (hitl.workspaceId !== input.workspaceId) {
        throw hitl.state === 'finalized' ? belongsToError(hitl) : stalePendingError(hitl);
      }
      if (hitl.tuple === null || !tupleEquals(hitl.tuple, input.objects)) {
        throw new ConflictError(
          input.workspaceId,
          `canonical object-store tuple mismatch — this database is stamped with [${hitl.tuple ? describeTuple(hitl.tuple) : 'no tuple'}], setup was given [${describeTuple(input.objects)}]; refusing before any bucket claim (one canonical tuple per workspace)`,
        );
      }
      return { resumed: true, state: hitl.state! };
    }
    for (const schema of OPS_SCHEMAS) {
      await client.query(
        `UPDATE ${schema}.meta
            SET workspace_id = $1::uuid, workspace_name = $2, state = 'pending', bound_at = now(),
                bucket = $3, region = $4, endpoint = $5, force_path_style = $6,
                marker_sha256 = $7, marker_etag = NULL
          WHERE singleton`,
        [
          input.workspaceId,
          input.workspaceName,
          input.objects.bucket,
          input.objects.region,
          input.objects.endpoint,
          input.objects.forcePathStyle,
          input.objects.markerSha256,
        ],
      );
    }
    return { resumed: false, state: 'pending' };
  });
}

// Post-bucket-claim: record the advisory etag (etags are not content digests
// for multipart, so the sha256 stamped at pending time stays the trust root).
export async function recordMarkerEtag(
  pool: pg.Pool,
  input: { workspaceId: string; markerEtag: string | null },
): Promise<void> {
  await withTransaction(pool, async (client) => {
    const hitl = await readBindingRow(client, 'hitl', true);
    const rosterOps = await readBindingRow(client, 'roster_ops', true);
    assertNoDivergence(hitl, rosterOps);
    if (hitl.workspaceId !== input.workspaceId) {
      throw hitl.workspaceId === null
        ? new WorkspaceMismatchError('this database is not stamped — run roster ops setup')
        : belongsToError(hitl);
    }
    for (const schema of OPS_SCHEMAS) {
      await client.query(`UPDATE ${schema}.meta SET marker_etag = $1 WHERE singleton`, [input.markerEtag]);
    }
  });
}

export type FinalizeResult = { alreadyFinalized: boolean };

export async function finalizeBinding(pool: pg.Pool, input: { workspaceId: string }): Promise<FinalizeResult> {
  return await withTransaction(pool, async (client) => {
    const hitl = await readBindingRow(client, 'hitl', true);
    const rosterOps = await readBindingRow(client, 'roster_ops', true);
    assertNoDivergence(hitl, rosterOps);
    if (hitl.workspaceId === null) {
      throw new WorkspaceMismatchError('this database is not stamped — run roster ops setup');
    }
    if (hitl.workspaceId !== input.workspaceId) {
      throw belongsToError(hitl);
    }
    if (hitl.state === 'finalized') return { alreadyFinalized: true };
    for (const schema of OPS_SCHEMAS) {
      await client.query(`UPDATE ${schema}.meta SET state = 'finalized' WHERE singleton`);
    }
    return { alreadyFinalized: false };
  });
}

// Fail-closed per-connection verification: mismatch, unbound, or non-finalized
// state all refuse with WorkspaceMismatchError. Returns the binding so callers
// (marker verification, doctor) can read the canonical tuple in the same trip.
export async function verifyBinding(q: PgQueryable, workspaceId: string): Promise<BindingRecord> {
  const hitl = await readBindingRow(q, 'hitl', false);
  const rosterOps = await readBindingRow(q, 'roster_ops', false);
  assertNoDivergence(hitl, rosterOps);
  if (hitl.workspaceId === null) {
    throw new WorkspaceMismatchError(
      'this database is not bound to any workspace — run roster ops setup before using it',
    );
  }
  if (hitl.workspaceId !== workspaceId) {
    throw belongsToError(hitl);
  }
  if (hitl.state !== 'finalized') {
    throw new WorkspaceMismatchError(
      `workspace binding is '${hitl.state}' — setup is incomplete; re-run roster ops setup`,
    );
  }
  return hitl;
}

// pg-pool grew PoolConfig.onConnect together with the internal _promiseTry
// helper that awaits it; probing for the helper is the reliable feature test.
export function poolSupportsOnConnect(): boolean {
  return typeof (pg.Pool.prototype as { _promiseTry?: unknown })._promiseTry === 'function';
}

export type VerifyFn = (client: pg.ClientBase, workspaceId: string) => Promise<void>;

export type BoundPoolOptions = {
  connectionString: string;
  workspaceId: string;
  max?: number;
  // Test seams: verify override (call counting / ordering proofs) and forcing
  // the checkout-wrapper path even where PoolConfig.onConnect is available.
  verify?: VerifyFn;
  forceCheckoutGating?: boolean;
};

// Every new physical client is verified before its first caller-visible query.
// Where pg supports PoolConfig.onConnect the pool itself gates (the client is
// not handed to ANY waiter before the hook resolves); the checkout wrapper is
// kept in both modes as the version-independent guarantee — a client is never
// returned from connect() unverified. Verification is cached per client
// OBJECT (WeakSet), never per process.
export class BoundPool {
  readonly workspaceId: string;
  private readonly pool: pg.Pool;
  private readonly verify: VerifyFn;
  private readonly verified = new WeakSet<object>();

  constructor(opts: BoundPoolOptions) {
    if (!isUuidV4(opts.workspaceId)) {
      throw new InvalidRecordError(`workspace id must be a UUID v4 (got '${opts.workspaceId}')`);
    }
    this.workspaceId = opts.workspaceId;
    this.verify = opts.verify ?? (async (client, ws) => void (await verifyBinding(client, ws)));
    const config: pg.PoolConfig & { onConnect?: (client: pg.PoolClient) => Promise<void> } = {
      connectionString: opts.connectionString,
      max: opts.max ?? 4,
    };
    if (poolSupportsOnConnect() && opts.forceCheckoutGating !== true) {
      config.onConnect = async (client) => {
        await this.verify(client, this.workspaceId);
        this.verified.add(client);
      };
    }
    this.pool = new pg.Pool(config);
  }

  async connect(): Promise<pg.PoolClient> {
    const client = await this.pool.connect();
    if (!this.verified.has(client)) {
      try {
        await this.verify(client, this.workspaceId);
      } catch (err) {
        client.release(err as Error);
        throw err;
      }
      this.verified.add(client);
    }
    return client;
  }

  async query(text: string, values?: unknown[]): Promise<pg.QueryResult> {
    const client = await this.connect();
    try {
      return await client.query(text, values);
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

const STAMPED_TABLES = [
  'hitl.requests',
  'hitl.decisions',
  'roster_ops.run_events',
  'roster_ops.artifacts',
  'roster_ops.delivery_ledger',
] as const;

export type RowStampViolation = { table: string; foreignRows: number };
export type RowStampReport = { ok: boolean; violations: RowStampViolation[] };

// Doctor-style belt-and-braces invariant: every data row carries the stamped
// workspace_id (rows are workspace-scoped even though isolation is physical).
export async function auditRowStamps(q: PgQueryable, workspaceId: string): Promise<RowStampReport> {
  const violations: RowStampViolation[] = [];
  for (const table of STAMPED_TABLES) {
    const res = await q.query(
      `SELECT count(*)::int AS foreign_rows FROM ${table} WHERE workspace_id <> $1::uuid`,
      [workspaceId],
    );
    const foreignRows = (res.rows[0] as { foreign_rows: number }).foreign_rows;
    if (foreignRows > 0) violations.push({ table, foreignRows });
  }
  return { ok: violations.length === 0, violations };
}
