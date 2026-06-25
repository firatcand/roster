import type pg from 'pg';
import { RUNTIME_ROLE } from './roles.ts';
import { pendingMigrations } from './migrate.ts';

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type DoctorReport = {
  ok: boolean;
  roleExists: boolean;
  roles: string[];
  checks: DoctorCheck[];
  pending: string[];
  tables: string[];
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
    await check(
      client,
      'no-inbound-members',
      'no other role is a member of the runtime role',
      'runtime role has inbound members',
      `SELECT m.rolname FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.roleid
         JOIN pg_roles m ON m.oid = am.member
        WHERE r.rolname = $1`,
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
        WHERE n.nspname IN ('brain', 'brain_meta') AND o.rolname = $1
       UNION ALL
       SELECT 'schema ' || s.nspname AS obj
         FROM pg_namespace s
         JOIN pg_roles o ON o.oid = s.nspowner
        WHERE s.nspname IN ('brain', 'brain_meta') AND o.rolname = $1
       UNION ALL
       SELECT 'function ' || n.nspname || '.' || p.proname AS obj
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         JOIN pg_roles o ON o.oid = p.proowner
        WHERE n.nspname IN ('brain', 'brain_meta') AND o.rolname = $1`,
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
        WHERE s.nspname IN ('brain', 'public', 'brain_meta')
          AND has_schema_privilege($1, s.nspname, 'CREATE')`,
      [roleName],
    ),
  );

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
      'runtime role cannot INSERT audit columns id/recorded_at',
      'runtime role has INSERT on audit column',
      `SELECT n.nspname || '.' || c.relname || '.' || a.attname AS obj
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'brain' AND c.relkind = 'r'
          AND a.attname IN ('id', 'recorded_at')
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

export async function runDoctor(pool: pg.Pool, roleName: string = RUNTIME_ROLE): Promise<DoctorReport> {
  const client = await pool.connect();
  try {
    const roleRow = await client.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [roleName]);
    const roleExists = (roleRow.rowCount ?? 0) > 0;

    const tablesRow = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'brain' ORDER BY tablename`,
    );
    const tables = tablesRow.rows.map((r) => r.tablename);

    const pending = await pendingMigrations(pool);

    if (!roleExists) {
      return {
        ok: false,
        roleExists: false,
        roles: [],
        checks: [{ name: 'runtime-role-exists', ok: false, detail: `${roleName} not found` }],
        pending,
        tables,
      };
    }

    const roles = await registeredRoles(client, roleName);
    const checks: DoctorCheck[] = [];
    for (const role of roles) {
      checks.push(...(await checksForRole(client, role)));
    }

    const ok = checks.every((c) => c.ok);
    return { ok, roleExists: true, roles, checks, pending, tables };
  } finally {
    client.release();
  }
}
