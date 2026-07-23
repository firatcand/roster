import type pg from 'pg';
import { RosterError, EXIT_ERROR } from '../../errors.ts';
import { assertPgIdentifier } from '../migrate-core.ts';
import { RUNTIME_ROLE as BRAIN_RUNTIME_ROLE, roleExists } from '../../brain/roles.ts';
import { OPS_SCHEMAS } from './binding.ts';

// Least-privilege grants for the ops runtime role (#318 section E): USAGE on
// both schemas, SELECT on everything, INSERT ONLY on the event/append tables
// (never meta / schema_migrations), sequence USAGE scoped to exactly the
// bigserial seq sequences INSERT needs — no UPDATE/DELETE/TRUNCATE, no DDL,
// no ownership. brain mode extends roster_brain_rw with exactly this set;
// dedicated mode applies it to the operator-supplied role (roster never mints
// credentials — owner decision 3).

export const OPS_INSERT_TABLES = [
  { schema: 'hitl', table: 'requests', serial: true },
  { schema: 'hitl', table: 'decisions', serial: true },
  { schema: 'roster_ops', table: 'run_events', serial: true },
  { schema: 'roster_ops', table: 'artifacts', serial: true },
  { schema: 'roster_ops', table: 'delivery_ledger', serial: false },
] as const;

function qIdent(name: string): string {
  assertPgIdentifier('identifier', name);
  return `"${name}"`;
}

