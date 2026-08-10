import { readWorkspaceFile } from './workspace-io.ts';
import {
  MAX_AUTHORED_YAML_BYTES,
  classifyBrainDeclaration,
  parseWorkspaceRegistry,
  type WorkspaceBrainConfig,
} from './workspace-record.ts';
import {
  isWorkspaceFailure,
  workspaceFailure,
  type WorkspaceRosterError,
} from './workspace-diagnostics.ts';

// The ambient variable names are inlined rather than imported from
// persistence/pool.ts: that module loads `pg`, which this shared activation
// predicate must never pull in (it is consumed by boundary code that may hold no
// database or object-storage client).
export const BRAIN_ACTIVATION_ENV = Object.freeze({
  runtimeUrl: 'ROSTER_BRAIN_URL',
  adminUrl: 'ROSTER_BRAIN_ADMIN_URL',
  stagedRuntimeUrl: 'ROSTER_BRAIN_URL_NEXT',
  objectStorageAccessKeyId: 'AWS_ACCESS_KEY_ID',
  objectStorageSecretAccessKey: 'AWS_SECRET_ACCESS_KEY',
});

export type BrainActivationHalf = 'postgresql' | 'object-storage';

export type BrainCredentialRequirement = {
  postgres: 'admin' | 'runtime' | 'admin+runtime';
  objectStorage: 'declared' | 'live';
};

export type BrainActivationConfig =
  | { status: 'absent' }
  | { status: 'incomplete'; axis: 'declaration' | 'ambient'; missing: readonly BrainActivationHalf[] }
  | { status: 'complete'; workspaceId: string; brain: WorkspaceBrainConfig };

export function brainNotConfiguredFailure(): WorkspaceRosterError {
  return workspaceFailure(
    'BRAIN_NOT_CONFIGURED',
    'This workspace has no tracked Brain configuration.',
    'Add the non-secret brain block to roster.yaml before using its database.',
    { path: 'roster.yaml' },
  );
}

export function brainConfigurationIncompleteFailure(
  axis: 'declaration' | 'ambient',
  missing: readonly BrainActivationHalf[],
): WorkspaceRosterError {
  return workspaceFailure(
    'BRAIN_CONFIGURATION_INCOMPLETE',
    'This workspace declares only part of its Brain; PostgreSQL and object storage are indivisible.',
    axis === 'declaration'
      ? 'Complete the brain block in roster.yaml with both brain.secrets_path and brain.storage (bucket + region).'
      : 'Supply the ambient object-storage credentials for this workspace before running an object-storage command.',
    { path: 'roster.yaml', axis, missing: [...missing] },
  );
}

export function brainAdminCredentialInvalidFailure(
  reason: 'missing' | 'malformed',
  secretsPath: string,
): WorkspaceRosterError {
  return workspaceFailure(
    'BRAIN_ADMIN_CREDENTIAL_INVALID',
    'The ambient Brain admin credential is missing or malformed.',
    'Inject a PostgreSQL admin URL from the tracked secret path before running an administrative Brain command.',
    { reason, env: BRAIN_ACTIVATION_ENV.adminUrl, secrets_path: secretsPath },
  );
}

function readRegistryText(cwd: string): string {
  let bytes: Buffer;
  try {
    bytes = readWorkspaceFile(cwd, 'roster.yaml', { maxBytes: MAX_AUTHORED_YAML_BYTES });
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'PARENT_NOT_FOUND') {
      throw workspaceFailure(
        'WORKSPACE_NOT_FOUND',
        'No schema-v2 roster.yaml exists in this directory.',
        'Run roster init in a new directory, or use the explicit migration command for a legacy workspace.',
        { root: cwd },
      );
    }
    throw error;
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw workspaceFailure(
      'YAML_INVALID',
      'roster.yaml: authored text is not valid UTF-8.',
      'Encode the authored workspace definition as valid UTF-8 before retrying.',
      { path: 'roster.yaml', reason: 'invalid-utf8' },
    );
  }
  return text;
}

function hasObjectStorageCredentials(env: NodeJS.ProcessEnv): boolean {
  return typeof env[BRAIN_ACTIVATION_ENV.objectStorageAccessKeyId] === 'string'
    && env[BRAIN_ACTIVATION_ENV.objectStorageAccessKeyId]!.length > 0
    && typeof env[BRAIN_ACTIVATION_ENV.objectStorageSecretAccessKey] === 'string'
    && env[BRAIN_ACTIVATION_ENV.objectStorageSecretAccessKey]!.length > 0;
}

export function resolveBrainActivationConfig(
  cwd: string,
  requirement: BrainCredentialRequirement,
  env: NodeJS.ProcessEnv = process.env,
): BrainActivationConfig {
  const text = readRegistryText(cwd);
  const declaration = classifyBrainDeclaration(text);
  if (declaration.status === 'absent') return { status: 'absent' };
  if (declaration.status === 'partial') {
    return { status: 'incomplete', axis: 'declaration', missing: declaration.missing };
  }
  const registry = parseWorkspaceRegistry(text);
  if (registry.brain === undefined) return { status: 'absent' };
  if (requirement.objectStorage === 'live' && !hasObjectStorageCredentials(env)) {
    return { status: 'incomplete', axis: 'ambient', missing: ['object-storage'] };
  }
  return { status: 'complete', workspaceId: registry.workspace_id, brain: registry.brain };
}

export function assertBrainAdminCredential(
  secretsPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const raw = env[BRAIN_ACTIVATION_ENV.adminUrl];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw brainAdminCredentialInvalidFailure('missing', secretsPath);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw brainAdminCredentialInvalidFailure('malformed', secretsPath);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw brainAdminCredentialInvalidFailure('malformed', secretsPath);
  }
}

function normalizeRequirement(
  requirement: BrainCredentialRequirement | BrainCredentialRequirement['postgres'],
): BrainCredentialRequirement {
  return typeof requirement === 'string'
    ? { postgres: requirement, objectStorage: 'declared' }
    : requirement;
}

// `admin+runtime` (init) deliberately does NOT assert the admin credential here:
// the shipped ordering resolves the runtime credential first, so connect.ts calls
// assertBrainAdminCredential itself once the runtime half has been accepted.
export function assertBrainActivationComplete(
  cwd: string,
  requirement: BrainCredentialRequirement | BrainCredentialRequirement['postgres'],
  env: NodeJS.ProcessEnv = process.env,
): { workspaceId: string; brain: WorkspaceBrainConfig } {
  const resolved = normalizeRequirement(requirement);
  const declared = resolveBrainActivationConfig(
    cwd,
    { postgres: resolved.postgres, objectStorage: 'declared' },
    env,
  );
  if (declared.status === 'absent') throw brainNotConfiguredFailure();
  if (declared.status === 'incomplete') {
    throw brainConfigurationIncompleteFailure(declared.axis, declared.missing);
  }
  if (resolved.postgres === 'admin') {
    assertBrainAdminCredential(declared.brain.secrets_path, env);
  }
  if (resolved.objectStorage === 'live' && !hasObjectStorageCredentials(env)) {
    throw brainConfigurationIncompleteFailure('ambient', ['object-storage']);
  }
  return { workspaceId: declared.workspaceId, brain: declared.brain };
}
