import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import chalk from 'chalk';
import { scanPending, type PendingItem } from '../lib/pending.ts';
import {
  EXIT_OK,
  EXIT_CANCELLED,
  invalidFunctionError,
  notTtyForReviewError,
} from '../lib/errors.ts';

export type ReviewOptions = {
  cwd: string;
  fn?: string;
  json: boolean;
  silent: boolean;
};

type Decision = 'approve' | 'reject' | 'defer';

type ReviewSummary = {
  approved: number;
  rejected: number;
  deferred: number;
};

function pendingItemPreview(item: PendingItem, maxLines: number): string {
  const trimmed = item.body.trim();
  if (trimmed === '') return chalk.dim('(empty body)');
  const lines = trimmed.split('\n').slice(0, maxLines);
  return lines.join('\n');
}

function workspaceRelative(absPath: string, cwd: string): string {
  const rel = relative(cwd, absPath);
  return rel === '' ? '.' : rel;
}

function targetWithinWorkspace(target: string, cwd: string): string | null {
  const absTarget = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  const rel = relative(resolve(cwd), absTarget);
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    return null;
  }
  return absTarget;
}

function functionDirExists(cwd: string, fn: string): boolean {
  try {
    return statSync(join(cwd, 'roster', fn)).isDirectory();
  } catch {
    return false;
  }
}

function renderItem(item: PendingItem, index: number, total: number, cwd: string): void {
  const rel = workspaceRelative(item.path, cwd);
  console.log();
  console.log(
    `${chalk.bold(`[${index + 1}/${total}]`)} ${chalk.cyan(item.function)} / ${chalk.bold(item.filename)}`,
  );
  console.log(chalk.dim(`  path: ${rel}`));
  const target = item.frontMatter['target_on_approve'];
  if (typeof target === 'string' && target.length > 0) {
    console.log(chalk.dim(`  on approve → ${target}`));
  } else {
    console.log(chalk.dim('  on approve → (no target_on_approve in front-matter — will defer)'));
  }
  const preview = pendingItemPreview(item, 6);
  for (const line of preview.split('\n')) console.log('  ' + line);
}

function summarize(s: ReviewSummary): string {
  const parts = [
    `${chalk.green(s.approved)} approved`,
    `${chalk.red(s.rejected)} rejected`,
    `${chalk.dim(s.deferred)} deferred`,
  ];
  return parts.join(', ');
}

function approveItem(item: PendingItem, cwd: string): { ok: boolean; reason?: string; target?: string } {
  const target = item.frontMatter['target_on_approve'];
  if (typeof target !== 'string' || target.length === 0) {
    return { ok: false, reason: 'missing target_on_approve in front-matter' };
  }
  const absTarget = targetWithinWorkspace(target, cwd);
  if (absTarget === null) {
    return { ok: false, reason: `target_on_approve escapes workspace (got '${target}')` };
  }
  if (existsSync(absTarget)) {
    return { ok: false, reason: `target already exists: ${target}` };
  }
  mkdirSync(dirname(absTarget), { recursive: true });
  renameSync(item.path, absTarget);
  return { ok: true, target: workspaceRelative(absTarget, cwd) };
}

function rejectItem(item: PendingItem): void {
  unlinkSync(item.path);
}

export async function executeReview(opts: ReviewOptions): Promise<number> {
  if (opts.fn !== undefined && !functionDirExists(opts.cwd, opts.fn)) {
    throw invalidFunctionError(opts.fn);
  }

  const items = scanPending(opts.cwd, opts.fn);

  if (opts.json) {
    const payload = items.map((item) => ({
      function: item.function,
      path: workspaceRelative(item.path, opts.cwd),
      filename: item.filename,
      frontMatter: item.frontMatter,
    }));
    console.log(JSON.stringify(payload, null, 2));
    return EXIT_OK;
  }

  if (items.length === 0) {
    if (!opts.silent) {
      const scope = opts.fn !== undefined ? `for ${chalk.cyan(opts.fn)}` : 'across all functions';
      console.log(`${chalk.green('✓')} No pending HITL items ${scope}.`);
    }
    return EXIT_OK;
  }

  if (!process.stdout.isTTY) {
    throw notTtyForReviewError();
  }

  const { select } = await import('@inquirer/prompts');
  const summary: ReviewSummary = { approved: 0, rejected: 0, deferred: 0 };

  if (!opts.silent) {
    const word = items.length === 1 ? 'item' : 'items';
    console.log(`\n${chalk.bold(`${items.length} pending HITL ${word}`)} — review each below.`);
  }

  try {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      renderItem(item, i, items.length, opts.cwd);
      const decision = (await select<Decision>({
        message: 'Action?',
        choices: [
          { name: 'Approve — move to target_on_approve', value: 'approve' },
          { name: 'Reject  — delete the pending item', value: 'reject' },
          { name: 'Defer   — leave in place, decide later', value: 'defer' },
        ],
      })) as Decision;

      if (decision === 'approve') {
        const result = approveItem(item, opts.cwd);
        if (result.ok) {
          console.log(chalk.green(`  ✓ approved → ${result.target}`));
          summary.approved++;
        } else {
          console.log(chalk.yellow(`  ⚠ skipped (${result.reason}) — counted as deferred`));
          summary.deferred++;
        }
      } else if (decision === 'reject') {
        rejectItem(item);
        console.log(chalk.red('  ✗ rejected (file deleted)'));
        summary.rejected++;
      } else {
        console.log(chalk.dim('  · deferred'));
        summary.deferred++;
      }
    }
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'name' in err && err.name === 'ExitPromptError') {
      console.log(`\n${chalk.dim('Cancelled.')} Partial summary: ${summarize(summary)}.`);
      return EXIT_CANCELLED;
    }
    throw err;
  }

  console.log(`\n${chalk.bold('Done.')} ${summarize(summary)}.`);
  return EXIT_OK;
}
