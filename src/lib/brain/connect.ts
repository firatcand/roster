import type pg from 'pg';
import {
  BRAIN_ENV_BINDING,
  createRolePool,
  resolveRoleUrl,
  type PersistenceRole,
} from '../persistence/pool.ts';

export type BrainRole = PersistenceRole;

export function resolveBrainUrl(role: BrainRole): string {
  return resolveRoleUrl(BRAIN_ENV_BINDING, role);
}

export function createBrainPool(role: BrainRole, urlOverride?: string): pg.Pool {
  return createRolePool(BRAIN_ENV_BINDING, role, urlOverride);
}

export { withPoolClient as withBrainClient } from '../persistence/pool.ts';
