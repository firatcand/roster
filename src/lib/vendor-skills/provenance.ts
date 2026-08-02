import { detectAuthoredSecretMaterial } from '../authored-secret-detector.ts';
import { workspaceFailure } from '../workspace-diagnostics.ts';

export type ProvenanceField = 'source' | 'ref';

export type ProvenanceValidationOptions = {
  path?: string;
  field?: ProvenanceField;
};

const GITHUB_OWNER_RE = /^(?!-)[a-z0-9]+(?:-[a-z0-9]+)*(?<!-)$/i;
const GITHUB_REPOSITORY_RE = /^[a-z0-9._-]{1,100}$/i;
const COMMIT_SHA_RE = /^[a-f0-9]{40}$/i;
const SHA256_REVISION_RE = /^sha256:[a-f0-9]{64}$/i;
const FORBIDDEN_GIT_REF_CHARS_RE = /[\x00-\x20\x7f~^:?*[\\#%$={}@]/;

function invalidProvenance(
  reason: string,
  options: ProvenanceValidationOptions,
  detector?: { detector_id: string; byte_offset: number; match_length: number },
): never {
  throw workspaceFailure(
    'SKILL_REF_INVALID',
    'Founder-skill provenance metadata is invalid.',
    'Use a canonical github:owner/repository source and a bounded credential-free Git revision.',
    {
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.field === undefined ? {} : { field: options.field }),
      reason,
      ...(detector === undefined
        ? {}
        : {
            detector_id: detector.detector_id,
            byte_offset: detector.byte_offset,
            match_length: detector.match_length,
          }),
    },
  );
}

function assertCredentialFree(value: string, options: ProvenanceValidationOptions): void {
  const finding = detectAuthoredSecretMaterial(value)[0];
  if (finding !== undefined) invalidProvenance('secret-material', options, finding);
}

export function normalizeFounderSource(
  value: unknown,
  options: ProvenanceValidationOptions = {},
): string {
  const fieldOptions = { ...options, field: options.field ?? 'source' };
  if (typeof value !== 'string' || value.length < 1 || value.length > 148) {
    invalidProvenance('source-shape', fieldOptions);
  }
  assertCredentialFree(value, fieldOptions);
  const match = /^(?:github:)?([^/]+)\/([^/]+)$/i.exec(value);
  if (match === null) invalidProvenance('source-shape', fieldOptions);
  const owner = match[1]!;
  const repository = match[2]!;
  if (
    owner.length > 39
    || repository.length > 100
    || !GITHUB_OWNER_RE.test(owner)
    || !GITHUB_REPOSITORY_RE.test(repository)
    || repository === '.'
    || repository === '..'
  ) {
    invalidProvenance('source-shape', fieldOptions);
  }
  return `github:${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

export function normalizeFounderRevision(
  value: unknown,
  options: ProvenanceValidationOptions = {},
): string {
  const fieldOptions = { ...options, field: options.field ?? 'ref' };
  if (typeof value !== 'string' || value.length < 1 || value.length > 255) {
    invalidProvenance('revision-shape', fieldOptions);
  }
  assertCredentialFree(value, fieldOptions);
  if (COMMIT_SHA_RE.test(value) || SHA256_REVISION_RE.test(value)) return value.toLowerCase();
  if (
    value === '.'
    || value === '..'
    || value.startsWith('-')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('//')
    || value.includes('..')
    || value.includes('@{')
    || FORBIDDEN_GIT_REF_CHARS_RE.test(value)
    || value.split('/').some((component) =>
      component.length === 0
      || component.startsWith('.')
      || component.toLowerCase().endsWith('.lock'))
  ) {
    invalidProvenance('revision-shape', fieldOptions);
  }
  return value;
}

export function isImmutableFounderRevision(value: string): boolean {
  return COMMIT_SHA_RE.test(value) || SHA256_REVISION_RE.test(value);
}
