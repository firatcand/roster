import { join, resolve } from 'node:path';
import chalk from 'chalk';
import { type ScheduleEntry } from './schedule-schema.ts';
import { findMostRecentRun, readStateMd, type StateLine } from './schedule-state.ts';
import { nextFireTime } from './cron-next.ts';
import { listFunctionDirs, readScheduleEntries } from './schedule-read.ts';

type ScheduleRow = {
  functionName: string;
  entry: ScheduleEntry;
  lastRun: StateLine | undefined;
  nextDueAt: Date | undefined;
};

export type ListReport = {
  cwd: string;
  rows: ScheduleRow[];
  warnings: string[];
};

export function buildListReport(cwd: string, now: Date = new Date()): ListReport {
  const workspacePath = resolve(cwd);
  const warnings: string[] = [];
  const rows: ScheduleRow[] = [];

  for (const functionName of listFunctionDirs(workspacePath)) {
    const entries = readScheduleEntries(workspacePath, functionName, warnings);
    if (entries.length === 0) continue;

    const stateMdPath = join(workspacePath, 'roster', functionName, 'state.md');
    const state = readStateMd(stateMdPath);
    if (state.malformedCount > 0) {
      warnings.push(
        `roster/${functionName}/state.md: ${state.malformedCount} malformed line${state.malformedCount === 1 ? '' : 's'} (skipped)`,
      );
    }

    for (const entry of entries) {
      const lastRun = findMostRecentRun(state.lines, functionName, entry.agent, entry.plan);
      const next = nextFireTime(entry.cron, now);
      rows.push({
        functionName,
        entry,
        lastRun,
        nextDueAt: next.ok ? next.next : undefined,
      });
    }
  }

  return { cwd: workspacePath, rows, warnings };
}

// ── Rendering ─────────────────────────────────────────────────────────────

function tildify(path: string): string {
  // Avoid the os.homedir() import dance here — only used by callers.
  return path;
}

export function fmtTs(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function lastRunCell(row: ScheduleRow): string {
  if (row.lastRun === undefined) return '(never fired)';
  return row.lastRun.timestamp;
}

function lastStatusCell(row: ScheduleRow): string {
  if (row.lastRun === undefined) return '-';
  return row.lastRun.status;
}

export function renderListText(report: ListReport): string[] {
  const lines: string[] = [''];
  lines.push(chalk.bold('roster schedule list'));
  lines.push(chalk.dim(`cwd: ${tildify(report.cwd)}`));

  if (report.rows.length === 0) {
    lines.push('');
    lines.push(chalk.dim('(no schedules registered)'));
    lines.push(chalk.dim(`Run ${chalk.bold('roster schedule install')} to register one.`));
    if (report.warnings.length > 0) {
      lines.push('');
      for (const w of report.warnings) lines.push(chalk.yellow(`! ${w}`));
    }
    return lines;
  }

  // Determine column widths.
  const headers = ['FUNCTION', 'NAME', 'TOOL', 'MODE', 'CRON', 'LAST RUN', 'STATUS'];
  const cells = report.rows.map((r) => [
    r.functionName,
    r.entry.name,
    r.entry.tool,
    r.entry.install_mode,
    r.entry.cron,
    lastRunCell(r),
    lastStatusCell(r),
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => row[i]!.length)),
  );

  function pad(row: string[]): string {
    return row.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
  }

  lines.push('');
  lines.push(chalk.bold(pad(headers)));
  for (const row of cells) lines.push(pad(row));

  lines.push('');
  const fns = new Set(report.rows.map((r) => r.functionName)).size;
  const fnWord = fns === 1 ? 'function' : 'functions';
  const schWord = report.rows.length === 1 ? 'schedule' : 'schedules';
  lines.push(chalk.dim(`${report.rows.length} ${schWord} across ${fns} ${fnWord}.`));
  lines.push(chalk.dim('LAST RUN shown in UTC; cron daemons honor local TZ (timezone support: ROS-42).'));

  if (report.warnings.length > 0) {
    lines.push('');
    for (const w of report.warnings) lines.push(chalk.yellow(`! ${w}`));
  }
  return lines;
}

export function renderListJson(report: ListReport): string {
  return JSON.stringify(
    {
      cwd: report.cwd,
      schedules: report.rows.map((r) => ({
        functionName: r.functionName,
        name: r.entry.name,
        agent: r.entry.agent,
        plan: r.entry.plan,
        tool: r.entry.tool,
        install_mode: r.entry.install_mode,
        cron: r.entry.cron,
        status: r.entry.status,
        last_run: r.lastRun?.timestamp ?? null,
        last_status: r.lastRun?.status ?? null,
        next_due_at: r.nextDueAt ? fmtTs(r.nextDueAt) : null,
      })),
      warnings: report.warnings,
    },
    null,
    2,
  );
}
