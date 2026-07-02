import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export const RUNTIME_ROLE = 'roster_brain_rw';

export type EnsureRoleResult = {
  created: boolean;
  password: string | null;
  // True when the creator's inbound membership (the PG16+/managed-Postgres
  // auto-grant) could not be revoked — stock-PG16 CREATEROLE admins can't
  // remove a bootstrap-granted membership. Doctor stays red until a superuser
  // revokes it; callers surface the remedial SQL.
  creatorGrantRemains: boolean;
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

// PG16+/managed Postgres (Neon): CREATE ROLE by a non-superuser auto-grants the
// new role back to the creator WITH ADMIN OPTION. That inbound membership trips
// doctor's no-inbound-members isolation invariant, so strip it (ROS-154).
// Idempotent — revoking a non-membership is a warning-level no-op. Deliberate
// one-way door on Neon: the admin forfeits SQL-level ALTER/DROP over the role
// (no superuser exists to restore admin option); only platform controls remain.
// Scope: only CURRENT_USER's membership — an inbound grant from any OTHER role
// is a real violation and stays visible to doctor.
//
// The REVOKE can itself silently no-op: stock PG16 records the auto-grant with
// the BOOTSTRAP superuser as grantor, a non-superuser creator may neither
// revoke it directly (warning, not error) nor via GRANTED BY (permission
// denied) — both verified empirically on PG 16. Neon's admin CAN revoke
// (verified live on Neon PG 17.10). So verify after revoking and report the
// truth instead of trusting the REVOKE.
async function stripCreatorGrant(client: pg.PoolClient, role: string): Promise<boolean> {
  await client.query(`REVOKE ${qIdent(role)} FROM CURRENT_USER`);
  const remains = await client.query(
    `SELECT 1 FROM pg_auth_members am
       JOIN pg_roles r ON r.oid = am.roleid
       JOIN pg_roles m ON m.oid = am.member
      WHERE r.rolname = $1 AND m.rolname = current_user`,
    [ident(role)],
  );
  return (remains.rowCount ?? 0) > 0;
}

export async function ensureRuntimeRole(
  client: pg.PoolClient,
  roleName: string = RUNTIME_ROLE,
): Promise<EnsureRoleResult> {
  const role = ident(roleName);
  if (await roleExists(client, role)) {
    await registerRuntimeRole(client, role);
    await applyGrants(client, role);
    // Re-init path strips too, so a pre-fix Neon brain self-heals on next init.
    const creatorGrantRemains = await stripCreatorGrant(client, role);
    return { created: false, password: null, creatorGrantRemains };
  }
  const password = generatePassword();
  const quotedPassword = "'" + password.replace(/'/g, "''") + "'";
  await client.query(
    `CREATE ROLE ${qIdent(role)} LOGIN PASSWORD ${quotedPassword}
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  await registerRuntimeRole(client, role);
  await applyGrants(client, role);
  const creatorGrantRemains = await stripCreatorGrant(client, role);
  return { created: true, password, creatorGrantRemains };
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
  await client.query(`GRANT EXECUTE ON FUNCTION brain.canonical_id(bigint) TO ${qrole}`);

  // ROS-146: merge is now an admin-owned SECURITY DEFINER function (008). The
  // runtime role EXECUTEs it instead of raw-inserting entity_merges/entity_aliases
  // (those INSERT grants are withheld below), so the cycle guard and the
  // canonical_id cache cannot be bypassed. refresh_canonical stays internal
  // (called within the SECURITY DEFINER context), never granted to runtime.
  // Guarded so pre-008 brains keep working.
  const hasMerge = await client.query<{ t: string | null }>(
    `SELECT to_regprocedure('brain.merge_entities(bigint, bigint, text)')::text AS t`,
  );
  if (hasMerge.rows[0]?.t) {
    await client.query(
      `GRANT EXECUTE ON FUNCTION brain.merge_entities(bigint, bigint, text) TO ${qrole}`,
    );
  }

  // ROS-146: the dedup %-prefilter relies on pg_trgm.similarity_threshold being
  // <= the 0.4 PROBABLE_THRESHOLD final filter, else a DB/session override could
  // silently drop candidates with similarity in [threshold, 0.4). Pin it to the
  // 0.3 default on the runtime role so every runtime session is deterministic.
  const hasTrgm = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM pg_extension WHERE extname = 'pg_trgm'`,
  );
  if ((hasTrgm.rowCount ?? 0) > 0) {
    // ROS-154: after stripCreatorGrant the connecting admin no longer holds
    // ADMIN OPTION on the role, so this ALTER would fail on re-init. The value
    // is pinned on create (while admin is still held) and never changes — skip
    // when pg_roles.rolconfig already stores it (exact form verified on Neon).
    const pinned = await client.query(
      `SELECT 1 FROM pg_roles
        WHERE rolname = $1 AND rolconfig @> ARRAY['pg_trgm.similarity_threshold=0.3']`,
      [ident(roleName)],
    );
    if ((pinned.rowCount ?? 0) === 0) {
      await client.query(`ALTER ROLE ${qrole} SET pg_trgm.similarity_threshold = '0.3'`);
    }
  }

  // Narrow brain_meta access (ROS-138): the runtime role may READ the non-secret
  // search/embedding config and nothing else in brain_meta (no schema_migrations,
  // no runtime_roles, no writes). The embedding API key is never stored in the DB.
  // Guarded so pre-007 brains (no config table) keep zero brain_meta access.
  const hasConfig = await client.query<{ t: string | null }>(
    `SELECT to_regclass('brain_meta.config')::text AS t`,
  );
  if (hasConfig.rows[0]?.t) {
    await client.query(`GRANT USAGE ON SCHEMA brain_meta TO ${qrole}`);
    await client.query(`GRANT SELECT ON brain_meta.config TO ${qrole}`);
  }

  for (const table of await brainTableNames(client)) {
    const t = qIdent(table);
    await client.query(`GRANT SELECT ON brain.${t} TO ${qrole}`);
    // ROS-146: entity_merges/entity_aliases are written only by the
    // brain.merge_entities() broker, so the runtime role gets SELECT but never
    // INSERT on them. canonical_id is a derived cache maintained by the broker;
    // it is excluded so the runtime role can never write it directly.
    if (table === 'entity_merges' || table === 'entity_aliases') continue;
    // canonical_id is the protected derived cache only on entities; an
    // agent-created table may have a same-named user column and must keep
    // runtime INSERT on it (consistent with the entities-scoped doctor check).
    const protectedCols =
      table === 'entities' ? "'id', 'recorded_at', 'canonical_id'" : "'id', 'recorded_at'";
    const cols = await client.query<{ attname: string }>(
      `SELECT a.attname FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = ('brain.' || quote_ident($1))::regclass
          AND a.attnum > 0 AND NOT a.attisdropped
          AND a.attgenerated = ''
          AND a.attname NOT IN (${protectedCols})`,
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
