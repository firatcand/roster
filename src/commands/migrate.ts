import { existsSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
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
