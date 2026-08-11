import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { EXIT_ERROR, RosterError } from '../errors.ts';
import { assertWorkspaceId } from '../workspace-layout.ts';

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

export type EnsureWorkspaceRuntimeRoleResult = {
  created: boolean;
  creatorGrantRemains: boolean;
  roleName: string;
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

function runtimeRoleCollision(roleName: string): RosterError {
  return new RosterError({
    header: 'Brain runtime role collision',
    body: 'The requested derived workspace runtime role conflicts with this cluster or this Brain database registration.',
    remedy: 'Use the original approved runtime role base, or have an administrator inspect the conflicting cluster role.',
    exitCode: EXIT_ERROR,
    code: 'BRAIN_RUNTIME_ROLE_COLLISION',
    details: { role_name: roleName },
  });
}

export function deriveWorkspaceRuntimeRoleName(workspaceId: string, roleBase: string = RUNTIME_ROLE): string {
  const workspace = assertWorkspaceId(workspaceId);
  const base = ident(roleBase);
  const digest = createHash('sha256')
    .update('roster.brain.runtime-role.v1\u0000', 'utf8')
    .update(base, 'utf8')
    .update('\u0000', 'utf8')
    .update(workspace, 'utf8')
    .digest('hex');
  const prefix = base.slice(0, 38);
  return `${prefix}_${digest.slice(0, 24)}`;
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

async function runtimeRoleRegistered(client: pg.PoolClient, role: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM brain_meta.runtime_roles WHERE rolname = $1`,
    [role],
  );
  return (result.rowCount ?? 0) === 1;
}

async function registeredRuntimeRoles(client: pg.PoolClient): Promise<string[]> {
  const result = await client.query<{ rolname: string }>(
    `SELECT rolname FROM brain_meta.runtime_roles ORDER BY rolname ASC`,
  );
  return result.rows.map((row) => row.rolname);
}

async function existingWorkspaceRuntimeRoleIsUnsafe(
  client: pg.PoolClient,
  role: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 'attributes' AS violation
       FROM pg_roles
      WHERE rolname = $1
        AND (NOT rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
     UNION ALL
     SELECT 'outbound-membership'
       FROM pg_auth_members membership
       JOIN pg_roles member_role ON member_role.oid = membership.member
      WHERE member_role.rolname = $1
     UNION ALL
     SELECT 'unsafe-inbound-membership'
       FROM pg_auth_members membership
       JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
       JOIN pg_roles member_role ON member_role.oid = membership.member
      WHERE granted_role.rolname = $1
        AND member_role.rolname <> current_user
        AND NOT member_role.rolsuper
     UNION ALL
     SELECT 'database-owner'
       FROM pg_database database_row
       JOIN pg_roles owner_role ON owner_role.oid = database_row.datdba
      WHERE owner_role.rolname = $1
     UNION ALL
     SELECT 'database-create'
      WHERE has_database_privilege($1, current_database(), 'CREATE')
     UNION ALL
     SELECT 'schema-create'
       FROM pg_namespace namespace_row
      WHERE namespace_row.nspname IN ('public', 'brain', 'brain_meta', 'brain_evidence')
        AND has_schema_privilege($1, namespace_row.oid, 'CREATE')
     UNION ALL
     SELECT 'owned-relation'
       FROM pg_class relation
       JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
       JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
      WHERE namespace_row.nspname IN ('brain', 'brain_meta', 'brain_evidence')
        AND owner_role.rolname = $1
     UNION ALL
     SELECT 'owned-schema'
       FROM pg_namespace namespace_row
       JOIN pg_roles owner_role ON owner_role.oid = namespace_row.nspowner
      WHERE namespace_row.nspname IN ('brain', 'brain_meta', 'brain_evidence')
        AND owner_role.rolname = $1
     UNION ALL
     SELECT 'owned-routine'
       FROM pg_proc routine
       JOIN pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
       JOIN pg_roles owner_role ON owner_role.oid = routine.proowner
      WHERE namespace_row.nspname IN ('brain', 'brain_meta', 'brain_evidence')
        AND owner_role.rolname = $1
     LIMIT 1`,
    [role],
  );
  return (result.rowCount ?? result.rows.length) > 0;
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

// TEST-FIXTURE ONLY since #383: no `src/**` module imports this (pinned in
// test/static-boundaries.test.ts). Production provisions roles through
// ensureWorkspaceRuntimeRole, which derives the name from workspace identity and
// consumes an ambient password instead of minting one. Removal is #363's.
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

export async function ensureWorkspaceRuntimeRole(
  client: pg.PoolClient,
  workspaceId: string,
  password: string,
  roleBase: string = RUNTIME_ROLE,
): Promise<EnsureWorkspaceRuntimeRoleResult> {
  const roleName = deriveWorkspaceRuntimeRoleName(workspaceId, roleBase);
  const exists = await roleExists(client, roleName);
  const registered = await runtimeRoleRegistered(client, roleName);
  const otherRegisteredRole = (await registeredRuntimeRoles(client)).find((role) => role !== roleName);
  if (otherRegisteredRole !== undefined) {
    throw runtimeRoleCollision(roleName);
  }
  if (exists && !registered) throw runtimeRoleCollision(roleName);
  if (!exists && registered) {
    throw new RosterError({
      header: 'Brain runtime role registration is invalid',
      body: 'This Brain database registers a derived runtime role that is absent from the PostgreSQL cluster.',
      remedy: 'Have an administrator repair the role registration before retrying initialization.',
      exitCode: EXIT_ERROR,
      code: 'BRAIN_RUNTIME_ROLE_COLLISION',
      details: { role_name: roleName },
    });
  }
  if (exists) {
    if (await existingWorkspaceRuntimeRoleIsUnsafe(client, roleName)) {
      throw runtimeRoleCollision(roleName);
    }
    await applyGrants(client, roleName);
    const creatorGrantRemains = await stripCreatorGrant(client, roleName);
    return { created: false, creatorGrantRemains, roleName };
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(password)) {
    throw new Error('invalid workspace runtime role password');
  }
  await client.query(
    `CREATE ROLE ${qIdent(roleName)} LOGIN PASSWORD '${password}'
       NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
  );
  await registerRuntimeRole(client, roleName);
  await applyGrants(client, roleName);
  const creatorGrantRemains = await stripCreatorGrant(client, roleName);
  return { created: true, creatorGrantRemains, roleName };
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

async function runtimeProtectedBrainTables(client: pg.PoolClient): Promise<Set<string>> {
  const registry = await client.query<{ t: string | null }>(
    `SELECT to_regclass('brain_meta.runtime_protected_tables')::text AS t`,
  );
  if (!registry.rows[0]?.t) return new Set();
  const protectedTables = await client.query<{ table_name: string }>(
    `SELECT table_name FROM brain_meta.runtime_protected_tables ORDER BY table_name ASC`,
  );
  return new Set(protectedTables.rows.map((row) => ident(row.table_name)));
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
  // #383 (AC-2): brain.create_table is a DDL broker — it CREATEs a table and
  // reassigns its owner. The runtime role may never reach it; the blanket
  // function REVOKE above self-heals a pre-#383 Brain on re-init.
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

  const hasWorkspaceIdentity = await client.query<{ t: string | null }>(
    `SELECT to_regclass('brain_meta.workspace_identity')::text AS t`,
  );
  if (hasWorkspaceIdentity.rows[0]?.t) {
    await client.query(`GRANT USAGE ON SCHEMA brain_meta TO ${qrole}`);
    await client.query(
      `GRANT SELECT (workspace_id, fingerprint_format_version, namespace_fingerprint, database_authority_id, initialized_at, migration_state)
       ON brain_meta.workspace_identity TO ${qrole}`,
    );
  }

  const protectedTables = await runtimeProtectedBrainTables(client);
  for (const table of await brainTableNames(client)) {
    const t = qIdent(table);
    await client.query(`GRANT SELECT ON brain.${t} TO ${qrole}`);
    // ROS-146: entity_merges/entity_aliases are written only by the
    // brain.merge_entities() broker, so the runtime role gets SELECT but never
    // INSERT on them. canonical_id is a derived cache maintained by the broker;
    // it is excluded so the runtime role can never write it directly.
    if (table === 'entity_merges' || table === 'entity_aliases' || protectedTables.has(table)) continue;
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

  await applyEvidenceGrants(client, qrole);
}

const EVIDENCE_RECORD_BROKERS = [
  'record_completed_run',
  'record_run_artifact',
  'record_feedback',
  'record_human_decision',
] as const;

// #358: the lifecycle brokers, the filesystem-phase fence, and the read-only
// governor verifier. `advance_dream_watermark` stays granted to NOBODY -- the
// runtime reaches it only INSIDE decide_lesson_candidate, after the promotion
// binding -- and `lock_key`/`lock_frame` stay internal, so the runtime can hold
// exactly the ONE advisory frame the fence derives for its own candidate and no
// other evidence-space lock.
const DREAM_LIFECYCLE_BROKERS = [
  'record_dream_candidate',
  'decide_lesson_candidate',
  'hold_dream_subject_lock',
  'verify_dream_subject_governor',
] as const;

// Pure reads over relations the runtime already holds SELECT on, so granting
// them adds no reachable state and keeps ONE implementation of the readiness
// predicate shared by `dream status` and the brokers.
const DREAM_READ_FUNCTIONS = [
  'brain_evidence.dream_effective_policy(text)',
  'brain_evidence.dream_eligible(text, timestamptz, bigint)',
] as const;

// #356: portable evidence is broker-append, not runtime-writable. The runtime
// role gets USAGE + table SELECT + EXECUTE on exactly the four record brokers
// and zero direct DML; promotion has no broker at all (admin path only), and the
// validation/lock helpers stay internal to the SECURITY DEFINER context.
// Existence-guarded so pre-013 brains keep zero brain_evidence access, and each
// #358 signature is guarded on its own so a pre-015 brain keeps zero dream
// lifecycle access instead of failing the whole grant pass.
async function applyEvidenceGrants(client: pg.PoolClient, qrole: string): Promise<void> {
  const hasEvidence = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM pg_namespace WHERE nspname = 'brain_evidence'`,
  );
  if ((hasEvidence.rowCount ?? 0) === 0) return;

  await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA brain_evidence FROM ${qrole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA brain_evidence FROM ${qrole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA brain_evidence FROM ${qrole}`);
  await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA brain_evidence FROM ${qrole}`);

  await client.query(`GRANT USAGE ON SCHEMA brain_evidence TO ${qrole}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA brain_evidence TO ${qrole}`);
  for (const broker of EVIDENCE_RECORD_BROKERS) {
    await client.query(`GRANT EXECUTE ON FUNCTION brain_evidence.${ident(broker)}(text) TO ${qrole}`);
  }
  const dreamSignatures = [
    ...DREAM_LIFECYCLE_BROKERS.map((broker) => `brain_evidence.${ident(broker)}(text)`),
    ...DREAM_READ_FUNCTIONS,
  ];
  for (const signature of dreamSignatures) {
    const present = await client.query<{ p: string | null }>(
      `SELECT to_regprocedure($1)::text AS p`,
      [signature],
    );
    if (present.rows[0]?.p === null) continue;
    await client.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${qrole}`);
  }
}

// TEST-FIXTURE ONLY since #383: reconstructing a connection string is exactly
// what the workspace authority path must never do (pinned in
// test/static-boundaries.test.ts). Removal is #363's.
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
