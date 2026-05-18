import { join } from 'node:path';
import chalk from 'chalk';
import { atomicWriteFile, readExistingSchedulesDoc, removeEntryFromDoc } from './schedule-yaml.ts';
import {
  defaultCrontabIO,
  removeCronEntry,
  getMarkerStrings,
  type CrontabIO,
} from './codex-cron.ts';
import { resolveScheduleByName } from './schedule-resolve.ts';
import { userCancelledRemove } from './errors.ts';

export type ScheduleRemoveOpts = {
  cwd: string;
  name: string;
  functionName: string | undefined;
  dryRun: boolean;
  yes: boolean;
  crontabIO?: CrontabIO;
  // Confirmation callback. Returns true to proceed, false to cancel.
  // Default uses readline / process.stdin; tests inject a deterministic stub.
  confirm?: () => Promise<boolean>;
};

export type ScheduleRemoveResult = {
  functionName: string;
  name: string;
  tool: string;
  installMode: string;
  cronStripped: boolean;
  cronMarkerMissing: boolean;
  schedulesYamlPath: string;
  fieldsDocPathHint: string | null;
  logPathHint: string | null;
  dryRun: boolean;
};

async function defaultConfirm(): Promise<boolean> {
  const readline = await import('node:readline/promises');
  const { stdin, stdout } = await import('node:process');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question('Proceed? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function executeRemove(opts: ScheduleRemoveOpts): Promise<ScheduleRemoveResult> {
  const resolved = resolveScheduleByName({
    cwd: opts.cwd,
    name: opts.name,
    functionName: opts.functionName,
  });

  const installMode = resolved.entry.install_mode;
  const tool = resolved.entry.tool;
  const fieldsDocPathHint =
    tool === 'claude'
      ? join(resolved.workspacePath, '.roster', 'schedule-specs', `${resolved.entry.name}.claude.fields.md`)
      : installMode === 'ui-handoff'
        ? join(resolved.workspacePath, '.roster', 'schedule-specs', `${resolved.entry.name}.codex.fields.md`)
        : null;
  const logPathHint =
    installMode === 'via-cron'
      ? join(resolved.workspacePath, 'logs', 'cron', `${resolved.entry.name}.log`)
      : null;

  const willStripCron = installMode === 'via-cron';

  if (opts.dryRun) {
    return {
      functionName: resolved.functionName,
      name: resolved.entry.name,
      tool,
      installMode,
      cronStripped: false,
      cronMarkerMissing: false,
      schedulesYamlPath: resolved.schedulesYamlPath,
      fieldsDocPathHint,
      logPathHint,
      dryRun: true,
    };
  }

  if (!opts.yes) {
    const confirm = opts.confirm ?? defaultConfirm;
    const proceed = await confirm();
    if (!proceed) throw userCancelledRemove();
  }

  // Side-effects first (crontab strip), YAML write last — mirrors
  // installCodexSchedule ordering so a crontab failure leaves YAML untouched.
  let cronStripped = false;
  let cronMarkerMissing = false;
  if (willStripCron) {
    const io = opts.crontabIO ?? defaultCrontabIO();
    const r = removeCronEntry(io, resolved.entry.name);
    cronStripped = r.removed;
    cronMarkerMissing = !r.removed;
  }

  const { doc, existedBefore } = readExistingSchedulesDoc(resolved.schedulesYamlPath);
  if (existedBefore) {
    removeEntryFromDoc(doc, resolved.entry.name);
    atomicWriteFile(resolved.schedulesYamlPath, doc.toString());
  }

  return {
    functionName: resolved.functionName,
    name: resolved.entry.name,
    tool,
    installMode,
    cronStripped,
    cronMarkerMissing,
    schedulesYamlPath: resolved.schedulesYamlPath,
    fieldsDocPathHint,
    logPathHint,
    dryRun: false,
  };
}

export function renderRemovePreview(result: ScheduleRemoveResult): string[] {
  const lines: string[] = [];
  const markers = getMarkerStrings(result.name);
  lines.push('');
  lines.push(chalk.bold(`About to remove schedule ${chalk.yellow(`'${result.name}'`)} (${result.functionName}, ${result.tool} ${result.installMode}):`));
  lines.push('');
  if (result.installMode === 'via-cron') {
    lines.push(`  - Crontab marker block:  ${chalk.dim(markers.begin)} … ${chalk.dim(markers.end)}`);
  }
  lines.push(`  - YAML entry:            ${chalk.dim(result.schedulesYamlPath)}`);
  if (result.fieldsDocPathHint) {
    lines.push(`  - Fields doc:            ${chalk.dim(result.fieldsDocPathHint)}  ${chalk.dim('(kept for audit)')}`);
  }
  if (result.logPathHint) {
    lines.push(`  - Log file:              ${chalk.dim(result.logPathHint)}  ${chalk.dim('(kept for audit)')}`);
  }
  if (result.installMode === 'ui-handoff') {
    const app = result.tool === 'claude' ? 'Claude Desktop' : 'Codex desktop app';
    lines.push('');
    lines.push(chalk.dim(`After this command exits, open ${app} and delete the schedule manually.`));
  }
  lines.push('');
  return lines;
}

export function renderRemoveSuccess(result: ScheduleRemoveResult): string[] {
  const lines: string[] = [''];
  lines.push(`${chalk.green('✓')} Removed schedule ${chalk.bold(result.name)} from ${chalk.dim(result.schedulesYamlPath)}`);
  if (result.installMode === 'via-cron') {
    if (result.cronStripped) {
      lines.push(`  ${chalk.green('✓')} Crontab marker block deleted.`);
    } else if (result.cronMarkerMissing) {
      lines.push(`  ${chalk.yellow('!')} No matching crontab block found (YAML entry was orphaned).`);
    }
  } else {
    const app = result.tool === 'claude' ? 'Claude Desktop' : 'Codex desktop app';
    lines.push(`  ${chalk.dim('→')} Open ${chalk.bold(app)} → delete the schedule manually.`);
  }
  if (result.fieldsDocPathHint || result.logPathHint) {
    const kept: string[] = [];
    if (result.fieldsDocPathHint) kept.push(result.fieldsDocPathHint);
    if (result.logPathHint) kept.push(result.logPathHint);
    lines.push(chalk.dim(`  Kept for audit: ${kept.join(', ')}`));
  }
  lines.push('');
  return lines;
}
