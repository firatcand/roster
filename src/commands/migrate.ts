import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import chalk from 'chalk';
import {
  EXIT_OK,
  EXIT_ERROR,
  RosterError,
  migrateSourceNotFoundError,
  migrateDestNotInitializedError,
  envPermissionTooOpenError,
  migrateSourceAlreadyRosterError,
} from '../lib/errors.ts';
import { isLikelyRosterWorkspace, scanSourceWorkspace } from '../lib/migrate/scan.ts';
import { planMigration } from '../lib/migrate/plan.ts';
import { executeMigration } from '../lib/migrate/execute.ts';
import { renderTextReport, renderMarkdownReport } from '../lib/migrate/report.ts';

export type MigrateFromAgentTeamOptions = {
  sourceDir: string;
  dest: string | undefined;
  dryRun: boolean;
  forceResync: boolean;
  json: boolean;
  silent: boolean;
  cwd: string;
  /** Injectable clock for deterministic tests. */
  clock?: () => Date;
};

export type MigrateCodexSkillsOptions = {
  cwd: string;
  dryRun: boolean;
  json: boolean;
  silent: boolean;
};

type CodexSkillMigrationItem = {
  name: string;
  src: string;
  dest: string;
  status: 'copied' | 'identical' | 'conflict' | 'skipped';
  reason?: string;
};

export type CodexSkillsMigrationReport = {
  workspace: string;
  sourceDir: string;
  destDir: string;
  items: ReadonlyArray<CodexSkillMigrationItem>;
  counts: {
    copied: number;
    identical: number;
    conflicts: number;
    skipped: number;
  };
};

function atomicWrite(absPath: string, content: string, mode = 0o644): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${absPath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode });
    renameSync(tmp, absPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort
    }
    throw err;
  }
}

function timestampSlug(clock: MigrateFromAgentTeamOptions['clock']): string {
  const d = clock ? clock() : new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function listSkillNames(sourceDir: string): string[] {
  if (!dirExists(sourceDir)) return [];
  return readdirSync(sourceDir, { withFileTypes: true })
    .map((d) => d.name)
    .filter((name) => dirExists(join(sourceDir, name)))
    .filter((name) => fileExists(join(sourceDir, name, 'SKILL.md')))
    .sort();
}

function listRelativeFiles(root: string): string[] {
  const out: string[] = [];
  function recurse(dir: string, rel: string): void {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name);
      const nextRel = rel ? join(rel, dirent.name) : dirent.name;
      const st = statSync(full);
      if (st.isDirectory()) recurse(full, nextRel);
      else if (st.isFile()) out.push(nextRel);
    }
  }
  recurse(root, '');
  return out.sort();
}

