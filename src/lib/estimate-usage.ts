import { resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import chalk from 'chalk';
import { buildListReport, fmtTs, type ListReport } from './schedule-list.ts';
import { nextFireTime } from './cron-next.ts';
import { walkFanout, DEFAULT_DEPTH_CAP } from './agent-fanout.ts';
import { loadPlanCeilings, type PlanCeilings } from './plan-ceilings.ts';
import type { ScheduleEntry, ToolValue } from './schedule-schema.ts';
import type { StateLine } from './schedule-state.ts';

const WEEK_HOURS = 7 * 24;

// chalk emits ANSI SGR sequences as ESC + '[' + digits/';' + 'm'. Build the
// regex from a string literal so the ESC byte is the explicit \x1b escape,
// not an invisible-in-source 0x1b byte (which makes regex-literal sources rot).
const ANSI_SGR_RE = new RegExp('\\x1b\\[[0-9;]*m', 'g');

export type EstimateRow = {
  functionName: string;
  name: string;
  agent: string;
  plan: string;
  tool: ToolValue;
  installMode: ScheduleEntry['install_mode'];
  cron: string;
  status: ScheduleEntry['status'];
  lastRun: StateLine | undefined;
  nextDueAt: Date | undefined;
  firesPerWeek: number;
  firesPerDay: number;
  fanout: number;
  depth: number;
  msgsPerFire: number;
  msgsPerFireWithRetry: number;
  msgsPerDay: number;
  msgsPerWeek: number;
  retryMaxAttempts: number;
  // Per-plan-tier comparison: msgs/week ÷ plan.msgs_per_week, expressed
  // as a fraction (1.0 = 100%). Only plans matching this row's `tool`.
  planLoads: ReadonlyArray<{ planId: string; planLabel: string; weeklyLoadFraction: number; warn: boolean }>;
  warnings: string[];
};

export type EstimateReport = {
  cwd: string;
  generatedAt: string;
  warnThreshold: number;
  rows: EstimateRow[];
  ceilings: PlanCeilings;
  warnings: string[];
};

export type EstimateOptions = {
  cwd: string;
  now?: Date;
  warnThreshold?: number;
  depthCap?: number;
  planFilter?: string | undefined; // restrict comparison to a single plan id
  ceilings?: PlanCeilings; // test seam
  listReport?: ListReport; // test seam
};

const DEFAULT_WARN_THRESHOLD = 0.70;

// 7-day-window fire count via brute-force minute stepping over nextFireTime.
// Caches per cron-string within an invocation since multiple schedules may
// share an expression.
export function makeFiresPerWeekFn(): (cron: string, from: Date) => number {
  const cache = new Map<string, number>();
  return (cron, from): number => {
    const cached = cache.get(cron);
    if (cached !== undefined) return cached;
    let count = 0;
    let cursor = from;
    const horizon = new Date(from.getTime() + WEEK_HOURS * 3600 * 1000);
    for (let i = 0; i < 60_000; i++) {
      const next = nextFireTime(cron, cursor);
      if (!next.ok) break;
      if (next.next.getTime() > horizon.getTime()) break;
      count++;
      cursor = next.next;
    }
    cache.set(cron, count);
    return count;
  };
}

function resolveAgentMdPath(
  workspacePath: string,
  functionName: string,
  agentName: string,
): { path: string; exists: boolean } {
  const nested = resolvePath(workspacePath, functionName, agentName, 'agent.md');
  if (existsSync(nested)) return { path: nested, exists: true };

  // Convention: when function name matches agent name, agent.md collapses
  // to <function>/agent.md (see templates/scaffold/chief-of-staff/agent.md).
  if (functionName === agentName) {
    const collapsed = resolvePath(workspacePath, functionName, 'agent.md');
    if (existsSync(collapsed)) return { path: collapsed, exists: true };
  }
  return { path: nested, exists: false };
}

function computeRow(
  workspacePath: string,
  functionName: string,
  entry: ScheduleEntry,
  lastRun: StateLine | undefined,
  nextDueAt: Date | undefined,
  ceilings: PlanCeilings,
  firesPerWeekFn: (cron: string, from: Date) => number,
  now: Date,
  depthCap: number,
  warnThreshold: number,
): EstimateRow {
  const warnings: string[] = [];
  const agentMd = resolveAgentMdPath(workspacePath, functionName, entry.agent);
  let fanout = 0;
  let depth = 0;
  if (!agentMd.exists) {
    warnings.push(`agent.md not found at ${agentMd.path} — fanout assumed 0`);
  } else {
    const result = walkFanout(agentMd.path, depthCap);
    fanout = result.fanoutCount;
    depth = result.depth;
    for (const w of result.warnings) warnings.push(w);
  }

  const retryMaxAttempts = entry.retry_policy?.max_attempts ?? 1;
  const msgsPerFire = 1 + fanout;
  const msgsPerFireWithRetry = msgsPerFire * retryMaxAttempts;

  const firesPerWeek = firesPerWeekFn(entry.cron, now);
  const firesPerDay = firesPerWeek / 7;
  const msgsPerWeek = msgsPerFireWithRetry * firesPerWeek;
  const msgsPerDay = msgsPerFireWithRetry * firesPerDay;

  const planLoads = ceilings
    .filter((c) => c.tool === entry.tool)
    .map((c) => {
      const fraction = msgsPerWeek / c.msgs_per_week;
      return {
        planId: c.id,
        planLabel: c.label,
        weeklyLoadFraction: fraction,
        warn: fraction >= warnThreshold,
      };
    });

  return {
    functionName,
    name: entry.name,
    agent: entry.agent,
    plan: entry.plan,
    tool: entry.tool,
    installMode: entry.install_mode,
    cron: entry.cron,
    status: entry.status,
    lastRun,
    nextDueAt,
    firesPerWeek,
    firesPerDay,
    fanout,
    depth,
    msgsPerFire,
    msgsPerFireWithRetry,
    msgsPerDay,
    msgsPerWeek,
    retryMaxAttempts,
    planLoads,
    warnings,
  };
}

export function estimateUsage(opts: EstimateOptions): EstimateReport {
  const now = opts.now ?? new Date();
  const warnThreshold = opts.warnThreshold ?? DEFAULT_WARN_THRESHOLD;
  const depthCap = opts.depthCap ?? DEFAULT_DEPTH_CAP;
  const allCeilings = opts.ceilings ?? loadPlanCeilings();
  const listReport = opts.listReport ?? buildListReport(opts.cwd, now);

  if (opts.planFilter !== undefined) {
    const match = allCeilings.find((c) => c.id === opts.planFilter);
    if (!match) {
      throw new Error(
        `--plan '${opts.planFilter}' not found in plan-ceilings.yaml (available: ${allCeilings.map((c) => c.id).join(', ')})`,
      );
    }
  }

  // When --plan is set, narrow EVERY downstream consumer (per-row planLoads,
  // text table columns, JSON ceilings array) to the requested plan only.
  const ceilings =
    opts.planFilter === undefined
      ? allCeilings
      : allCeilings.filter((c) => c.id === opts.planFilter);

  const firesPerWeekFn = makeFiresPerWeekFn();
  const rows: EstimateRow[] = [];
  for (const r of listReport.rows) {
    rows.push(
      computeRow(
        listReport.cwd,
        r.functionName,
        r.entry,
        r.lastRun,
        r.nextDueAt,
        ceilings,
        firesPerWeekFn,
        now,
        depthCap,
        warnThreshold,
      ),
    );
  }

  rows.sort((a, b) => {
    if (a.tool !== b.tool) return a.tool.localeCompare(b.tool);
    if (a.functionName !== b.functionName) return a.functionName.localeCompare(b.functionName);
    return a.name.localeCompare(b.name);
  });

  return {
    cwd: listReport.cwd,
    generatedAt: now.toISOString(),
    warnThreshold,
    rows,
    ceilings,
    warnings: [...listReport.warnings],
  };
}

// ── Rendering ────────────────────────────────────────────────────────────

export function renderEstimateJson(report: EstimateReport): string {
  return JSON.stringify(
    {
      cwd: report.cwd,
      generated_at: report.generatedAt,
      warn_threshold: report.warnThreshold,
      schedules: report.rows.map((r) => ({
        functionName: r.functionName,
        name: r.name,
        agent: r.agent,
        plan: r.plan,
        tool: r.tool,
        install_mode: r.installMode,
        cron: r.cron,
        status: r.status,
        last_run: r.lastRun?.timestamp ?? null,
        last_status: r.lastRun?.status ?? null,
        next_due_at: r.nextDueAt ? fmtTs(r.nextDueAt) : null,
        fires_per_day: round(r.firesPerDay, 2),
        fires_per_week: r.firesPerWeek,
        fanout: r.fanout,
        depth: r.depth,
        retry_max_attempts: r.retryMaxAttempts,
        msgs_per_fire: r.msgsPerFire,
        msgs_per_fire_with_retry: r.msgsPerFireWithRetry,
        msgs_per_day: round(r.msgsPerDay, 2),
        msgs_per_week: r.msgsPerWeek,
        plan_loads: r.planLoads.map((p) => ({
          plan_id: p.planId,
          plan_label: p.planLabel,
          weekly_load_fraction: round(p.weeklyLoadFraction, 4),
          warn: p.warn,
        })),
        warnings: r.warnings,
      })),
      ceilings: report.ceilings.map((c) => ({
        id: c.id,
        tool: c.tool,
        label: c.label,
        msgs_per_window: c.msgs_per_window,
        window_hours: c.window_hours,
        msgs_per_week: c.msgs_per_week,
        source_url: c.source_url,
        as_of: c.as_of,
      })),
      warnings: report.warnings,
    },
    null,
    2,
  );
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

export function renderEstimateText(report: EstimateReport): string[] {
  const lines: string[] = [''];
  lines.push(chalk.bold('roster schedule estimate-usage'));
  lines.push(chalk.dim(`cwd: ${report.cwd}`));
  lines.push(chalk.dim(`generated: ${report.generatedAt}  warn-threshold: ${pct(report.warnThreshold)}`));

  if (report.rows.length === 0) {
    lines.push('');
    lines.push(chalk.dim('(no schedules registered)'));
    if (report.warnings.length > 0) {
      lines.push('');
      for (const w of report.warnings) lines.push(chalk.yellow(`! ${w}`));
    }
    return lines;
  }

  const byTool = new Map<ToolValue, EstimateRow[]>();
  for (const r of report.rows) {
    const arr = byTool.get(r.tool) ?? [];
    arr.push(r);
    byTool.set(r.tool, arr);
  }

  for (const [tool, toolRows] of byTool) {
    lines.push('');
    lines.push(chalk.bold.cyan(`[ ${tool} ]`));
    const ceilingsForTool = report.ceilings.filter((c) => c.tool === tool);

    const headers = ['SCHEDULE', 'CRON', 'FIRES/DAY', 'MSGS/FIRE', 'MSGS/DAY', 'MSGS/WEEK'];
    for (const c of ceilingsForTool) headers.push(`${c.label.toUpperCase()} %`);

    const cells: string[][] = toolRows.map((r) => {
      const msgsPerFireCell =
        r.retryMaxAttempts > 1 ? `${r.msgsPerFire}→${r.msgsPerFireWithRetry}` : `${r.msgsPerFire}`;
      const row = [
        r.name,
        r.cron,
        round(r.firesPerDay, 2).toString(),
        msgsPerFireCell,
        round(r.msgsPerDay, 1).toString(),
        r.msgsPerWeek.toString(),
      ];
      for (const c of ceilingsForTool) {
        const load = r.planLoads.find((p) => p.planId === c.id);
        if (!load) {
          row.push('-');
        } else {
          const cell = pct(load.weeklyLoadFraction);
          row.push(load.warn ? chalk.yellow(cell) : cell);
        }
      }
      return row;
    });

    // Strip ANSI SGR sequences for visible width (chalk emits ESC + [ + ... + m).
    const widthOf = (s: string): number => s.replace(ANSI_SGR_RE, '').length;
    const widths = headers.map((h, i) =>
      Math.max(widthOf(h), ...cells.map((row) => widthOf(row[i]!))),
    );
    const pad = (row: string[]): string =>
      row
        .map((c, i) => {
          const vw = widthOf(c);
          return c + ' '.repeat(Math.max(0, widths[i]! - vw));
        })
        .join('  ')
        .trimEnd();
    lines.push(chalk.bold(pad(headers)));
    for (const row of cells) lines.push(pad(row));
  }

  lines.push('');
  lines.push(chalk.bold('Plan ceilings:'));
  for (const c of report.ceilings) {
    lines.push(
      chalk.dim(
        `  ${c.id.padEnd(16)}  ${c.msgs_per_week.toString().padStart(6)} msgs/week  (as of ${c.as_of}, ${c.source_url})`,
      ),
    );
  }

  const warnings = report.rows.flatMap((r) =>
    r.planLoads
      .filter((p) => p.warn)
      .map((p) => `${r.name} (${r.tool}): ${pct(p.weeklyLoadFraction)} of ${p.planLabel} weekly cap`),
  );
  if (warnings.length > 0) {
    lines.push('');
    lines.push(chalk.yellow.bold(`! ${warnings.length} schedule${warnings.length === 1 ? '' : 's'} at or above ${pct(report.warnThreshold)} threshold:`));
    for (const w of warnings) lines.push(chalk.yellow(`  - ${w}`));
  }

  const otherWarnings: string[] = [...report.warnings];
  for (const r of report.rows) for (const w of r.warnings) otherWarnings.push(`${r.name}: ${w}`);
  if (otherWarnings.length > 0) {
    lines.push('');
    for (const w of otherWarnings) lines.push(chalk.yellow(`! ${w}`));
  }

  return lines;
}
