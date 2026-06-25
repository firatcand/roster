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
