import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import fsExtra from 'fs-extra';
import chalk from 'chalk';
import type { Tool, ToolKey } from './tools.ts';
import type { Scope } from './install-scope.ts';
import { permissionError } from './errors.ts';
import { renderSkillFrontmatterContent } from './frontmatter.ts';
import { renderCodexAgentToml, RosterAgentRenderError } from './agent-render.ts';

const { copy, ensureDir } = fsExtra;

export type ConfirmFn = (message: string) => Promise<boolean>;

export type InstallLogger = {
  log: (msg: string) => void;
  warn: (msg: string) => void;
};

export type InstallOptions = {
  skills: string;
  agents: string;
  silent?: boolean;
  confirm?: ConfirmFn;
  logger?: InstallLogger;
  // Scope drives the EACCES remediation message only — project-scope errors
  // suggest chmod (workspace-local), user-scope errors suggest sudo (home dir).
  // See errors.ts#permissionError.
  scope?: Scope;
};

export type InstallResult = {
  skillsCount: number;
  skillsTarget: string;
  agentsCount: number;
  agentsTarget: string | null;
};

export class RosterPathTraversalError extends Error {
  public readonly target: string;
  public readonly root: string;
  public readonly label: string;
  constructor(target: string, root: string, label: string) {
    super(`Refusing to write ${label} outside configRoot: ${target} is not under ${root}`);
    this.name = 'RosterPathTraversalError';
    this.target = target;
    this.root = root;
    this.label = label;
  }
}

// Internal invariant check. Not a defense against ROSTER_*_HOME=/etc; that env var is
// trusted input on the same level as the invoking user. Catches future bugs where a
// Tool is constructed with a target outside its own configRoot, and provides
// defense-in-depth against per-entry name escapes during copy. See ROS-30 plan + the
// security.test.ts header for the full threat-model writeup.
// Exported so the per-entry defense-in-depth callsites can be unit-tested directly —
// real POSIX `dirent.name` cannot contain `/`, so the validator's per-entry behavior
// is otherwise unreachable from integration tests.
export function assertWithinRoot(target: string, root: string, label: string): void {
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  const rel = relative(absRoot, absTarget);
  if (rel === '' || rel === '.') return;
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new RosterPathTraversalError(absTarget, absRoot, label);
  }
}

function isEacces(err: unknown): err is NodeJS.ErrnoException {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'EACCES'
  );
}

async function defaultConfirm(message: string): Promise<boolean> {
  // Lazy import keeps inquirer out of the cold-start path when no symlinks exist.
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message, default: false });
}

const consoleLogger: InstallLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

// File-system wrapper around the pure frontmatter renderer in
// src/lib/frontmatter.ts. Reads target, applies the canonical render, writes
// only when content actually changes (idempotent).
export function renderSkillFrontmatter(skillMdPath: string, toolKey: ToolKey): void {
  if (!existsSync(skillMdPath)) return;
  const content = readFileSync(skillMdPath, 'utf8');
  const newContent = renderSkillFrontmatterContent(content, toolKey);
  if (newContent !== content) writeFileSync(skillMdPath, newContent);
}

async function prepareTargetForWrite(
  targetPath: string,
  kind: 'skill' | 'agent' | 'agent persona',
  logger: InstallLogger,
  confirm: ConfirmFn,
): Promise<boolean> {
  if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
    const accepted = await confirm(
      `${targetPath} is a symbolic link. Replace it with the bundled ${kind}?`,
    );
    if (!accepted) {
      logger.warn(chalk.dim(`  ~ preserved symlink: ${targetPath}`));
      return false;
    }
    await rm(targetPath, { force: true });
  }
  return true;
}

async function copyOne(
  srcPath: string,
  targetPath: string,
  kind: 'skill' | 'agent',
  logger: InstallLogger,
  confirm: ConfirmFn,
  scope: Scope | undefined,
): Promise<boolean> {
  try {
    const ok = await prepareTargetForWrite(targetPath, kind, logger, confirm);
    if (!ok) return false;
    await copy(srcPath, targetPath, { overwrite: true, errorOnExist: false });
    return true;
  } catch (err: unknown) {
    if (isEacces(err)) {
      throw permissionError(targetPath, err, scope);
    }
    throw err;
  }
}

async function writeRenderedOne(
  targetPath: string,
  contents: string,
  kind: 'agent' | 'agent persona',
  logger: InstallLogger,
  confirm: ConfirmFn,
  scope: Scope | undefined,
): Promise<boolean> {
  try {
    const ok = await prepareTargetForWrite(targetPath, kind, logger, confirm);
    if (!ok) return false;
    writeFileSync(targetPath, contents);
    return true;
  } catch (err: unknown) {
    if (isEacces(err)) {
      throw permissionError(targetPath, err, scope);
    }
    throw err;
  }
}

