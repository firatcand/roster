import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { EXIT_ERROR, RosterError } from '../errors.ts';
import {
  fingerprintBrainNamespace,
  type WorkspaceBrainConfig,
} from '../workspace-record.ts';
import { attachPoolIdleErrorHandler } from '../persistence/pool.ts';
import { BRAIN_TARGET, runMigrationsOnClient, schemaDir, type MigrationResult } from './migrate.ts';
import { ensureWorkspaceRuntimeRole, type EnsureWorkspaceRuntimeRoleResult } from './roles.ts';

export type BrainWorkspaceAuthority = {
  workspaceId: string;
  fingerprintFormatVersion: number;
  namespaceFingerprint: string;
};

export type BrainWorkspaceIdentity = {
  workspaceId: string;
  fingerprintFormatVersion: number;
  namespaceFingerprint: string;
  databaseAuthorityId: string;
  initializedAt: string;
  migrationState: 'migrating' | 'ready';
};

export type BrainAuthorityBootstrapResult = {
  outcome: 'initialized' | 'upgraded' | 'current';
  migrations: MigrationResult;
  role: EnsureWorkspaceRuntimeRoleResult;
  databaseAuthorityId: string;
};

type VerifiedBrainPoolOptions = {
  connectionString: string;
  authority: BrainWorkspaceAuthority;
  databaseAuthorityId?: string;
};

type AuthorityQueryable = {
  query: <T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<pg.QueryResult<T>>;
};

function authorityError(
  code:
    | 'BRAIN_IDENTITY_UNINITIALIZED'
    | 'BRAIN_MIGRATION_IN_PROGRESS'
    | 'BRAIN_WORKSPACE_MISMATCH'
    | 'BRAIN_NAMESPACE_MISMATCH'
    | 'BRAIN_DATABASE_AUTHORITY_MISMATCH'
    | 'BRAIN_LEGACY_ADOPTION_REQUIRED'
    | 'BRAIN_AUTHORITY_INVALID',
  body: string,
): RosterError {
  return new RosterError({
    header: 'Brain workspace authority rejected the database',
    body,
    remedy: code === 'BRAIN_LEGACY_ADOPTION_REQUIRED'
      ? 'Preserve the existing Brain and use the reviewed legacy-adoption workflow when it is available.'
      : 'Confirm the tracked workspace Brain configuration and use the database assigned to that workspace.',
    exitCode: EXIT_ERROR,
    code,
  });
}

export function deriveBrainWorkspaceAuthority(
  workspaceId: string,
  config: WorkspaceBrainConfig,
): BrainWorkspaceAuthority {
  const namespace = fingerprintBrainNamespace(config);
  return Object.freeze({
    workspaceId,
    fingerprintFormatVersion: namespace.format_version,
    namespaceFingerprint: namespace.fingerprint,
  });
}

