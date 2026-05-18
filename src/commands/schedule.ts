import chalk from 'chalk';
import { homedir } from 'node:os';
import { validateSchedulesInCwd, type ValidationReport } from '../lib/schedule-validate.ts';
import {
  installClaudeSchedule,
  type ClaudeInstallOpts,
  type ClaudeInstallResult,
} from '../lib/schedule-install.ts';
import {
  installCodexSchedule,
  type CodexInstallOpts,
  type CodexInstallResult,
} from '../lib/codex-install.ts';
import { buildListReport, renderListText, renderListJson, type ListReport } from '../lib/schedule-list.ts';
import { estimateUsage, renderEstimateText, renderEstimateJson } from '../lib/estimate-usage.ts';
import {
  executeRemove,
  renderRemovePreview,
  renderRemoveSuccess,
  type ScheduleRemoveResult,
  type ScheduleRemoveOpts,
} from '../lib/schedule-remove.ts';
import { executeRun, type ScheduleRunOpts, type ScheduleRunResult } from '../lib/schedule-run.ts';
import { resolveScheduleByName } from '../lib/schedule-resolve.ts';
import { readStateMd, findRecentRuns } from '../lib/schedule-state.ts';
import { nextFireTime } from '../lib/cron-next.ts';
import { getPlatform } from '../lib/platform.ts';
import { join } from 'node:path';
import {
  EXIT_OK,
  EXIT_ERROR,
  RosterError,
  linuxClaudeUnsupportedError,
  cloudRoutineNotImplementedError,
  unsupportedViaModeError,
  windowsCronNotSupportedError,
  linuxCodexHandoffUnsupportedError,
} from '../lib/errors.ts';
import type { ToolValue, InstallModeValue } from '../lib/schedule-schema.ts';
import type { ViaMode } from '../lib/schedule-args.ts';

export type ScheduleValidateOptions = {
  cwd: string;
  json: boolean;
  silent: boolean;
  dryRun: boolean;
};

const READONLY_DRYRUN_LINE = chalk.dim('--dry-run: read-only command; nothing would be written.');

export type ScheduleInstallOptions = {
  cwd: string;
  functionName: string;
  agent: string;
  plan: string;
  project: string;
  cron: string;
  tool: ToolValue;
  via: ViaMode | undefined;
  name: string | undefined;
  dryRun: boolean;
  cloudRoutine: boolean;
  json: boolean;
  silent: boolean;
};

