import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export const RUNTIME_ROLE = 'roster_brain_rw';

export type EnsureRoleResult = {
  created: boolean;
  password: string | null;
};

function generatePassword(): string {
  return randomBytes(24).toString('base64url');
}

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return name;
}

function qIdent(name: string): string {
  return '"' + ident(name) + '"';
}

export async function roleExists(
  client: pg.PoolClient,
  roleName: string = RUNTIME_ROLE,
): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName]);
  return (r.rowCount ?? 0) > 0;
}

async function registerRuntimeRole(client: pg.PoolClient, role: string): Promise<void> {
  await client.query(
    `INSERT INTO brain_meta.runtime_roles (rolname) VALUES ($1) ON CONFLICT DO NOTHING`,
    [role],
  );
}

export async function ensureRuntimeRole(
  client: pg.PoolClient,
  roleName: string = RUNTIME_ROLE,
): Promise<EnsureRoleResult> {
  const role = ident(roleName);
  if (await roleExists(client, role)) {
    await registerRuntimeRole(client, role);
    await applyGrants(client, role);
    return { created: false, password: null };
  }
  const password = generatePassword();
  const quotedPassword = "'" + password.replace(/'/g, "''") + "'";
  await client.query(
    `CREATE ROLE ${qIdent(role)} LOGIN PASSWORD ${quotedPassword}
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  await registerRuntimeRole(client, role);
  await applyGrants(client, role);
  return { created: true, password };
}

async function brainTableNames(client: pg.PoolClient): Promise<string[]> {
  const r = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'brain'`,
  );
  return r.rows.map((row) => row.tablename);
}

async function brainViewNames(client: pg.PoolClient): Promise<string[]> {
  const r = await client.query<{ viewname: string }>(
    `SELECT viewname FROM pg_views WHERE schemaname = 'brain'`,
  );
  return r.rows.map((row) => row.viewname);
}

export async function applyGrants(
  client: pg.PoolClient,
  roleName: string = RUNTIME_ROLE,
): Promise<void> {
  const qrole = qIdent(roleName);

  // Complete reset: strip every privilege (incl. stale column-level grants,
  // sequence USAGE/UPDATE, REFERENCES, and brain_meta access) before
  // re-granting the precise minimal set. REVOKE ALL ON TABLE drops
  // column-level grants too.
  await client.query(`REVOKE ALL ON SCHEMA public FROM ${qrole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA brain FROM ${qrole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA brain FROM ${qrole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA brain FROM ${qrole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA brain FROM ${qrole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA brain_meta FROM ${qrole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA brain_meta FROM ${qrole}`);

  await client.query(`GRANT USAGE ON SCHEMA brain TO ${qrole}`);
  await client.query(`GRANT EXECUTE ON FUNCTION brain.create_table(text, jsonb) TO ${qrole}`);

  for (const table of await brainTableNames(client)) {
    const t = qIdent(table);
    await client.query(`GRANT SELECT ON brain.${t} TO ${qrole}`);
    const cols = await client.query<{ attname: string }>(
      `SELECT a.attname FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = ('brain.' || quote_ident($1))::regclass
          AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attname NOT IN ('id', 'recorded_at')`,
      [ident(table)],
    );
    const colList = cols.rows.map((c) => qIdent(c.attname)).join(', ');
    if (colList.length > 0) {
      await client.query(`GRANT INSERT (${colList}) ON brain.${t} TO ${qrole}`);
    }
  }

  for (const view of await brainViewNames(client)) {
    const v = qIdent(view);
    await client.query(`GRANT SELECT ON brain.${v} TO ${qrole}`);
  }
}

export function buildRuntimeUrl(
  adminUrl: string,
  password: string,
  roleName: string = RUNTIME_ROLE,
): string {
  const u = new URL(adminUrl);
  u.username = ident(roleName);
  u.password = password;
  return u.toString();
}
