import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type pg from 'pg';
import { EXIT_ERROR, RosterError } from '../errors.ts';
import { runMigrations } from './migrate.ts';
import { bundledMigrationSet } from './export.ts';
import {
  assertCast,
  assertIdent,
  type BackupManifest,
  BROKER_TYPES,
  type Cell,
  checksumRows,
  CORE_TABLES,
  IMPORT_ADVISORY_LOCK_KEY,
  listAllBrainTables,
  orderTables,
  qualTable,
  quoteIdent,
  type Row,
  snapshotTable,
  type TableManifestEntry,
} from './backup-shared.ts';

export type ImportResult = {
  format: 'jsonl' | 'sql';
  tables: { name: string; rowCount: number }[];
  totalRows: number;
};

function readManifest(dir: string): BackupManifest {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} not a brain backup`,
      body: `  No manifest.json found in ${dir}`,
      remedy: '  Point at a directory produced by `roster brain export`.',
      exitCode: EXIT_ERROR,
    });
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8')) as BackupManifest;
  } catch {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} corrupt backup manifest`,
      body: `  ${path} is not valid JSON.`,
      remedy: '  Re-export the brain, or restore an earlier backup.',
      exitCode: EXIT_ERROR,
    });
  }
  if (manifest.format_version !== 1) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} unsupported backup format version`,
      body: `  manifest.format_version is ${manifest.format_version}; this roster supports 1.`,
      remedy: '  Use a roster version matching the backup.',
      exitCode: EXIT_ERROR,
    });
  }
  return manifest;
}

function assertSchemaMatch(dumpSet: { filename: string; sha256: string }[]): void {
  const norm = (arr: { filename: string; sha256: string }[]): string[] =>
    arr.map((m) => `${m.filename}:${m.sha256}`).sort();
  const dump = norm(dumpSet);
  const bundled = norm(bundledMigrationSet());
  const matches = dump.length === bundled.length && dump.every((x, i) => x === bundled[i]);
  if (!matches) {
    const dumpFiles = dumpSet.map((m) => m.filename).join(', ') || '(none)';
    const bundledFiles = bundledMigrationSet()
      .map((m) => m.filename)
      .join(', ');
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} brain schema version mismatch`,
      body: [
        '  The backup was taken at a different brain schema version than this CLI ships.',
        `  backup migrations:  ${dumpFiles}`,
        `  this CLI migrations: ${bundledFiles}`,
      ].join('\n'),
      remedy: '  Install the roster version whose brain schema matches the backup, then re-run import.',
      exitCode: EXIT_ERROR,
    });
  }
}

// Structurally validate an untrusted manifest BEFORE any value is interpolated
// into SQL. Every identifier and cast that reaches a dynamic query for the JSONL
// path is checked here against an allowlist, closing the cast/identifier
// injection surface a hostile or corrupt backup could otherwise exploit.
function validateManifest(manifest: BackupManifest): void {
  const reject = (msg: string): RosterError =>
    new RosterError({
      header: `${chalk.red.bold('roster:')} invalid backup manifest`,
      body: `  ${msg}`,
      remedy: '  Re-export the brain, or restore a known-good backup.',
      exitCode: EXIT_ERROR,
    });
  const safe = (fn: () => void, msg: string): void => {
    try {
      fn();
    } catch {
      throw reject(msg);
    }
  };

  if (manifest.format !== 'jsonl' && manifest.format !== 'sql') {
    throw reject(`unknown format ${JSON.stringify(manifest.format)}`);
  }
  if (!Array.isArray(manifest.tables)) throw reject('tables is not an array');
  if (!Array.isArray(manifest.schema_migrations)) throw reject('schema_migrations is not an array');

  const seen = new Set<string>();
  for (const t of manifest.tables) {
    safe(() => assertIdent(t.name), `invalid table name ${JSON.stringify(t?.name)}`);
    if (seen.has(t.name)) throw reject(`duplicate table ${t.name}`);
    seen.add(t.name);
    if (typeof t.core !== 'boolean') throw reject(`table ${t.name}: core must be boolean`);
    if (!Array.isArray(t.columns) || t.columns.length < 2) {
      throw reject(`table ${t.name}: columns missing id/recorded_at`);
    }
    if (t.columns[0]!.name !== 'id' || t.columns[1]!.name !== 'recorded_at') {
      throw reject(`table ${t.name}: columns must begin with id, recorded_at`);
    }
    for (const c of t.columns) {
      safe(() => assertIdent(c.name), `table ${t.name}: invalid column ${JSON.stringify(c?.name)}`);
      safe(() => assertCast(c.cast), `table ${t.name}.${c.name}: unsupported cast ${JSON.stringify(c?.cast)}`);
    }
    if (t.create_columns !== undefined && !Array.isArray(t.create_columns)) {
      throw reject(`table ${t.name}: create_columns is not an array`);
    }
    for (const c of t.create_columns ?? []) {
      safe(() => assertIdent(c.name), `table ${t.name}: invalid create column`);
      if (!BROKER_TYPES.has(c.type)) {
        throw reject(`table ${t.name}.${c.name}: create type ${JSON.stringify(c.type)} not allowed`);
      }
    }
    if (!Number.isInteger(t.row_count) || t.row_count < 0) throw reject(`table ${t.name}: bad row_count`);
    if (typeof t.checksum !== 'string') throw reject(`table ${t.name}: bad checksum`);
  }
}

