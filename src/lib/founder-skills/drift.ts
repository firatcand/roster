import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseFrontMatter } from '../front-matter.ts';
import { founderManifestSchema, normalizeManifest } from './manifest-schema.ts';
import { readLockfile } from './lockfile.ts';
import { hashSkillDir } from './lockfile.ts';
import { isSupportedFounderTool, targetDirFor } from './tool-targets.ts';
import { manifestPath, MANIFEST_NAME } from './sync.ts';
import { detectTools } from '../tools.ts';

export type DriftFinding = {
  kind:
    | 'missing-install'
    | 'orphan-install'
    | 'ref-mismatch'
    | 'hash-mismatch'
    | 'source-mismatch'
    | 'malformed-frontmatter'
    | 'no-lock'
    | 'manifest-parse-error';
  skill: string | null;
  message: string;
};

export type FounderSkillsDriftResult =
  | { status: 'not-applicable' }
  | { status: 'checked'; findings: DriftFinding[]; hasFailure: boolean };

// Audit manifest ↔ lock ↔ installed. Fail-LOUD: any finding is an error that
// must flip doctor's exit code (mirrors the ROS-112 fail-open fix — never
// silent-skip a missing dir). Returns not-applicable only when there is no
// manifest (clean opt-out).
export function auditFounderSkillsDrift(cwd: string): FounderSkillsDriftResult {
  if (!existsSync(manifestPath(cwd))) {
    return { status: 'not-applicable' };
  }

  const findings: DriftFinding[] = [];

  let normalized;
  try {
    const raw = parseYaml(readFileSync(manifestPath(cwd), 'utf8')) as unknown;
    normalized = normalizeManifest(founderManifestSchema.parse(raw ?? {}));
  } catch (err) {
    findings.push({
      kind: 'manifest-parse-error',
      skill: null,
      message: `${MANIFEST_NAME} is invalid: ${(err as Error).message}`,
    });
    return { status: 'checked', findings, hasFailure: true };
  }

  const lock = readLockfile(cwd);
  if (!lock) {
    findings.push({
      kind: 'no-lock',
      skill: null,
      message: 'founder-skills.lock is missing — run `roster skills sync`',
    });
  }

  if (lock && lock.source !== normalized.source) {
    findings.push({
      kind: 'source-mismatch',
      skill: null,
      message: `lock source '${lock.source}' != manifest source '${normalized.source}'`,
    });
  }

  const tools = detectTools()
    .map((t) => t.key)
    .filter(isSupportedFounderTool);
  const declared = new Set(normalized.skills.map((s) => s.name));

  for (const skill of normalized.skills) {
    const locked = lock?.skills.find((s) => s.name === skill.name);
    if (lock && !locked) {
      findings.push({
        kind: 'missing-install',
        skill: skill.name,
        message: `'${skill.name}' is declared but not in the lockfile`,
      });
    }
    if (locked && locked.ref !== skill.ref) {
      findings.push({
        kind: 'ref-mismatch',
        skill: skill.name,
        message: `'${skill.name}' lock ref '${locked.ref}' != manifest ref '${skill.ref}'`,
      });
    }

    let installedSomewhere = false;
    for (const toolKey of tools) {
      const dir = join(targetDirFor(cwd, toolKey), skill.name);
      if (!existsSync(dir)) continue;
      installedSomewhere = true;
      if (locked) {
        const h = hashSkillDir(dir);
        if (h !== locked.contentHash) {
          findings.push({
            kind: 'hash-mismatch',
            skill: skill.name,
            message: `'${skill.name}' content in ${toolKey} differs from the lockfile`,
          });
        }
      }
      const skillMd = join(dir, 'SKILL.md');
      if (existsSync(skillMd)) {
        const { frontMatter } = parseFrontMatter(readFileSync(skillMd, 'utf8'));
        if (typeof frontMatter['name'] !== 'string' || typeof frontMatter['description'] !== 'string') {
          findings.push({
            kind: 'malformed-frontmatter',
            skill: skill.name,
            message: `'${skill.name}' SKILL.md in ${toolKey} is missing name/description frontmatter`,
          });
        }
      }
    }
    if (tools.length > 0 && !installedSomewhere) {
      findings.push({
        kind: 'missing-install',
        skill: skill.name,
        message: `'${skill.name}' is declared but not installed in any detected tool`,
      });
    }
  }

  // Orphans: a skill in the lock but no longer declared means a sync never ran
  // after the manifest was edited (prune is the sync's job).
  for (const locked of lock?.skills ?? []) {
    if (declared.has(locked.name)) continue;
    findings.push({
      kind: 'orphan-install',
      skill: locked.name,
      message: `'${locked.name}' is in the lockfile but no longer declared — re-run \`roster skills sync\` to prune`,
    });
  }

  return { status: 'checked', findings, hasFailure: findings.length > 0 };
}
