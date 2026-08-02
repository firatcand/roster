import { join } from 'node:path';
import YAML, { stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { ToolKey } from '../tools.ts';
import { atomicWriteFile } from '../schedule-yaml.ts';
import { detectAuthoredSecretMaterial } from '../authored-secret-detector.ts';
import { tryReadWorkspaceFile } from '../workspace-io.ts';
import {
  isWorkspaceFailure,
  workspaceFailure,
} from '../workspace-diagnostics.ts';
import { FOUNDER_SKILLS_LOCK_VERSION, isSafeSkillName } from './manifest-schema.ts';
import {
  normalizeFounderRevision,
  normalizeFounderSource,
} from '../vendor-skills/provenance.ts';
import {
  parseSkillRef,
  type CanonicalSkillRef,
} from '../vendor-skills/skill-ref.ts';

export const LOCKFILE_NAME = 'founder-skills.lock';

export type LockedSkill = {
  name: string;
  ref: string;
  contentHash: string;
  contentHashes?: Partial<Record<ToolKey, string>>;
  tools: ToolKey[];
  skill_ref?: CanonicalSkillRef;
};

export type Lockfile = {
  version: number;
  source: string;
  skills: LockedSkill[];
};

export function lockfilePath(workspaceRoot: string): string {
  return join(workspaceRoot, LOCKFILE_NAME);
}

const lockSkillSchema = z.object({
  name: z.string().refine(isSafeSkillName),
  ref: z.string().transform((value) => normalizeFounderRevision(value, {
    path: LOCKFILE_NAME,
  })),
  contentHash: z.string().refine((value) =>
    value === 'absent' || /^sha256:[a-f0-9]{64}$/.test(value)),
  contentHashes: z.object({
    claude: z.string().refine((value) => /^sha256:[a-f0-9]{64}$/.test(value)).optional(),
    codex: z.string().refine((value) => /^sha256:[a-f0-9]{64}$/.test(value)).optional(),
  }).strict().optional(),
  tools: z.array(z.enum(['claude', 'codex'])).max(2),
  skill_ref: z.string().transform((value) => parseSkillRef(value, {
    path: LOCKFILE_NAME,
  })).optional(),
}).strict();

const lockfileSchema = z.object({
  version: z.literal(FOUNDER_SKILLS_LOCK_VERSION),
  source: z.string().transform((value) => normalizeFounderSource(value, {
    path: LOCKFILE_NAME,
  })),
  skills: z.array(lockSkillSchema).max(512),
}).strict();

function normalizeLockfile(value: unknown): Lockfile {
  try {
    const parsed = lockfileSchema.parse(value);
    const names = new Set<string>();
    for (const skill of parsed.skills) {
      if (names.has(skill.name) || new Set(skill.tools).size !== skill.tools.length) {
        throw workspaceFailure(
          'SKILL_REF_INVALID',
          'The founder-skills lock metadata is invalid.',
          'Regenerate founder-skills.lock with roster skills sync.',
          { path: LOCKFILE_NAME, reason: 'duplicate-lock-metadata' },
        );
      }
      names.add(skill.name);
    }
    return parsed;
  } catch (error) {
    if (isWorkspaceFailure(error)) throw error;
    throw workspaceFailure(
      'SKILL_REF_INVALID',
      'The founder-skills lock metadata is invalid.',
      'Regenerate founder-skills.lock with roster skills sync.',
      { path: LOCKFILE_NAME, reason: 'lock-schema' },
    );
  }
}

export function readLockfile(workspaceRoot: string): Lockfile | null {
  const bytes = tryReadWorkspaceFile(workspaceRoot, LOCKFILE_NAME, { maxBytes: 256 * 1024 });
  if (bytes === null) return null;
  const secret = detectAuthoredSecretMaterial(bytes)[0];
  if (secret !== undefined) {
    throw workspaceFailure(
      'SECRET_MATERIAL_FORBIDDEN',
      'Founder-skill lock metadata contains forbidden secret material.',
      'Remove the credential material and regenerate founder-skills.lock with roster skills sync.',
      {
        path: LOCKFILE_NAME,
        detector_id: secret.detector_id,
        byte_offset: secret.byte_offset,
        match_length: secret.match_length,
      },
    );
  }
  try {
    const document = YAML.parseDocument(bytes.toString('utf8'), {
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) throw new TypeError('invalid YAML');
    return normalizeLockfile(document.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    if (isWorkspaceFailure(error)) throw error;
    throw workspaceFailure(
      'SKILL_REF_INVALID',
      'The founder-skills lock metadata is invalid.',
      'Regenerate founder-skills.lock with roster skills sync.',
      { path: LOCKFILE_NAME, reason: 'lock-parse' },
    );
  }
}

export function writeLockfile(workspaceRoot: string, lock: Lockfile): void {
  const normalized = normalizeLockfile(lock);
  const ordered: Lockfile = {
    version: normalized.version,
    source: normalized.source,
    skills: [...normalized.skills]
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))
      .map((skill) => ({
        name: skill.name,
        ref: skill.ref,
        contentHash: skill.contentHash,
        ...(skill.contentHashes === undefined
          ? {}
          : {
              contentHashes: Object.fromEntries(
                Object.entries(skill.contentHashes).sort(([a], [b]) => a.localeCompare(b, 'en')),
              ),
            }),
        tools: [...skill.tools].sort((a, b) => a.localeCompare(b, 'en')),
        ...(skill.skill_ref === undefined ? {} : { skill_ref: skill.skill_ref }),
      })),
  };
  const banner = '# Generated by `roster skills sync`. Do not edit by hand.\n';
  atomicWriteFile(lockfilePath(workspaceRoot), banner + stringifyYaml(ordered), workspaceRoot);
}
