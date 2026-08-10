import pg from 'pg';
import { randomBytes } from 'node:crypto';

export const ADMIN_URL = process.env.ROSTER_BRAIN_ADMIN_URL ?? '';
export const HAS_DB = ADMIN_URL.length > 0;

function adminUrlForDb(db: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = '/' + db;
  return u.toString();
}

export type FreshDb = {
  url: string;
  db: string;
  role: string;
  drop: () => Promise<void>;
};

export async function createFreshDb(): Promise<FreshDb> {
  const suffix = randomBytes(8).toString('hex');
  const db = 'brain_test_' + suffix;
  const role = 'rbrw_' + suffix;
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  try {
    await root.query(`CREATE DATABASE ${db}`);
  } finally {
    await root.end();
  }
  const url = adminUrlForDb(db);
  return {
    url,
    db,
    role,
    drop: async () => {
      const r = new pg.Client({ connectionString: ADMIN_URL });
      await r.connect();
      try {
        await r.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [db],
        );
        await r.query(`DROP DATABASE IF EXISTS ${db}`);
      } finally {
        try {
          await r.query(`DROP ROLE IF EXISTS ${role}`);
        } catch {
          /* best-effort: role may still hold grants in a leftover DB */
        }
        await r.end();
      }
    },
  };
}

export async function runtimeClient(adminUrl: string, password: string, roleName: string): Promise<pg.Client> {
  const u = new URL(adminUrl);
  u.username = roleName;
  u.password = password;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  return c;
}

// #383: `runDoctor` reports a Brain with schema but no protected workspace
// identity as uninitialized and stops before every relation-dependent check —
// a state real workspaces cannot reach, because bootstrapBrainWorkspaceAuthority
// installs the identity in the SAME transaction as the migrations. Legacy
// fixtures that call runMigrations directly seed the equivalent handshake here.
// Retired with the legacy fixtures in #363.
export async function seedWorkspaceIdentity(
  pool: pg.Pool,
  workspaceId = 'brain-fixture-workspace',
): Promise<void> {
  await pool.query(
    `INSERT INTO brain_meta.workspace_identity (
       singleton, workspace_id, fingerprint_format_version, namespace_fingerprint,
       database_authority_id, migration_state
     ) VALUES (true, $1, 1, $2, gen_random_uuid(), 'migrating')
     ON CONFLICT (singleton) DO NOTHING`,
    [workspaceId, `sha256:${'0'.repeat(64)}`],
  );
  await pool.query(
    `UPDATE brain_meta.workspace_identity SET migration_state = 'ready'
      WHERE singleton AND migration_state <> 'ready'`,
  );
}