function tildify(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

function countTotalErrors(report: ValidationReport): number {
  return report.files.reduce((acc, f) => acc + f.errors.length, 0);
}

function renderText(report: ValidationReport): string[] {
  const lines: string[] = [''];
  lines.push(chalk.bold('roster schedule validate'));
  lines.push(chalk.dim(`cwd: ${tildify(report.cwd)}`));

  if (report.files.length === 0) {
    lines.push('');
    lines.push(chalk.dim('No roster/<function>/schedules.yaml files found.'));
    return lines;
  }

  for (const file of report.files) {
    lines.push('');
    if (file.status === 'pass') {
      const entryWord = file.entryCount === 1 ? 'entry' : 'entries';
      lines.push(`${chalk.green('✓')} ${file.relativePath}  ${chalk.dim('PASS')} ${chalk.dim(`(${file.entryCount} ${entryWord})`)}`);
    } else {
      lines.push(`${chalk.red('✗')} ${file.relativePath}  ${chalk.red('FAIL')}`);
      for (const e of file.errors) {
        lines.push(`    ${chalk.red('-')} ${chalk.dim(e.path + ':')} ${e.message}`);
      }
    }
  }

  lines.push('');
  if (report.ok) {
    const totalEntries = report.files.reduce((acc, f) => acc + f.entryCount, 0);
    const fileWord = report.files.length === 1 ? 'file' : 'files';
    const entryWord = totalEntries === 1 ? 'entry' : 'entries';
    lines.push(chalk.green(`All schedules valid (${totalEntries} ${entryWord} across ${report.files.length} ${fileWord}).`));
  } else {
    const errs = countTotalErrors(report);
    const fileWord = report.files.length === 1 ? 'file' : 'files';
    lines.push(chalk.yellow(`Summary: ${errs} error${errs === 1 ? '' : 's'} across ${report.files.length} ${fileWord}.`));
    lines.push(`${chalk.dim('Run ')}${chalk.bold('roster schedule validate --json')}${chalk.dim(' for machine-readable output.')}`);
  }
  return lines;
}

export function executeScheduleValidate(opts: ScheduleValidateOptions): number {
  const report = validateSchedulesInCwd(opts.cwd);

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (!opts.silent) {
    for (const line of renderText(report)) console.log(line);
    if (opts.dryRun) console.log(READONLY_DRYRUN_LINE);
  }

  return report.ok ? EXIT_OK : EXIT_ERROR;
}

function preflightInstall(opts: ScheduleInstallOptions): void {
  if (opts.cloudRoutine) {
    throw cloudRoutineNotImplementedError();
  }

  if (opts.tool === 'claude' && getPlatform() === 'linux') {
    throw linuxClaudeUnsupportedError();
  }

  // --via cron is codex-only; claude has no programmatic install path today.
  if (opts.via === 'cron' && opts.tool !== 'codex') {
    throw unsupportedViaModeError({ tool: opts.tool, via: opts.via });
  }

  if (opts.tool === 'codex') {
    // Cron is unavailable on Windows.
    if (opts.via === 'cron' && getPlatform() === 'win32') {
      throw windowsCronNotSupportedError();
    }
    // Codex desktop app isn't available on Linux — default hand-off has no target.
    if (opts.via === undefined && getPlatform() === 'linux') {
      throw linuxCodexHandoffUnsupportedError();
    }
  }
}

function renderClaudeInstallText(result: ClaudeInstallResult, dryRun: boolean): string[] {
  const lines: string[] = [];
  lines.push(result.handoffMessage);
  if (dryRun) {
    lines.push(chalk.bold('--- Fields document (would be written) ---'));
    lines.push(result.fieldsDocContent);
    lines.push(chalk.bold('--- End fields document ---'));
    lines.push('');
  }
  return lines;
}

function renderCodexInstallText(result: CodexInstallResult, dryRun: boolean): string[] {
  const lines: string[] = [];
  lines.push(result.handoffMessage);
  if (dryRun) {
    if (result.installMode === 'ui-handoff') {
      lines.push(chalk.bold('--- Fields document (would be written) ---'));
      lines.push(result.fieldsDocContent ?? '');
      lines.push(chalk.bold('--- End fields document ---'));
    } else {
      lines.push(chalk.bold('--- Crontab line (would be installed) ---'));
      lines.push(result.cronLine ?? '');
      lines.push(chalk.bold('--- End crontab line ---'));
    }
    lines.push('');
  }
  return lines;
}

export function executeScheduleInstall(opts: ScheduleInstallOptions): number {
  preflightInstall(opts);

  if (opts.tool === 'claude') {
    const installOpts: ClaudeInstallOpts = {
      cwd: opts.cwd,
      functionName: opts.functionName,
      agent: opts.agent,
      plan: opts.plan,
      project: opts.project,
      cron: opts.cron,
      name: opts.name,
      dryRun: opts.dryRun,
    };

    const result = installClaudeSchedule(installOpts);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            dryRun: opts.dryRun,
            name: result.resolvedName,
            tool: opts.tool,
            action: result.action,
            fieldsDocPath: result.fieldsDocPath,
            schedulesYamlPath: result.schedulesYamlPath,
            fieldsDocContent: opts.dryRun ? result.fieldsDocContent : undefined,
          },
          null,
          2,
        ),
      );
    } else if (!opts.silent) {
      for (const line of renderClaudeInstallText(result, opts.dryRun)) console.log(line);
    }
    return EXIT_OK;
  }

  // Codex path
  const installMode: InstallModeValue = opts.via === 'cron' ? 'via-cron' : 'ui-handoff';
  const codexOpts: CodexInstallOpts = {
    cwd: opts.cwd,
    functionName: opts.functionName,
    agent: opts.agent,
    plan: opts.plan,
    project: opts.project,
    cron: opts.cron,
    name: opts.name,
    installMode,
    dryRun: opts.dryRun,
  };

  const result = installCodexSchedule(codexOpts);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dryRun: opts.dryRun,
          name: result.resolvedName,
          tool: opts.tool,
          installMode: result.installMode,
          action: result.action,
          fieldsDocPath: result.fieldsDocPath,
          cronLine: result.cronLine,
          logPath: result.logPath,
          schedulesYamlPath: result.schedulesYamlPath,
          fieldsDocContent: opts.dryRun ? result.fieldsDocContent : undefined,
          attestation: result.attestation,
        },
        null,
        2,
      ),
    );
  } else if (!opts.silent) {
    for (const line of renderCodexInstallText(result, opts.dryRun)) console.log(line);
  }
  return EXIT_OK;
}

// ── list ─────────────────────────────────────────────────────────────────

export type ScheduleListOptions = {
  cwd: string;
  json: boolean;
  silent: boolean;
  dryRun: boolean;
};