function treesHaveSameFileBytes(left: string, right: string): boolean {
  try {
    const leftFiles = listRelativeFiles(left);
    const rightFiles = listRelativeFiles(right);
    if (leftFiles.length !== rightFiles.length) return false;
    for (let i = 0; i < leftFiles.length; i++) {
      const rel = leftFiles[i]!;
      if (rel !== rightFiles[i]) return false;
      const leftBytes = readFileSync(join(left, rel));
      const rightBytes = readFileSync(join(right, rel));
      if (Buffer.compare(leftBytes, rightBytes) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function buildCounts(items: ReadonlyArray<CodexSkillMigrationItem>): CodexSkillsMigrationReport['counts'] {
  return {
    copied: items.filter((i) => i.status === 'copied').length,
    identical: items.filter((i) => i.status === 'identical').length,
    conflicts: items.filter((i) => i.status === 'conflict').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
  };
}

function renderCodexSkillsText(report: CodexSkillsMigrationReport, dryRun: boolean): string {
  const lines: string[] = [
    '',
    `${chalk.cyan.bold('roster migrate codex-skills')}${dryRun ? ` ${chalk.dim('(dry-run)')}` : ''}`,
    `  Source: ${report.sourceDir}`,
    `  Destination: ${report.destDir}`,
    '',
    `  copied: ${report.counts.copied}  identical: ${report.counts.identical}  conflicts: ${report.counts.conflicts}  skipped: ${report.counts.skipped}`,
  ];

  const interesting = report.items.filter((i) => i.status === 'conflict' || i.status === 'skipped');
  for (const item of interesting) {
    const mark = item.status === 'conflict' ? chalk.yellow('!') : chalk.dim('-');
    lines.push(`  ${mark} ${item.name}: ${item.status}${item.reason ? ` (${item.reason})` : ''}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function executeMigrateCodexSkills(opts: MigrateCodexSkillsOptions): number {
  const workspace = resolve(opts.cwd);
  const sourceDir = join(workspace, '.codex', 'skills');
  const destDir = join(workspace, '.agents', 'skills');
  const items: CodexSkillMigrationItem[] = [];

  for (const name of listSkillNames(sourceDir)) {
    const src = join(sourceDir, name);
    const dest = join(destDir, name);
    if (!existsSync(dest)) {
      items.push({ name, src, dest, status: 'copied' });
      if (!opts.dryRun) {
        mkdirSync(destDir, { recursive: true });
        cpSync(src, dest, { recursive: true, dereference: false, force: false, errorOnExist: true });
      }
      continue;
    }
    if (treesHaveSameFileBytes(src, dest)) {
      items.push({ name, src, dest, status: 'identical' });
      continue;
    }
    items.push({ name, src, dest, status: 'conflict', reason: '.agents/skills is canonical; legacy .codex/skills was left untouched' });
  }

  const report: CodexSkillsMigrationReport = {
    workspace,
    sourceDir,
    destDir,
    items,
    counts: buildCounts(items),
  };

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: opts.dryRun, ...report }, null, 2));
  } else if (!opts.silent) {
    console.log(renderCodexSkillsText(report, opts.dryRun));
  }

  return EXIT_OK;
}

export function executeMigrateFromAgentTeam(opts: MigrateFromAgentTeamOptions): number {
  const sourceDir = resolve(opts.sourceDir);
  const destWorkspace = resolve(opts.dest ?? opts.cwd);

  if (!existsSync(sourceDir)) throw migrateSourceNotFoundError(sourceDir);
  if (isLikelyRosterWorkspace(sourceDir)) throw migrateSourceAlreadyRosterError(sourceDir);

  const destIsInitialized = isLikelyRosterWorkspace(destWorkspace);
  if (!destIsInitialized && !opts.dryRun) {
    // For live runs, hard-fail before scanning. Dry-run still scans so the user can preview.
    throw migrateDestNotInitializedError(destWorkspace);
  }

  const model = scanSourceWorkspace({ sourceDir });
  const plan = planMigration(model, { destWorkspace, destIsInitialized });

  // Translate env-too-open blocker into a typed error (so it renders consistently)
  for (const b of plan.blockers) {
    if (b.kind === 'env-too-open' && !opts.dryRun) {
      throw envPermissionTooOpenError(b.envPath, b.mode);
    }
    if (b.kind === 'dest-not-initialized' && !opts.dryRun) {
      throw migrateDestNotInitializedError(b.destDir);
    }
  }

  const execReport = executeMigration(plan, { dryRun: opts.dryRun, forceResync: opts.forceResync, clock: opts.clock });

  // Persist a markdown report to disk (live runs only)
  let reportPathOnDisk: string | null = null;
  if (!opts.dryRun && !execReport.blockersHit) {
    const ts = timestampSlug(opts.clock);
    reportPathOnDisk = join(destWorkspace, '.roster', 'migration-reports', `agent-team-${ts}.md`);
    const md = renderMarkdownReport(plan, execReport, { dryRun: false });
    atomicWrite(reportPathOnDisk, md);
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: !execReport.blockersHit,
          dryRun: opts.dryRun,
          sourceDir,
          destWorkspace,
          plan: {
            scheduleInstalls: plan.scheduleInstalls,
            unmappedWrappers: plan.unmappedWrappers,
            pendingMoves: plan.pendingMoves,
            logCopies: plan.logCopies.map((lc) => ({ srcDir: lc.srcDir, destDir: lc.destDir, fileCount: lc.files.length })),
            envCopy: plan.envCopy,
            subscriptionWarnings: plan.subscriptionWarnings,
            agentMdNotes: plan.agentMdNotes,
            manualSteps: plan.manualSteps,
            blockers: plan.blockers,
          },
          execution: {
            fileResults: execReport.fileResults,
            installScriptPath: execReport.installScriptPath,
            manifestPath: execReport.manifestPath,
            reportPath: reportPathOnDisk,
            generatedAtUtc: execReport.generatedAtUtc,
          },
        },
        null,
        2,
      ),
    );
  } else if (!opts.silent) {
    console.log(renderTextReport(plan, execReport, { dryRun: opts.dryRun }));
  }

  if (execReport.blockersHit) {
    if (opts.json || opts.silent) {
      // Render blockers to stderr in machine modes so the user still sees them
      const err = new RosterError({
        header: `${chalk.red.bold('roster:')} migration blocked`,
        body: plan.blockers.map((b) => `  - ${b.kind}`).join('\n'),
        remedy: '  Re-run with --dry-run to see the full plan and resolution hints.',
        exitCode: EXIT_ERROR,
      });
      throw err;
    }
    return EXIT_ERROR;
  }

  return EXIT_OK;
}
