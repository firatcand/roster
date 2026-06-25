import pg from 'pg';

export type BrainRole = 'admin' | 'runtime';

const ENV_FOR_ROLE: Record<BrainRole, string> = {
  admin: 'ROSTER_BRAIN_ADMIN_URL',
  runtime: 'ROSTER_BRAIN_URL',
};

export function resolveBrainUrl(role: BrainRole): string {
  const envVar = ENV_FOR_ROLE[role];
  const url = process.env[envVar];
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error(`${envVar} is not set`);
  }
  return url;
}

export function createBrainPool(role: BrainRole, urlOverride?: string): pg.Pool {
  const connectionString = urlOverride ?? resolveBrainUrl(role);
  return new pg.Pool({ connectionString, max: 4 });
}

export async function withBrainClient<T>(
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