export function executeScheduleList(opts: ScheduleListOptions): number {
  const report: ListReport = buildListReport(opts.cwd);
  if (opts.json) {
    console.log(renderListJson(report));
  } else if (!opts.silent) {
    for (const line of renderListText(report)) console.log(line);
    if (opts.dryRun) console.log(READONLY_DRYRUN_LINE);
  }
  // Warnings emitted to stderr so JSON consumers can still pipe stdout cleanly.
  for (const w of report.warnings) {
    if (!opts.silent) process.stderr.write(`${chalk.yellow('!')} ${w}\n`);
  }
  return EXIT_OK;
}

// ── status ────────────────────────────────────────────────────────────────

export type ScheduleStatusOptions = {
  cwd: string;
  name: string;
  functionName: string | undefined;
  json: boolean;
  silent: boolean;
  dryRun: boolean;
};

const HISTORY_LIMIT = 5;

function fmtTs(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function relativeAgo(now: Date, then: Date): string {
  const ms = now.getTime() - then.getTime();
  if (ms < 0) {
    const abs = -ms;
    const min = Math.round(abs / 60000);
    if (min < 1) return 'in <1 min';
    if (min < 60) return `in ${min} min`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `in ${hr} hr`;
    return `in ${Math.round(hr / 24)} d`;
  }
  const min = Math.round(ms / 60000);
  if (min < 1) return '<1 min ago';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  return `${Math.round(hr / 24)} d ago`;
}

export function executeScheduleStatus(opts: ScheduleStatusOptions): number {
  const resolved = resolveScheduleByName({
    cwd: opts.cwd,
    name: opts.name,
    functionName: opts.functionName,
  });

  const stateMdPath = join(resolved.workspacePath, 'roster', resolved.functionName, 'state.md');
  const state = readStateMd(stateMdPath);
  const history = findRecentRuns(state.lines, resolved.functionName, resolved.entry.agent, resolved.entry.plan, HISTORY_LIMIT);
  const lastRun = history[0];
  const now = new Date();
  const next = nextFireTime(resolved.entry.cron, now);
  const nextDueAt = next.ok ? next.next : undefined;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          functionName: resolved.functionName,
          name: resolved.entry.name,
          agent: resolved.entry.agent,
          plan: resolved.entry.plan,
          tool: resolved.entry.tool,
          install_mode: resolved.entry.install_mode,
          cron: resolved.entry.cron,
          status: resolved.entry.status,
          last_run: lastRun?.timestamp ?? null,
          last_status: lastRun?.status ?? null,
          next_due_at: nextDueAt ? fmtTs(nextDueAt) : null,
          history: history.map((h) => ({
            ts: h.timestamp,
            scope: h.scope,
            status: h.status,
          })),
          malformed_state_lines: state.malformedCount,
        },
        null,
        2,
      ),
    );
    return EXIT_OK;
  }

  if (opts.silent) return EXIT_OK;

  const lines: string[] = [''];
  lines.push(chalk.bold(`roster schedule status ${resolved.entry.name}`));
  lines.push('');
  lines.push(`${chalk.bold('Schedule:')}     ${resolved.entry.name}`);
  lines.push(`${chalk.bold('Function:')}     ${resolved.functionName}`);
  lines.push(`${chalk.bold('Agent/plan:')}   ${resolved.entry.agent}/${resolved.entry.plan}`);
  lines.push(`${chalk.bold('Tool:')}         ${resolved.entry.tool} (${resolved.entry.install_mode})`);
  lines.push(`${chalk.bold('Cron:')}         ${resolved.entry.cron}`);
  if (lastRun) {
    const t = new Date(lastRun.timestamp);
    lines.push(`${chalk.bold('Last run:')}    ${lastRun.timestamp} ${chalk.dim(`(${relativeAgo(now, t)})`)}`);
    const statusColor = lastRun.status === 'success' ? chalk.green : lastRun.status === 'failed' ? chalk.red : chalk.yellow;
    lines.push(`${chalk.bold('Last status:')} ${statusColor(lastRun.status)}`);
  } else {
    lines.push(`${chalk.bold('Last run:')}    ${chalk.dim('(never fired)')}`);
    lines.push(`${chalk.bold('Last status:')} ${chalk.dim('-')}`);
  }
  if (nextDueAt) {
    lines.push(`${chalk.bold('Next due:')}    ${fmtTs(nextDueAt)} ${chalk.dim(`(${relativeAgo(now, nextDueAt)})`)}`);
    lines.push(chalk.dim('              ↑ UTC; cron honors daemon\'s local TZ (timezone display: ROS-42)'));
  } else {
    lines.push(`${chalk.bold('Next due:')}    ${chalk.dim(`(cannot compute: ${next.ok ? '' : next.reason})`)}`);
  }

  if (history.length > 1) {
    lines.push('');
    lines.push(chalk.bold(`History (last ${history.length}):`));
    for (const h of history) {
      const scopeProject = h.scope.split('/').slice(3).join('/');
      lines.push(`  ${h.timestamp}  ${h.status.padEnd(8)}  ${chalk.dim(scopeProject)}`);
    }
  }
  if (state.malformedCount > 0) {
    lines.push('');
    lines.push(chalk.yellow(`! ${state.malformedCount} malformed line${state.malformedCount === 1 ? '' : 's'} in state.md (skipped)`));
  }
  if (opts.dryRun) lines.push(READONLY_DRYRUN_LINE);
  lines.push('');

  for (const line of lines) console.log(line);
  return EXIT_OK;
}

