import chalk from 'chalk';
import { EXIT_OK } from '../lib/errors.ts';
import { executeUpgrade, type UpgradeResult } from '../lib/upgrade.ts';

export type UpgradeCommandOptions = {
  cwd: string;
  dryRun: boolean;
  json: boolean;
};

export function renderUpgradeResult(result: UpgradeResult): string[] {
  const lines: string[] = ['', chalk.bold('roster upgrade')];
  if (!result.hadManifest) {
    lines.push(
      `  ${chalk.yellow('!')} no scaffold manifest — treating every changed file as user-edited (safe). A baseline was written for next time.`,
    );
  }
  const touched =
    result.created.length + result.updated.length + result.conflicts.length;
  if (touched === 0 && result.symlinkSkipped.length === 0) {
    lines.push(`  ${chalk.dim('·')} workspace already matches the installed templates`);
    lines.push('');
    return lines;
  }
  const verb = result.dryRun ? 'would ' : '';
  for (const p of result.created) lines.push(`  ${chalk.green('+')} ${verb}create   ${p}`);
  for (const p of result.updated) lines.push(`  ${chalk.green('~')} ${verb}update   ${chalk.dim('(unchanged by you) ')}${p}`);
  for (const p of result.conflicts) lines.push(`  ${chalk.yellow('!')} ${verb}write    ${p}${chalk.dim('.new')} ${chalk.dim('(you edited this — review & merge)')}`);
  for (const p of result.symlinkSkipped) lines.push(`  ${chalk.red('✗')} skipped  ${p} ${chalk.dim('(symlink — not touched)')}`);
  for (const p of result.droppedKept) lines.push(`  ${chalk.dim('·')} kept     ${p} ${chalk.dim('(no longer shipped; left in place)')}`);

  lines.push('');
  if (result.conflicts.length > 0) {
    lines.push(
      chalk.dim(`Review the ${result.conflicts.length} .new file${result.conflicts.length === 1 ? '' : 's'} and merge what you want into your copy, then delete the .new.`),
    );
  }
  if (result.founderExampleChanged) {
    lines.push(chalk.dim('founder-skills.yaml.example changed — if you use it, re-run `roster skills sync`.'));
  }
  if (result.dryRun) lines.push(chalk.dim('--dry-run: nothing written.'));
  return lines;
}

export function executeUpgradeCommand(opts: UpgradeCommandOptions): number {
  const result = executeUpgrade({ cwd: opts.cwd, dryRun: opts.dryRun });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else {
    console.log(renderUpgradeResult(result).join('\n'));
  }
  return EXIT_OK;
}
