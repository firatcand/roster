import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type {
  NormalizedManifest,
  NormalizedSkill,
} from '../founder-skills/manifest-schema.ts';
import { isSafeSkillName } from '../founder-skills/manifest-schema.ts';
import { detectAuthoredSecretMaterial } from '../authored-secret-detector.ts';
import type { Lockfile, LockedSkill } from '../founder-skills/lockfile.ts';
import {
  PROJECT_SKILL_ROOTS,
  projectSkillPathFor,
} from '../founder-skills/tool-targets.ts';
import {
  enumerateWorkspaceSlot,
  inspectWorkspaceEntry,
  readWorkspaceFile,
} from '../workspace-io.ts';
import {
  isWorkspaceFailure,
  workspaceFailure,
} from '../workspace-diagnostics.ts';
import { isRecordId, WORKSPACE_TOOL_USES_ROOT } from '../workspace-layout.ts';
import { canonicalJson } from './canonical-json.ts';
import {
  isImmutableFounderRevision,
  normalizeFounderRevision,
  normalizeFounderSource,
} from './provenance.ts';
import {
  isCanonicalSkillRef,
  parseSkillRef,
  type CanonicalSkillRef,
} from './skill-ref.ts';
import { hashSkillTree } from './tree-hash.ts';

export const VENDOR_SKILL_MAP_PATH = '.roster/vendor-skill-map.json';
export const VENDOR_SKILL_MAP_SCHEMA_VERSION = 1;
export const VENDOR_SKILL_MAP_GENERATOR = '@firatcand/roster';
export const VENDOR_SKILL_MAP_MAX_BYTES = 1024 * 1024;

export type VendorSkillHost = 'claude' | 'codex';

export type HostNativeSkillLocator = {
  kind: 'host-native';
  identity: CanonicalSkillRef;
  assurance: 'host-resolved';
};

export type WorkspaceRelativeSkillLocator = {
  kind: 'workspace-relative';
  path: string;
  content_hash: string;
  source: string;
  revision: string;
  revision_immutable: boolean;
  assurance: 'verified';
};

export type VendorSkillLocator = HostNativeSkillLocator | WorkspaceRelativeSkillLocator;

export type VendorSkillMapEntry = {
  skill_ref: CanonicalSkillRef;
  authored_paths: string[];
  hosts: Partial<Record<VendorSkillHost, VendorSkillLocator>>;
};

export type VendorSkillMapPayload = {
  schema_version: typeof VENDOR_SKILL_MAP_SCHEMA_VERSION;
  generator: typeof VENDOR_SKILL_MAP_GENERATOR;
  generator_version: string;
  skills: VendorSkillMapEntry[];
};

export type VendorSkillMap = VendorSkillMapPayload & {
  map_hash: string;
};

export type ProjectSkillHashLimits = {
  maxDepth?: number;
  maxEntries?: number;
  maxBytes?: number;
};

export type VendorSkillMapInput = {
  workspaceRoot: string;
  skillRefs: readonly CanonicalSkillRef[];
  skillRefPaths?: ReadonlyMap<CanonicalSkillRef, readonly string[]>;
  enabledHosts: readonly VendorSkillHost[];
  manifest: NormalizedManifest | null;
  lockfile: Lockfile | null;
  generatorVersion: string;
  limits?: ProjectSkillHashLimits;
};

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_ENTRIES = 4_096;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_VENDOR_SKILL_REFS = 1_024;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;
const GENERATOR_VERSION_RE = /^[0-9a-z][0-9a-z.+-]{0,63}$/i;

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validAuthoredPath(value: unknown): value is string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.includes('\\')
    || value.startsWith('/')
    || value !== posix.normalize(value)
    || detectAuthoredSecretMaterial(value).length > 0) return false;
  const parts = value.split('/');
  const yamlId = (candidate: string | undefined): boolean => (
    candidate !== undefined
    && candidate.endsWith('.yaml')
    && isRecordId(candidate.slice(0, -'.yaml'.length))
  );
  if (parts.length === 2) {
    return parts[0] === WORKSPACE_TOOL_USES_ROOT && yamlId(parts[1]);
  }
  return parts.length >= 3
    && parts.at(-2) === WORKSPACE_TOOL_USES_ROOT
    && yamlId(parts.at(-1))
    && parts.slice(0, -2).every((part) => isRecordId(part));
}

