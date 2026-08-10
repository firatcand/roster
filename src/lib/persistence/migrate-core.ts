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

function sqlCodeOnly(sql: string): string {
  const chars = [...sql];
  const masked = [...chars];
  const hide = (start: number, end: number) => {
    for (let index = start; index < end; index++) {
      if (masked[index] !== '\n' && masked[index] !== '\r') masked[index] = ' ';
    }
  };
  let index = 0;
  while (index < chars.length) {
    if (chars[index] === '-' && chars[index + 1] === '-') {
      const start = index;
      index += 2;
      while (index < chars.length && chars[index] !== '\n') index++;
      hide(start, index);
      continue;
    }
    if (chars[index] === '/' && chars[index + 1] === '*') {
      const start = index;
      let depth = 1;
      index += 2;
      while (index < chars.length && depth > 0) {
        if (chars[index] === '/' && chars[index + 1] === '*') {
          depth++;
          index += 2;
        } else if (chars[index] === '*' && chars[index + 1] === '/') {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      hide(start, index);
      continue;
    }
    if (chars[index] === "'" || chars[index] === '"') {
      const quote = chars[index]!;
      const start = index++;
      while (index < chars.length) {
        if (quote === "'" && chars[index] === '\\') {
          index += 2;
          continue;
        }
        if (chars[index] !== quote) {
          index++;
          continue;
        }
        if (chars[index + 1] === quote) {
          index += 2;
          continue;
        }
        index++;
        break;
      }
      hide(start, index);
      continue;
    }
    if (chars[index] === '$' && !/[A-Za-z0-9_$]/u.test(chars[index - 1] ?? '')) {
      const rest = chars.slice(index).join('');
      const tag = rest.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0];
      if (tag !== undefined) {
        const start = index;
        index += [...tag].length;
        const tail = chars.slice(index).join('');
        const close = tail.indexOf(tag);
        index = close === -1 ? chars.length : index + [...tail.slice(0, close + tag.length)].length;
        hide(start, index);
        continue;
      }
    }
    index++;
  }
  return masked.join('');
}

function assertTransactionSafeMigration(filename: string, sql: string): void {
  const code = sqlCodeOnly(sql);
  if (/\b(?:CREATE|DROP)\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/iu.test(code)) {
    throw new Error(`migration ${filename} contains non-transactional concurrent index DDL`);
  }
  if (/(?:^|;)\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE(?:\s+SAVEPOINT)?|PREPARE\s+TRANSACTION)\b/iu.test(code)) {
    throw new Error(`migration ${filename} contains transaction-control SQL`);
  }
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
    assertTransactionSafeMigration(filename, sql);
    files.push({ prefix, filename, sql, sha256: sha256(sql) });
  }
  files.sort((a, b) => a.prefix - b.prefix);
  return files;
}

type RecordedMigration = { filename: string; sha256: string };

async function recordedMigrations(
  client: pg.PoolClient,
  target: MigrationTarget,
): Promise<RecordedMigration[]> {
  const exists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
    [target.schema, target.table],
  );
  if (exists.rowCount === 0) return [];
  const rows = await client.query<{ filename: string; sha256: string }>(
    `SELECT filename, sha256 FROM ${target.schema}.${target.table} ORDER BY filename ASC`,
  );
  return rows.rows;
}

function validateRecordedMigrations(
  files: readonly MigrationFile[],
  recorded: readonly RecordedMigration[],
): void {
  if (recorded.length > files.length) {
    throw new Error('migration ledger is not an exact ordered prefix of the loaded migration set');
  }
  const recordedByFilename = new Map(recorded.map((entry) => [entry.filename, entry]));
  for (let index = 0; index < recorded.length; index++) {
    const expected = files[index];
    if (expected === undefined) {
      throw new Error('migration ledger is not an exact ordered prefix of the loaded migration set');
    }
    const actual = recordedByFilename.get(expected.filename);
    if (actual === undefined) {
      throw new Error('migration ledger is not an exact ordered prefix of the loaded migration set');
    }
    if (actual.sha256 !== expected.sha256) {
      throw new Error(
        `migration ${actual.filename} sha256 mismatch: recorded ${actual.sha256}, found ${expected.sha256} (edited migration?)`,
      );
    }
  }
}

export async function runMigrationsOnClient(
  client: pg.PoolClient,
  dir: string,
  target: MigrationTarget,
): Promise<MigrationResult> {
  validateTarget(target);
  const files = loadMigrations(dir);
  const recorded = await recordedMigrations(client, target);
  validateRecordedMigrations(files, recorded);
  const applied: string[] = [];
  const skipped: string[] = [];

  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    if (index < recorded.length) {
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
  return { applied, skipped };
}

export async function runMigrations(
  pool: pg.Pool,
  dir: string,
  target: MigrationTarget,
): Promise<MigrationResult> {
  validateTarget(target);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [target.advisoryLockKey]);

    const result = await runMigrationsOnClient(client, dir, target);

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Only `connect()` is needed, so a verified/diagnostic authority pool satisfies
// this without handing out a raw pg.Pool.
export type MigrationConnectable = {
  connect(): Promise<pg.PoolClient>;
};

export async function pendingMigrations(
  pool: MigrationConnectable,
  dir: string,
  target: MigrationTarget,
): Promise<string[]> {
  validateTarget(target);
  const files = loadMigrations(dir);
  const client = await pool.connect();
  try {
    const recorded = await recordedMigrations(client, target);
    validateRecordedMigrations(files, recorded);
    return files.slice(recorded.length).map((file) => file.filename);
  } finally {
    client.release();
  }
}