// Write barrier for the import transaction. Two layers:
//   1. The import advisory lock (IMPORT_ADVISORY_LOCK_KEY), taken by the caller,
//      is ALSO taken as the first statement of brain.create_table() (migration
//      006). That fully serializes concurrent broker DDL against import — no
//      agent can materialize a new brain table during the restore (closes the
//      create-a-new-table TOCTOU before any CREATE TABLE runs).
//   2. ACCESS EXCLUSIVE on every existing brain.* table here blocks concurrent
//      row writes (save/event/link/mount) for the empty-check→load window. Taken
//      in deterministic (load) order to avoid deadlocking with a concurrent op.
// Import still assumes restore into an idle/fresh brain (the documented
// contract); verify() additionally rejects any unexpected table.
async function lockForImport(client: pg.PoolClient): Promise<void> {
  const names = await listAllBrainTables(client);
  const ordered = orderTables(names.map((n) => ({ name: n, core: CORE_TABLES.has(n) })));
  for (const t of ordered) {
    await client.query(`LOCK TABLE ${qualTable(t.name)} IN ACCESS EXCLUSIVE MODE`);
  }
}

async function assertEmptyTarget(client: pg.PoolClient): Promise<void> {
  for (const name of await listAllBrainTables(client)) {
    const r = await client.query(`SELECT 1 FROM ${qualTable(name)} LIMIT 1`);
    if ((r.rowCount ?? 0) > 0) {
      throw new RosterError({
        header: `${chalk.red.bold('roster:')} target brain is not empty`,
        body: `  brain.${name} already contains rows; import preserves ids and would collide.`,
        remedy: '  Import only into a fresh brain (no data rows). Provision one with `roster brain init`.',
        exitCode: EXIT_ERROR,
      });
    }
  }
}

async function recreateAgentTables(client: pg.PoolClient, tables: TableManifestEntry[]): Promise<void> {
  for (const t of tables) {
    if (t.core) continue;
    await client.query(`SELECT brain.create_table($1, $2::jsonb)`, [t.name, JSON.stringify(t.create_columns)]);
  }
}

async function loadRows(client: pg.PoolClient, table: TableManifestEntry, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = table.columns;
  const colList = cols.map((c) => quoteIdent(c.name)).join(', ');
  const batch = Math.max(1, Math.floor(60000 / cols.length));
  for (let start = 0; start < rows.length; start += batch) {
    const slice = rows.slice(start, start + batch);
    const params: Cell[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const row of slice) {
      const placeholders = row.map((_, i) => `$${p++}::${cols[i]!.cast}`);
      tuples.push(`(${placeholders.join(', ')})`);
      for (const cell of row) params.push(cell);
    }
    await client.query(
      `INSERT INTO ${qualTable(table.name)} (${colList}) OVERRIDING SYSTEM VALUE VALUES ${tuples.join(', ')}`,
      params,
    );
  }
}

async function resetSequence(client: pg.PoolClient, name: string, hasRows: boolean): Promise<void> {
  const seq = `pg_get_serial_sequence('${qualTable(name)}', 'id')`;
  if (hasRows) {
    await client.query(`SELECT setval(${seq}, (SELECT max(id) FROM ${qualTable(name)}), true)`);
  } else {
    await client.query(`SELECT setval(${seq}, 1, false)`);
  }
}

