import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import type pg from 'pg';
import { EXIT_ERROR, RosterError } from '../errors.ts';
import { loadMigrations } from './migrate.ts';
import {
  BACKUP_FORMAT_VERSION,
  type BackupManifest,
  CORE_TABLES,
  checksumRows,
  listAllBrainTables,
  orderTables,
  qualTable,
  quoteIdent,
  type Row,
  snapshotTable,
  sqlLiteral,
  type TableManifestEntry,
} from './backup-shared.ts';

export type ExportFormat = 'jsonl' | 'sql';

export type ExportOptions = {
  outDir: string;
  format: ExportFormat;
  exportedAt: string;
};

export type ExportResult = {
  outDir: string;
  format: ExportFormat;
  tables: { name: string; rowCount: number }[];
  totalRows: number;
};

type CollectedTable = {
  name: string;
  core: boolean;
  columns: { name: string; cast: string }[];
  createColumns: { name: string; type: string }[];
  rows: Row[];
};

async function collect(client: pg.PoolClient): Promise<{
  schemaMigrations: { filename: string; sha256: string }[];
  tables: CollectedTable[];
}> {
  // Consistent snapshot: parent/child rows from one moment, no concurrent appends.
  await client.query('BEGIN');
  await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  try {
    const mig = await client.query<{ filename: string; sha256: string }>(
      `SELECT filename, sha256 FROM brain_meta.schema_migrations ORDER BY filename`,
    );
    const names = await listAllBrainTables(client);
    const tables: CollectedTable[] = [];
    for (const name of names) {
      const { columns, createColumns, rows } = await snapshotTable(client, name);
      const core = CORE_TABLES.has(name);
      const finalCreate: { name: string; type: string }[] = [];
      if (!core) {
        for (const c of createColumns) {
          if (c.brokerType === null || c.hasModifier) {
            throw new Error(
              `brain.${name}.${c.name}: column type cannot be faithfully recreated by the table ` +
                `broker; agent table '${name}' is not backup-supported`,
            );
          }
          finalCreate.push({ name: c.name, type: c.brokerType });
        }
      }
      tables.push({
        name,
        core,
        columns: columns.map((c) => ({ name: c.name, cast: c.cast })),
        createColumns: finalCreate,
        rows,
      });
    }
    await client.query('COMMIT');
    return { schemaMigrations: mig.rows, tables: orderTables(tables) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

function renderSqlDump(
  manifest: BackupManifest,
  tables: CollectedTable[],
): string {
  const out: string[] = [];
  out.push(`-- roster brain export · format_version ${manifest.format_version} · ${manifest.exported_at}`);
  out.push('-- Restore into a freshly `roster brain init`-ed brain via `roster brain import`,');
  out.push('-- or standalone (atomically) with: psql --single-transaction -f dump.sql');
  // standard_conforming_strings=on (the default) makes backslashes literal, so
  // doubling single quotes is sufficient escaping for the literals below.
  out.push('SET standard_conforming_strings = on;');

  // Recreate agent-created tables through the same broker that made them.
  for (const t of tables) {
    if (t.core) continue;
    const colsJson = JSON.stringify(t.createColumns).replace(/'/g, "''");
    out.push(`SELECT brain.create_table('${t.name}', '${colsJson}'::jsonb);`);
  }

  for (const t of tables) {
    if (t.rows.length === 0) continue;
    const colList = t.columns.map((c) => quoteIdent(c.name)).join(', ');
    out.push(`INSERT INTO ${qualTable(t.name)} (${colList}) OVERRIDING SYSTEM VALUE VALUES`);
    const valueLines = t.rows.map((row) => {
      const lits = row.map((cell, i) => sqlLiteral(cell, t.columns[i]!.cast));
      return `  (${lits.join(', ')})`;
    });
    out.push(valueLines.join(',\n') + ';');
  }

  // Sequence resets so subsequent live inserts don't collide with restored ids.
  for (const t of tables) {
    const seq = `pg_get_serial_sequence('${qualTable(t.name)}', 'id')`;
    if (t.rows.length === 0) {
      out.push(`SELECT setval(${seq}, 1, false);`);
    } else {
      out.push(`SELECT setval(${seq}, (SELECT max(id) FROM ${qualTable(t.name)}), true);`);
    }
  }

  return out.join('\n') + '\n';
}

// Refuse to export a brain whose applied migrations don't match this CLI's
// bundled set: such a backup carries a schema version import (exact-match guard)
// would later reject, i.e. an unrestorable artifact. Fail at export, not restore.
function assertExportSchemaCurrent(sourceSet: { filename: string; sha256: string }[]): void {
  const norm = (arr: { filename: string; sha256: string }[]): string[] =>
    arr.map((m) => `${m.filename}:${m.sha256}`).sort();
  const src = norm(sourceSet);
  const bundled = norm(bundledMigrationSet());
  if (src.length !== bundled.length || src.some((x, i) => x !== bundled[i])) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} brain schema is not current`,
      body: [
        "  The source brain's applied migrations differ from this roster's bundled set.",
        '  Exporting now would produce a backup this roster could not restore.',
      ].join('\n'),
      remedy: '  Run `roster brain init` to apply pending migrations, or export with the matching roster version.',
      exitCode: EXIT_ERROR,
    });
  }
}

export async function exportBrain(pool: pg.Pool, opts: ExportOptions): Promise<ExportResult> {
  const client = await pool.connect();
  let collected;
  try {
    collected = await collect(client);
  } finally {
    client.release();
  }
  assertExportSchemaCurrent(collected.schemaMigrations);

  const entries: TableManifestEntry[] = collected.tables.map((t) => ({
    name: t.name,
    core: t.core,
    columns: t.columns,
    create_columns: t.createColumns,
    row_count: t.rows.length,
    checksum: checksumRows(t.rows),
  }));

  const manifest: BackupManifest = {
    format_version: BACKUP_FORMAT_VERSION,
    exported_at: opts.exportedAt,
    format: opts.format,
    schema_migrations: collected.schemaMigrations,
    tables: entries,
  };

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // JSONL data files are ALWAYS written — they are the canonical, tool-restorable
  // form that `roster brain import` reads (verified, single-transaction).
  for (const t of collected.tables) {
    const body = t.rows.map((r) => JSON.stringify(r)).join('\n');
    writeFileSync(join(opts.outDir, `${t.name}.jsonl`), body.length > 0 ? body + '\n' : '');
  }
  // --format sql ADDITIONALLY emits a standalone, psql-replayable restore script
  // (`psql --single-transaction -f dump.sql`). It is a DBA convenience artifact;
  // import never executes it (executing opaque SQL can't be verified/rolled back).
  if (opts.format === 'sql') {
    writeFileSync(join(opts.outDir, 'dump.sql'), renderSqlDump(manifest, collected.tables));
  }

  return {
    outDir: opts.outDir,
    format: opts.format,
    tables: collected.tables.map((t) => ({ name: t.name, rowCount: t.rows.length })),
    totalRows: collected.tables.reduce((n, t) => n + t.rows.length, 0),
  };
}

// Exposed for the import-time schema guard: the code's bundled migration set.
export function bundledMigrationSet(): { filename: string; sha256: string }[] {
  return loadMigrations().map((m) => ({ filename: m.filename, sha256: m.sha256 }));
}
