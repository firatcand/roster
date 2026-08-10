import type pg from 'pg';
import { RUNTIME_ROLE } from './roles.ts';
import { pendingMigrations } from './migrate.ts';

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

// #383 (AC-3): diagnostics may inspect protected metadata before identity is
// ready, but may never read company content or touch object storage. Both are
// structural here — doctor imports no S3 client and selects no company table —
// and both are asserted in the report so a regression is machine-detectable.
export type DoctorIdentityState = 'uninitialized' | 'migrating' | 'ready';

export type DoctorReport = {
  ok: boolean;
  roleExists: boolean;
  roles: string[];
  checks: DoctorCheck[];
  pending: string[];
  tables: string[];
  identity_state: DoctorIdentityState;
  object_storage_contacted: false;
  company_content_read: false;
};

// Only `connect()` is used, so the verified/diagnostic authority pools satisfy
// this without exposing a raw pg.Pool to callers.
export type DoctorConnectable = {
  connect(): Promise<pg.PoolClient>;
};

async function check(
  client: pg.PoolClient,
  name: string,
  okWhenEmpty: string,
  failPrefix: string,
  sql: string,
  params: unknown[] = [],
): Promise<DoctorCheck> {
  const r = await client.query(sql, params);
  const violations = r.rows.map((row) => Object.values(row).join(' ')).filter((v) => v.length > 0);
  if ((r.rowCount ?? 0) === 0) {
    return { name, ok: true, detail: okWhenEmpty };
  }
  return { name, ok: false, detail: `${failPrefix}: ${violations.join(', ')}` };
}

// Protected metadata only, and readable before identity is ready — which is
// exactly the authority AC-3 grants diagnostics. Derived here so the whole
// three-field AC-3 contract lives in the library report, not in a CLI patch.
async function readIdentityState(client: pg.PoolClient): Promise<DoctorIdentityState> {
  const relation = await client.query<{ relation: string | null }>(
    `SELECT to_regclass('brain_meta.workspace_identity')::text AS relation`,
  );
  if (relation.rows[0]?.relation !== 'brain_meta.workspace_identity') return 'uninitialized';
  const row = await client.query<{ migration_state: string }>(
    `SELECT migration_state FROM brain_meta.workspace_identity`,
  );
  if (row.rows.length !== 1) return 'uninitialized';
  return row.rows[0]!.migration_state === 'ready' ? 'ready' : 'migrating';
}

async function registeredRoles(client: pg.PoolClient, requested: string): Promise<string[]> {
  const reg = await client.query<{ rolname: string }>(
    `SELECT rr.rolname FROM brain_meta.runtime_roles rr
       JOIN pg_roles r ON r.rolname = rr.rolname
      ORDER BY rr.rolname`,
  );
  const names = reg.rows.map((r) => r.rolname);
  if (!names.includes(requested)) names.unshift(requested);
  return names;
}