// Reads + structurally validates a table's data file. Export writes one .jsonl
// per manifest table (empty file for zero-row tables), so a missing file is a
// corrupt/incomplete backup, not an empty table. Every row must be an array of
// the table's column arity with string|null cells.
function parseJsonl(dir: string, entry: TableManifestEntry): Row[] {
  const path = join(dir, `${entry.name}.jsonl`);
  if (!existsSync(path)) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} incomplete backup`,
      body: `  Missing data file ${entry.name}.jsonl for a table the manifest declares.`,
      remedy: '  Re-export the brain, or restore a complete backup.',
      exitCode: EXIT_ERROR,
    });
  }
  const width = entry.columns.length;
  const bad = (detail: string): RosterError =>
    new RosterError({
      header: `${chalk.red.bold('roster:')} corrupt backup data`,
      body: `  ${entry.name}.jsonl: ${detail}`,
      remedy: '  Re-export the brain, or restore a known-good backup.',
      exitCode: EXIT_ERROR,
    });
  const text = readFileSync(path, 'utf8');
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw bad('invalid JSON line');
    }
    if (!Array.isArray(row) || row.length !== width) {
      throw bad(`row width ${Array.isArray(row) ? row.length : '?'} != ${width} columns`);
    }
    for (const cell of row) {
      if (cell !== null && typeof cell !== 'string') throw bad('cell is not string|null');
    }
    rows.push(row as Row);
  }
  return rows;
}

function verifyFail(detail: string): RosterError {
  return new RosterError({
    header: `${chalk.red.bold('roster:')} import verification failed`,
    body: `  ${detail}`,
    remedy: '  The backup may be corrupt, or another session wrote during the restore. Retry into a fresh brain.',
    exitCode: EXIT_ERROR,
  });
}

async function verify(client: pg.PoolClient, manifest: BackupManifest): Promise<void> {
  // Exact table-set parity — no table missing, none unexpectedly present (the
  // latter catches a table a concurrent writer slipped in past the lock).
  const live = new Set(await listAllBrainTables(client));
  const expected = new Set(manifest.tables.map((t) => t.name));
  for (const name of expected) {
    if (!live.has(name)) throw verifyFail(`brain.${name}: missing after restore`);
  }
  for (const name of live) {
    if (!expected.has(name)) throw verifyFail(`brain.${name}: unexpected table present after restore`);
  }
  for (const entry of manifest.tables) {
    const { columns, rows } = await snapshotTable(client, entry.name);
    // Column-layout parity catches a wrong-schema table that row counts alone miss.
    const liveCols = columns.map((c) => `${c.name}:${c.cast}`).join(',');
    const expCols = entry.columns.map((c) => `${c.name}:${c.cast}`).join(',');
    if (liveCols !== expCols) {
      throw verifyFail(`brain.${entry.name}: column layout mismatch after restore`);
    }
    if (rows.length !== entry.row_count) {
      throw verifyFail(`brain.${entry.name}: expected ${entry.row_count} row(s), found ${rows.length}`);
    }
    if (checksumRows(rows) !== entry.checksum) {
      throw verifyFail(`brain.${entry.name}: content checksum mismatch after restore`);
    }
  }
}

export async function importBrain(pool: pg.Pool, dir: string): Promise<ImportResult> {
  const manifest = readManifest(dir);
  validateManifest(manifest);
  // Code-vs-dump check next — no DB work if the versions can't match.
  assertSchemaMatch(manifest.schema_migrations);

  // Idempotently build the core schema, functions, views, and brain_meta.
  await runMigrations(pool);

  // Import always restores from the JSONL data files (the canonical form), inside
  // one verified transaction. A `--format sql` backup also carries dump.sql, but
  // import never executes it — opaque SQL can't be safely verified or rolled back;
  // it's restored standalone with `psql --single-transaction -f dump.sql`.
  const ordered = orderTables(manifest.tables);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_ADVISORY_LOCK_KEY]);
      await lockForImport(client);
      await assertEmptyTarget(client);
      await recreateAgentTables(client, ordered);
      for (const entry of ordered) {
        await loadRows(client, entry, parseJsonl(dir, entry));
      }
      for (const entry of ordered) {
        await resetSequence(client, entry.name, entry.row_count > 0);
      }
      await verify(client, manifest);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    client.release();
  }

  return {
    format: manifest.format,
    tables: ordered.map((t) => ({ name: t.name, rowCount: t.row_count })),
    totalRows: ordered.reduce((n, t) => n + t.row_count, 0),
  };
}
