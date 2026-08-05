import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBrainPool } from '../src/lib/brain/connect.ts';
import { RosterError } from '../src/lib/errors.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  deriveBrainWorkspaceAuthority,
  isPristineBrainDatabase,
  VerifiedBrainPool,
  verifyBrainWorkspaceAuthority,
} from '../src/lib/brain/workspace-authority.ts';
import {
  deriveWorkspaceRuntimeRoleName,
  ensureWorkspaceRuntimeRole,
} from '../src/lib/brain/roles.ts';
import type { WorkspaceBrainConfig } from '../src/lib/workspace-record.ts';
import { HAS_DB, createFreshDb, runtimeClient } from './brain-helpers.ts';

const opts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };
const RUNTIME_PASSWORD_A = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
const RUNTIME_PASSWORD_B = `Bb1_${randomBytes(32).toString('base64url')}-B2_`;
const DATABASE_AUTHORITY_ID_A = '11111111-1111-4111-8111-111111111111';
const DATABASE_AUTHORITY_ID_B = '22222222-2222-4222-8222-222222222222';

function config(secretsPath = '/legacy-fixture'): WorkspaceBrainConfig {
  return {
    secrets_path: secretsPath,
    storage: {
      bucket: 'legacy-fixture-vault',
      region: 'eu-central-1',
      root_prefix: 'brain',
      force_path_style: false,
    },
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RosterError && error.code === code;
}

async function dropDerivedRoles(roleNames: readonly string[]): Promise<void> {
  const pool = createBrainPool('admin');
  try {
    for (const roleName of roleNames) {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleName)) throw new Error('unsafe derived role fixture');
      const exists = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName]);
      if ((exists.rowCount ?? 0) === 0) continue;
      await pool.query(`REVOKE "${roleName}" FROM CURRENT_USER`);
      await pool.query(`DROP ROLE IF EXISTS "${roleName}"`);
    }
  } finally {
    await pool.end();
  }
}

function identityRow(
  authority = deriveBrainWorkspaceAuthority('legacy-fixture', config()),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    workspace_id: authority.workspaceId,
    fingerprint_format_version: authority.fingerprintFormatVersion,
    namespace_fingerprint: authority.namespaceFingerprint,
    database_authority_id: DATABASE_AUTHORITY_ID_A,
    initialized_at: '2026-08-05T00:00:00.000Z',
    migration_state: 'ready',
    ...overrides,
  };
}

test('brain workspace authority: namespace identity is checkout and secret-path independent', () => {
  const first = deriveBrainWorkspaceAuthority('legacy-fixture', config('/one'));
  const second = deriveBrainWorkspaceAuthority('legacy-fixture', config('/two'));
  const changed = deriveBrainWorkspaceAuthority('legacy-fixture', {
    ...config(),
    storage: { ...config().storage, root_prefix: 'different-root' },
  });
  assert.equal(first.fingerprintFormatVersion, 1);
  assert.equal(first.namespaceFingerprint, second.namespaceFingerprint);
  assert.notEqual(first.namespaceFingerprint, changed.namespaceFingerprint);
});

test('brain workspace authority: runtime role names are stable per workspace and distinct across workspaces', () => {
  const first = deriveWorkspaceRuntimeRoleName('legacy-fixture', 'brain_runtime');
  assert.equal(first, deriveWorkspaceRuntimeRoleName('legacy-fixture', 'brain_runtime'));
  assert.notEqual(first, deriveWorkspaceRuntimeRoleName('other-fixture', 'brain_runtime'));
  assert.match(first, /^[a-z_][a-z0-9_]{0,62}$/);
});

