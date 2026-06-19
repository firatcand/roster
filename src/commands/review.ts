import { statSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { scanPending, type PendingItem } from '../lib/pending.ts';
import {
  approveItem,
  rejectItem,
  workspaceRelative,
  computeItemId,
  resolveItemBySelector,
} from '../lib/pending-apply.ts';
import {
  EXIT_OK,
  EXIT_ERROR,
  EXIT_CANCELLED,
  invalidFunctionError,
  notTtyForReviewError,
  itemNotFoundError,
  ambiguousItemError,
} from '../lib/errors.ts';

export type ReviewOptions = {
  cwd: string;
  fn?: string;
  json: boolean;
  silent: boolean;
  approve?: string;
  reject?: string;
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

// Headless apply — the non-interactive path the /inbox skill drives (no TTY).
function applyOne(items: readonly PendingItem[], opts: ReviewOptions): number {
  const selector = (opts.approve ?? opts.reject)!;
  const res = resolveItemBySelector(items, selector, opts.cwd);
  if (!res.ok) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, reason: res.reason, selector, ...(res.reason === 'ambiguous' ? { paths: res.paths } : {}) }, null, 2));
      return EXIT_ERROR;
    }
    throw res.reason === 'ambiguous' ? ambiguousItemError(selector, res.paths) : itemNotFoundError(selector);
  }

  const item = res.item;
  const rel = workspaceRelative(item.path, opts.cwd);
  if (opts.approve !== undefined) {
    const result = approveItem(item, opts.cwd);
    if (!result.ok) {
      if (opts.json) console.log(JSON.stringify({ ok: false, action: 'approve', reason: result.reason, path: rel }, null, 2));
      else console.error(`${chalk.red('✗')} cannot approve ${rel}: ${result.reason}`);
      return EXIT_ERROR;
    }
    if (opts.json) console.log(JSON.stringify({ ok: true, action: 'approve', target: result.target, id: computeItemId(item), path: rel }, null, 2));
    else if (!opts.silent) console.log(`${chalk.green('✓')} approved → ${result.target}`);
    return EXIT_OK;
  }

  rejectItem(item);
  if (opts.json) console.log(JSON.stringify({ ok: true, action: 'reject', path: rel, id: computeItemId(item) }, null, 2));
  else if (!opts.silent) console.log(`${chalk.red('✗')} rejected (deleted) ${rel}`);
  return EXIT_OK;
}

export async function executeReview(opts: ReviewOptions): Promise<number> {
  if (opts.fn !== undefined && !functionDirExists(opts.cwd, opts.fn)) {
    throw invalidFunctionError(opts.fn);
  }

  const items = scanPending(opts.cwd, opts.fn);

  if (opts.approve !== undefined || opts.reject !== undefined) {
    return applyOne(items, opts);
  }

  if (opts.json) {
    const payload = items.map((item) => ({
      id: computeItemId(item),
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
      console.log(`${chalk.green('✓')} No unread decisions ${scope}.`);
    }
    return EXIT_OK;
  }

  if (!process.stdout.isTTY) {
    throw notTtyForReviewError();
  }

  const { select } = await import('@inquirer/prompts');
  const summary: ReviewSummary = { approved: 0, rejected: 0, deferred: 0 };

  if (!opts.silent) {
    const word = items.length === 1 ? 'decision' : 'decisions';
    console.log(`\n${chalk.bold(`${items.length} unread ${word}`)} — review each below.`);
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
