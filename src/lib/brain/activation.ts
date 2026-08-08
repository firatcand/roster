import { EXIT_ERROR, RosterError, type JsonValue } from '../errors.ts';
import { COMPILED_ACTIVE_EXTRACTORS } from './extractors.ts';
import type { BrainObjectReader, BrainObjectStore } from './object-store.ts';
import type { VerifiedBrainPool } from './workspace-authority.ts';

const activationBrand = Symbol('roster.brain.activation.v1');

export type BrainActivationStore = BrainObjectStore & BrainObjectReader;

export type BrainActivation = Readonly<{
  pool: VerifiedBrainPool;
  objectStore: BrainActivationStore;
  [activationBrand]: true;
}>;

export type BrainExtractionErrorCode =
  | 'BRAIN_EXTRACTION_ACTIVATION_INCOMPLETE'
  | 'BRAIN_EXTRACTION_NAMESPACE_MISMATCH'
  | 'BRAIN_EXTRACTION_ADMIN_REQUIRED'
  | 'BRAIN_EXTRACTION_REGISTRY_DRIFT'
  | 'BRAIN_EXTRACTION_INPUT_INVALID'
  | 'BRAIN_EXTRACTION_SOURCE_NOT_FOUND'
  | 'BRAIN_EXTRACTION_OBJECT_UNVERIFIED'
  | 'BRAIN_EXTRACTION_INTEGRITY_CONFLICT';

const REMEDIES: Readonly<Record<BrainExtractionErrorCode, string>> = Object.freeze({
  BRAIN_EXTRACTION_ACTIVATION_INCOMPLETE:
    'Activate Brain with both the verified database pool and its object store before extracting.',
  BRAIN_EXTRACTION_NAMESPACE_MISMATCH:
    'Use the object store configured for this verified Brain workspace.',
  BRAIN_EXTRACTION_ADMIN_REQUIRED:
    'Run extraction and indexing with the ambient Brain admin credential; the runtime role is read-only here.',
  BRAIN_EXTRACTION_REGISTRY_DRIFT:
    'Upgrade this Brain so its active-extractor registry matches the installed Roster extractors.',
  BRAIN_EXTRACTION_INPUT_INVALID:
    'Supply exact immutable identifiers and bounded options.',
  BRAIN_EXTRACTION_SOURCE_NOT_FOUND:
    'Ingest the source version before extracting it.',
  BRAIN_EXTRACTION_OBJECT_UNVERIFIED:
    'Restore the exact immutable object bytes recorded for this source version, then retry.',
  BRAIN_EXTRACTION_INTEGRITY_CONFLICT:
    'Inspect the durable extraction and retry with matching deterministic input.',
});

export function extractionError(
  code: BrainExtractionErrorCode,
  body: string,
  details: Record<string, JsonValue> = {},
): RosterError {
  return new RosterError({
    header: 'Brain extraction refused the operation',
    body,
    remedy: REMEDIES[code],
    exitCode: EXIT_ERROR,
    code,
    details,
  });
}

function isActivationStore(value: unknown): value is BrainActivationStore {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<BrainActivationStore>;
  return typeof candidate.namespaceFingerprint === 'string'
    && typeof candidate.createOrVerify === 'function'
    && typeof candidate.inspect === 'function'
    && typeof candidate.readVerified === 'function';
}

export function requireBrainActivation(input: {
  pool: VerifiedBrainPool;
  objectStore: BrainActivationStore;
}): BrainActivation {
  if (input === null || typeof input !== 'object'
    || input.pool === null || typeof input.pool !== 'object'
    || typeof input.pool.connect !== 'function'
    || input.pool.authority === undefined) {
    throw extractionError(
      'BRAIN_EXTRACTION_ACTIVATION_INCOMPLETE',
      'Brain extraction requires a verified workspace database pool.',
    );
  }
  if (!isActivationStore(input.objectStore)) {
    throw extractionError(
      'BRAIN_EXTRACTION_ACTIVATION_INCOMPLETE',
      'Brain extraction requires an object store that can read exact immutable bytes.',
    );
  }
  if (input.objectStore.namespaceFingerprint !== input.pool.authority.namespaceFingerprint) {
    throw extractionError(
      'BRAIN_EXTRACTION_NAMESPACE_MISMATCH',
      'The object store is not bound to the verified Brain workspace namespace.',
    );
  }
  return Object.freeze({
    pool: input.pool,
    objectStore: input.objectStore,
    [activationBrand]: true as const,
  });
}

const adminPreflights = new WeakMap<BrainActivation, Promise<void>>();

// Identity is not write authority: the 012 tables are runtime-protected, so a
// runtime-credential pool physically holds no INSERT. Probing the grant once per
// activation turns that into a stable diagnostic before the first mutation
// instead of a mid-operation SQL error.
export async function assertBrainExtractionAdmin(activation: BrainActivation): Promise<void> {
  const cached = adminPreflights.get(activation);
  if (cached !== undefined) return await cached;
  const probe = (async () => {
    const result = await activation.pool.query<{ writable: boolean }>(
      `SELECT has_table_privilege(current_user, 'brain.source_extractions', 'INSERT') AS writable`,
    );
    if (result.rows[0]?.writable !== true) {
      throw extractionError(
        'BRAIN_EXTRACTION_ADMIN_REQUIRED',
        'This Brain connection cannot write extraction state; extraction, spec registration, and reindex are admin-path operations.',
      );
    }
  })();
  adminPreflights.set(activation, probe);
  try {
    return await probe;
  } catch (error) {
    adminPreflights.delete(activation);
    throw error;
  }
}

const registryChecks = new WeakMap<BrainActivation, Promise<void>>();

// Selection of current content is driven by the durable active-extractor
// registry, so a Brain that registers different extractors than this build
// compiles must fail closed on EVERY path that consumes or produces
// active-version content — reads included. Read through the owner-privileged
// brain.active_extractors projection so the runtime role can run the same check.
export async function assertBrainExtractionRegistry(activation: BrainActivation): Promise<void> {
  const cached = registryChecks.get(activation);
  if (cached !== undefined) return await cached;
  const check = (async () => {
    const rows = await activation.pool.query<{ extractor_name: string; active_version: number }>(
      `SELECT extractor_name, active_version FROM brain.active_extractors ORDER BY extractor_name`,
    );
    const registered = rows.rows.map((row) => `${row.extractor_name}@${row.active_version}`);
    const compiled = [...COMPILED_ACTIVE_EXTRACTORS.entries()]
      .map(([name, version]) => `${name}@${version}`)
      .sort();
    if (registered.join(',') !== compiled.join(',')) {
      throw extractionError(
        'BRAIN_EXTRACTION_REGISTRY_DRIFT',
        'This Brain registers different active extractors than the installed Roster build compiles.',
        { registered, compiled },
      );
    }
  })();
  registryChecks.set(activation, check);
  try {
    return await check;
  } catch (error) {
    registryChecks.delete(activation);
    throw error;
  }
}

export async function assertBrainExtractionWriteAuthority(activation: BrainActivation): Promise<void> {
  await assertBrainExtractionAdmin(activation);
  await assertBrainExtractionRegistry(activation);
}