test('brain workspace authority: registered role reuse rejects unsafe role state before grant mutation', async () => {
  const roleName = deriveWorkspaceRuntimeRoleName('legacy-fixture', 'brain_runtime');
  const calls: string[] = [];
  const client = {
    query: async (text: string) => {
      calls.push(text);
      if (/FROM pg_roles WHERE rolname = \$1/u.test(text)) return { rowCount: 1, rows: [{ one: 1 }] };
      if (/FROM brain_meta\.runtime_roles WHERE rolname = \$1/u.test(text)) return { rowCount: 1, rows: [{ one: 1 }] };
      if (/FROM brain_meta\.runtime_roles ORDER BY rolname/u.test(text)) return { rowCount: 1, rows: [{ rolname: roleName }] };
      if (/SELECT 'attributes' AS violation/u.test(text)) return { rowCount: 1, rows: [{ violation: 'attributes' }] };
      throw new Error(`unexpected query: ${text}`);
    },
  };

  await assert.rejects(
    ensureWorkspaceRuntimeRole(client as never, 'legacy-fixture', RUNTIME_PASSWORD_A, 'brain_runtime'),
    hasCode('BRAIN_RUNTIME_ROLE_COLLISION'),
  );
  assert.equal(calls.some((sql) => /^\s*(?:ALTER|CREATE|GRANT|REVOKE)\b/u.test(sql)), false);
});

test('brain workspace authority: runtime verification reads protected identity directly first', async () => {
  const calls: string[] = [];
  const authority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const client = {
    query: async (text: string) => {
      calls.push(text);
      return {
        rows: [{
          workspace_id: authority.workspaceId,
          fingerprint_format_version: authority.fingerprintFormatVersion,
          namespace_fingerprint: authority.namespaceFingerprint,
          database_authority_id: DATABASE_AUTHORITY_ID_A,
          initialized_at: '2026-08-05T00:00:00.000Z',
          migration_state: 'ready',
        }],
      };
    },
  };
  await verifyBrainWorkspaceAuthority(client as never, authority);
  assert.match(calls[0]!, /^SELECT workspace_id, fingerprint_format_version, namespace_fingerprint/);
  assert.doesNotMatch(calls[0]!, /to_regclass/);
});

test('brain workspace authority: exact database authority mismatch fails redacted', async () => {
  const authority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const client = {
    query: async () => ({
      rows: [identityRow(authority, { database_authority_id: DATABASE_AUTHORITY_ID_B })],
    }),
  };

  await assert.rejects(
    verifyBrainWorkspaceAuthority(client as never, authority, DATABASE_AUTHORITY_ID_A),
    (error: unknown) => {
      assert.ok(error instanceof RosterError);
      assert.equal(error.code, 'BRAIN_DATABASE_AUTHORITY_MISMATCH');
      assert.deepEqual(error.details, {});
      assert.equal(error.message.includes(DATABASE_AUTHORITY_ID_A), false);
      assert.equal(error.message.includes(DATABASE_AUTHORITY_ID_B), false);
      return true;
    },
  );
});

test('brain workspace authority: verification fails closed with stable redacted outcomes', async () => {
  const authority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const cases: Array<{ row?: Record<string, unknown>; error?: Error; code: string }> = [
    { error: Object.assign(new Error('relation absent'), { code: '42P01' }), code: 'BRAIN_IDENTITY_UNINITIALIZED' },
    { row: {}, code: 'BRAIN_AUTHORITY_INVALID' },
    { row: identityRow(authority, { database_authority_id: 'not-a-uuid' }), code: 'BRAIN_AUTHORITY_INVALID' },
    { row: identityRow(authority, { migration_state: 'migrating' }), code: 'BRAIN_MIGRATION_IN_PROGRESS' },
    { row: identityRow(authority, { workspace_id: 'foreign-workspace' }), code: 'BRAIN_WORKSPACE_MISMATCH' },
    { row: identityRow(authority, { namespace_fingerprint: 'sha256:'.concat('0'.repeat(64)) }), code: 'BRAIN_NAMESPACE_MISMATCH' },
  ];
  for (const entry of cases) {
    const client = {
      query: async () => {
        if (entry.error !== undefined) throw entry.error;
        return { rows: [entry.row] };
      },
    };
    await assert.rejects(verifyBrainWorkspaceAuthority(client as never, authority), hasCode(entry.code));
    await assert.rejects(
      verifyBrainWorkspaceAuthority(client as never, authority),
      (error: unknown) => error instanceof RosterError && error.details && Object.keys(error.details).length === 0,
    );
  }
});

