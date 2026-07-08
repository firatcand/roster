import { createHash } from 'node:crypto';
import type pg from 'pg';

export const BACKUP_FORMAT_VERSION = 1 as const;

// Advisory lock for import — distinct from migrate (8135135) and merge (8135140).
export const IMPORT_ADVISORY_LOCK_KEY = 8135141;

// Core tables in FK-safe load order: parents before children.
// `entities` before facts/events/edges/aliases/merges; `mounts` before documents
// and `files` (both FK mounts). NOTE: this is the authoritative core set — do NOT
// reuse table.ts CORE_TABLES, which omits entity_merges/entity_aliases (they'd be
// misclassified as agent tables and the broker can't recreate their FKs/indexes).
export const CORE_TABLE_ORDER: readonly string[] = [
  'entities',
  'mounts',
  'facts',
  'events',
  'edges',
  'documents',
  'files',
  'entity_aliases',
  'entity_merges',
];

export const CORE_TABLES: ReadonlySet<string> = new Set(CORE_TABLE_ORDER);

export type ColumnMeta = {
  name: string;
  // Postgres cast target used on both read (`col::text`) and write (`$n::<cast>`).
  cast: string;
  // brain.create_table() type key, or null if this type can't be recreated by
  // the broker (only legal for core tables, which are never broker-recreated).
  brokerType: string | null;
};

export type TableMeta = {
  name: string;
  core: boolean;
  // All non-generated columns in attnum order (includes id + recorded_at).
  // These are SELECTed (as ::text) and INSERTed (with OVERRIDING SYSTEM VALUE).
  columns: ColumnMeta[];
  // Columns minus id + recorded_at, mapped to broker type keys — used to
  // recreate agent tables. Empty/ignored for core tables.
  createColumns: { name: string; type: string }[];
  rowCount: number;
  checksum: string;
};

export type BackupManifest = {
  format_version: typeof BACKUP_FORMAT_VERSION;
  exported_at: string;
  format: 'jsonl' | 'sql';
  schema_migrations: { filename: string; sha256: string }[];
  tables: TableManifestEntry[];
};

export type TableManifestEntry = {
  name: string;
  core: boolean;
  columns: { name: string; cast: string }[];
  create_columns: { name: string; type: string }[];
  row_count: number;
  checksum: string;
};

// Each cell is the column's ::text rendering, or null for a SQL NULL. This
// keeps SQL NULL distinct from a JSONB `null` value (which arrives as the
// string "null") and preserves bigint/numeric/timestamptz fidelity that JSON
// number/Date parsing would lose.
export type Cell = string | null;
export type Row = Cell[];

const IMPLICIT_COLUMNS: ReadonlySet<string> = new Set(['id', 'recorded_at']);

// Cast targets we ever emit into `$n::<cast>` / `'..'::<cast>`. Import validates
// every manifest column cast against this set so a hostile/corrupt backup can't
// inject SQL through the cast slot.
export const ALLOWED_CASTS: ReadonlySet<string> = new Set([
  'bigint',
  'integer',
  'text',
  'numeric',
  'boolean',
  'jsonb',
  'uuid',
  'timestamptz',
  'real',
  'double precision',
  'vector',
]);

export function assertCast(cast: string): string {
  if (!ALLOWED_CASTS.has(cast)) {
    throw new Error(`unsupported column cast in backup: ${JSON.stringify(cast)}`);
  }
  return cast;
}

// Type keys the brain.create_table() broker accepts (see 002_roles.sql).
export const BROKER_TYPES: ReadonlySet<string> = new Set([
  'text',
  'int',
  'bigint',
  'numeric',
  'boolean',
  'timestamptz',
  'jsonb',
  'uuid',
]);

