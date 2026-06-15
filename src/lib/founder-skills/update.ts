import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { atomicWriteFile } from '../schedule-yaml.ts';
import { workspaceRequiredError } from '../errors.ts';
import { detectWorkspace } from '../install-scope.ts';
import { founderManifestSchema, normalizeManifest } from './manifest-schema.ts';
import { parseSource } from './installer.ts';
import { manifestPath, syncFounderSkills, type SyncResult, type SyncOptions } from './sync.ts';

const execFileAsync = promisify(execFile);

// Resolve the newest tag for a source repo. Injectable so unit tests stay
// hermetic (no network). Real impl uses `git ls-remote --tags`.
export interface RefResolver {
  latest(source: string): Promise<string>;
}

export const realRefResolver: RefResolver = {
  async latest(source) {
    const { owner, repo } = parseSource(source);
    const url = `https://github.com/${owner}/${repo}.git`;
    const { stdout } = await execFileAsync(
      'git',
      ['ls-remote', '--tags', '--refs', '--sort=-v:refname', url],
      { encoding: 'utf8' },
    );
    const first = stdout.split('\n').find((l) => l.includes('refs/tags/'));
    if (!first) throw new Error(`no tags found for ${source}`);
    return first.replace(/^.*refs\/tags\//, '').trim();
  },
};

export type UpdateOptions = SyncOptions & {
  latest: boolean;
  resolver: RefResolver;
};

// Rewrite the manifest so every skill is pinned to `ref`. Collapses to the
// top-level `ref` form (one ref for all skills) since --latest bumps the whole
// set together.
function rewriteManifestRef(workspaceRoot: string, ref: string): void {
  const path = manifestPath(workspaceRoot);
  const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const parsed = founderManifestSchema.parse(raw ?? {});
  const names = normalizeManifest(parsed).skills.map((s) => s.name);
  const next = { source: parsed.source, ref, skills: names };
  atomicWriteFile(path, stringifyYaml(next));
}

export async function updateFounderSkills(opts: UpdateOptions): Promise<SyncResult> {
  if (!existsSync(manifestPath(opts.cwd))) {
    return { status: 'no-manifest' };
  }
  if (!detectWorkspace(opts.cwd)) {
    throw workspaceRequiredError(opts.cwd);
  }
  if (opts.latest) {
    const raw = parseYaml(readFileSync(manifestPath(opts.cwd), 'utf8')) as Record<string, unknown>;
    const parsed = founderManifestSchema.parse(raw ?? {});
    const newRef = await opts.resolver.latest(parsed.source);
    rewriteManifestRef(opts.cwd, newRef);
  }
  return syncFounderSkills({ cwd: opts.cwd, installer: opts.installer });
}
