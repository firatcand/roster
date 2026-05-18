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
import { getPlatform } from '../lib/platform.ts';
import {
  EXIT_OK,
  EXIT_ERROR,
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
};

export type ScheduleInstallOptions = {
  cwd: string;
  functionName: string;
  agent: string;
  plan: string;
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
