import { z } from 'zod';
import YAML from 'yaml';
import { detectAuthoredSecretMaterial } from '../authored-secret-detector.ts';
import { tryReadWorkspaceFile } from '../workspace-io.ts';
import {
  isWorkspaceFailure,
  workspaceFailure,
} from '../workspace-diagnostics.ts';
import {
  normalizeFounderRevision,
  normalizeFounderSource,
} from '../vendor-skills/provenance.ts';
import {
  parseSkillRef,
  type CanonicalSkillRef,
} from '../vendor-skills/skill-ref.ts';

export const FOUNDER_SKILLS_LOCK_VERSION = 1;
export const FOUNDER_SKILLS_MANIFEST_NAME = 'founder-skills.yaml';

export const DEFAULT_SOURCE = 'github:firatcand/founder-skills';
// Sentinel ref meaning "the source repo's default branch". Kept explicit so the
// lockfile records a concrete value rather than an empty string.
export const DEFAULT_REF = 'main';

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Single source of truth for "is this a safe skill name". Reused at every
// trust boundary that turns a name into a filesystem path (manifest parse,
// lockfile read, prune) so a hand-edited name can never contain `..` or `/`.
export function isSafeSkillName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 63 && KEBAB_RE.test(value);
}

const skillNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(KEBAB_RE, { message: "skill name must be kebab-case (e.g. 'sales-skill')" });

const sourceSchema = z.string().transform((value) => normalizeFounderSource(value, {
  path: FOUNDER_SKILLS_MANIFEST_NAME,
}));
const revisionSchema = z.string().transform((value) => normalizeFounderRevision(value, {
  path: FOUNDER_SKILLS_MANIFEST_NAME,
}));
const skillRefSchema = z.string().transform((value) => parseSkillRef(value, {
  path: FOUNDER_SKILLS_MANIFEST_NAME,
}));

const skillEntrySchema = z.union([
  skillNameSchema,
  z.object({
    name: skillNameSchema,
    ref: revisionSchema.optional(),
    skill_ref: skillRefSchema.optional(),
  }).strict(),
]);

export const founderManifestSchema = z.object({
  source: sourceSchema.default(DEFAULT_SOURCE),
  ref: revisionSchema.default(DEFAULT_REF),
  skills: z
    .array(skillEntrySchema)
    .min(1, { message: 'skills: must declare at least one skill' })
    .max(512, { message: 'skills: exceeds the 512-entry limit' }),
}).strict();

export type FounderManifest = z.infer<typeof founderManifestSchema>;

export type NormalizedSkill = {
  name: string;
  ref: string;
  skillRef?: CanonicalSkillRef;
};

export type NormalizedManifest = {
  source: string;
  skills: NormalizedSkill[];
};

// Collapse the union'd skill list into {name, ref} pairs: a per-skill `ref`
// overrides the top-level `ref`. Rejects duplicate names so the install/prune
// reconcile has a single source of truth per skill.
export function normalizeManifest(manifest: FounderManifest): NormalizedManifest {
  const seen = new Set<string>();
  const skills: NormalizedSkill[] = [];
  for (const entry of manifest.skills) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const ref = typeof entry === 'string' ? manifest.ref : (entry.ref ?? manifest.ref);
    if (seen.has(name)) {
      throw workspaceFailure(
        'SKILL_REF_INVALID',
        'Founder-skill manifest entries are duplicated.',
        'Declare each project skill name exactly once.',
        { path: FOUNDER_SKILLS_MANIFEST_NAME, reason: 'duplicate-skill-name' },
      );
    }
    seen.add(name);
    skills.push({
      name,
      ref,
      ...(typeof entry === 'string' || entry.skill_ref === undefined
        ? {}
        : { skillRef: entry.skill_ref }),
    });
  }
  return { source: manifest.source, skills };
}

export type FounderSkillsManifestSnapshot = {
  bytes: Buffer;
  manifest: NormalizedManifest;
};

export function readFounderSkillsManifestSnapshot(
  workspaceRoot: string,
): FounderSkillsManifestSnapshot | null {
  const bytes = tryReadWorkspaceFile(workspaceRoot, FOUNDER_SKILLS_MANIFEST_NAME, {
    maxBytes: 256 * 1024,
  });
  if (bytes === null) return null;
  const secret = detectAuthoredSecretMaterial(bytes)[0];
  if (secret !== undefined) {
    throw workspaceFailure(
      'SECRET_MATERIAL_FORBIDDEN',
      'Founder-skill manifest metadata contains forbidden secret material.',
      'Remove the credential material and reference only the canonical public source and revision.',
      {
        path: FOUNDER_SKILLS_MANIFEST_NAME,
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
    return {
      bytes,
      manifest: normalizeManifest(founderManifestSchema.parse(document.toJS({ maxAliasCount: 0 }) ?? {})),
    };
  } catch (error) {
    if (isWorkspaceFailure(error)) throw error;
    throw workspaceFailure(
      'SKILL_REF_INVALID',
      'Founder-skill manifest metadata is invalid.',
      'Use a closed founder-skills.yaml schema with bounded canonical source, revision, and optional skill_ref values.',
      { path: FOUNDER_SKILLS_MANIFEST_NAME, reason: 'manifest-parse' },
    );
  }
}

export function readFounderSkillsManifest(workspaceRoot: string): NormalizedManifest | null {
  return readFounderSkillsManifestSnapshot(workspaceRoot)?.manifest ?? null;
}
