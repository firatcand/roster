import chalk from 'chalk';
import { homedir } from 'node:os';
import { validateSchedulesInCwd, type ValidationReport } from '../lib/schedule-validate.ts';
import {
  installClaudeSchedule,
  type ClaudeInstallOpts,
  type ClaudeInstallResult,
} from '../lib/schedule-install.ts';
import { getPlatform } from '../lib/platform.ts';
import {
  EXIT_OK,
  EXIT_ERROR,
  RosterError,
  linuxClaudeUnsupportedError,
  cloudRoutineNotImplementedError,
} from '../lib/errors.ts';
import type { ToolValue } from '../lib/schedule-schema.ts';

export type ScheduleValidateOptions = {
  cwd: string;
  json: boolean;
  silent: boolean;
};

export type ScheduleInstallOptions = {
  cwd: string;
  functionName: string;
  agent: string;
  plan: string;
  cron: string;
  tool: ToolValue;
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
  }

  return report.ok ? EXIT_OK : EXIT_ERROR;
}

function preflightInstall(opts: ScheduleInstallOptions): void {
  // --cloud-routine is reserved for a follow-up ADR (tracked under future
  // ROS-XX). Refuse regardless of platform so the Linux gate has a documented
  // escape hatch and users get a clear "not yet" rather than a partial result.
  if (opts.cloudRoutine) {
    throw cloudRoutineNotImplementedError();
  }

  if (opts.tool === 'claude' && getPlatform() === 'linux') {
    throw linuxClaudeUnsupportedError();
  }

  if (opts.tool === 'codex') {
    // Codex install ships in ROS-35; refuse here so users get the right
    // pointer instead of a half-implemented Claude path running on Codex inputs.
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} --tool codex is not implemented in this release`,
      body: '  Codex install (Automation hand-off and --via cron) lands in ROS-35.',
      remedy: `  Use ${chalk.bold('--tool claude')} for now, or track ROS-35 for Codex support.`,
      exitCode: EXIT_ERROR,
    });
  }
}

function renderInstallText(result: ClaudeInstallResult, dryRun: boolean): string[] {
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

export function executeScheduleInstall(opts: ScheduleInstallOptions): number {
  preflightInstall(opts);

  const installOpts: ClaudeInstallOpts = {
    cwd: opts.cwd,
    functionName: opts.functionName,
    agent: opts.agent,
    plan: opts.plan,
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
    for (const line of renderInstallText(result, opts.dryRun)) console.log(line);
  }

  return EXIT_OK;
}
