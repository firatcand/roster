import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseFrontMatter } from '../front-matter.ts';
import { readFounderSkillsManifest } from './manifest-schema.ts';
import { readLockfile } from './lockfile.ts';
import {
  isSupportedFounderTool,
  projectSkillPathFor,
  targetDirFor,
} from './tool-targets.ts';
import { MANIFEST_NAME } from './sync.ts';
import { detectTools } from '../tools.ts';
import { hashProjectSkillForHost } from '../vendor-skills/adapter-map.ts';
import { tryReadWorkspaceFile } from '../workspace-io.ts';

export type DriftFinding = {
  kind:
    | 'missing-install'
    | 'orphan-install'
    | 'ref-mismatch'
    | 'hash-mismatch'
    | 'source-mismatch'
    | 'malformed-frontmatter'
    | 'no-lock'
    | 'lock-parse-error'
    | 'skill-ref-mismatch'
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
  const findings: DriftFinding[] = [];

  let normalized;
  try {
    normalized = readFounderSkillsManifest(cwd);
  } catch {
    findings.push({
      kind: 'manifest-parse-error',
      skill: null,
      message: `${MANIFEST_NAME} contains invalid or forbidden metadata`,
    });
    return { status: 'checked', findings, hasFailure: true };
  }
  if (normalized === null) return { status: 'not-applicable' };

  let lock;
  try {
    lock = readLockfile(cwd);
  } catch {
    findings.push({
      kind: 'lock-parse-error',
      skill: null,
      message: 'founder-skills.lock contains invalid or forbidden metadata',
    });
    return { status: 'checked', findings, hasFailure: true };
  }
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
    if (locked && locked.skill_ref !== skill.skillRef) {
      findings.push({
        kind: 'skill-ref-mismatch',
        skill: skill.name,
        message: `'${skill.name}' lock skill_ref does not match the manifest`,
      });
    }

    let installedSomewhere = false;
    for (const toolKey of tools) {
      const dir = join(targetDirFor(cwd, toolKey), skill.name);
      if (!existsSync(dir)) continue;
      installedSomewhere = true;
      let actualHash: string;
      try {
        actualHash = hashProjectSkillForHost({
          workspaceRoot: cwd,
          host: toolKey,
          skillName: skill.name,
        }).contentHash;
      } catch {
        findings.push({
          kind: 'hash-mismatch',
          skill: skill.name,
          message: `'${skill.name}' content in ${toolKey} cannot be verified safely`,
        });
        continue;
      }
      if (locked) {
        const expectedHash = locked.contentHashes?.[toolKey];
        if (expectedHash === undefined || actualHash !== expectedHash) {
          findings.push({
            kind: 'hash-mismatch',
            skill: skill.name,
            message: expectedHash === undefined
              ? `'${skill.name}' has no canonical per-host hash for ${toolKey} — run roster skills sync`
              : `'${skill.name}' content in ${toolKey} differs from the lockfile`,
          });
        }
      }
      let skillMd: Buffer | null;
      try {
        skillMd = tryReadWorkspaceFile(cwd, `${projectSkillPathFor(toolKey, skill.name)}/SKILL.md`);
      } catch {
        findings.push({
          kind: 'hash-mismatch',
          skill: skill.name,
          message: `'${skill.name}' SKILL.md in ${toolKey} cannot be read safely`,
        });
        continue;
      }
      if (skillMd !== null) {
        const { frontMatter } = parseFrontMatter(skillMd.toString('utf8'));
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
