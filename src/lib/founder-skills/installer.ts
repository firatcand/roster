import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { agentFlagFor } from './tool-targets.ts';

const execFileAsync = promisify(execFile);

export type ParsedSource = { owner: string; repo: string };

// Parse a manifest `source` into owner/repo. v1 only supports GitHub because the
// ref-pinning vector is a github.com `/tree/<ref>/<skill>` URL. Accept the
// `github:owner/repo` shorthand and a bare `owner/repo`.
export function parseSource(source: string): ParsedSource {
  const stripped = source.startsWith('github:') ? source.slice('github:'.length) : source;
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(stripped);
  if (!m) {
    throw new Error(
      `unsupported source '${source}' — expected 'github:owner/repo' (v1 supports GitHub only)`,
    );
  }
  return { owner: m[1]!, repo: m[2]! };
}

export type AddSpec = {
  source: ParsedSource;
  skill: string;
  ref: string;
  tools: ReadonlyArray<'claude' | 'codex'>;
};

// Build the `skills add` argv (without the leading `npx`). Pins via a per-skill
// GitHub tree URL — the shorthand `owner/repo` can't take a ref. `--copy`
// materializes the skill files (default is a symlink to npx's temp cache, which
// is useless for a committed, reproducible workspace). `-y` keeps it
// non-interactive.
export function buildAddArgv(spec: AddSpec): string[] {
  const { owner, repo } = spec.source;
  const url = `https://github.com/${owner}/${repo}/tree/${spec.ref}/${spec.skill}`;
  const argv = ['skills', 'add', url, '--copy', '-y'];
  for (const tool of spec.tools) {
    argv.push('-a', agentFlagFor(tool));
  }
  return argv;
}

export interface SkillsInstaller {
  add(spec: AddSpec, opts: { cwd: string }): Promise<void>;
}

// Real installer: runs `npx skills add …` from the workspace dir so the install
// lands project-local. No shell — argv array via execFile to avoid injection.
export const realInstaller: SkillsInstaller = {
  async add(spec, opts) {
    const argv = buildAddArgv(spec);
    await execFileAsync('npx', argv, { cwd: opts.cwd, encoding: 'utf8' });
  },
};
