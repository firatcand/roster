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

export function createRolePool(
  binding: RoleEnvBinding,
  role: PersistenceRole,
  urlOverride?: string,
): pg.Pool {
  const connectionString = urlOverride ?? resolveRoleUrl(binding, role);
  return new pg.Pool({ connectionString, max: 4 });
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