test('brain workspace authority: verification is once per physical client and a failed client is destroyed', async () => {
  const authority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const makeClient = (row = identityRow(authority)) => {
    let queries = 0;
    const releases: unknown[] = [];
    return {
      client: {
        query: async () => {
          queries++;
          return { rows: [row] };
        },
        release: (error?: unknown) => releases.push(error),
      },
      queries: () => queries,
      releases,
    };
  };
  const first = makeClient();
  const second = makeClient();
  const clients = [first.client, first.client, second.client];
  const pool = { connect: async () => clients.shift()! };
  const verified = new VerifiedBrainPool(pool as never, authority);
  for (let index = 0; index < 3; index++) (await verified.connect()).release();
  assert.equal(first.queries(), 1);
  assert.equal(second.queries(), 1);

  const concurrentLeft = makeClient();
  const concurrentRight = makeClient();
  const concurrentClients = [concurrentLeft.client, concurrentRight.client];
  const concurrent = new VerifiedBrainPool({ connect: async () => concurrentClients.shift()! } as never, authority);
  const checkedOut = await Promise.all([concurrent.connect(), concurrent.connect()]);
  for (const client of checkedOut) client.release();
  assert.equal(concurrentLeft.queries(), 1);
  assert.equal(concurrentRight.queries(), 1);

  const rejected = makeClient(identityRow(authority, { workspace_id: 'foreign-workspace' }));
  const failing = new VerifiedBrainPool({ connect: async () => rejected.client } as never, authority);
  await assert.rejects(failing.connect(), hasCode('BRAIN_WORKSPACE_MISMATCH'));
  assert.equal(rejected.queries(), 1);
  assert.equal(rejected.releases.length, 1);
  assert.ok(rejected.releases[0] instanceof Error);
});

test('brain workspace authority: direct query rejects an authority mismatch before caller SQL', async () => {
  const authority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const calls: string[] = [];
  const releases: unknown[] = [];
  const client = {
    query: async (text: string) => {
      calls.push(text);
      return { rows: [identityRow(authority, { workspace_id: 'foreign-workspace' })] };
    },
    release: (error?: unknown) => releases.push(error),
  };
  const verified = new VerifiedBrainPool({ connect: async () => client } as never, authority);

  await assert.rejects(
    verified.query('SELECT caller_sql_must_not_run()'),
    hasCode('BRAIN_WORKSPACE_MISMATCH'),
  );
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!, /caller_sql_must_not_run/u);
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
});

test('brain workspace authority: direct query rejects a database authority mismatch before caller SQL', async () => {
  const authority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const calls: string[] = [];
  const releases: unknown[] = [];
  const client = {
    query: async (text: string) => {
      calls.push(text);
      return {
        rows: [identityRow(authority, { database_authority_id: DATABASE_AUTHORITY_ID_B })],
      };
    },
    release: (error?: unknown) => releases.push(error),
  };
  const verified = new VerifiedBrainPool(
    { connect: async () => client } as never,
    authority,
    DATABASE_AUTHORITY_ID_A,
  );

  await assert.rejects(
    verified.query('SELECT database_authority_caller_sql_must_not_run()'),
    hasCode('BRAIN_DATABASE_AUTHORITY_MISMATCH'),
  );
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0]!, /database_authority_caller_sql_must_not_run/u);
  assert.equal(releases.length, 1);
  assert.ok(releases[0] instanceof Error);
});

test('brain workspace authority: advisory unlock failure destroys the physical client', async () => {
  const released: unknown[] = [];
  const unlockError = new Error('unlock failed');
  const client = {
    query: async (text: string) => {
      if (text === 'SELECT pg_advisory_lock($1::bigint)') return { rows: [] };
      if (text === 'BEGIN') throw new Error('bootstrap failed');
      if (text === 'ROLLBACK') return { rows: [] };
      if (text === 'SELECT pg_advisory_unlock($1::bigint) AS unlocked') throw unlockError;
      throw new Error(`unexpected query: ${text}`);
    },
    release: (error?: unknown) => released.push(error),
  };
  const pool = { connect: async () => client };

  await assert.rejects(
    bootstrapBrainWorkspaceAuthority(
      pool as never,
      deriveBrainWorkspaceAuthority('legacy-fixture', config()),
      { runtimePassword: RUNTIME_PASSWORD_A },
    ),
    /bootstrap failed/u,
  );
  assert.deepEqual(released, [unlockError]);
});