function fail(
  code: 'SKILL_REF_INVALID' | 'SKILL_REF_UNMAPPED' | 'SKILL_REF_DRIFTED',
  message: string,
  reason: string,
  options: { host?: VendorSkillHost; path?: string } = {},
): never {
  throw workspaceFailure(
    code,
    message,
    code === 'SKILL_REF_UNMAPPED'
      ? 'Run roster skills sync in an environment that materializes every committed enabled host, then commit the regenerated lock and vendor-skill map.'
      : 'Repair the founder-skill metadata or project skill tree, then regenerate the vendor-skill map.',
    {
      reason,
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.path === undefined ? {} : { path: options.path }),
    },
  );
}

function positiveLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    return fail('SKILL_REF_INVALID', 'Vendor-skill map limits are invalid.', 'invalid-limit');
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function hashProjectSkillForHost(options: {
  workspaceRoot: string;
  host: VendorSkillHost;
  skillName: string;
  limits?: ProjectSkillHashLimits;
}): { path: string; contentHash: string } {
  if (!isSafeSkillName(options.skillName)) {
    return fail('SKILL_REF_INVALID', 'Founder-skill metadata contains an invalid project skill name.', 'invalid-skill-name');
  }
  const maxDepth = positiveLimit(options.limits?.maxDepth, DEFAULT_MAX_DEPTH);
  const maxEntries = positiveLimit(options.limits?.maxEntries, DEFAULT_MAX_ENTRIES);
  const maxBytes = positiveLimit(options.limits?.maxBytes, DEFAULT_MAX_BYTES);
  const skillPath = projectSkillPathFor(options.host, options.skillName);
  const files: Array<{ path: string; content: Buffer }> = [];
  let entries = 0;
  let bytes = 0;

  const walk = (directory: string, depth: number): void => {
    if (depth > maxDepth) {
      throw workspaceFailure(
        'READ_LIMIT_EXCEEDED',
        `Project skill tree '${skillPath}' exceeds the bounded depth limit.`,
        'Reduce the project skill tree depth before regenerating the vendor-skill map.',
        { path: skillPath, maxDepth },
      );
    }
    const remainingEntries = maxEntries - entries;
    if (remainingEntries < 0) {
      throw workspaceFailure(
        'READ_LIMIT_EXCEEDED',
        `Project skill tree '${skillPath}' exceeds the bounded entry limit.`,
        'Reduce the project skill tree size before regenerating the vendor-skill map.',
        { path: skillPath, maxEntries },
      );
    }
    const children = enumerateWorkspaceSlot(options.workspaceRoot, directory, {
      maxEntries: remainingEntries,
    }).sort((left, right) => lexical(left.name, right.name));
    for (const child of children) {
      entries += 1;
      if (entries > maxEntries) {
        throw workspaceFailure(
          'READ_LIMIT_EXCEEDED',
          `Project skill tree '${skillPath}' exceeds the bounded entry limit.`,
          'Reduce the project skill tree size before regenerating the vendor-skill map.',
          { path: skillPath, maxEntries },
        );
      }
      const childPath = posix.join(directory, child.name);
      if (child.kind === 'directory') {
        walk(childPath, depth + 1);
        continue;
      }
      const remainingBytes = maxBytes - bytes;
      const content = readWorkspaceFile(options.workspaceRoot, childPath, {
        maxBytes: remainingBytes,
      });
      bytes += content.byteLength;
      const relativePath = posix.relative(skillPath, childPath);
      files.push({ path: relativePath, content });
    }
  };

  try {
    const skillKind = inspectWorkspaceEntry(options.workspaceRoot, skillPath);
    if (skillKind === 'absent') {
      return fail(
        'SKILL_REF_UNMAPPED',
        'A project-materialized vendor skill is missing for an enabled host.',
        'project-target-missing',
        { host: options.host, path: skillPath },
      );
    }
    if (skillKind !== 'directory') {
      return fail(
        'SKILL_REF_DRIFTED',
        'A project-materialized vendor skill is not a confined directory.',
        'project-target-not-directory',
        { host: options.host, path: skillPath },
      );
    }
    walk(skillPath, 0);
  } catch (error) {
    if (isWorkspaceFailure(error) && error.code === 'PARENT_NOT_FOUND') {
      return fail(
        'SKILL_REF_UNMAPPED',
        'A project-materialized vendor skill is missing for an enabled host.',
        'project-target-missing',
        { host: options.host, path: skillPath },
      );
    }
    throw error;
  }
  return { path: skillPath, contentHash: hashSkillTree(files) };
}

