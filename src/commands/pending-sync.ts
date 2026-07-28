import chalk from 'chalk';
import { correlateFailedFires, syncPending, type PendingSyncResult } from '../lib/pending-sync.ts';
import { resolveOpsBackend } from '../lib/persistence/resolve.ts';
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
    const tag =
      w.reason === 'failed-exit'
        ? chalk.red('FAIL')
        : w.reason === 'malformed-exit'
          ? chalk.red('MALFORMED')
          : chalk.yellow('STALE');
    lines.push(`  ${chalk.green('+')} ${tag} ${chalk.bold(w.scheduleName.padEnd(22))} ${chalk.dim(verb)} ${chalk.dim(w.path)}`);
  }
  for (const s of result.skipped) {
    const why =
      s.reason === 'acknowledged'
        ? '(acknowledged — durable skip)'
        : s.reason === 'refused'
          ? '(refused — destination is a symlink or resolves outside the workspace)'
          : '(already exists)';
    lines.push(`  ${chalk.dim('·')} ${chalk.dim('skip  ')} ${chalk.dim(s.path)} ${chalk.dim(why)}`);
  }
  lines.push('');
  if (dryRun) lines.push(chalk.dim('--dry-run: nothing written'));
  return lines;
}

// Correlate failed/stale fires into the run ledger (finding: correlateFailedFires
// existed but the command never called it — a crashed scheduled run stayed
// 'running' forever). Best-effort + opt-in: only when an ops backend with a run
// store is configured. Legacy workspaces (no persistence.yaml) skip silently, and
// any resolution/store failure never fails the markdown sync (the primary job).
async function correlatePendingFires(cwd: string): Promise<void> {
  try {
    const resolved = await resolveOpsBackend(cwd);
    if (resolved.state === 'local' || resolved.state === 'postgres-s3' || resolved.state === 'degraded') {
      try {
        await correlateFailedFires({ cwd, runs: resolved.backend.runs });
      } finally {
        if (resolved.state === 'postgres-s3') await resolved.close();
      }
    }
  } catch {
    // Best-effort: correlation must never break the markdown alert path.
  }
}

export async function executePendingSync(opts: PendingSyncCommandOptions): Promise<number> {
  const result = syncPending({
    cwd: opts.cwd,
    dryRun: opts.dryRun,
  });

  // The markdown alert is authoritative; correlation is a side channel into the
  // ledger. Skip it on --dry-run (correlation mutates the run ledger).
  if (!opts.dryRun) await correlatePendingFires(opts.cwd);

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, dryRun: opts.dryRun, ...result }, null, 2));
  } else if (!opts.silent) {
    for (const line of renderText(result, opts.dryRun)) console.log(line);
  }
  return EXIT_OK;
}
