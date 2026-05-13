import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, relative } from 'node:path';
import chalk from 'chalk';
import { ROSTER_ROOT } from '../lib/paths.ts';

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

const FORGE_MARKERS = ['BRIEF.md', 'spec/PRD.md', 'plans/phases.yaml'];

// Matches `<basename>.template` or `<basename>.template.<ext>`. Capture group
// is the trailing extension (or empty), so the suffix can be replaced with the
// captured ext to drop only `.template` from the filename.
const TEMPLATE_SUFFIX_RE = /\.template(\.[^.]+)?$/;

function readTemplate(name: string): string {
  return readFileSync(join(ROSTER_ROOT, 'templates', name), 'utf8');
}

export function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

export function detectForgeMarkers(cwd: string): string[] {
  return FORGE_MARKERS.filter((m) => existsSync(join(cwd, m)));
}

// Destination probes use lstat (not stat) so symlinks are detected as themselves
// rather than followed. Non-template files: anything present at the path is
// preserved (file, dir, symlink, broken symlink). Template files: a regular
// file is overwritten; a symlink causes a hard error — refusing to write
// through a link is a security boundary, not a UX choice.

function entryAtPath(path: string): { exists: boolean; isSymlink: boolean } {
  try {
    const st = lstatSync(path);
    return { exists: true, isSymlink: st.isSymbolicLink() };
  } catch {
    return { exists: false, isSymlink: false };
  }
}

export function walkScaffold(
  srcRoot: string,
  dstRoot: string,
  vars: Record<string, string>,
): string[] {
  const written: string[] = [];

  function walk(srcDir: string, dstDir: string): void {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = join(srcDir, entry.name);

      if (entry.isDirectory()) {
        const subDst = join(dstDir, entry.name);
        mkdirSync(subDst, { recursive: true });
        walk(srcPath, subDst);
        continue;
      }

      if (!entry.isFile()) {
        throw new Error(
          `roster: unexpected entry type in scaffold: ${srcPath}. ` +
            `Scaffold must contain only regular files and directories.`,
        );
      }

      if (TEMPLATE_SUFFIX_RE.test(entry.name)) {
        const outName = entry.name.replace(TEMPLATE_SUFFIX_RE, '$1');
        const dstPath = join(dstDir, outName);
        const dst = entryAtPath(dstPath);
        if (dst.isSymlink) {
          throw new Error(
            `roster: refusing to overwrite symlink at ${dstPath}. ` +
              `Remove the symlink and re-run roster init.`,
          );
        }
        const rendered = substitute(readFileSync(srcPath, 'utf8'), vars);
        writeFileSync(dstPath, rendered, 'utf8');
        written.push(relative(dstRoot, dstPath));
        continue;
      }

      const dstPath = join(dstDir, entry.name);
      if (entryAtPath(dstPath).exists) continue;
      copyFileSync(srcPath, dstPath);
      written.push(relative(dstRoot, dstPath));
    }
  }

  mkdirSync(dstRoot, { recursive: true });
  walk(srcRoot, dstRoot);
  return written;
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

  const forgeMarkers = detectForgeMarkers(opts.cwd);
  const claudeMdPath = join(opts.cwd, 'CLAUDE.md');
  const claudeMdExists = existsSync(claudeMdPath);

  if (claudeMdExists && !force) {
    const message =
      forgeMarkers.length > 0
        ? `This looks like a forge-initialized project (found: ${forgeMarkers.join(', ')}). Running roster init will replace CLAUDE.md and add the agent-team scaffold. Continue?`
        : `CLAUDE.md already exists in this directory. Overwrite?`;

    let ok: boolean;
    try {
      ok = await confirm(message);
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
  } else if (forgeMarkers.length > 0 && !silent) {
    logger.warn(
      chalk.yellow(
        `Detected forge artifacts (${forgeMarkers.join(', ')}); roster scaffold will be added alongside.`,
      ),
    );
  }

  const filesWritten: string[] = [];

  const scaffoldSrc = join(ROSTER_ROOT, 'templates', 'scaffold');
  if (!existsSync(scaffoldSrc)) {
    throw new Error(
      `roster: scaffold templates missing at ${scaffoldSrc}. ` +
        `This roster install is broken — reinstall with: npm install -g @firatcand/roster`,
    );
  }
  const scaffoldFiles = walkScaffold(scaffoldSrc, opts.cwd, { PROJECT_NAME: projectName });
  filesWritten.push(...scaffoldFiles);

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
    if (filesWritten.length > 8) {
      info(chalk.dim(`Files: ${filesWritten.length} written`));
    } else {
      info(chalk.dim('Files: ') + filesWritten.join(', '));
    }
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