function validateManifest(manifest: NormalizedManifest | null): void {
  if (manifest === null) return;
  if (normalizeFounderSource(manifest.source) !== manifest.source || manifest.skills.length > 512) {
    return fail('SKILL_REF_INVALID', 'Founder-skill manifest metadata is invalid.', 'manifest-not-normalized');
  }
  const names = new Set<string>();
  for (const skill of manifest.skills) {
    if (
      !isSafeSkillName(skill.name)
      || normalizeFounderRevision(skill.ref) !== skill.ref
      || (skill.skillRef !== undefined && parseSkillRef(skill.skillRef) !== skill.skillRef)
      || names.has(skill.name)
    ) {
      return fail('SKILL_REF_INVALID', 'Founder-skill manifest metadata is invalid.', 'manifest-not-normalized');
    }
    names.add(skill.name);
  }
}

function validateLockfile(lockfile: Lockfile | null): void {
  if (lockfile === null) return;
  if (
    lockfile.version !== 1
    || normalizeFounderSource(lockfile.source) !== lockfile.source
    || lockfile.skills.length > 512
  ) {
    return fail('SKILL_REF_INVALID', 'Founder-skill lock metadata is invalid.', 'lock-not-normalized');
  }
  const names = new Set<string>();
  for (const skill of lockfile.skills) {
    if (
      !isSafeSkillName(skill.name)
      || normalizeFounderRevision(skill.ref) !== skill.ref
      || (skill.skill_ref !== undefined && parseSkillRef(skill.skill_ref) !== skill.skill_ref)
      || !(skill.contentHash === 'absent' || SHA256_RE.test(skill.contentHash))
      || Object.entries(skill.contentHashes ?? {}).some(([host, hash]) => (
        (host !== 'claude' && host !== 'codex') || hash === undefined || !SHA256_RE.test(hash)
      ))
      || skill.tools.some((host) => host !== 'claude' && host !== 'codex')
      || new Set(skill.tools).size !== skill.tools.length
      || names.has(skill.name)
    ) {
      return fail('SKILL_REF_INVALID', 'Founder-skill lock metadata is invalid.', 'lock-not-normalized');
    }
    names.add(skill.name);
  }
}

function validateManifestLockAgreement(
  manifest: NormalizedManifest | null,
  lockfile: Lockfile | null,
): void {
  if (manifest === null && lockfile === null) return;
  if (manifest === null || lockfile === null || manifest.source !== lockfile.source) {
    return fail(
      'SKILL_REF_UNMAPPED',
      'Founder-skill manifest and lock provenance do not agree.',
      'manifest-lock-provenance-mismatch',
    );
  }
  const manifestByName = new Map(manifest.skills.map((skill) => [skill.name, skill]));
  if (manifestByName.size !== lockfile.skills.length) {
    return fail(
      'SKILL_REF_UNMAPPED',
      'Founder-skill manifest and lock entries do not agree.',
      'manifest-lock-entry-mismatch',
    );
  }
  for (const locked of lockfile.skills) {
    const declared = manifestByName.get(locked.name);
    if (
      declared === undefined
      || declared.ref !== locked.ref
      || declared.skillRef !== locked.skill_ref
    ) {
      return fail(
        'SKILL_REF_UNMAPPED',
        'Founder-skill manifest and lock provenance do not agree.',
        'manifest-lock-provenance-mismatch',
      );
    }
  }
}

function joinedProjectSkill(
  skillRef: CanonicalSkillRef,
  manifest: NormalizedManifest | null,
  lockfile: Lockfile | null,
): { manifestSkill: NormalizedSkill; lockedSkill: LockedSkill; source: string } | null {
  const manifestMatches = manifest?.skills.filter((skill) => skill.skillRef === skillRef) ?? [];
  if (manifestMatches.length === 0) return null;
  if (manifestMatches.length !== 1 || manifest === null || lockfile === null) {
    return fail(
      'SKILL_REF_UNMAPPED',
      'A project-materialized vendor skill does not have one manifest and lock join.',
      'manifest-lock-join-count',
    );
  }
  const manifestSkill = manifestMatches[0]!;
  const lockMatches = lockfile.skills.filter((skill) => skill.skill_ref === skillRef);
  if (
    lockMatches.length !== 1
    || lockfile.source !== manifest.source
    || lockMatches[0]!.name !== manifestSkill.name
    || lockMatches[0]!.ref !== manifestSkill.ref
  ) {
    return fail(
      'SKILL_REF_UNMAPPED',
      'A project-materialized vendor skill disagrees with reviewed lock metadata.',
      'manifest-lock-provenance-mismatch',
    );
  }
  return {
    manifestSkill,
    lockedSkill: lockMatches[0]!,
    source: manifest.source,
  };
}

