import { z } from 'zod';

export const FOUNDER_SKILLS_LOCK_VERSION = 1;

export const DEFAULT_SOURCE = 'github:firatcand/founder-skills';
// Sentinel ref meaning "the source repo's default branch". Kept explicit so the
// lockfile records a concrete value rather than an empty string.
export const DEFAULT_REF = 'main';

const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const skillNameSchema = z
  .string()
  .min(1)
  .regex(KEBAB_RE, { message: "skill name must be kebab-case (e.g. 'sales-skill')" });

const skillEntrySchema = z.union([
  skillNameSchema,
  z.object({
    name: skillNameSchema,
    ref: z.string().min(1).optional(),
  }),
]);

export const founderManifestSchema = z.object({
  source: z.string().min(1).default(DEFAULT_SOURCE),
  ref: z.string().min(1).default(DEFAULT_REF),
  skills: z.array(skillEntrySchema).min(1, { message: 'skills: must declare at least one skill' }),
});

export type FounderManifest = z.infer<typeof founderManifestSchema>;

export type NormalizedSkill = {
  name: string;
  ref: string;
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
      throw new Error(`duplicate skill '${name}' in founder-skills.yaml`);
    }
    seen.add(name);
    skills.push({ name, ref });
  }
  return { source: manifest.source, skills };
}