async function checksForRole(client: pg.PoolClient, roleName: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push(
    await check(
      client,
      'no-superuser-attrs',
      'runtime role has no SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS/REPLICATION',
      'runtime role has elevated attributes',
      `SELECT rolname FROM pg_roles
        WHERE rolname = $1
          AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication)`,
      [roleName],
    ),
  );

  checks.push(
    await check(
      client,
      'not-admin-member',
      'runtime role is not a member of any other role',
      'runtime role is a member of',
      `SELECT g.rolname FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
         JOIN pg_roles g ON g.oid = m.roleid
        WHERE r.rolname = $1`,
      [roleName],
    ),
  );

  checks.push(
    // The check flags any role that can act AS the restricted runtime role — an
    // escalation path — EXCEPT a member that ALREADY holds ≥ the runtime role's
    // privileges, for which membership grants nothing new. Two such members are
    // whitelisted (ROS-161):
    //   * a superuser — trivially exceeds any role;
    //   * a role that OWNS THE ENTIRE brain surface the runtime role touches —
    //     both the `brain` and `brain_meta` schemas, every table/view in them,
    //     AND every function in them. The runtime role's grants are USAGE on
    //     those schemas, SELECT/INSERT on their tables, SELECT on their views,
    //     and EXECUTE on the SECURITY DEFINER brokers (create_table, canonical_id,
    //     merge_entities); ownership of all of it confers each of those, so
    //     membership adds nothing. Owning only the schema, or only the tables, is
    //     NOT enough — a partial owner would gain the rest via membership, so it
    //     stays flagged.
    // Ownership (nspowner/relowner/proowner) is the right signal because it is
    // independent of the membership under test — has_table_privilege would be
    // circular (the member inherits the runtime grants THROUGH that very
    // membership). This lets `brain doctor` pass on managed Postgres (Neon), where
    // the control plane force-grants the DB owner (`neondb_owner` — it ran the
    // migrations and owns every brain object) into every role via an internal
    // superuser the customer cannot revoke. A genuinely less-privileged inbound
    // member is still a violation.
    await check(
      client,
      'no-inbound-members',
      'no non-privileged role is a member of the runtime role',
      'runtime role has inbound members',
      `SELECT m.rolname FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.roleid
         JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = $1
          AND NOT m.rolsuper
          AND (
            EXISTS (
              SELECT 1 FROM pg_namespace n
               WHERE n.nspname IN ('brain', 'brain_meta', 'brain_evidence') AND n.nspowner <> m.oid
            )
            OR EXISTS (
              SELECT 1 FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname IN ('brain', 'brain_meta', 'brain_evidence')
                 AND c.relkind IN ('r', 'p', 'v', 'm')
                 AND c.relowner <> m.oid
            )
            OR EXISTS (
              SELECT 1 FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname IN ('brain', 'brain_meta', 'brain_evidence') AND p.proowner <> m.oid
            )
          )`,
      [roleName],
    ),
  );

  checks.push(
    await check(
      client,
      'no-owned-objects',
      'runtime role owns no brain/brain_meta tables, schemas, or functions',
      'runtime role owns objects',
      `SELECT n.nspname || '.' || c.relname AS obj
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles o ON o.oid = c.relowner
        WHERE n.nspname IN ('brain', 'brain_meta', 'brain_evidence') AND o.rolname = $1
       UNION ALL
       SELECT 'schema ' || s.nspname AS obj
         FROM pg_namespace s
         JOIN pg_roles o ON o.oid = s.nspowner
        WHERE s.nspname IN ('brain', 'brain_meta', 'brain_evidence') AND o.rolname = $1
       UNION ALL
       SELECT 'function ' || n.nspname || '.' || p.proname AS obj
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles o ON o.oid = p.proowner
        WHERE n.nspname IN ('brain', 'brain_meta', 'brain_evidence') AND o.rolname = $1`,
      [roleName],
    ),
  );

  checks.push(
    await check(
      client,
      'no-schema-create',
      'runtime role has no CREATE on brain or public',
      'runtime role has CREATE on schema',
      `SELECT s.nspname FROM pg_namespace s
        WHERE s.nspname IN ('brain', 'public', 'brain_meta', 'brain_evidence')
          AND has_schema_privilege($1, s.nspname, 'CREATE')`,
      [roleName],
    ),
  );

  // #356: portable evidence is broker-append. The runtime role's brain_evidence
  // privileges must be EXACTLY schema USAGE + table SELECT + EXECUTE on the four
  // record brokers: no direct DML at any granularity, and no EXECUTE on the
  // promotion-adjacent helpers (validation, lock framing, workspace identity).
  // The broker comparison is by full SIGNATURE, not name: an added overload such
  // as record_completed_run(jsonb) is an unapproved executable surface, and a
  // MISSING expected broker must read as a finding rather than a cast error.
  // #357: the generic `no-sequence-privs` audit below is scoped to nspname =
  // 'brain', so a grant on brain_evidence's commit-ordering sequence would have
  // been invisible here while this check's description still promised "exactly
  // USAGE + SELECT + the four record brokers". The last clause closes that hole.
  // SELECT is refused alongside USAGE/UPDATE because `last_value` is an
  // evidence-volume side channel; the `missing SELECT` clause above stays
  // relkind = 'r', so a sequence is never REQUIRED to be readable.
  const hasEvidenceSchema = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM pg_namespace WHERE nspname = 'brain_evidence'`,
  );
  if ((hasEvidenceSchema.rowCount ?? 0) > 0) {
    checks.push(
      await check(
        client,
        'brain-evidence-append-only',
        'runtime role brain_evidence access is exactly USAGE + SELECT + the four record brokers',
        'runtime role brain_evidence privileges are wrong',
        `SELECT 'missing USAGE on brain_evidence'
          WHERE NOT has_schema_privilege($1, 'brain_evidence', 'USAGE')
          UNION ALL
         SELECT 'CREATE on brain_evidence'
          WHERE has_schema_privilege($1, 'brain_evidence', 'CREATE')
          UNION ALL
         SELECT 'missing SELECT on brain_evidence.' || c.relname
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'brain_evidence' AND c.relkind = 'r'
            AND NOT has_table_privilege($1, c.oid, 'SELECT')
          UNION ALL
         SELECT 'brain_evidence.' || c.relname || ' ' || p.priv
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
          WHERE n.nspname = 'brain_evidence' AND c.relkind = 'r'
            AND has_table_privilege($1, c.oid, p.priv)
          UNION ALL
         SELECT 'brain_evidence.' || c.relname || '.' || a.attname || ' ' || p.priv
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid
           CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
          WHERE n.nspname = 'brain_evidence' AND c.relkind = 'r'
            AND a.attnum > 0 AND NOT a.attisdropped
            AND has_column_privilege($1, c.oid, a.attnum, p.priv)
          UNION ALL
         SELECT 'missing EXECUTE on ' || expected.signature
           FROM (VALUES
             ('brain_evidence.record_completed_run(text)'),
             ('brain_evidence.record_run_artifact(text)'),
             ('brain_evidence.record_feedback(text)'),
             ('brain_evidence.record_human_decision(text)')
           ) AS expected(signature)
          WHERE NOT EXISTS (
            SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'brain_evidence'
               AND n.nspname || '.' || p.proname
                   || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' = expected.signature
               AND has_function_privilege($1, p.oid, 'EXECUTE')
          )
          UNION ALL
         SELECT 'unexpected EXECUTE on ' || n.nspname || '.' || p.proname
                || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'brain_evidence'
            AND has_function_privilege($1, p.oid, 'EXECUTE')
            AND n.nspname || '.' || p.proname
                || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' <> ALL (ARRAY[
                  'brain_evidence.record_completed_run(text)',
                  'brain_evidence.record_run_artifact(text)',
                  'brain_evidence.record_feedback(text)',
                  'brain_evidence.record_human_decision(text)'
                ])
          UNION ALL
         SELECT 'brain_evidence.' || c.relname || ' ' || p.priv
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS p(priv)
          WHERE n.nspname = 'brain_evidence' AND c.relkind = 'S'
            AND has_sequence_privilege($1, c.oid, p.priv)`,
        [roleName],
      ),
    );
  }

  // brain_meta access is limited to read-only runtime configuration plus the
  // protected workspace-authority handshake columns. Everything else remains
  // admin-only, including the singleton guard column and every write privilege.
  const hasConfig = await client.query<{ t: string | null }>(
    `SELECT to_regclass('brain_meta.config')::text AS t`,
  );
  if (hasConfig.rows[0]?.t) {
    checks.push(
      await check(
        client,
        'brain-meta-config-read-only',
        'runtime role brain_meta access is exactly USAGE + approved read-only metadata',
        'runtime role brain_meta privileges are wrong',
        `SELECT 'missing USAGE on brain_meta' WHERE NOT has_schema_privilege($1, 'brain_meta', 'USAGE')
          UNION ALL
         SELECT 'missing SELECT on brain_meta.config' WHERE NOT has_table_privilege($1, 'brain_meta.config', 'SELECT')
          UNION ALL
         SELECT 'CREATE on brain_meta' WHERE has_schema_privilege($1, 'brain_meta', 'CREATE')
          UNION ALL
         SELECT 'brain_meta.' || t.relname || ' ' || p.priv
           FROM (VALUES ('schema_migrations'), ('runtime_roles')) AS t(relname)
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
          WHERE has_table_privilege($1, 'brain_meta.' || t.relname, p.priv)
          UNION ALL
         SELECT 'brain_meta.config ' || p.priv
           FROM (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
          WHERE has_table_privilege($1, 'brain_meta.config', p.priv)
          UNION ALL
         SELECT 'brain_meta.workspace_identity ' || p.priv
           FROM (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
          WHERE to_regclass('brain_meta.workspace_identity') IS NOT NULL
            AND has_table_privilege($1, to_regclass('brain_meta.workspace_identity'), p.priv)
          UNION ALL
         SELECT 'missing SELECT on brain_meta.workspace_identity.' || expected.column_name
           FROM (VALUES
             ('workspace_id'),
             ('fingerprint_format_version'),
             ('namespace_fingerprint'),
             ('database_authority_id'),
             ('initialized_at'),
             ('migration_state')
           ) AS expected(column_name)
          WHERE to_regclass('brain_meta.workspace_identity') IS NOT NULL
            AND NOT has_column_privilege(
              $1,
              to_regclass('brain_meta.workspace_identity'),
              expected.column_name,
              'SELECT'
            )
          UNION ALL
         SELECT cp.table_name || '.' || cp.column_name || ' ' || cp.privilege_type
           FROM information_schema.column_privileges cp
          WHERE cp.grantee = $1 AND cp.table_schema = 'brain_meta'
            AND NOT (
              cp.privilege_type = 'SELECT'
              AND (
                cp.table_name = 'config'
                OR (
                  cp.table_name = 'workspace_identity'
                  AND cp.column_name IN (
                    'workspace_id',
                    'fingerprint_format_version',
                    'namespace_fingerprint',
                    'database_authority_id',
                    'initialized_at',
                    'migration_state'
                  )
                )
              )
            )`,
        [roleName],
      ),
    );
  } else {
    checks.push(
      await check(
        client,
        'no-brain-meta-usage',
        'runtime role has no USAGE on brain_meta',
        'runtime role has USAGE on brain_meta',
        `SELECT 'brain_meta' WHERE has_schema_privilege($1, 'brain_meta', 'USAGE')`,
        [roleName],
      ),
    );
  }

  checks.push(
    await check(
      client,
      'no-mutating-table-privs',
      'runtime role has no UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any brain table',
      'runtime role has mutating privileges on',
      `SELECT n.nspname || '.' || c.relname || ' ' || p.priv AS obj
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
        WHERE n.nspname = 'brain' AND c.relkind = 'r'
          AND has_table_privilege($1, c.oid, p.priv)`,
      [roleName],
    ),
  );

  checks.push(
    await check(
      client,
      'no-column-update-privs',
      'runtime role has no column-level UPDATE on any brain table',
      'runtime role has column-level UPDATE on',
      `SELECT n.nspname || '.' || c.relname || '.' || a.attname AS obj
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'brain' AND c.relkind = 'r'
          AND a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege($1, c.oid, a.attnum, 'UPDATE')`,
      [roleName],
    ),
  );

  checks.push(
    await check(
      client,
      'no-table-insert-privs',
      'runtime role has no table-level INSERT on any brain table',
      'runtime role has table-level INSERT on',
      `SELECT n.nspname || '.' || c.relname AS obj
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'brain' AND c.relkind = 'r'
          AND has_table_privilege($1, c.oid, 'INSERT')`,
      [roleName],
    ),
  );

  checks.push(
    await check(
      client,
      'no-audit-column-insert-privs',
      'runtime role cannot INSERT protected columns (id/recorded_at; entities.canonical_id)',
      'runtime role has INSERT on protected column',
      // canonical_id is the materialized cache only on brain.entities; an
      // agent-created table may legitimately have a user column of that name, so
      // the canonical_id protection is scoped to entities (id/recorded_at stay
      // protected on every table).
      `SELECT n.nspname || '.' || c.relname || '.' || a.attname AS obj
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'brain' AND c.relkind = 'r'
          AND (a.attname IN ('id', 'recorded_at')
               OR (a.attname = 'canonical_id' AND c.relname = 'entities'))
          AND has_column_privilege($1, c.oid, a.attnum, 'INSERT')`,
      [roleName],
    ),
  );

  checks.push(
    await check(
      client,
      'no-sequence-privs',
      'runtime role has no USAGE/UPDATE on brain identity sequences',
      'runtime role has sequence privileges on',
      `SELECT n.nspname || '.' || c.relname || ' ' || p.priv AS obj
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('USAGE'), ('UPDATE')) AS p(priv)
        WHERE n.nspname = 'brain' AND c.relkind = 'S'
          AND has_sequence_privilege($1, c.oid, p.priv)`,
      [roleName],
    ),
  );

  return checks.map((c) => ({ ...c, name: `${c.name} [${roleName}]` }));
}

export async function runDoctor(
  pool: DoctorConnectable,
  roleName: string = RUNTIME_ROLE,
): Promise<DoctorReport> {
  const client = await pool.connect();
  try {
    const roleRow = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName]);
    const roleExists = (roleRow.rowCount ?? 0) > 0;

    const tablesRow = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'brain' ORDER BY tablename`,
    );
    const tables = tablesRow.rows.map((r) => r.tablename);

    const pending = await pendingMigrations(pool);
    const identityState = await readIdentityState(client);

    // AC-3's tolerance is structural, not cosmetic: with no protected identity the
    // brain/brain_meta relations every check below reads may not exist at all, and
    // a cluster-wide role of the same name is NOT evidence that they do. Report
    // the state and stop before the first relation-dependent query.
    if (identityState === 'uninitialized') {
      return {
        ok: false,
        roleExists,
        roles: [],
        checks: [{
          name: 'workspace-identity-initialized',
          ok: false,
          detail: 'this database has no protected workspace identity — run roster brain init',
        }],
        pending,
        tables,
        identity_state: identityState,
        object_storage_contacted: false,
        company_content_read: false,
      };
    }

    if (!roleExists) {
      return {
        ok: false,
        roleExists: false,
        roles: [],
        checks: [{ name: 'runtime-role-exists', ok: false, detail: `${roleName} not found` }],
        pending,
        tables,
        identity_state: identityState,
        object_storage_contacted: false,
        company_content_read: false,
      };
    }

    const roles = await registeredRoles(client, roleName);
    const checks: DoctorCheck[] = [];
    for (const role of roles) {
      checks.push(...(await checksForRole(client, role)));
    }

    const ok = checks.every((c) => c.ok);
    return {
      ok,
      roleExists: true,
      roles,
      checks,
      pending,
      tables,
      identity_state: identityState,
      object_storage_contacted: false,
      company_content_read: false,
    };
  } finally {
    client.release();
  }
}
