import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, relative } from 'node:path';
import chalk from 'chalk';
import { ROSTER_ROOT } from '../lib/paths.ts';
import { missingScaffoldError, v04WorkspaceDetectedError } from '../lib/errors.ts';
import { writeContextAndLinks } from '../lib/project-context.ts';

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
  migrate?: boolean;
  noGit?: boolean;
  confirm?: ConfirmFn;
  logger?: InitLogger;
  platform?: string;
};

export type InitStatus = 'ok' | 'cancelled';

export type InitResult = {
  status: InitStatus;
  workspaceRoot: string;
  projectName: string;
  filesWritten: string[];
  filesUpdated: string[];
  filesSkipped: string[];
  filesLinked: string[];
  warnings: string[];
  gitInitialized: boolean;
};

export const GITIGNORE_MARKER_START = '# Roster defaults';

const FORGE_MARKERS = ['BRIEF.md', 'spec/PRD.md', 'plans/phases.yaml'];

const V04_SCAN_SKIP = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'lib',
  'bin',
]);

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

// SPEC §Flow 1 step 2 — v0.4 had nested `<function>/<agent>/projects/<project>/`,
// so we scan two levels deep under every non-skiplisted top-level dir. Hidden
// dirs (`.git`, `.forge`, `.claude`) are excluded by the `.`-prefix check.
export function detectV04Workspace(cwd: string): string[] {
  const hits: string[] = [];
  if (existsSync(join(cwd, 'projects'))) hits.push('projects/');

  let topEntries;
  try {
    topEntries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return hits;
  }

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    if (top.name.startsWith('.')) continue;
    if (V04_SCAN_SKIP.has(top.name)) continue;

    const topPath = join(cwd, top.name);
    if (existsSync(join(topPath, 'projects'))) hits.push(`${top.name}/projects/`);

    let subEntries;
    try {
      subEntries = readdirSync(topPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      if (sub.name.startsWith('.')) continue;
      if (existsSync(join(topPath, sub.name, 'projects'))) {
        hits.push(`${top.name}/${sub.name}/projects/`);
      }
    }
  }

  return hits;
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

function ensureEnvExample(cwd: string): void {
  const target = join(cwd, '.env.example');
  if (existsSync(target)) return;
  writeFileSync(target, readTemplate('env.example'), 'utf8');
}

export function appendGitignoreBlock(cwd: string): 'written' | 'skipped' {
  const path = join(cwd, '.gitignore');
  const block = readTemplate('gitignore-defaults.txt');

  if (!existsSync(path)) {
    writeFileSync(path, block, 'utf8');
    return 'written';
  }

  const current = readFileSync(path, 'utf8');
  if (current.includes(GITIGNORE_MARKER_START)) return 'skipped';

  const sep = current.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(path, current + sep + block, 'utf8');
  return 'written';
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
  const migrate = opts.migrate ?? false;
  const confirm = opts.confirm ?? defaultConfirm;

  const info = (msg: string): void => {
    if (!silent) logger.log(msg);
  };

  const v04Hits = detectV04Workspace(opts.cwd);
  if (v04Hits.length > 0) {
    throw v04WorkspaceDetectedError(v04Hits);
  }

  const forgeMarkers = detectForgeMarkers(opts.cwd);
  const contextMdPath = join(opts.cwd, 'CONTEXT.md');
  const claudeMdPath = join(opts.cwd, 'CLAUDE.md');
  const contextMdExists = existsSync(contextMdPath);
  const claudeMdExists = existsSync(claudeMdPath);

  const claudeMdIsSymlink = claudeMdExists
    ? (() => { try { return lstatSync(claudeMdPath).isSymbolicLink(); } catch { return false; } })()
    : false;

  const isMigration = claudeMdExists && !contextMdExists && !claudeMdIsSymlink;

  const cancelledResult: InitResult = {
    status: 'cancelled',
    workspaceRoot: opts.cwd,
    projectName,
    filesWritten: [],
    filesUpdated: [],
    filesSkipped: [],
    filesLinked: [],
    warnings: [],
    gitInitialized: false,
  };

  if (isMigration && !force && !migrate) {
    info(
      `roster: detected a pre-CONTEXT.md workspace (CLAUDE.md is a regular file).\n` +
        `  - Re-run with --migrate to upgrade and preserve your CLAUDE.md content.\n` +
        `  - Re-run with --force to replace CLAUDE.md without preserving content.\n` +
        `  - Or manually delete CLAUDE.md and re-run roster init.`,
    );
    return cancelledResult;
  }

  if (!isMigration && (contextMdExists || claudeMdExists) && !force) {
    const message =
      forgeMarkers.length > 0
        ? `This looks like a forge-initialized project (found: ${forgeMarkers.join(', ')}). Running roster init will update CONTEXT.md and add the agent-team scaffold. Continue?`
        : `CONTEXT.md or CLAUDE.md already exists in this directory. Overwrite?`;

    let ok: boolean;
    try {
      ok = await confirm(message);
    } catch {
      ok = false;
    }
    if (!ok) {
      return cancelledResult;
    }
  } else if (forgeMarkers.length > 0 && !isMigration && !silent) {
    logger.warn(
      chalk.yellow(
        `Detected forge artifacts (${forgeMarkers.join(', ')}); roster scaffold will be added alongside.`,
      ),
    );
  }

  const filesWritten: string[] = [];
  const filesUpdated: string[] = [];
  const filesSkipped: string[] = [];
  const filesLinked: string[] = [];
  const warnings: string[] = [];

  const scaffoldSrc = join(ROSTER_ROOT, 'templates', 'scaffold');
  if (!existsSync(scaffoldSrc)) {
    throw missingScaffoldError(scaffoldSrc);
  }
  const scaffoldFiles = walkScaffold(scaffoldSrc, opts.cwd, {
    PROJECT_NAME: projectName,
    DISPLAY_NAME: projectName,
  });
  filesWritten.push(...scaffoldFiles);

  // For --migrate: inject existing CLAUDE.md content into user region before writing
  if (isMigration && migrate) {
    const existingClaudeMd = readFileSync(claudeMdPath, 'utf8');
    const oldTemplateSrc = join(ROSTER_ROOT, 'templates', 'CLAUDE.project.template.md');
    let oldTemplateRendered = '';
    try {
      oldTemplateRendered = substitute(readFileSync(oldTemplateSrc, 'utf8'), { PROJECT_NAME: projectName });
    } catch {
      // If old template is gone, treat all as user content
    }

    const userLines: string[] = [];
    const existingLines = existingClaudeMd.split('\n');

    if (!oldTemplateRendered || existingClaudeMd.trim() !== oldTemplateRendered.trim()) {
      // Diff line by line: lines not in template are user content
      const templateSet = new Set(oldTemplateRendered.split('\n').map((l) => l.trim()));
      for (const line of existingLines) {
        if (!templateSet.has(line.trim())) {
          userLines.push(line);
        }
      }
    }

    if (userLines.length > 0) {
      const fresh = readFileSync(join(ROSTER_ROOT, 'templates', 'CONTEXT.template.md'), 'utf8');
      const rendered = substitute(fresh, { PROJECT_NAME: projectName });

      const USER_START = `<!-- roster:user:start workspace -->`;
      const USER_END = `<!-- roster:user:end workspace -->`;
      const userPlaceholder = `## Workspace: ${projectName}\n\n[Replace this section with project-specific context: domain, goals, constraints.]`;
      const userInjected = userLines.join('\n').trim();
      const withUserContent = rendered.replace(
        `${USER_START}\n${userPlaceholder}\n${USER_END}`,
        `${USER_START}\n${userInjected}\n${USER_END}`,
      );
      writeFileSync(contextMdPath, withUserContent, 'utf8');
    }

    unlinkSync(claudeMdPath);
    const agentsMdPath = join(opts.cwd, 'AGENTS.md');
    if (existsSync(agentsMdPath) && !lstatSync(agentsMdPath).isSymbolicLink()) {
      unlinkSync(agentsMdPath);
    }
  }

  const writeResult = writeContextAndLinks(opts.cwd, projectName, {
    force,
    platform: opts.platform,
  });
  filesWritten.push(...writeResult.filesWritten);
  filesUpdated.push(...writeResult.filesUpdated);
  filesSkipped.push(...writeResult.filesSkipped);
  filesLinked.push(...writeResult.filesLinked);
  warnings.push(...writeResult.warnings);

  if (!existsSync(join(opts.cwd, '.env.example'))) {
    ensureEnvExample(opts.cwd);
    filesWritten.push('.env.example');
  }

  const gitignoreResult = appendGitignoreBlock(opts.cwd);
  if (gitignoreResult === 'written') {
    filesWritten.push('.gitignore');
  } else {
    filesSkipped.push('.gitignore');
  }

  const gitInitialized = await maybeGitInit(opts.cwd, opts.noGit ?? false, confirm);

  const totalChanged = filesWritten.length + filesUpdated.length + filesLinked.length;

  if (!silent) {
    info('');
    info(
      `${chalk.green('✓')} Initialized roster workspace ${chalk.bold(`'${projectName}'`)} in ${opts.cwd} ${chalk.dim('(current directory)')}`,
    );
    if (totalChanged > 8) {
      info(chalk.dim(`Files: ${totalChanged} written/linked`));
    } else {
      const changed = [...filesWritten, ...filesUpdated, ...filesLinked];
      info(chalk.dim('Files: ') + changed.join(', '));
    }
    for (const w of warnings) info(chalk.yellow(w));
    if (gitInitialized) info(chalk.dim('Git: initialized .git/'));
    info('');
    info(
      `${chalk.dim('Next: ')}you are already in this directory — ${chalk.bold('open Claude Code here')}${chalk.dim(' and run ')}${chalk.bold('/chief-of-staff audit-repo')}`,
    );
  }

  return {
    status: 'ok',
    workspaceRoot: opts.cwd,
    projectName,
    filesWritten,
    filesUpdated,
    filesSkipped,
    filesLinked,
    warnings,
    gitInitialized,
  };
}