export async function installToTool(tool: Tool, opts: InstallOptions): Promise<InstallResult> {
  const logger = opts.logger ?? consoleLogger;
  const confirm = opts.confirm ?? defaultConfirm;
  const silent = opts.silent ?? false;
  const info = (msg: string): void => {
    if (!silent) logger.log(msg);
  };

  assertWithinRoot(tool.skillsTarget, tool.configRoot, 'skillsTarget');
  if (tool.agentsTarget) {
    assertWithinRoot(tool.agentsTarget, tool.configRoot, 'agentsTarget');
  }

  try {
    await ensureDir(tool.skillsTarget);
    if (tool.agentsTarget) await ensureDir(tool.agentsTarget);
  } catch (err: unknown) {
    if (isEacces(err)) {
      throw permissionError(tool.skillsTarget, err, opts.scope);
    }
    throw err;
  }

  let skillsCount = 0;
  if (existsSync(opts.skills)) {
    const entries = readdirSync(opts.skills, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const srcDir = join(opts.skills, dirent.name);

      const srcSkillMd = join(srcDir, 'SKILL.md');
      if (!existsSync(srcSkillMd)) {
        logger.warn(chalk.yellow(`  ! skill ${dirent.name}: SKILL.md missing — skipped`));
        continue;
      }

      const srcPath = srcDir;
      const targetPath = join(tool.skillsTarget, dirent.name);
      const renderedSkillMd = join(targetPath, 'SKILL.md');

      assertWithinRoot(targetPath, tool.configRoot, 'skill targetPath');
      info(chalk.dim(`  + skill ${dirent.name} -> ${targetPath}`));
      const written = await copyOne(srcPath, targetPath, 'skill', logger, confirm, opts.scope);
      if (written) {
        renderSkillFrontmatter(renderedSkillMd, tool.key);
        skillsCount++;
      }
    }
  }

  // Per-tool agent install branch (ROS-33).
  //
  // - md-copy   (Claude, Gemini): copy source agents/<name>.md verbatim.
  // - codex-toml (Codex):         render to <name>.toml + <name>.persona.md.
  //
  // The .persona.md sidecar is emitted on every host so the roster-orchestrator
  // skill (ROS-32) has a uniform source-of-truth for runtime persona injection
  // via `-c developer_instructions=…` on Codex Windows, where the .toml is
  // silently ignored (openai/codex#19399).
  //
  // Remove the persona sidecar branch when openai/codex#19399 closes.
  let agentsCount = 0;
  if (tool.agentsTarget && existsSync(opts.agents)) {
    const entries = readdirSync(opts.agents, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue;
      const srcPath = join(opts.agents, dirent.name);

      if (tool.agentsLayout === 'codex-toml') {
        const baseName = dirent.name.replace(/\.md$/, '');
        const tomlTarget = join(tool.agentsTarget, `${baseName}.toml`);
        const personaTarget = join(tool.agentsTarget, `${baseName}.persona.md`);
        assertWithinRoot(tomlTarget, tool.configRoot, 'agent targetPath');
        assertWithinRoot(personaTarget, tool.configRoot, 'agent persona targetPath');

        let rendered;
        try {
          rendered = renderCodexAgentToml(readFileSync(srcPath, 'utf8'));
        } catch (err: unknown) {
          if (err instanceof RosterAgentRenderError) {
            logger.warn(chalk.yellow(`  ! agent ${dirent.name}: ${err.message} — skipped`));
            continue;
          }
          throw err;
        }

        info(chalk.dim(`  + agent ${dirent.name} -> ${tomlTarget}`));
        const wroteToml = await writeRenderedOne(tomlTarget, rendered.toml, 'agent', logger, confirm, opts.scope);
        const wrotePersona = await writeRenderedOne(
          personaTarget,
          rendered.personaBody,
          'agent persona',
          logger,
          confirm,
          opts.scope,
        );
        if (wroteToml && wrotePersona) agentsCount++;
        continue;
      }

      const targetPath = join(tool.agentsTarget, dirent.name);
      assertWithinRoot(targetPath, tool.configRoot, 'agent targetPath');
      info(chalk.dim(`  + agent ${dirent.name} -> ${targetPath}`));
      const written = await copyOne(srcPath, targetPath, 'agent', logger, confirm, opts.scope);
      if (written) agentsCount++;
    }
  }

  return {
    skillsCount,
    skillsTarget: tool.skillsTarget,
    agentsCount,
    agentsTarget: tool.agentsTarget,
  };
}
