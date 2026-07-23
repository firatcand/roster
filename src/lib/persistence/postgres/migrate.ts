import { join } from 'node:path';
import type pg from 'pg';
import { ROSTER_ROOT } from '../../paths.ts';
import {
  runMigrations,
  pendingMigrations,
  type MigrationResult,
  type MigrationTarget,
} from '../migrate-core.ts';

// Two independently-versioned schemas (section E), each with its own
// migrations ledger and advisory lock (distinct from brain's 8135135).

export const HITL_MIGRATION_TARGET: MigrationTarget = {
  schema: 'hitl',
  table: 'schema_migrations',
  advisoryLockKey: 8135318,
};

export const ROSTER_OPS_MIGRATION_TARGET: MigrationTarget = {
  schema: 'roster_ops',
  table: 'schema_migrations',
  advisoryLockKey: 8135319,
};

export function opsSchemaDir(schema: 'hitl' | 'roster_ops'): string {
  return join(ROSTER_ROOT, 'data', 'ops', 'schema', schema);
}

export type OpsMigrationResult = {
  hitl: MigrationResult;
  roster_ops: MigrationResult;
};

export async function runOpsMigrations(
  pool: pg.Pool,
  dirs: { hitl?: string; roster_ops?: string } = {},
): Promise<OpsMigrationResult> {
  const hitl = await runMigrations(pool, dirs.hitl ?? opsSchemaDir('hitl'), HITL_MIGRATION_TARGET);
  const rosterOps = await runMigrations(
    pool,
    dirs.roster_ops ?? opsSchemaDir('roster_ops'),
    ROSTER_OPS_MIGRATION_TARGET,
  );
  return { hitl, roster_ops: rosterOps };
}

export async function pendingOpsMigrations(
  pool: pg.Pool,
  dirs: { hitl?: string; roster_ops?: string } = {},
): Promise<{ hitl: string[]; roster_ops: string[] }> {
  return {
    hitl: await pendingMigrations(pool, dirs.hitl ?? opsSchemaDir('hitl'), HITL_MIGRATION_TARGET),
    roster_ops: await pendingMigrations(
      pool,
      dirs.roster_ops ?? opsSchemaDir('roster_ops'),
      ROSTER_OPS_MIGRATION_TARGET,
    ),
  };
}