test('brain workspace authority: false advisory unlock result destroys the physical client', async () => {
  const released: unknown[] = [];
  const client = {
    query: async (text: string) => {
      if (text === 'SELECT pg_advisory_lock($1::bigint)') return { rows: [] };
      if (text === 'BEGIN') throw new Error('bootstrap failed');
      if (text === 'ROLLBACK') return { rows: [] };
      if (text === 'SELECT pg_advisory_unlock($1::bigint) AS unlocked') {
        return { rows: [{ unlocked: false }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release: (error?: unknown) => released.push(error),
  };

  await assert.rejects(
    bootstrapBrainWorkspaceAuthority(
      { connect: async () => client } as never,
      deriveBrainWorkspaceAuthority('legacy-fixture', config()),
      { runtimePassword: RUNTIME_PASSWORD_A },
    ),
    /bootstrap failed/u,
  );
  assert.equal(released.length, 1);
  assert.match((released[0] as Error).message, /was not released/u);
});

test('brain workspace authority: pristine classification is catalog-only and rejects custom relations or routines', async () => {
  let inspected = '';
  const client = {
    query: async (text: string) => {
      inspected = text;
      return { rows: [{ exists: false }] };
    },
  };
  assert.equal(await isPristineBrainDatabase(client as never), true);
  assert.match(inspected, /pg_catalog\.pg_class/);
  assert.match(inspected, /pg_catalog\.pg_type/);
  assert.match(inspected, /pg_catalog\.pg_collation/);
  assert.match(inspected, /pg_catalog\.pg_operator/);
  assert.match(inspected, /pg_catalog\.pg_extension/);
  assert.match(inspected, /pg_catalog\.pg_proc/);
  assert.doesNotMatch(inspected, /SELECT \*|LIMIT 1/);
  assert.doesNotMatch(inspected, /typtype\s+IN/u);
});

test('brain workspace authority: does not depend on the legacy persistence binding module', () => {
  const source = readFileSync(new URL('../src/lib/brain/workspace-authority.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /persistence\/postgres\/binding/);
});

test('brain workspace authority: approved pg_trgm generated types remain pristine but custom types do not', opts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    assert.equal(await isPristineBrainDatabase(pool), true);
    await pool.query(`CREATE DOMAIN public.custom_brain_domain AS public.gtrgm[]`);
    assert.equal(await isPristineBrainDatabase(pool), false);
  } finally {
    await pool.end();
    await fresh.drop();
  }
});

test('brain workspace authority: clean bootstrap is atomic, idempotent, and grants runtime identity reads only', opts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  const authority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const derivedRole = deriveWorkspaceRuntimeRoleName(authority.workspaceId, fresh.role);
  try {
    const first = await bootstrapBrainWorkspaceAuthority(pool, authority, {
      runtimeRole: fresh.role,
      runtimePassword: RUNTIME_PASSWORD_A,
    });
    assert.equal(first.outcome, 'initialized');
    assert.equal(first.role.created, true);
    assert.match(first.databaseAuthorityId, /^[0-9a-f-]{36}$/u);
    assert.equal(Object.hasOwn(first.role, 'password'), false);
    const second = await bootstrapBrainWorkspaceAuthority(pool, authority, {
      runtimeRole: fresh.role,
      runtimePassword: RUNTIME_PASSWORD_B,
    });
    assert.equal(second.outcome, 'current');
    assert.equal(second.role.roleName, first.role.roleName);
    assert.equal(second.databaseAuthorityId, first.databaseAuthorityId);
    assert.equal(Object.hasOwn(second.role, 'password'), false);
    await assert.rejects(
      bootstrapBrainWorkspaceAuthority(pool, authority, {
        runtimeRole: 'different_runtime_base',
        runtimePassword: RUNTIME_PASSWORD_B,
      }),
      hasCode('BRAIN_RUNTIME_ROLE_COLLISION'),
    );
    await assert.rejects(pool.query(`TRUNCATE brain_meta.workspace_identity`), /cannot be truncated/i);
    await assert.rejects(
      pool.query(`UPDATE brain_meta.workspace_identity SET database_authority_id = $1`, [DATABASE_AUTHORITY_ID_B]),
      /immutable/i,
    );

    const runtime = await runtimeClient(fresh.url, RUNTIME_PASSWORD_A, first.role.roleName);
    try {
      const identity = await runtime.query(
        `SELECT workspace_id, namespace_fingerprint, database_authority_id, migration_state FROM brain_meta.workspace_identity`,
      );
      assert.equal(identity.rows[0]?.workspace_id, authority.workspaceId);
      assert.equal(identity.rows[0]?.database_authority_id, first.databaseAuthorityId);
      await assert.rejects(
        runtime.query(`UPDATE brain_meta.workspace_identity SET migration_state = 'ready'`),
        /permission denied/i,
      );
      await assert.rejects(runtime.query(`DELETE FROM brain_meta.workspace_identity`), /permission denied/i);
      await assert.rejects(runtime.query(`TRUNCATE brain_meta.workspace_identity`), /permission denied/i);
    } finally {
      await runtime.end();
    }
  } finally {
    await pool.end();
    await fresh.drop();
    await dropDerivedRoles([derivedRole]);
  }
});

test('brain workspace authority: a custom public relation is legacy adoption, not a clean target', opts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  try {
    await pool.query(`CREATE TABLE public.legacy_custom_relation (id integer)`);
    await assert.rejects(
      bootstrapBrainWorkspaceAuthority(pool, deriveBrainWorkspaceAuthority('legacy-fixture', config()), {
        runtimeRole: fresh.role,
        runtimePassword: RUNTIME_PASSWORD_A,
      }),
      hasCode('BRAIN_LEGACY_ADOPTION_REQUIRED'),
    );
    const identity = await pool.query<{ relation: string | null }>(
      `SELECT to_regclass('brain_meta.workspace_identity')::text AS relation`,
    );
    assert.equal(identity.rows[0]?.relation, null);
  } finally {
    await pool.end();
    await fresh.drop();
  }
});

test('brain workspace authority: empty custom schemas and every public user-defined type require adoption without mutation', opts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  const authority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const roleName = deriveWorkspaceRuntimeRoleName(authority.workspaceId, fresh.role);
  try {
    await pool.query(`CREATE SCHEMA legacy_empty`);
    await pool.query(`CREATE TYPE public.legacy_status AS ENUM ('pending')`);
    await pool.query(`CREATE TYPE public.legacy_pair AS (value integer)`);
    await pool.query(`CREATE TYPE public.legacy_range AS RANGE (subtype = integer)`);
    await assert.rejects(
      bootstrapBrainWorkspaceAuthority(pool, authority, {
        runtimeRole: fresh.role,
        runtimePassword: RUNTIME_PASSWORD_A,
      }),
      hasCode('BRAIN_LEGACY_ADOPTION_REQUIRED'),
    );
    const state = await pool.query<{ migrations: string | null; identity: string | null; role_exists: boolean }>(
      `SELECT to_regclass('brain_meta.schema_migrations')::text AS migrations,
              to_regclass('brain_meta.workspace_identity')::text AS identity,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS role_exists`,
      [roleName],
    );
    assert.deepEqual(state.rows[0], { migrations: null, identity: null, role_exists: false });
  } finally {
    await pool.end();
    await fresh.drop();
  }
});

test('brain workspace authority: a failed clean migration rolls back schema ledger identity and role creation', opts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  const directory = mkdtempSync(join(tmpdir(), 'brain-authority-fail-'));
  writeFileSync(join(directory, '001_init.sql'), `CREATE SCHEMA brain_meta;
CREATE TABLE brain_meta.schema_migrations (filename text PRIMARY KEY, sha256 text NOT NULL);`, 'utf8');
  writeFileSync(join(directory, '002_fail.sql'), `SELECT missing_authority_migration_function();`, 'utf8');
  try {
    await assert.rejects(
      bootstrapBrainWorkspaceAuthority(pool, deriveBrainWorkspaceAuthority('legacy-fixture', config()), {
        migrationsDir: directory,
        runtimeRole: fresh.role,
        runtimePassword: RUNTIME_PASSWORD_A,
      }),
    );
    const state = await pool.query<{ migrations: string | null; identity: string | null; role_exists: boolean }>(
      `SELECT to_regclass('brain_meta.schema_migrations')::text AS migrations,
              to_regclass('brain_meta.workspace_identity')::text AS identity,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS role_exists`,
      [fresh.role],
    );
    assert.deepEqual(state.rows[0], { migrations: null, identity: null, role_exists: false });
  } finally {
    await pool.end();
    rmSync(directory, { recursive: true, force: true });
    await fresh.drop();
  }
});

