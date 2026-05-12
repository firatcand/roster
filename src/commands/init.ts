import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import fsExtra from 'fs-extra';
import chalk from 'chalk';
import { ROSTER_ROOT } from '../lib/paths.ts';

const { copy } = fsExtra;

export type ConfirmFn = (message: string) => Promise<boolean>;

export type InitLogger = {
  log: (msg: string) => void;
  warn: (msg: string) => void;
};

export type InitOptions = {
  cwd: string;
  name?: string;
  silent?: boolean;
  force?: boolean;
  noGit?: boolean;
  confirm?: ConfirmFn;
  logger?: InitLogger;
};

export type InitStatus = 'ok' | 'cancelled';

export type InitResult = {
  status: InitStatus;
  workspaceRoot: string;
  projectName: string;
  filesWritten: string[];
  gitInitialized: boolean;
};

export const GITIGNORE_MARKER_START = '# Roster defaults';

function readTemplate(name: string): string {
  return readFileSync(join(ROSTER_ROOT, 'templates', name), 'utf8');
}

export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

async function defaultConfirm(message: string): Promise<boolean> {
  const { confirm } = await import('@inquirer/prompts');
  return confirm({ message, default: false });
}

const consoleLogger: InitLogger = {
  log: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

function writeClaudeMd(cwd: string, projectName: string): void {
  const tpl = readTemplate('CLAUDE.project.template.md');
  writeFileSync(join(cwd, 'CLAUDE.md'), substitute(tpl, { PROJECT_NAME: projectName }), 'utf8');
}

function ensureEnvExample(cwd: string): void {
  const target = join(cwd, '.env.example');
  if (existsSync(target)) return;
  writeFileSync(target, readTemplate('env.example'), 'utf8');
}

export function appendGitignoreBlock(cwd: string): void {
  const path = join(cwd, '.gitignore');
  const block = readTemplate('gitignore-defaults.txt');

  if (!existsSync(path)) {
    writeFileSync(path, block, 'utf8');
    return;
  }

  const current = readFileSync(path, 'utf8');
  if (current.includes(GITIGNORE_MARKER_START)) return;

  const sep = current.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(path, current + sep + block, 'utf8');
}

async function maybeGitInit(cwd: string, noGit: boolean, confirm: ConfirmFn): Promise<boolean> {
  if (noGit) return false;
  if (existsSync(join(cwd, '.git'))) return false;
  const ok = await confirm('Initialize a git repo here?');
  if (!ok) return false;
  try {
    // execFileSync (not execSync): no shell, args are an array — no injection surface.
    execFileSync('git', ['init', '-q'], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function executeInit(opts: InitOptions): Promise<InitResult> {
  const projectName = opts.name ?? basename(opts.cwd);
  const logger = opts.logger ?? consoleLogger;
  const silent = opts.silent ?? false;
  const force = opts.force ?? false;
  const confirm = opts.confirm ?? defaultConfirm;

  const info = (msg: string): void => {
    if (!silent) logger.log(msg);
  };

  const claudeMdPath = join(opts.cwd, 'CLAUDE.md');
  if (existsSync(claudeMdPath) && !force) {
    let ok: boolean;
    try {
      ok = await confirm(`CLAUDE.md already exists in this directory. Overwrite?`);
    } catch {
      ok = false;
    }
    if (!ok) {
      info(chalk.dim('Cancelled. Nothing written.'));
      return {
        status: 'cancelled',
        workspaceRoot: opts.cwd,
        projectName,
        filesWritten: [],
        gitInitialized: false,
      };
    }
  }

  const filesWritten: string[] = [];

  const scaffoldSrc = join(ROSTER_ROOT, 'templates', 'scaffold');
  if (existsSync(scaffoldSrc)) {
    await copy(scaffoldSrc, opts.cwd, { overwrite: true, errorOnExist: false });
    filesWritten.push('projects/_demo/');
  }

  writeClaudeMd(opts.cwd, projectName);
  filesWritten.push('CLAUDE.md');

  if (!existsSync(join(opts.cwd, '.env.example'))) {
    ensureEnvExample(opts.cwd);
    filesWritten.push('.env.example');
  }

  appendGitignoreBlock(opts.cwd);
  filesWritten.push('.gitignore');

  const gitInitialized = await maybeGitInit(opts.cwd, opts.noGit ?? false, confirm);

  if (!silent) {
    info('');
    info(`${chalk.green('✓')} Initialized ${chalk.bold(projectName)} in ${opts.cwd}`);
    info(chalk.dim('Files: ') + filesWritten.join(', '));
    if (gitInitialized) info(chalk.dim('Git: initialized .git/'));
    info('');
    info(
      `${chalk.dim('Next: ')}${chalk.bold('open in Claude Code')}${chalk.dim(' and run ')}${chalk.bold('/chief-of-staff audit-repo')}`,
    );
  }

  return {
    status: 'ok',
    workspaceRoot: opts.cwd,
    projectName,
    filesWritten,
    gitInitialized,
  };
}
