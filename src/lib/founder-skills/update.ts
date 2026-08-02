import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify as stringifyYaml } from 'yaml';
import chalk from 'chalk';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import { workspaceFailure } from '../workspace-diagnostics.ts';
import {
  FOUNDER_SKILLS_MANIFEST_NAME,
  readFounderSkillsManifestSnapshot,
  type NormalizedManifest,
} from './manifest-schema.ts';
import { parseSource } from './installer.ts';
import { normalizeFounderRevision } from '../vendor-skills/provenance.ts';
import { hashWorkspaceBytes, replaceWorkspaceFile } from '../workspace-io.ts';
import {
  assertFounderSkillsWorkspace,
  syncFounderSkills,
  type SyncResult,
  type SyncOptions,
} from './sync.ts';

const execFileAsync = promisify(execFile);

// Resolve the newest tag for a source repo. Injectable so unit tests stay
// hermetic (no network). Real impl uses `git ls-remote --tags`.
export interface RefResolver {
  latest(source: string): Promise<string>;
}

const LS_REMOTE_TIMEOUT_MS = 30_000;

export const realRefResolver: RefResolver = {
  async latest(source) {
    const { owner, repo } = parseSource(source);
    const url = `https://github.com/${owner}/${repo}.git`;
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'git',
        ['ls-remote', '--tags', '--refs', '--sort=-v:refname', url],
        { encoding: 'utf8', timeout: LS_REMOTE_TIMEOUT_MS },
      ));
    } catch (err) {
      // execFile's timeout kills the child (SIGTERM) and rejects with killed:true.
      if ((err as { killed?: boolean }).killed) {
        throw new RosterError({
          header: `${chalk.red.bold('roster:')} tag resolution timed out`,
          body: `  \`git ls-remote\` against ${url} gave no answer within ${LS_REMOTE_TIMEOUT_MS / 1000}s.`,
          remedy: `  Check network/GitHub reachability and re-run \`roster skills update --latest\`.`,
          exitCode: EXIT_ERROR,
        });
      }
      throw err;
    }
    const first = stdout.split('\n').find((l) => l.includes('refs/tags/'));
    if (!first) {
      throw new RosterError({
        header: `${chalk.red.bold('roster:')} no tags to bump to`,
        body: `  ${source} has no git tags — \`--latest\` resolves the newest tag.`,
        remedy: `  Pin an explicit \`ref:\` (e.g. a branch or commit) in founder-skills.yaml and run \`roster skills sync\`.`,
        exitCode: EXIT_ERROR,
      });
    }
    return first.replace(/^.*refs\/tags\//, '').trim();
  },
};

export type UpdateOptions = SyncOptions & {
  latest: boolean;
  resolver: RefResolver;
};

// Rewrite the manifest so every skill is pinned to `ref`, retaining the
// explicit skill_ref join metadata used by the generated vendor-skill map.
function rewriteManifestRef(
  workspaceRoot: string,
  manifest: NormalizedManifest,
  ref: string,
  expectedHash: string,
): void {
  const skills = manifest.skills.map((skill) => skill.skillRef === undefined
    ? skill.name
    : { name: skill.name, skill_ref: skill.skillRef });
  const next = { source: manifest.source, ref, skills };
  replaceWorkspaceFile(workspaceRoot, FOUNDER_SKILLS_MANIFEST_NAME, stringifyYaml(next), {
    expectedHash,
  });
}

export async function updateFounderSkills(opts: UpdateOptions): Promise<SyncResult> {
  assertFounderSkillsWorkspace(opts.cwd);
  const snapshot = readFounderSkillsManifestSnapshot(opts.cwd);
  if (snapshot === null) return { status: 'no-manifest' };
  if (opts.latest) {
    const newRef = normalizeFounderRevision(await opts.resolver.latest(snapshot.manifest.source), {
      path: FOUNDER_SKILLS_MANIFEST_NAME,
    });
    const current = readFounderSkillsManifestSnapshot(opts.cwd);
    if (current === null || !current.bytes.equals(snapshot.bytes)) {
      throw workspaceFailure(
        'WRITE_CONFLICT',
        'founder-skills.yaml changed while the latest revision was being resolved.',
        'Preserve the concurrent manifest bytes, review the edit, and retry the update.',
        { path: FOUNDER_SKILLS_MANIFEST_NAME },
      );
    }
    rewriteManifestRef(
      opts.cwd,
      snapshot.manifest,
      newRef,
      hashWorkspaceBytes(snapshot.bytes),
    );
  }
  return syncFounderSkills({ cwd: opts.cwd, installer: opts.installer });
}
