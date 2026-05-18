import chalk from 'chalk';
import { syncPending, type PendingSyncResult } from '../lib/pending-sync.ts';
import { EXIT_OK } from '../lib/errors.ts';

export type PendingSyncCommandOptions = {
  cwd: string;
  silent: boolean;
  json: boolean;
  dryRun: boolean;
};

function renderText(result: PendingSyncResult, dryRun: boolean): string[] {
  const lines: string[] = [''];
  lines.push(chalk.bold('roster pending sync'));
  if (result.written.length === 0 && result.skipped.length === 0) {
    lines.push(`  ${chalk.dim('·')} no signals — inspected ${result.inspected} schedule${result.inspected === 1 ? '' : 's'}`);
    lines.push('');
    return lines;
  }
  for (const w of result.written) {
    const verb = dryRun ? 'WOULD WRITE' : 'WROTE';
    const tag = w.reason === 'failed-exit' ? chalk.red('FAIL') : chalk.yellow('STALE');
    lines.push(`  ${chalk.green('+')} ${tag} ${chalk.bold(w.scheduleName.padEnd(22))} ${chalk.dim(verb)} ${chalk.dim(w.path)}`);
  }
  for (const s of result.skipped) {
    lines.push(`  ${chalk.dim('·')} ${chalk.dim('skip  ')} ${chalk.dim(s.path)} ${chalk.dim('(already exists)')}`);
  }
  lines.push('');
  if (dryRun) lines.push(chalk.dim('--dry-run: nothing written'));
  return lines;
}

export function executePendingSync(opts: PendingSyncCommandOptions): number {
  const result = syncPending({
    cwd: opts.cwd,
    dryRun: opts.dryRun,
  });

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: opts.dryRun, ...result }, null, 2));
  } else if (!opts.silent) {
    for (const line of renderText(result, opts.dryRun)) console.log(line);
  }
  return EXIT_OK;
}