export async function applyOpsGrants(client: pg.PoolClient, roleName: string): Promise<void> {
  const role = qIdent(roleName);
  for (const schema of OPS_SCHEMAS) {
    await client.query(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA ${schema} FROM ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  }
  for (const t of OPS_INSERT_TABLES) {
    await client.query(`GRANT INSERT ON ${t.schema}.${qIdent(t.table)} TO ${role}`);
    if (!t.serial) continue;
    const seqRes = await client.query<{ seq: string | null }>(
      `SELECT pg_get_serial_sequence($1, 'seq') AS seq`,
      [`${t.schema}.${t.table}`],
    );
    const qualified = seqRes.rows[0]?.seq;
    if (!qualified) {
      throw new Error(`table ${t.schema}.${t.table} has no serial 'seq' column — schema drift?`);
    }
    const [seqSchema, seqName] = qualified.split('.', 2) as [string, string];
    await client.query(`GRANT USAGE ON SEQUENCE ${qIdent(seqSchema)}.${qIdent(seqName)} TO ${role}`);
  }
}

export type OpsRoleMode = 'brain' | 'dedicated';

export function dedicatedRoleCreateSql(roleName: string): string {
  return `CREATE ROLE ${qIdent(roleName)} LOGIN PASSWORD '<choose-a-password>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`;
}

// opts.role: dedicated mode's operator-supplied role (required there); in
// brain mode it is a test seam — production always extends roster_brain_rw.
export async function ensureOpsRuntimeRole(
  client: pg.PoolClient,
  mode: OpsRoleMode,
  opts: { role?: string } = {},
): Promise<{ role: string }> {
  const role = mode === 'brain' ? (opts.role ?? BRAIN_RUNTIME_ROLE) : opts.role;
  if (role === undefined || role.length === 0) {
    throw new RosterError({
      header: 'roster: ops runtime role required',
      body: '  database: dedicated needs the operator-supplied runtime role (the user in ROSTER_OPS_URL).',
      remedy: '  Set ROSTER_OPS_URL to a URL whose user is the runtime role, then re-run.',
      exitCode: EXIT_ERROR,
    });
  }
  assertPgIdentifier('role', role);
  if (!(await roleExists(client, role))) {
    if (mode === 'brain') {
      throw new RosterError({
        header: 'roster: brain runtime role missing',
        body: `  role '${role}' does not exist on this database server, so there is nothing to extend with the ops grant set.`,
        remedy: "  Run 'roster brain setup' first — ops piggybacks on the brain runtime role and never creates it silently.",
        exitCode: EXIT_ERROR,
      });
    }
    throw new RosterError({
      header: 'roster: ops runtime role missing',
      body: `  role '${role}' does not exist. roster never creates or credentials roles in dedicated mode (credentials are env-only).`,
      remedy: `  Have the operator run:\n    ${dedicatedRoleCreateSql(role)}\n  then re-run setup.`,
      exitCode: EXIT_ERROR,
    });
  }
  await applyOpsGrants(client, role);
  return { role };
}

// ---------- invariant checker ----------

export type OpsRoleViolationKind =
  | 'missing-role'
  | 'unsafe-attribute'
  | 'settable-role'
  | 'security-definer'
  | 'ownership'
  | 'destructive-privilege'
  | 'column-privilege'
  | 'meta-writable'
  | 'insert-not-allowlisted'
  | 'schema-create'
  | 'public-grant'
  | 'default-privilege'
  | 'sequence-privilege';

export type OpsRoleViolation = { kind: OpsRoleViolationKind; detail: string; remedy: string };
export type OpsRoleReport = { ok: boolean; violations: OpsRoleViolation[] };

const UNSAFE_ATTRIBUTES = [
  { column: 'rolsuper', name: 'SUPERUSER', fix: 'NOSUPERUSER' },
  { column: 'rolcreatedb', name: 'CREATEDB', fix: 'NOCREATEDB' },
  { column: 'rolcreaterole', name: 'CREATEROLE', fix: 'NOCREATEROLE' },
  { column: 'rolreplication', name: 'REPLICATION', fix: 'NOREPLICATION' },
  { column: 'rolbypassrls', name: 'BYPASSRLS', fix: 'NOBYPASSRLS' },
] as const;

const META_TABLES = new Set(['hitl.meta', 'hitl.schema_migrations', 'roster_ops.meta', 'roster_ops.schema_migrations']);

const INSERT_ALLOWLIST = new Set(OPS_INSERT_TABLES.map((t) => `${t.schema}.${t.table}`));

const DEFAULT_ACL_OBJTYPE: Record<string, string> = {
  r: 'TABLES',
  S: 'SEQUENCES',
  f: 'FUNCTIONS',
  T: 'TYPES',
  n: 'SCHEMAS',
};

// Mandatory pre-finalization gate + doctor check. Uses has_*_privilege /
// pg_has_role so DIRECT and INHERITED grants (and PUBLIC) are all accounted
// for; PUBLIC and default-privilege entries are additionally enumerated
// explicitly so the remedy names the exact grant to revoke. Read-only.
export async function checkOpsRoleInvariants(
  client: pg.PoolClient,
  roleName: string,
): Promise<OpsRoleReport> {
  assertPgIdentifier('role', roleName);
  const role = qIdent(roleName);
  const schemas = [...OPS_SCHEMAS];
  const violations: OpsRoleViolation[] = [];

  const attrs = await client.query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_catalog.pg_roles WHERE rolname = $1`,
    [roleName],
  );
  if (attrs.rowCount === 0) {
    return {
      ok: false,
      violations: [
        {
          kind: 'missing-role',
          detail: `role '${roleName}' does not exist`,
          remedy: dedicatedRoleCreateSql(roleName),
        },
      ],
    };
  }
  const attrRow = attrs.rows[0] as Record<string, boolean>;
  for (const attr of UNSAFE_ATTRIBUTES) {
    if (attrRow[attr.column]) {
      violations.push({
        kind: 'unsafe-attribute',
        detail: `role '${roleName}' has ${attr.name}`,
        remedy: `ALTER ROLE ${role} ${attr.fix};`,
      });
    }
  }

  // SET ROLE escalation: any role the runtime login is a (transitive) member
  // of is reachable via SET ROLE even with NOINHERIT — unsafe attributes on
  // those parents defeat the gate exactly like on the login role itself.
  // (Ownership through parents is already covered: the ownership probes below
  // use pg_has_role(..., 'MEMBER').)
  if (!attrRow.rolsuper) {
    const parents = await client.query(
      `SELECT r.rolname, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls
         FROM pg_catalog.pg_roles r
        WHERE r.rolname <> $1
          AND pg_has_role($1, r.oid, 'MEMBER')
          AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)`,
      [roleName],
    );
    for (const row of parents.rows as Array<Record<string, unknown> & { rolname: string }>) {
      for (const attr of UNSAFE_ATTRIBUTES) {
        if (row[attr.column]) {
          violations.push({
            kind: 'settable-role',
            detail: `role '${roleName}' can SET ROLE into '${row.rolname}', which has ${attr.name}`,
            remedy: `REVOKE ${qIdent(row.rolname)} FROM ${role}; -- or: ALTER ROLE ${qIdent(row.rolname)} ${attr.fix};`,
          });
        }
      }
    }
  }

  // Effective-privilege closure: the runtime can SET ROLE into any role it is a
  // (transitive) member of, regardless of INHERIT, and then wield THAT role's
  // full privilege set. So the effective set on ops objects is the UNION over
  // {runtime} ∪ {SET ROLE-reachable}. has_*_privilege(candidate, obj, priv)
  // models "what the runtime can do after SET ROLE candidate"; a bool_or over
  // candidates is the effective privilege. (A superuser runtime is already
  // flagged above; skip the enumeration there to avoid listing every role.)
  const candidateRoles: string[] = [roleName];
  if (!attrRow.rolsuper) {
    const reachable = await client.query(
      `SELECT r.rolname FROM pg_catalog.pg_roles r
        WHERE r.rolname <> $1 AND pg_has_role($1, r.oid, 'MEMBER')`,
      [roleName],
    );
    for (const row of reachable.rows as { rolname: string }[]) candidateRoles.push(row.rolname);
  }

  const db = await client.query(
    `SELECT current_database() AS db,
            pg_get_userbyid(datdba) AS owner,
            pg_has_role($1, datdba, 'MEMBER') AS owns,
            (SELECT bool_or(has_database_privilege(cand, d.oid, 'CREATE')) FROM unnest($2::text[]) cand) AS can_create
       FROM pg_catalog.pg_database d WHERE datname = current_database()`,
    [roleName, candidateRoles],
  );
  const dbRow = db.rows[0] as { db: string; owner: string; owns: boolean; can_create: boolean };
  if (dbRow.owns) {
    violations.push({
      kind: 'ownership',
      detail: `role '${roleName}' owns (or is a member of the owner '${dbRow.owner}' of) database '${dbRow.db}'`,
      remedy: `ALTER DATABASE ${qIdent(dbRow.db)} OWNER TO <admin-role>;`,
    });
  }
  if (dbRow.can_create) {
    violations.push({
      kind: 'schema-create',
      detail: `role '${roleName}' can CREATE schemas in database '${dbRow.db}'`,
      remedy: `REVOKE CREATE ON DATABASE ${qIdent(dbRow.db)} FROM ${role};`,
    });
  }

  const ownedSchemas = await client.query(
    `SELECT n.nspname FROM pg_catalog.pg_namespace n
      WHERE n.nspname = ANY($2) AND pg_has_role($1, n.nspowner, 'MEMBER')`,
    [roleName, schemas],
  );
  for (const row of ownedSchemas.rows as { nspname: string }[]) {
    violations.push({
      kind: 'ownership',
      detail: `role '${roleName}' owns schema '${row.nspname}'`,
      remedy: `ALTER SCHEMA ${qIdent(row.nspname)} OWNER TO <admin-role>;`,
    });
  }
  const ownedObjects = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($2) AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
        AND pg_has_role($1, c.relowner, 'MEMBER')`,
    [roleName, schemas],
  );
  for (const row of ownedObjects.rows as { schema: string; name: string }[]) {
    violations.push({
      kind: 'ownership',
      detail: `role '${roleName}' owns ${row.schema}.${row.name}`,
      remedy: `ALTER TABLE ${qIdent(row.schema)}.${qIdent(row.name)} OWNER TO <admin-role>;`,
    });
  }

  for (const schema of schemas) {
    const canCreate = await client.query(
      `SELECT bool_or(has_schema_privilege(cand, $2, 'CREATE')) AS ok FROM unnest($1::text[]) cand`,
      [candidateRoles, schema],
    );
    if ((canCreate.rows[0] as { ok: boolean }).ok) {
      violations.push({
        kind: 'schema-create',
        detail: `role '${roleName}' can CREATE objects in schema '${schema}'`,
        remedy: `REVOKE CREATE ON SCHEMA ${schema} FROM ${role};`,
      });
    }
  }

  // Effective table privileges = bool_or over the SET ROLE-reachable closure,
  // so a NOINHERIT runtime that can SET ROLE into a parent holding UPDATE/DELETE
  // (etc.) on an ops table is flagged exactly as if it held the grant directly.
  const tables = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name,
            bool_or(has_any_column_privilege(cand, c.oid, 'INSERT')) AS can_insert,
            bool_or(has_table_privilege(cand, c.oid, 'UPDATE')) AS can_update,
            bool_or(has_table_privilege(cand, c.oid, 'DELETE')) AS can_delete,
            bool_or(has_table_privilege(cand, c.oid, 'TRUNCATE')) AS can_truncate,
            bool_or(has_table_privilege(cand, c.oid, 'TRIGGER')) AS can_trigger,
            bool_or(has_table_privilege(cand, c.oid, 'REFERENCES')) AS can_references
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest($1::text[]) AS cand
      WHERE n.nspname = ANY($2) AND c.relkind IN ('r', 'p', 'v', 'm')
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [candidateRoles, schemas],
  );
  for (const row of tables.rows as {
    schema: string;
    name: string;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
    can_truncate: boolean;
    can_trigger: boolean;
    can_references: boolean;
  }[]) {
    const qualified = `${row.schema}.${row.name}`;
    const flags: Array<[string, boolean]> = [
      ['UPDATE', row.can_update],
      ['DELETE', row.can_delete],
      ['TRUNCATE', row.can_truncate],
      ['REFERENCES', row.can_references],
      ['TRIGGER', row.can_trigger],
    ];
    for (const [priv, held] of flags) {
      if (held) {
        violations.push({
          kind: 'destructive-privilege',
          detail: `role '${roleName}' holds ${priv} (direct, inherited, or SET ROLE-reachable) on ${qualified}`,
          remedy: `REVOKE ${priv} ON ${qualified} FROM ${role}; -- if inherited/reachable, also revoke from (or drop membership in) the granting role`,
        });
      }
    }
    if (row.can_insert && META_TABLES.has(qualified)) {
      violations.push({
        kind: 'meta-writable',
        detail: `role '${roleName}' can INSERT into ${qualified} — meta is admin-authored, runtime-read-only`,
        remedy: `REVOKE INSERT ON ${qualified} FROM ${role};`,
      });
    } else if (row.can_insert && !INSERT_ALLOWLIST.has(qualified)) {
      violations.push({
        kind: 'insert-not-allowlisted',
        detail: `role '${roleName}' can INSERT into ${qualified}, which is not an append table`,
        remedy: `REVOKE INSERT ON ${qualified} FROM ${role};`,
      });
    }
  }

  // Column-level UPDATE (append-only tables permit NO update at any grain). A
  // column grant is invisible to table-level has_table_privilege, so scan every
  // column of the ops tables per candidate; only report columns NOT already
  // covered by a flagged table-level UPDATE (avoids duplicate noise).
  const columnUpdates = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name, a.attname AS column
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       CROSS JOIN unnest($1::text[]) AS cand
      WHERE n.nspname = ANY($2) AND c.relkind IN ('r', 'p')
        AND has_column_privilege(cand, c.oid, a.attnum, 'UPDATE')
        AND NOT has_table_privilege(cand, c.oid, 'UPDATE')
      GROUP BY 1, 2, 3
      ORDER BY 1, 2, 3`,
    [candidateRoles, schemas],
  );
  for (const row of columnUpdates.rows as { schema: string; name: string; column: string }[]) {
    const qualified = `${row.schema}.${row.name}`;
    violations.push({
      kind: 'column-privilege',
      detail: `role '${roleName}' holds column-level UPDATE on ${qualified}(${row.column}) — the ops tables are append-only (no UPDATE at any grain)`,
      remedy: `REVOKE UPDATE (${qIdent(row.column)}) ON ${qIdent(row.schema)}.${qIdent(row.name)} FROM ${role}; -- if inherited/reachable, revoke from the granting role`,
    });
  }

  const publicGrants = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name, a.privilege_type AS priv
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
            LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = ANY($1) AND c.relacl IS NOT NULL
        AND c.relkind IN ('r', 'p', 'S', 'v', 'm') AND a.grantee = 0`,
    [schemas],
  );
  for (const row of publicGrants.rows as { schema: string; name: string; priv: string }[]) {
    violations.push({
      kind: 'public-grant',
      detail: `${row.schema}.${row.name} grants ${row.priv} to PUBLIC`,
      remedy: `REVOKE ${row.priv} ON ${qIdent(row.schema)}.${qIdent(row.name)} FROM PUBLIC;`,
    });
  }

  const defaultAcls = await client.query(
    `SELECT pg_get_userbyid(d.defaclrole) AS grantor,
            n.nspname AS schema,
            d.defaclobjtype AS objtype,
            a.privilege_type AS priv,
            a.grantee AS grantee_oid,
            CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
            (a.grantee <> 0 AND pg_has_role($1, a.grantee, 'MEMBER')) AS reaches_role
       FROM pg_catalog.pg_default_acl d
       LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace,
            LATERAL aclexplode(d.defaclacl) a
      WHERE d.defaclnamespace = 0 OR n.nspname = ANY($2)`,
    [roleName, schemas],
  );
  for (const row of defaultAcls.rows as {
    grantor: string;
    schema: string | null;
    objtype: string;
    priv: string;
    grantee_oid: number;
    grantee: string;
    reaches_role: boolean;
  }[]) {
    const toPublic = row.grantee_oid === 0;
    const harmless = row.priv === 'SELECT' && !toPublic && row.reaches_role;
    if (!toPublic && !row.reaches_role) continue;
    if (harmless) continue;
    const objtype = DEFAULT_ACL_OBJTYPE[row.objtype] ?? row.objtype;
    const scope = row.schema === null ? '' : ` IN SCHEMA ${qIdent(row.schema)}`;
    violations.push({
      kind: 'default-privilege',
      detail: `default privileges by '${row.grantor}'${row.schema ? ` in schema '${row.schema}'` : ' (database-wide)'} grant ${row.priv} on future ${objtype} to ${row.grantee}`,
      remedy: `ALTER DEFAULT PRIVILEGES FOR ROLE ${qIdent(row.grantor)}${scope} REVOKE ${row.priv} ON ${objtype} FROM ${toPublic ? 'PUBLIC' : qIdent(row.grantee)};`,
    });
  }

  // Sequence allowlist: the ONLY sequence privilege the grant set hands out is
  // USAGE (nextval) on the append tables' bigserial seq sequences. UPDATE
  // (setval) is destructive everywhere; USAGE/SELECT on any sequence outside
  // the exact allowlist is state mutation outside the promised grant set.
  const allowedSequences = new Set<string>();
  for (const t of OPS_INSERT_TABLES) {
    if (!t.serial) continue;
    const seqRes = await client.query<{ seq: string | null }>(
      `SELECT pg_get_serial_sequence($1, 'seq') AS seq`,
      [`${t.schema}.${t.table}`],
    );
    const qualified = seqRes.rows[0]?.seq;
    if (qualified) allowedSequences.add(qualified.replace(/"/g, ''));
  }
  const sequences = await client.query(
    `SELECT n.nspname AS schema, c.relname AS name,
            bool_or(has_sequence_privilege(cand, c.oid, 'USAGE')) AS can_usage,
            bool_or(has_sequence_privilege(cand, c.oid, 'SELECT')) AS can_select,
            bool_or(has_sequence_privilege(cand, c.oid, 'UPDATE')) AS can_setval
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN unnest($1::text[]) AS cand
      WHERE n.nspname = ANY($2) AND c.relkind = 'S'
      GROUP BY 1, 2`,
    [candidateRoles, schemas],
  );
  for (const row of sequences.rows as {
    schema: string;
    name: string;
    can_usage: boolean;
    can_select: boolean;
    can_setval: boolean;
  }[]) {
    const qualified = `${row.schema}.${row.name}`;
    const allowlisted = allowedSequences.has(qualified);
    if (row.can_setval) {
      violations.push({
        kind: 'sequence-privilege',
        detail: `role '${roleName}' holds UPDATE (setval) on sequence ${qualified} — only USAGE (nextval) on the append-table sequences is allowed`,
        remedy: `REVOKE UPDATE ON SEQUENCE ${qIdent(row.schema)}.${qIdent(row.name)} FROM ${role};`,
      });
    }
    if (allowlisted) continue;
    for (const [priv, held] of [
      ['USAGE', row.can_usage],
      ['SELECT', row.can_select],
    ] as Array<[string, boolean]>) {
      if (held) {
        violations.push({
          kind: 'sequence-privilege',
          detail: `role '${roleName}' holds ${priv} on sequence ${qualified}, which is not an append-table sequence`,
          remedy: `REVOKE ${priv} ON SEQUENCE ${qIdent(row.schema)}.${qIdent(row.name)} FROM ${role};`,
        });
      }
    }
  }

  // SECURITY DEFINER escape hatch across ALL (non-system) schemas: a definer-
  // rights function anywhere that ANY reachable candidate (or PUBLIC — functions
  // default to PUBLIC EXECUTE) can execute runs with its OWNER's privileges. If
  // the owner can write the ops tables (superuser, or holds INSERT/UPDATE/DELETE/
  // TRUNCATE on an ops schema), that function is a write path into the ops data
  // that every direct-grant probe reports clean — e.g. a public.escalate()
  // owned by admin that updates hitl.meta.
  //
  // owner_can_write must account for COLUMN-level grants: a definer owner holding
  // only UPDATE(workspace_name)/INSERT(col) on an ops table (table-level
  // has_table_privilege stays FALSE) can still mutate ops through the function.
  // has_any_column_privilege is true when the privilege is held at table OR
  // column grain, so it subsumes the table-level probe for INSERT/UPDATE; DELETE
  // and TRUNCATE have no column grain, so they stay has_table_privilege.
  const definers = await client.query(
    `SELECT n.nspname AS schema, p.proname AS name,
            pg_get_function_identity_arguments(p.oid) AS args,
            pg_get_userbyid(p.proowner) AS owner,
            EXISTS (SELECT 1 FROM unnest($1::text[]) cand WHERE has_function_privilege(cand, p.oid, 'EXECUTE')) AS can_execute,
            (ro.rolsuper OR EXISTS (
               SELECT 1 FROM pg_catalog.pg_class oc
                 JOIN pg_catalog.pg_namespace onn ON onn.oid = oc.relnamespace
                WHERE onn.nspname = ANY($2) AND oc.relkind IN ('r', 'p')
                  AND (has_any_column_privilege(p.proowner, oc.oid, 'INSERT')
                    OR has_any_column_privilege(p.proowner, oc.oid, 'UPDATE')
                    OR has_table_privilege(p.proowner, oc.oid, 'DELETE')
                    OR has_table_privilege(p.proowner, oc.oid, 'TRUNCATE'))
             )) AS owner_can_write
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_roles ro ON ro.oid = p.proowner
      WHERE p.prosecdef
        AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`,
    [candidateRoles, schemas],
  );
  for (const row of definers.rows as {
    schema: string;
    name: string;
    args: string;
    owner: string;
    can_execute: boolean;
    owner_can_write: boolean;
  }[]) {
    if (!row.can_execute || !row.owner_can_write) continue;
    const signature = `${qIdent(row.schema)}.${qIdent(row.name)}(${row.args})`;
    violations.push({
      kind: 'security-definer',
      detail: `SECURITY DEFINER function ${row.schema}.${row.name}(${row.args}) (owner '${row.owner}', who can write the ops tables) is executable by role '${roleName}' (or a reachable role / PUBLIC) and runs with its owner's privileges`,
      remedy: `REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC; REVOKE EXECUTE ON FUNCTION ${signature} FROM ${role};`,
    });
  }

  return { ok: violations.length === 0, violations };
}
