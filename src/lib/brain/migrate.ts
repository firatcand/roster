import { join } from 'node:path';
import type pg from 'pg';
import { ROSTER_ROOT } from '../paths.ts';
import {
  loadMigrations as loadMigrationsFrom,
  pendingMigrations as pendingMigrationsCore,
  runMigrations as runMigrationsCore,
  type MigrationFile,
  type MigrationResult,
  type MigrationTarget,
} from '../persistence/migrate-core.ts';

export type { MigrationFile, MigrationResult };

const BRAIN_TARGET: MigrationTarget = {
  schema: 'brain_meta',
  table: 'schema_migrations',
  advisoryLockKey: 8135135,
};

export function schemaDir(): string {
  return join(ROSTER_ROOT, 'data', 'brain', 'schema');
}

export function loadMigrations(dir: string = schemaDir()): MigrationFile[] {
  return loadMigrationsFrom(dir);
}

export async function runMigrations(
  pool: pg.Pool,
  dir: string = schemaDir(),
): Promise<MigrationResult> {
  return runMigrationsCore(pool, dir, BRAIN_TARGET);
}

export async function pendingMigrations(pool: pg.Pool, dir: string = schemaDir()): Promise<string[]> {
  return pendingMigrationsCore(pool, dir, BRAIN_TARGET);
}