async function hasWorkspaceIdentityRelation(client: AuthorityQueryable): Promise<boolean> {
  const result = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('brain_meta.workspace_identity')::text AS relation`,
  );
  return result.rows[0]?.relation === 'brain_meta.workspace_identity';
}

function decodeIdentity(row: Record<string, unknown> | undefined): BrainWorkspaceIdentity {
  const fingerprintFormatVersion = row?.fingerprint_format_version;
  if (row === undefined
    || typeof row.workspace_id !== 'string'
    || typeof fingerprintFormatVersion !== 'number'
    || !Number.isInteger(fingerprintFormatVersion)
    || typeof row.namespace_fingerprint !== 'string'
    || typeof row.database_authority_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.database_authority_id)
    || typeof row.initialized_at !== 'string'
    || (row.migration_state !== 'migrating' && row.migration_state !== 'ready')) {
    throw authorityError('BRAIN_AUTHORITY_INVALID', 'The protected workspace identity has an invalid shape.');
  }
  return {
    workspaceId: row.workspace_id,
    fingerprintFormatVersion,
    namespaceFingerprint: row.namespace_fingerprint,
    databaseAuthorityId: row.database_authority_id,
    initializedAt: row.initialized_at,
    migrationState: row.migration_state,
  };
}

async function readBrainWorkspaceIdentity(
  client: AuthorityQueryable,
): Promise<BrainWorkspaceIdentity | null> {
  let result: pg.QueryResult<Record<string, unknown>>;
  try {
    result = await client.query<Record<string, unknown>>(
      `SELECT workspace_id, fingerprint_format_version, namespace_fingerprint, database_authority_id, initialized_at::text AS initialized_at, migration_state
         FROM brain_meta.workspace_identity`,
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === '42P01' || (error as { code?: unknown }).code === '3F000') {
      return null;
    }
    throw error;
  }
  if (result.rows.length === 0) return null;
  if (result.rows.length !== 1) {
    throw authorityError('BRAIN_AUTHORITY_INVALID', 'The protected workspace identity is not a singleton.');
  }
  return decodeIdentity(result.rows[0]);
}

export async function verifyBrainWorkspaceAuthority(
  client: AuthorityQueryable,
  authority: BrainWorkspaceAuthority,
  expectedDatabaseAuthorityId?: string,
): Promise<BrainWorkspaceIdentity> {
  const identity = await readBrainWorkspaceIdentity(client);
  if (identity === null) {
    throw authorityError('BRAIN_IDENTITY_UNINITIALIZED', 'This database has no initialized protected workspace identity.');
  }
  if (identity.workspaceId !== authority.workspaceId) {
    throw authorityError('BRAIN_WORKSPACE_MISMATCH', 'The protected database identity belongs to a different workspace.');
  }
  if (identity.fingerprintFormatVersion !== authority.fingerprintFormatVersion
    || identity.namespaceFingerprint !== authority.namespaceFingerprint) {
    throw authorityError('BRAIN_NAMESPACE_MISMATCH', 'The protected database identity has a different S3 namespace fingerprint.');
  }
  if (expectedDatabaseAuthorityId !== undefined
    && identity.databaseAuthorityId !== expectedDatabaseAuthorityId) {
    throw authorityError(
      'BRAIN_DATABASE_AUTHORITY_MISMATCH',
      'The protected database identity is a different database authority instance.',
    );
  }
  if (identity.migrationState !== 'ready') {
    throw authorityError('BRAIN_MIGRATION_IN_PROGRESS', 'The protected database identity is still migrating.');
  }
  return identity;
}

export class VerifiedBrainPool {
  private readonly verified = new WeakSet<object>();
  private readonly pool: pg.Pool;
  private readonly databaseAuthorityId: string | undefined;
  readonly authority: BrainWorkspaceAuthority;

  constructor(pool: pg.Pool, authority: BrainWorkspaceAuthority, databaseAuthorityId?: string) {
    this.pool = pool;
    this.authority = authority;
    this.databaseAuthorityId = databaseAuthorityId;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  async verifyClient(client: pg.ClientBase): Promise<void> {
    if (!this.verified.has(client)) {
      await verifyBrainWorkspaceAuthority(client, this.authority, this.databaseAuthorityId);
      this.verified.add(client);
    }
  }

  async connect(): Promise<pg.PoolClient> {
    const client = await this.pool.connect();
    try {
      await this.verifyClient(client);
      return client;
    } catch (error) {
      client.release(error instanceof Error ? error : new Error('Brain authority verification failed'));
      throw error;
    }
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    const client = await this.connect();
    try {
      return await client.query<T>(text, values);
    } finally {
      client.release();
    }
  }
}

export function createVerifiedBrainPool(options: VerifiedBrainPoolOptions): VerifiedBrainPool {
  const pool = attachPoolIdleErrorHandler(new pg.Pool({
    connectionString: options.connectionString,
    max: 4,
  }));
  return new VerifiedBrainPool(pool, options.authority, options.databaseAuthorityId);
}

export type BrainDiagnosticIdentityState =
  | { state: 'uninitialized' }
  | { state: 'migrating'; identity: BrainWorkspaceIdentity }
  | { state: 'ready'; identity: BrainWorkspaceIdentity };

// Diagnostics get a NARROWER but EARLIER authority than every other verb: they
// may inspect protected metadata before identity is ready, so an uninitialized
// or migrating database is permitted — but diagnosing ANOTHER workspace's
// database never is, at any readiness.
export async function verifyBrainDiagnosticAuthority(
  client: AuthorityQueryable,
  authority: BrainWorkspaceAuthority,
): Promise<BrainDiagnosticIdentityState> {
  const identity = await readBrainWorkspaceIdentity(client);
  if (identity === null) return { state: 'uninitialized' };
  if (identity.workspaceId !== authority.workspaceId) {
    throw authorityError('BRAIN_WORKSPACE_MISMATCH', 'The protected database identity belongs to a different workspace.');
  }
  if (identity.fingerprintFormatVersion !== authority.fingerprintFormatVersion
    || identity.namespaceFingerprint !== authority.namespaceFingerprint) {
    throw authorityError('BRAIN_NAMESPACE_MISMATCH', 'The protected database identity has a different S3 namespace fingerprint.');
  }
  if (identity.migrationState !== 'ready') return { state: 'migrating', identity };
  return { state: 'ready', identity };
}

export class DiagnosticBrainPool {
  private readonly verified = new WeakSet<object>();
  private readonly pool: pg.Pool;
  readonly authority: BrainWorkspaceAuthority;

  constructor(pool: pg.Pool, authority: BrainWorkspaceAuthority) {
    this.pool = pool;
    this.authority = authority;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }

  async connect(): Promise<pg.PoolClient> {
    const client = await this.pool.connect();
    try {
      if (!this.verified.has(client)) {
        await verifyBrainDiagnosticAuthority(client, this.authority);
        this.verified.add(client);
      }
      return client;
    } catch (error) {
      client.release(error instanceof Error ? error : new Error('Brain diagnostic authority verification failed'));
      throw error;
    }
  }

  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<T>> {
    const client = await this.connect();
    try {
      return await client.query<T>(text, values);
    } finally {
      client.release();
    }
  }
}

export function createDiagnosticBrainPool(
  options: { connectionString: string; authority: BrainWorkspaceAuthority },
): DiagnosticBrainPool {
  const pool = attachPoolIdleErrorHandler(new pg.Pool({
    connectionString: options.connectionString,
    max: 4,
  }));
  return new DiagnosticBrainPool(pool, options.authority);
}

export async function isPristineBrainDatabase(client: AuthorityQueryable): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname IN ('brain', 'brain_meta')
       UNION ALL
       SELECT 1
         FROM pg_catalog.pg_extension extension
        WHERE extension.extname NOT IN ('plpgsql', 'pg_trgm', 'vector')
       UNION ALL
       SELECT 1
         FROM pg_catalog.pg_namespace namespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname NOT IN ('public', 'information_schema')
          AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_extension extension
             WHERE extension.extnamespace = namespace.oid
          )
       UNION ALL
       SELECT 1
         FROM pg_catalog.pg_class relation
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_depend dependency
              JOIN pg_catalog.pg_extension extension ON extension.oid = dependency.refobjid
             WHERE dependency.classid = 'pg_class'::regclass
               AND dependency.objid = relation.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e'
          )
       UNION ALL
       SELECT 1
         FROM pg_catalog.pg_type type_row
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = type_row.typnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_depend dependency
              JOIN pg_catalog.pg_extension extension ON extension.oid = dependency.refobjid
             WHERE dependency.classid = 'pg_type'::regclass
               AND dependency.objid = type_row.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e'
          )
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_type element_type
              JOIN pg_catalog.pg_depend dependency
                ON dependency.classid = 'pg_type'::regclass
               AND dependency.objid = element_type.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e'
              JOIN pg_catalog.pg_extension extension
                ON extension.oid = dependency.refobjid
               AND extension.extname IN ('pg_trgm', 'vector')
             WHERE type_row.typelem = element_type.oid
               AND element_type.typarray = type_row.oid
          )
       UNION ALL
       SELECT 1
         FROM pg_catalog.pg_collation collation_row
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = collation_row.collnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_depend dependency
              JOIN pg_catalog.pg_extension extension ON extension.oid = dependency.refobjid
             WHERE dependency.classid = 'pg_collation'::regclass
               AND dependency.objid = collation_row.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e'
          )
       UNION ALL
       SELECT 1
         FROM pg_catalog.pg_operator operator_row
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = operator_row.oprnamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_depend dependency
              JOIN pg_catalog.pg_extension extension ON extension.oid = dependency.refobjid
             WHERE dependency.classid = 'pg_operator'::regclass
               AND dependency.objid = operator_row.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e'
          )
       UNION ALL
       SELECT 1
         FROM pg_catalog.pg_proc routine
         JOIN pg_catalog.pg_namespace namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname !~ '^pg_'
          AND namespace.nspname <> 'information_schema'
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_depend dependency
              JOIN pg_catalog.pg_extension extension ON extension.oid = dependency.refobjid
             WHERE dependency.classid = 'pg_proc'::regclass
               AND dependency.objid = routine.oid
               AND dependency.refclassid = 'pg_extension'::regclass
               AND dependency.deptype = 'e'
          )
     ) AS exists`,
  );
  return result.rows[0]?.exists === false;
}

