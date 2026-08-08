import type pg from 'pg';
import {
  BRAIN_ENV_BINDING,
  createRolePool,
  resolveRoleUrl,
  type PersistenceRole,
} from '../persistence/pool.ts';
import { EXIT_ERROR, isRosterError, RosterError } from '../errors.ts';
import { readWorkspaceRegistry } from '../workspace-registry.ts';
import { isWorkspaceFailure, workspaceFailure } from '../workspace-diagnostics.ts';
import { deriveWorkspaceRuntimeRoleName, RUNTIME_ROLE } from './roles.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  createVerifiedBrainPool as createAuthorityVerifiedBrainPool,
  deriveBrainWorkspaceAuthority,
  type BrainAuthorityBootstrapResult,
  type BrainWorkspaceAuthority,
  type VerifiedBrainPool,
} from './workspace-authority.ts';

export type BrainRole = PersistenceRole;

export function resolveBrainUrl(role: BrainRole): string {
  return resolveRoleUrl(BRAIN_ENV_BINDING, role);
}

export function createBrainPool(role: BrainRole, urlOverride?: string): pg.Pool {
  return createRolePool(BRAIN_ENV_BINDING, role, urlOverride);
}

function createVerifiedBrainPool(
  role: BrainRole,
  authority: BrainWorkspaceAuthority,
  urlOverride?: string,
  databaseAuthorityId?: string,
): VerifiedBrainPool {
  return createAuthorityVerifiedBrainPool({
    connectionString: urlOverride ?? resolveBrainUrl(role),
    authority,
    ...(databaseAuthorityId === undefined ? {} : { databaseAuthorityId }),
  });
}

function requireBrainConfig(cwd: string) {
  const registry = readWorkspaceRegistry(cwd).registry;
  if (registry.brain === undefined) {
    throw workspaceFailure(
      'BRAIN_NOT_CONFIGURED',
      'This workspace has no tracked Brain configuration.',
      'Add the non-secret brain block to roster.yaml before using its database.',
      { path: 'roster.yaml' },
    );
  }
  return {
    workspaceId: registry.workspace_id,
    brain: registry.brain,
    secretsPath: registry.brain.secrets_path,
  };
}

function runtimeCredentialFailure(
  expectedRole: string,
  secretsPath: string,
  reason: 'missing' | 'malformed' | 'role-mismatch' | 'password-invalid' | 'verification-failed',
): RosterError {
  return new RosterError({
    header: 'Brain runtime credential rejected',
    body: `The ambient ROSTER_BRAIN_URL does not satisfy this workspace runtime-role contract. Expected role "${expectedRole}" from Infisical path "${secretsPath}".`,
    remedy: 'Store a PostgreSQL URL with the expected role and a 43–128 character base64url password under the tracked Infisical path, then retry.',
    exitCode: EXIT_ERROR,
    code: 'BRAIN_RUNTIME_CREDENTIAL_INVALID',
    details: {
      reason,
      role_name: expectedRole,
      secrets_path: secretsPath,
    },
  });
}

function resolveRuntimeCredential(expectedRole: string, secretsPath: string): {
  connectionString: string;
  password: string;
} {
  const connectionString = process.env[BRAIN_ENV_BINDING.runtime];
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw runtimeCredentialFailure(expectedRole, secretsPath, 'missing');
  }
  let parsed: URL;
  let username: string;
  let password: string;
  try {
    parsed = new URL(connectionString);
    username = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw runtimeCredentialFailure(expectedRole, secretsPath, 'malformed');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw runtimeCredentialFailure(expectedRole, secretsPath, 'malformed');
  }
  if (username !== expectedRole) {
    throw runtimeCredentialFailure(expectedRole, secretsPath, 'role-mismatch');
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(password)) {
    throw runtimeCredentialFailure(expectedRole, secretsPath, 'password-invalid');
  }
  return { connectionString, password };
}

export function resolveBrainDoctorRoleName(cwd: string, roleBase: string = RUNTIME_ROLE): string {
  try {
    const workspace = requireBrainConfig(cwd);
    return deriveWorkspaceRuntimeRoleName(workspace.workspaceId, roleBase);
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'WORKSPACE_NOT_FOUND') return roleBase;
    throw error;
  }
}

// #356: the runtime seam every Brain runtime verb should open. Authority is
// derived from the tracked workspace record, so complete Brain configuration
// (including the S3 namespace the fingerprint covers) is structurally required
// before a single evidence row can be written. Callers close it in `finally`.
export function openVerifiedRuntimePool(
  cwd: string,
  roleBase: string = RUNTIME_ROLE,
): VerifiedBrainPool {
  const workspace = requireBrainConfig(cwd);
  const authority = deriveBrainWorkspaceAuthority(workspace.workspaceId, workspace.brain);
  const expectedRole = deriveWorkspaceRuntimeRoleName(workspace.workspaceId, roleBase);
  const credential = resolveRuntimeCredential(expectedRole, workspace.secretsPath);
  return createVerifiedBrainPool('runtime', authority, credential.connectionString);
}

type InitializeCleanBrainOptions = {
  cwd: string;
  adminUrl?: string;
  role?: string;
};

type InitializeCleanBrainResult = {
  bootstrap: BrainAuthorityBootstrapResult;
  adminRole: string;
};

export async function initializeCleanBrain(
  options: InitializeCleanBrainOptions,
): Promise<InitializeCleanBrainResult> {
  const workspace = requireBrainConfig(options.cwd);
  const authority = deriveBrainWorkspaceAuthority(workspace.workspaceId, workspace.brain);
  const roleBase = options.role ?? RUNTIME_ROLE;
  const expectedRole = deriveWorkspaceRuntimeRoleName(workspace.workspaceId, roleBase);
  const runtimeCredential = resolveRuntimeCredential(expectedRole, workspace.secretsPath);
  const adminUrl = options.adminUrl ?? resolveBrainUrl('admin');
  const bootstrapPool = createBrainPool('admin', adminUrl);
  let bootstrap: BrainAuthorityBootstrapResult;
  try {
    bootstrap = await bootstrapBrainWorkspaceAuthority(
      bootstrapPool,
      authority,
      { runtimeRole: roleBase, runtimePassword: runtimeCredential.password },
    );
  } finally {
    await bootstrapPool.end();
  }

  const verifiedAdminPool = createVerifiedBrainPool(
    'admin',
    authority,
    adminUrl,
    bootstrap.databaseAuthorityId,
  );
  let adminRole: string;
  try {
    adminRole = (await verifiedAdminPool.query<{ u: string }>(
      'SELECT quote_ident(current_user) AS u',
    )).rows[0]!.u;
  } finally {
    await verifiedAdminPool.end();
  }

  const verifiedRuntimePool = createVerifiedBrainPool(
    'runtime',
    authority,
    runtimeCredential.connectionString,
    bootstrap.databaseAuthorityId,
  );
  try {
    const runtimeRole = (await verifiedRuntimePool.query<{ u: string }>(
      'SELECT current_user AS u',
    )).rows[0]?.u;
    if (runtimeRole !== expectedRole) {
      throw runtimeCredentialFailure(expectedRole, workspace.secretsPath, 'verification-failed');
    }
  } catch (error) {
    if (isRosterError(error)) throw error;
    throw runtimeCredentialFailure(expectedRole, workspace.secretsPath, 'verification-failed');
  } finally {
    await verifiedRuntimePool.end();
  }
  return { bootstrap, adminRole };
}

export { withPoolClient as withBrainClient } from '../persistence/pool.ts';