function hostNativeLocator(skillRef: CanonicalSkillRef): HostNativeSkillLocator {
  return {
    kind: 'host-native',
    identity: skillRef,
    assurance: 'host-resolved',
  };
}

export function buildVendorSkillMap(input: VendorSkillMapInput): VendorSkillMap {
  if (!GENERATOR_VERSION_RE.test(input.generatorVersion)) {
    return fail('SKILL_REF_INVALID', 'The vendor-skill map generator version is invalid.', 'generator-version');
  }
  validateManifest(input.manifest);
  validateLockfile(input.lockfile);
  const skillRefs = [...new Set(input.skillRefs.map((value) => parseSkillRef(value)))]
    .sort(lexical);
  if (skillRefs.length > MAX_VENDOR_SKILL_REFS) {
    return fail('SKILL_REF_INVALID', 'The vendor-skill map exceeds its bounded reference limit.', 'skill-ref-limit');
  }
  if (skillRefs.length > 0) validateManifestLockAgreement(input.manifest, input.lockfile);
  const enabledHosts = [...new Set(input.enabledHosts)].sort(lexical);
  if (enabledHosts.some((host) => host !== 'claude' && host !== 'codex')) {
    return fail('SKILL_REF_INVALID', 'The vendor-skill map has an unsupported enabled host.', 'enabled-host');
  }

  const skills: VendorSkillMapEntry[] = skillRefs.map((skillRef) => {
    const projectSkill = joinedProjectSkill(skillRef, input.manifest, input.lockfile);
    const hosts: Partial<Record<VendorSkillHost, VendorSkillLocator>> = {};
    for (const host of enabledHosts) {
      if (projectSkill === null) {
        hosts[host] = hostNativeLocator(skillRef);
        continue;
      }
      if (!projectSkill.lockedSkill.tools.includes(host)) {
        return fail(
          'SKILL_REF_UNMAPPED',
          'A project-materialized vendor skill is missing an enabled host target.',
          'enabled-host-not-locked',
          { host },
        );
      }
      const actual = hashProjectSkillForHost({
        workspaceRoot: input.workspaceRoot,
        host,
        skillName: projectSkill.manifestSkill.name,
        limits: input.limits,
      });
      const reviewedHash = projectSkill.lockedSkill.contentHashes?.[host];
      if (reviewedHash === undefined) {
        return fail(
          'SKILL_REF_UNMAPPED',
          'A project-materialized vendor skill has no reviewed per-host content hash.',
          'project-host-hash-missing',
          { host, path: actual.path },
        );
      }
      if (actual.contentHash !== reviewedHash) {
        return fail(
          'SKILL_REF_DRIFTED',
          'A project-materialized vendor skill differs from reviewed per-host lock metadata.',
          'project-content-drift',
          { host, path: actual.path },
        );
      }
      hosts[host] = {
        kind: 'workspace-relative',
        path: actual.path,
        content_hash: actual.contentHash,
        source: projectSkill.source,
        revision: projectSkill.manifestSkill.ref,
        revision_immutable: isImmutableFounderRevision(projectSkill.manifestSkill.ref),
        assurance: 'verified',
      };
    }
    const authoredPaths = [...new Set(input.skillRefPaths?.get(skillRef) ?? [])].sort(lexical);
    if (authoredPaths.some((path) => !validAuthoredPath(path))) {
      return fail('SKILL_REF_INVALID', 'Vendor-skill map authored provenance is invalid.', 'authored-path');
    }
    return { skill_ref: skillRef, authored_paths: authoredPaths, hosts };
  });

  const payload: VendorSkillMapPayload = {
    schema_version: VENDOR_SKILL_MAP_SCHEMA_VERSION,
    generator: VENDOR_SKILL_MAP_GENERATOR,
    generator_version: input.generatorVersion,
    skills,
  };
  const map = { ...payload, map_hash: sha256(canonicalJson(payload)) };
  serializeVendorSkillMap(map);
  return map;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validWorkspacePath(host: VendorSkillHost, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 255 || value.includes('\\')) return false;
  if (value !== posix.normalize(value) || value.startsWith('/') || value.includes('../')) return false;
  const prefix = `${PROJECT_SKILL_ROOTS[host]}/`;
  return value.startsWith(prefix) && isSafeSkillName(value.slice(prefix.length));
}

