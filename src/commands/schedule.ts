import chalk from 'chalk';
import { homedir } from 'node:os';
import { validateSchedulesInCwd, type ValidationReport } from '../lib/schedule-validate.ts';
import { EXIT_OK, EXIT_ERROR } from '../lib/errors.ts';

export type ScheduleValidateOptions = {
  cwd: string;
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