test('brain workspace authority: distinct workspace databases use distinct runtime credentials', opts, async () => {
  const left = await createFreshDb();
  const right = await createFreshDb();
  const leftPool = createBrainPool('admin', left.url);
  const rightPool = createBrainPool('admin', right.url);
  const roleBase = 'brain_runtime';
  const leftAuthority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const rightAuthority = deriveBrainWorkspaceAuthority('other-fixture', config());
  const leftRole = deriveWorkspaceRuntimeRoleName(leftAuthority.workspaceId, roleBase);
  const rightRole = deriveWorkspaceRuntimeRoleName(rightAuthority.workspaceId, roleBase);
  try {
    const leftResult = await bootstrapBrainWorkspaceAuthority(leftPool, leftAuthority, {
      runtimeRole: roleBase,
      runtimePassword: RUNTIME_PASSWORD_A,
    });
    const rightResult = await bootstrapBrainWorkspaceAuthority(rightPool, rightAuthority, {
      runtimeRole: roleBase,
      runtimePassword: RUNTIME_PASSWORD_B,
    });
    assert.notEqual(leftResult.role.roleName, rightResult.role.roleName);
    assert.notEqual(leftResult.databaseAuthorityId, rightResult.databaseAuthorityId);
    assert.equal(Object.hasOwn(leftResult.role, 'password'), false);
    assert.equal(Object.hasOwn(rightResult.role, 'password'), false);
    const leftRuntime = await runtimeClient(left.url, RUNTIME_PASSWORD_A, leftResult.role.roleName);
    const rightRuntime = await runtimeClient(right.url, RUNTIME_PASSWORD_B, rightResult.role.roleName);
    try {
      assert.equal((await leftRuntime.query(`SELECT workspace_id FROM brain_meta.workspace_identity`)).rows[0]?.workspace_id, 'legacy-fixture');
      assert.equal((await rightRuntime.query(`SELECT workspace_id FROM brain_meta.workspace_identity`)).rows[0]?.workspace_id, 'other-fixture');
    } finally {
      await leftRuntime.end();
      await rightRuntime.end();
    }
  } finally {
    await leftPool.end();
    await rightPool.end();
    await left.drop();
    await right.drop();
    await dropDerivedRoles([leftRole, rightRole]);
  }
});

