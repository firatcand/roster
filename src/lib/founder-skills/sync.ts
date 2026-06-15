import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { detectTools, type ToolKey } from '../tools.ts';
import { detectWorkspace } from '../install-scope.ts';
import { workspaceRequiredError } from '../errors.ts';
import {
  founderManifestSchema,
  normalizeManifest,
  type NormalizedManifest,
  FOUNDER_SKILLS_LOCK_VERSION,
} from './manifest-schema.ts';
import { parseSource, type SkillsInstaller } from './installer.ts';
import {
  SUPPORTED_FOUNDER_TOOLS,
  isSupportedFounderTool,
  targetDirFor,
} from './tool-targets.ts';
import {
  hashSkillDir,
  readLockfile,
  writeLockfile,
  type Lockfile,
  type LockedSkill,
} from './lockfile.ts';

export const MANIFEST_NAME = 'founder-skills.yaml';

export function manifestPath(workspaceRoot: string): string {
  return join(workspaceRoot, MANIFEST_NAME);
}

export type SyncResult =
  | { status: 'no-manifest' }
  | {
      status: 'synced';
      installed: string[];
      pruned: string[];
      tools: ToolKey[];
    };

export type SyncOptions = {
  cwd: string;
  installer: SkillsInstaller;
};

function loadManifest(workspaceRoot: string): NormalizedManifest {
  const raw = parseYaml(readFileSync(manifestPath(workspaceRoot), 'utf8')) as unknown;
  const parsed = founderManifestSchema.parse(raw ?? {});
  return normalizeManifest(parsed);
}

// Tools roster will fan out to: detected on this machine AND supported by the
// `skills` CLI mapping (claude, codex).
function resolveTools(): Array<'claude' | 'codex'> {
  return detectTools()
    .map((t) => t.key)
    .filter(isSupportedFounderTool);
}

export async function syncFounderSkills(opts: SyncOptions): Promise<SyncResult> {
  const { cwd } = opts;
  if (!existsSync(manifestPath(cwd))) {
    return { status: 'no-manifest' };
  }
  // Manifest present but not a workspace: we don't know where `.claude/` should
  // live. Refuse rather than guess.
  if (!detectWorkspace(cwd)) {
    throw workspaceRequiredError(cwd);
  }

  const manifest = loadManifest(cwd);
  const source = parseSource(manifest.source);
  const tools = resolveTools();
  const priorLock = readLockfile(cwd);

  const declaredNames = new Set(manifest.skills.map((s) => s.name));

  // Install every declared skill at its resolved ref, into every supported tool
  // target in one invocation per skill.
  const installed: string[] = [];
  if (tools.length > 0) {
    for (const skill of manifest.skills) {
      await opts.installer.add(
        { source, skill: skill.name, ref: skill.ref, tools },
        { cwd },
      );
      installed.push(skill.name);
    }
  }

  // Reconcile/prune: delete any skill roster PREVIOUSLY installed (recorded in
  // the prior lock) that is no longer declared. The lock is the ownership
  // ledger — a user's hand-placed or roster-own skill is never in it, so it is
  // never pruned.
  const pruned: string[] = [];
  for (const locked of priorLock?.skills ?? []) {
    if (declaredNames.has(locked.name)) continue;
    for (const toolKey of locked.tools) {
      if (!isSupportedFounderTool(toolKey)) continue;
      const dir = join(targetDirFor(cwd, toolKey), locked.name);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    pruned.push(locked.name);
  }

  // Recompute content hashes from the installed tree and write the lock. Hash is
  // taken from the first supported tool target that has the skill materialized.
  const lockedSkills: LockedSkill[] = manifest.skills.map((skill) => {
    let contentHash = 'absent';
    for (const toolKey of tools) {
      const h = hashSkillDir(join(targetDirFor(cwd, toolKey), skill.name));
      if (h !== 'absent') {
        contentHash = h;
        break;
      }
    }
    return { name: skill.name, ref: skill.ref, contentHash, tools: [...tools] };
  });

  const lock: Lockfile = {
    version: FOUNDER_SKILLS_LOCK_VERSION,
    source: manifest.source,
    skills: lockedSkills,
  };
  writeLockfile(cwd, lock);

  return { status: 'synced', installed, pruned, tools };
}

export { SUPPORTED_FOUNDER_TOOLS };