function validLocator(
  host: VendorSkillHost,
  skillRef: CanonicalSkillRef,
  value: unknown,
): value is VendorSkillLocator {
  const locator = objectValue(value);
  if (locator === null || typeof locator['kind'] !== 'string') return false;
  if (locator['kind'] === 'host-native') {
    return exactKeys(locator, ['kind', 'identity', 'assurance'])
      && locator['identity'] === skillRef
      && locator['assurance'] === 'host-resolved';
  }
  if (locator['kind'] !== 'workspace-relative') return false;
  if (!exactKeys(locator, [
    'kind',
    'path',
    'content_hash',
    'source',
    'revision',
    'revision_immutable',
    'assurance',
  ])) return false;
  if (
    !validWorkspacePath(host, locator['path'])
    || typeof locator['content_hash'] !== 'string'
    || !SHA256_RE.test(locator['content_hash'])
    || locator['assurance'] !== 'verified'
    || typeof locator['revision_immutable'] !== 'boolean'
  ) return false;
  try {
    return normalizeFounderSource(locator['source']) === locator['source']
      && normalizeFounderRevision(locator['revision']) === locator['revision']
      && isImmutableFounderRevision(locator['revision']) === locator['revision_immutable'];
  } catch {
    return false;
  }
}

function validMapShape(value: unknown): value is VendorSkillMap {
  const map = objectValue(value);
  if (
    map === null
    || !exactKeys(map, [
      'schema_version',
      'generator',
      'generator_version',
      'skills',
      'map_hash',
    ])
    || map['schema_version'] !== VENDOR_SKILL_MAP_SCHEMA_VERSION
    || map['generator'] !== VENDOR_SKILL_MAP_GENERATOR
    || typeof map['generator_version'] !== 'string'
    || !GENERATOR_VERSION_RE.test(map['generator_version'])
    || typeof map['map_hash'] !== 'string'
    || !SHA256_RE.test(map['map_hash'])
    || !Array.isArray(map['skills'])
    || map['skills'].length > MAX_VENDOR_SKILL_REFS
  ) return false;
  let priorRef: string | null = null;
  for (const entryValue of map['skills']) {
    const entry = objectValue(entryValue);
    if (entry === null || !exactKeys(entry, ['skill_ref', 'authored_paths', 'hosts'])) return false;
    if (!isCanonicalSkillRef(entry['skill_ref'])) return false;
    if (priorRef !== null && lexical(priorRef, entry['skill_ref']) >= 0) return false;
    priorRef = entry['skill_ref'];
    if (!Array.isArray(entry['authored_paths'])) return false;
    const authoredPaths = entry['authored_paths'] as unknown[];
    if (authoredPaths.some((path) => !validAuthoredPath(path))
      || authoredPaths.some((path, index) => index > 0
        && lexical(authoredPaths[index - 1] as string, path as string) >= 0)) {
      return false;
    }
    const hosts = objectValue(entry['hosts']);
    if (hosts === null) return false;
    for (const host of Object.keys(hosts)) {
      if (host !== 'claude' && host !== 'codex') return false;
      if (!validLocator(host, entry['skill_ref'], hosts[host])) return false;
    }
  }
  const payload: VendorSkillMapPayload = {
    schema_version: VENDOR_SKILL_MAP_SCHEMA_VERSION,
    generator: VENDOR_SKILL_MAP_GENERATOR,
    generator_version: map['generator_version'],
    skills: map['skills'] as VendorSkillMapEntry[],
  };
  return map['map_hash'] === sha256(canonicalJson(payload));
}

export function serializeVendorSkillMap(map: VendorSkillMap): string {
  if (!validMapShape(map)) {
    return fail(
      'SKILL_REF_DRIFTED',
      'The vendor-skill map does not match its canonical self-hash.',
      'map-self-hash',
      { path: VENDOR_SKILL_MAP_PATH },
    );
  }
  const serialized = `${canonicalJson(map)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > VENDOR_SKILL_MAP_MAX_BYTES) {
    throw workspaceFailure(
      'READ_LIMIT_EXCEEDED',
      'The canonical vendor-skill map exceeds its bounded byte limit.',
      'Reduce the number of distinct authored vendor skill references.',
      { path: VENDOR_SKILL_MAP_PATH, maxBytes: VENDOR_SKILL_MAP_MAX_BYTES },
    );
  }
  return serialized;
}

export function parseVendorSkillMap(text: string): VendorSkillMap | null {
  if (Buffer.byteLength(text, 'utf8') > VENDOR_SKILL_MAP_MAX_BYTES || !text.endsWith('\n')) return null;
  try {
    const parsed = JSON.parse(text.slice(0, -1)) as unknown;
    if (!validMapShape(parsed)) return null;
    if (`${canonicalJson(parsed)}\n` !== text) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function isCanonicalVendorSkillMapBytes(text: string): boolean {
  return parseVendorSkillMap(text) !== null;
}