// Maps a catalog format_type() string to a (cast target, broker key) pair.
// brokerType null => not creatable via the brain.create_table() broker.
function mapType(formatType: string): { cast: string; brokerType: string | null } | null {
  const base = formatType.replace(/\(.*$/, '').trim();
  switch (base) {
    case 'bigint':
      return { cast: 'bigint', brokerType: 'bigint' };
    case 'integer':
      return { cast: 'integer', brokerType: 'int' };
    case 'text':
      return { cast: 'text', brokerType: 'text' };
    case 'numeric':
      return { cast: 'numeric', brokerType: 'numeric' };
    case 'boolean':
      return { cast: 'boolean', brokerType: 'boolean' };
    case 'jsonb':
      return { cast: 'jsonb', brokerType: 'jsonb' };
    case 'uuid':
      return { cast: 'uuid', brokerType: 'uuid' };
    case 'timestamp with time zone':
      return { cast: 'timestamptz', brokerType: 'timestamptz' };
    // Core-only types (never broker-recreated):
    case 'real':
      return { cast: 'real', brokerType: null };
    case 'double precision':
      return { cast: 'double precision', brokerType: null };
    case 'vector':
      // pgvector embedding column (documents.embedding). `embedding::text` -> '[..]'
      // re-casts via '[..]'::vector; the column's own vector(1536) enforces the dim.
      return { cast: 'vector', brokerType: null };
    default:
      return null;
  }
}

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertIdent(name: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`unsafe brain identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

// Quoted, schema-qualified table reference, e.g. brain."entities".
export function qualTable(name: string): string {
  return `brain."${assertIdent(name)}"`;
}

export function quoteIdent(name: string): string {
  return `"${assertIdent(name)}"`;
}

type RawColumn = { name: string; type: string; generated: string };

export type RawCreateColumn = { name: string; brokerType: string | null; hasModifier: boolean };

export async function describeTable(
  client: pg.PoolClient | pg.Client,
  table: string,
): Promise<{ columns: ColumnMeta[]; createColumns: RawCreateColumn[] }> {
  const r = await client.query<RawColumn>(
    `SELECT a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            a.attgenerated AS generated
       FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = ('brain.' || quote_ident($1))::regclass
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [assertIdent(table)],
  );

  const columns: ColumnMeta[] = [];
  const createColumns: RawCreateColumn[] = [];
  for (const col of r.rows) {
    if (col.generated !== '') continue; // skip generated columns (e.g. documents.tsv)
    const mapped = mapType(col.type);
    if (mapped === null) {
      throw new Error(
        `brain.${table}.${col.name}: column type '${col.type}' is not supported by backup`,
      );
    }
    columns.push({ name: col.name, cast: mapped.cast, brokerType: mapped.brokerType });
    // brokerType may be null (e.g. `real`) — legal for core tables, which are
    // never broker-recreated. The export path rejects null only for agent tables.
    if (!IMPLICIT_COLUMNS.has(col.name)) {
      createColumns.push({
        name: col.name,
        brokerType: mapped.brokerType,
        hasModifier: col.type !== col.type.replace(/\(.*$/, '').trim(),
      });
    }
  }
  return { columns, createColumns };
}

// Reads a table's full contents as text cells in id order, with its column
// metadata. Used by both export (snapshot) and import (verify).
export async function snapshotTable(
  client: pg.PoolClient | pg.Client,
  name: string,
): Promise<{ columns: ColumnMeta[]; createColumns: RawCreateColumn[]; rows: Row[] }> {
  const { columns, createColumns } = await describeTable(client, name);
  const selectList = columns.map((c) => `${quoteIdent(c.name)}::text AS ${quoteIdent(c.name)}`).join(', ');
  const res = await client.query(`SELECT ${selectList} FROM ${qualTable(name)} ORDER BY id`);
  const rows: Row[] = res.rows.map((r) =>
    columns.map((c): Cell => (r[c.name] === null ? null : (r[c.name] as string))),
  );
  return { columns, createColumns, rows };
}

// All non-system brain.* tables (core + agent-created), excluding views.
export async function listAllBrainTables(client: pg.PoolClient | pg.Client): Promise<string[]> {
  const r = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'brain' ORDER BY tablename`,
  );
  return r.rows.map((row) => row.tablename);
}

export function orderTables<T extends { name: string; core: boolean }>(tables: T[]): T[] {
  const rank = (t: T): number => {
    const i = CORE_TABLE_ORDER.indexOf(t.name);
    return i === -1 ? CORE_TABLE_ORDER.length : i;
  };
  return [...tables].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

// Stable content hash over a table's rows (already ordered by id).
export function checksumRows(rows: Row[]): string {
  const h = createHash('md5');
  for (const row of rows) {
    h.update(JSON.stringify(row));
    h.update('\n');
  }
  return h.digest('hex');
}

// SQL literal for a single cell: NULL or '<escaped>'::<cast>.
export function sqlLiteral(cell: Cell, cast: string): string {
  if (cell === null) return 'NULL';
  return `'${cell.replace(/'/g, "''")}'::${cast}`;
}