// ── remove ────────────────────────────────────────────────────────────────

export type ScheduleRemoveOptions = {
  cwd: string;
  name: string;
  functionName: string | undefined;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  silent: boolean;
  // Test seam: bypasses prompt + CrontabIO. Plumbed through to executeRemove.
  remove?: (opts: ScheduleRemoveOpts) => Promise<ScheduleRemoveResult>;
};

export async function executeScheduleRemove(opts: ScheduleRemoveOptions): Promise<number> {
  const runner = opts.remove ?? executeRemove;

  if (opts.dryRun) {
    const result = await runner({
      cwd: opts.cwd,
      name: opts.name,
      functionName: opts.functionName,
      dryRun: true,
      yes: true,
    });
    if (opts.json) {
      console.log(
        JSON.stringify({ ok: true, dryRun: true, ...resultToJson(result) }, null, 2),
      );
    } else if (!opts.silent) {
      for (const line of renderRemovePreview(result)) console.log(line);
      console.log(chalk.dim('--dry-run: nothing removed.'));
      console.log('');
    }
    return EXIT_OK;
  }

  // When NOT --yes and NOT --silent, show the preview banner first so the
  // confirm prompt has context. The runner's default confirm fires next.
  if (!opts.yes && !opts.silent) {
    const preview = await runner({
      cwd: opts.cwd,
      name: opts.name,
      functionName: opts.functionName,
      dryRun: true,
      yes: true,
    });
    for (const line of renderRemovePreview(preview)) console.log(line);
  }

  const result = await runner({
    cwd: opts.cwd,
    name: opts.name,
    functionName: opts.functionName,
    dryRun: false,
    yes: opts.yes,
  });

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: false, ...resultToJson(result) }, null, 2));
  } else if (!opts.silent) {
    for (const line of renderRemoveSuccess(result)) console.log(line);
  }
  return EXIT_OK;
}

function resultToJson(r: ScheduleRemoveResult): Record<string, unknown> {
  return {
    functionName: r.functionName,
    name: r.name,
    tool: r.tool,
    installMode: r.installMode,
    cronStripped: r.cronStripped,
    cronMarkerMissing: r.cronMarkerMissing,
    schedulesYamlPath: r.schedulesYamlPath,
    fieldsDocPathHint: r.fieldsDocPathHint,
    logPathHint: r.logPathHint,
  };
}

// ── run ───────────────────────────────────────────────────────────────────

export type ScheduleRunOptions = {
  cwd: string;
  name: string;
  functionName: string | undefined;
  silent: boolean;
  dryRun: boolean;
  // Test seam: same factory used by executeRun.
  run?: (opts: ScheduleRunOpts) => Promise<ScheduleRunResult>;
};

export async function executeScheduleRun(opts: ScheduleRunOptions): Promise<number> {
  const runner = opts.run ?? executeRun;
  const result = await runner({
    cwd: opts.cwd,
    name: opts.name,
    functionName: opts.functionName,
    silent: opts.silent,
    dryRun: opts.dryRun,
  });
  return result.exitCode;
}

// ── estimate-usage ───────────────────────────────────────────────────────

export type ScheduleEstimateUsageOptions = {
  cwd: string;
  json: boolean;
  silent: boolean;
  dryRun: boolean;
  plan: string | undefined;
  warnThreshold: number;
};

export async function executeScheduleEstimateUsage(
  opts: ScheduleEstimateUsageOptions,
): Promise<number> {
  let report;
  try {
    report = estimateUsage({
      cwd: opts.cwd,
      warnThreshold: opts.warnThreshold,
      planFilter: opts.plan,
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('--plan')) {
      throw new RosterError({
        header: `${chalk.red.bold('roster:')} ${err.message}`,
        body: '',
        remedy: `  Run ${chalk.bold('roster schedule estimate-usage --help')} for available plan ids.`,
        exitCode: EXIT_ERROR,
      });
    }
    throw err;
  }

  if (opts.json) {
    console.log(renderEstimateJson(report));
  } else if (!opts.silent) {
    for (const line of await renderEstimateText(report)) console.log(line);
    if (opts.dryRun) console.log(READONLY_DRYRUN_LINE);
  }

  return EXIT_OK;
}