async function insertMigratingIdentity(
  client: pg.PoolClient,
  authority: BrainWorkspaceAuthority,
  databaseAuthorityId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO brain_meta.workspace_identity (
       singleton, workspace_id, fingerprint_format_version, namespace_fingerprint, database_authority_id, migration_state
     ) VALUES (true, $1, $2, $3, $4, 'migrating')`,
    [
      authority.workspaceId,
      authority.fingerprintFormatVersion,
      authority.namespaceFingerprint,
      databaseAuthorityId,
    ],
  );
  await client.query(
    `UPDATE brain_meta.workspace_identity SET migration_state = 'ready' WHERE singleton`,
  );
}

export async function bootstrapBrainWorkspaceAuthority(
  pool: pg.Pool,
  authority: BrainWorkspaceAuthority,
  options: { runtimePassword: string; migrationsDir?: string; runtimeRole?: string },
): Promise<BrainAuthorityBootstrapResult> {
  const client = await pool.connect();
  let locked = false;
  let committed = false;
  let failure: unknown;
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [BRAIN_TARGET.advisoryLockKey]);
    locked = true;
    await client.query('BEGIN');
    const identityRelationExists = await hasWorkspaceIdentityRelation(client);
    const identity = identityRelationExists ? await readBrainWorkspaceIdentity(client) : null;
    let outcome: BrainAuthorityBootstrapResult['outcome'];
    let migrations: MigrationResult;
    let databaseAuthorityId: string;
    if (identity === null) {
      if (identityRelationExists) {
        throw authorityError('BRAIN_IDENTITY_UNINITIALIZED', 'The protected workspace identity relation has no singleton row.');
      }
      if (!await isPristineBrainDatabase(client)) {
        throw authorityError('BRAIN_LEGACY_ADOPTION_REQUIRED', 'This unidentified database has existing Brain schema state.');
      }
      migrations = await runMigrationsOnClient(client, options.migrationsDir ?? schemaDir());
      databaseAuthorityId = randomUUID();
      await insertMigratingIdentity(client, authority, databaseAuthorityId);
      outcome = 'initialized';
    } else {
      databaseAuthorityId = identity.databaseAuthorityId;
      if (identity.workspaceId !== authority.workspaceId) {
        throw authorityError('BRAIN_WORKSPACE_MISMATCH', 'The protected database identity belongs to a different workspace.');
      }
      if (identity.fingerprintFormatVersion !== authority.fingerprintFormatVersion
        || identity.namespaceFingerprint !== authority.namespaceFingerprint) {
        throw authorityError('BRAIN_NAMESPACE_MISMATCH', 'The protected database identity has a different S3 namespace fingerprint.');
      }
      if (identity.migrationState !== 'ready') {
        throw authorityError('BRAIN_MIGRATION_IN_PROGRESS', 'The protected database identity is still migrating.');
      }
      migrations = await runMigrationsOnClient(client, options.migrationsDir ?? schemaDir());
      outcome = migrations.applied.length === 0 ? 'current' : 'upgraded';
    }
    const workspaceRole = await ensureWorkspaceRuntimeRole(
      client,
      authority.workspaceId,
      options.runtimePassword,
      options.runtimeRole,
    );
    await client.query('COMMIT');
    committed = true;
    return { outcome, migrations, role: workspaceRole, databaseAuthorityId };
  } catch (error) {
    failure = error;
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    let unlockFailure: Error | undefined;
    if (locked) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
          [BRAIN_TARGET.advisoryLockKey],
        );
        if (unlocked.rows[0]?.unlocked !== true) {
          unlockFailure = new Error('Brain advisory lock was not released');
        }
      } catch (error) {
        unlockFailure = error instanceof Error ? error : new Error('Brain advisory unlock failed');
      }
    }
    client.release(unlockFailure);
    if (unlockFailure !== undefined && failure === undefined) throw unlockFailure;
  }
}
