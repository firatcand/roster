import pg from 'pg';

export type PersistenceRole = 'admin' | 'runtime';

export type RoleEnvBinding = Record<PersistenceRole, string>;

export const BRAIN_ENV_BINDING: RoleEnvBinding = {
  admin: 'ROSTER_BRAIN_ADMIN_URL',
  runtime: 'ROSTER_BRAIN_URL',
};

export const OPS_ENV_BINDING: RoleEnvBinding = {
  admin: 'ROSTER_OPS_ADMIN_URL',
  runtime: 'ROSTER_OPS_URL',
};

export function resolveRoleUrl(
  binding: RoleEnvBinding,
  role: PersistenceRole,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const envVar = binding[role];
  const url = env[envVar];
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`${envVar} is not set`);
  }
  return url;
}

// A pooled client that is IDLE has no caller to reject, so node-postgres reports
// its failure on the Pool itself. `pg_terminate_backend` (every throwaway-database
// teardown issues one), a server restart, or an idle-timeout cut therefore emits
// 'error' on the Pool — and an EventEmitter 'error' with NO listener is rethrown
// as a process-level uncaughtException. That is not hypothetical: it crashed CI
// on #383 with `terminating connection due to administrator command`, attributed
// to whichever test happened to be running when the notice landed.
//
// The pool has already evicted the broken client by the time this fires and the
// next connect() opens a fresh one, so there is nothing to propagate and nothing
// a caller could act on. Every Pool this codebase constructs must attach it.
export function attachPoolIdleErrorHandler(pool: pg.Pool): pg.Pool {
  pool.on('error', () => {});
  return pool;
}

export function createRolePool(
  binding: RoleEnvBinding,
  role: PersistenceRole,
  urlOverride?: string,
): pg.Pool {
  const connectionString = urlOverride ?? resolveRoleUrl(binding, role);
  return attachPoolIdleErrorHandler(new pg.Pool({ connectionString, max: 4 }));
}

export async function withPoolClient<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