test('brain workspace authority: an unregistered cluster role collision rolls back bootstrap', opts, async () => {
  const fresh = await createFreshDb();
  const pool = createBrainPool('admin', fresh.url);
  const authority = deriveBrainWorkspaceAuthority('legacy-fixture', config());
  const roleName = deriveWorkspaceRuntimeRoleName(authority.workspaceId, fresh.role);
  try {
    await pool.query(`CREATE ROLE "${roleName}" LOGIN`);
    await assert.rejects(
      bootstrapBrainWorkspaceAuthority(pool, authority, {
        runtimeRole: fresh.role,
        runtimePassword: RUNTIME_PASSWORD_A,
      }),
      hasCode('BRAIN_RUNTIME_ROLE_COLLISION'),
    );
    const state = await pool.query<{ migrations: string | null; identity: string | null; registered: boolean }>(
      `SELECT to_regclass('brain_meta.schema_migrations')::text AS migrations,
              to_regclass('brain_meta.workspace_identity')::text AS identity,
              EXISTS (SELECT 1 FROM brain_meta.runtime_roles WHERE rolname = $1) AS registered`,
      [roleName],
    ).catch(() => ({ rows: [{ migrations: null, identity: null, registered: false }] }));
    assert.deepEqual(state.rows[0], { migrations: null, identity: null, registered: false });
  } finally {
    await pool.end();
    await fresh.drop();
    await dropDerivedRoles([roleName]);
  }
});
