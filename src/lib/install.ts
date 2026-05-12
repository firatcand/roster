import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import fsExtra from 'fs-extra';
import chalk from 'chalk';
import type { Tool } from './tools.ts';

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
};

export type InstallResult = {
  skillsCount: number;
  skillsTarget: string;
  agentsCount: number;
  agentsTarget: string | null;
};

export class RosterPermissionError extends Error {
  public readonly targetPath: string;
  constructor(targetPath: string, cause: NodeJS.ErrnoException) {
    super(
      [
        `Permission denied: ${targetPath}`,
        `  cause: ${cause.code}${cause.syscall ? ` (${cause.syscall})` : ''}`,
        `  remedy: re-run with sudo, or run \`sudo chown -R "$USER" ${targetPath}\``,
      ].join('\n'),
    );
    this.name = 'RosterPermissionError';
    this.targetPath = targetPath;
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

async function copyOne(
  srcPath: string,
  targetPath: string,
  kind: 'skill' | 'agent',
  logger: InstallLogger,
  confirm: ConfirmFn,
): Promise<boolean> {
  try {
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
    await copy(srcPath, targetPath, { overwrite: true, errorOnExist: false });
    return true;
  } catch (err: unknown) {
    if (isEacces(err)) {
      throw new RosterPermissionError(targetPath, err);
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

  try {
    await ensureDir(tool.skillsTarget);
    if (tool.agentsTarget) await ensureDir(tool.agentsTarget);
  } catch (err: unknown) {
    if (isEacces(err)) {
      throw new RosterPermissionError(tool.skillsTarget, err);
    }
    throw err;
  }

  let skillsCount = 0;
  if (existsSync(opts.skills)) {
    const entries = readdirSync(opts.skills, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue;
      const srcDir = join(opts.skills, dirent.name);

      let srcPath: string;
      let targetPath: string;
      if (tool.skillsLayout === 'file') {
        // Codex-style: write SKILL.md body as a flat <name><ext> file.
        const srcSkillMd = join(srcDir, 'SKILL.md');
        if (!existsSync(srcSkillMd)) {
          logger.warn(chalk.yellow(`  ! skill ${dirent.name}: SKILL.md missing — skipped`));
          continue;
        }
        const ext = tool.skillsFileExt ?? '.md';
        srcPath = srcSkillMd;
        targetPath = join(tool.skillsTarget, `${dirent.name}${ext}`);
      } else {
        // Claude/Gemini-style: copy the whole skill directory.
        srcPath = srcDir;
        targetPath = join(tool.skillsTarget, dirent.name);
      }

      info(chalk.dim(`  + skill ${dirent.name} -> ${targetPath}`));
      const written = await copyOne(srcPath, targetPath, 'skill', logger, confirm);
      if (written) skillsCount++;
    }
  }

  let agentsCount = 0;
  if (tool.agentsTarget && existsSync(opts.agents)) {
    const entries = readdirSync(opts.agents, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isFile() || !dirent.name.endsWith('.md')) continue;
      const srcPath = join(opts.agents, dirent.name);
      const targetPath = join(tool.agentsTarget, dirent.name);
      info(chalk.dim(`  + agent ${dirent.name} -> ${targetPath}`));
      const written = await copyOne(srcPath, targetPath, 'agent', logger, confirm);
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
