import chalk from 'chalk';
import { EXIT_OK } from '../lib/errors.ts';
import { syncFounderSkills, type SyncResult } from '../lib/founder-skills/sync.ts';
import { realInstaller } from '../lib/founder-skills/installer.ts';
import { updateFounderSkills, realRefResolver } from '../lib/founder-skills/update.ts';

export type SkillsCommandOptions = {
  cwd: string;
  json: boolean;
  silent: boolean;
};

export function renderSyncResult(result: SyncResult): string[] {
  const lines: string[] = [''];
  lines.push(chalk.bold('roster skills sync'));
  if (result.status === 'no-manifest') {
    lines.push(`  ${chalk.dim('·')} no founder-skills.yaml — nothing to sync`);
    lines.push('');
    return lines;
  }
  if (result.tools.length === 0) {
    lines.push(`  ${chalk.yellow('!')} no supported tool detected (claude, codex) — wrote lockfile only`);
  } else {
    lines.push(`  ${chalk.dim('tools:')} ${result.tools.join(', ')}`);
  }
  for (const name of result.installed) {
    lines.push(`  ${chalk.green('+')} installed ${chalk.bold(name)}`);
  }
  for (const name of result.pruned) {
    lines.push(`  ${chalk.red('-')} pruned    ${chalk.bold(name)}`);
  }
  if (result.installed.length === 0 && result.pruned.length === 0) {
    lines.push(`  ${chalk.dim('·')} up to date`);
  }
  lines.push('');
  return lines;
}

export async function executeSkillsSync(opts: SkillsCommandOptions): Promise<number> {
  const result = await syncFounderSkills({ cwd: opts.cwd, installer: realInstaller });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else if (!opts.silent) {
    console.log(renderSyncResult(result).join('\n'));
  }
  return EXIT_OK;
}

export async function executeSkillsUpdate(
  opts: SkillsCommandOptions & { latest: boolean },
): Promise<number> {
  const result = await updateFounderSkills({
    cwd: opts.cwd,
    installer: realInstaller,
    resolver: realRefResolver,
    latest: opts.latest,
  });
  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...result }, null, 2));
  } else if (!opts.silent) {
    console.log(renderSyncResult(result).join('\n'));
  }
  return EXIT_OK;
}
