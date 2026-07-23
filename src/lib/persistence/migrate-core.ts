import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

export type MigrationFile = {
  prefix: number;
  filename: string;
  sql: string;
  sha256: string;
};

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

// Which ledger this runner writes to. schema/table are interpolated into SQL as
// identifiers, so they are validated against a strict allowlist regex first —
// never pass unvalidated input through.
export type MigrationTarget = {
  schema: string;
  table: string;
  advisoryLockKey: number;
};

const PG_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function assertPgIdentifier(label: string, value: string): void {
  if (value.length === 0 || value.length > 63 || !PG_IDENTIFIER.test(value)) {
    throw new Error(
      `invalid ${label} identifier '${value}' (lowercase letters, digits, '_', max 63, no quoting)`,
    );
  }
}

function validateTarget(target: MigrationTarget): void {
  assertPgIdentifier('schema', target.schema);
  assertPgIdentifier('table', target.table);
  if (!Number.isSafeInteger(target.advisoryLockKey)) {
    throw new Error(`invalid advisory lock key '${target.advisoryLockKey}' (must be a safe integer)`);
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function loadMigrations(dir: string): MigrationFile[] {
  const entries = readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  const seen = new Map<number, string>();
  const files: MigrationFile[] = [];
  for (const filename of entries) {
    const prefix = Number.parseInt(filename.split('_', 1)[0]!, 10);
    const prior = seen.get(prefix);
    if (prior !== undefined) {
      throw new Error(
        `duplicate migration prefix ${prefix}: ${prior} and ${filename}`,
      );
    }
    seen.set(prefix, filename);
    const sql = readFileSync(join(dir, filename), 'utf8');
    files.push({ prefix, filename, sql, sha256: sha256(sql) });
  }
  files.sort((a, b) => a.prefix - b.prefix);
  return files;
}

async function recordedMigrations(
  client: pg.PoolClient,
  target: MigrationTarget,
): Promise<Map<string, string>> {
  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [target.schema, target.table],
  );
  if (exists.rowCount === 0) return new Map();
  const rows = await client.query<{ filename: string; sha256: string }>(
    `SELECT filename, sha256 FROM ${target.schema}.${target.table}`,
  );
  return new Map(rows.rows.map((r) => [r.filename, r.sha256]));
}

export async function runMigrations(
  pool: pg.Pool,
  dir: string,
  target: MigrationTarget,
): Promise<MigrationResult> {
  validateTarget(target);
  const files = loadMigrations(dir);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [target.advisoryLockKey]);

    const recorded = await recordedMigrations(client, target);
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const priorSha = recorded.get(file.filename);
      if (priorSha !== undefined) {
        if (priorSha !== file.sha256) {
          throw new Error(
            `migration ${file.filename} sha256 mismatch: recorded ${priorSha}, found ${file.sha256} (edited migration?)`,
          );
        }
        skipped.push(file.filename);
        continue;
      }
      await client.query(file.sql);
      await client.query(
        `INSERT INTO ${target.schema}.${target.table} (filename, sha256) VALUES ($1, $2)`,
        [file.filename, file.sha256],
      );
      applied.push(file.filename);
    }

    await client.query('COMMIT');
    return { applied, skipped };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function pendingMigrations(
  pool: pg.Pool,
  dir: string,
  target: MigrationTarget,
): Promise<string[]> {
  validateTarget(target);
  const files = loadMigrations(dir);
  const client = await pool.connect();
  try {
    const recorded = await recordedMigrations(client, target);
    return files.filter((f) => !recorded.has(f.filename)).map((f) => f.filename);
  } finally {
    client.release();
  }
}
