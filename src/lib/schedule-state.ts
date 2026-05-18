import { readFileSync, existsSync } from 'node:fs';
import { nextFireTime } from './cron-next.ts';

// Contract: skills/roster-orchestrator/SKILL.md:58-64. The orchestrator skill
// appends one line per fire to roster/<function>/state.md in this exact shape:
//   <utc-iso-8601> | <function>/<agent>/<plan>/<project> | <status>
// where status is one of `success` or `failed`. This module is a reader only —
// ROS-32 owns the writes; ROS-42 will extend with missed-fire detection on top
// of the same log.

export type StateLine = {
  timestamp: string;
  scope: string;
  status: string;
  raw: string;
  lineNumber: number;
};

export type ParseResult = {
  lines: StateLine[];
  malformedCount: number;
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export function parseStateMd(content: string): ParseResult {
  const out: StateLine[] = [];
  let malformedCount = 0;
  const rawLines = content.split(/\r?\n/);

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;

    const parts = trimmed.split(' | ');
    if (parts.length !== 3) {
      malformedCount++;
      continue;
    }
    const [timestamp, scope, status] = parts as [string, string, string];

    if (!ISO_RE.test(timestamp)) {
      malformedCount++;
      continue;
    }
    if (status.length === 0) {
      malformedCount++;
      continue;
    }
    // scope shape: <function>/<agent>/<plan>/<project> — exactly 4 non-empty
    // segments per skills/roster-orchestrator/SKILL.md:60.
    const scopeParts = scope.split('/');
    if (scopeParts.length !== 4 || scopeParts.some((p) => p.length === 0)) {
      malformedCount++;
      continue;
    }

    out.push({
      timestamp,
      scope,
      status,
      raw,
      lineNumber: i + 1,
    });
  }
  return { lines: out, malformedCount };
}

export function readStateMd(path: string): ParseResult {
  if (!existsSync(path)) return { lines: [], malformedCount: 0 };
  const content = readFileSync(path, 'utf8');
  return parseStateMd(content);
}

// Match lines whose scope starts with `<function>/<agent>/<plan>/`. The
// trailing slash anchors the prefix so 'gtm/sdr/cold' does not accidentally
// match a longer plan name like 'cold-outreach' under a future schema change.
function scopePrefix(functionName: string, agent: string, plan: string): string {
  return `${functionName}/${agent}/${plan}/`;
}

export function findRecentRuns(
  lines: readonly StateLine[],
  functionName: string,
  agent: string,
  plan: string,
  limit: number,
): StateLine[] {
  const prefix = scopePrefix(functionName, agent, plan);
  const out: StateLine[] = [];
  // Reverse-scan: orchestrator appends; most recent lives at the bottom.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i]!;
    if (line.scope.startsWith(prefix)) out.push(line);
  }
  return out;
}

export function findMostRecentRun(
  lines: readonly StateLine[],
  functionName: string,
  agent: string,
  plan: string,
): StateLine | undefined {
  const matches = findRecentRuns(lines, functionName, agent, plan, 1);
  return matches[0];
}

// ── ROS-42: stale-fire detection ─────────────────────────────────────────

export type StaleDetectInput = {
  cronExpr: string;
  // Most recent line for this schedule from state.md. `undefined` when the
  // agent has never reported a run.
  lastRun: StateLine | undefined;
  // Last fire's process-level mtime, when available. Used as a fallback signal:
  // if `.exit` is recent (within grace), the cron daemon DID fire — but the
  // agent never wrote state.md. That's a "ran-but-silent" failure, not STALE.
  lastFireMtimeMs: number | undefined;
  now: Date;
  graceMinutes: number;
};

export type StaleDetectResult =
  | { stale: false; reason?: 'recent-run' | 'recent-fire' | 'never-fired-yet' }
  | { stale: true; reason: 'no-recent-run' | 'missed-window'; expectedBeforeUtc: string };

// Reports STALE when the most recent agent self-report is older than the
// cron's expected next-fire + grace. Cases:
//
//   - lastRun present + (lastRun + cron-next + grace) > now → not stale
//     (the agent reported within the most recent expected window)
//   - lastRun present + cutoff passed + .exit recent (≥ expected fire) → not
//     stale, reason=recent-fire (wrapper ran; agent silent → failure path
//     surfaces it via pending-sync, not STALE)
//   - lastRun present + cutoff passed + no recent .exit → STALE missed-window
//   - lastRun absent + .exit recent → not stale, reason=recent-fire
//   - lastRun absent + .exit absent → not stale, reason=never-fired-yet
//     (cannot distinguish "freshly installed" from "broken since forever"
//     without an install-time anchor; caller decides via schedules.yaml mtime
//     in a separate doctor check if it cares)
//
// ROS-42 acceptance #2: "STALE if last_run is older than expected_next_fire
// + 2h" — implemented for the `lastRun present` branch above.
export function detectStale(input: StaleDetectInput): StaleDetectResult {
  const { cronExpr, lastRun, lastFireMtimeMs, now, graceMinutes } = input;

  if (lastRun === undefined) {
    if (lastFireMtimeMs !== undefined) return { stale: false, reason: 'recent-fire' };
    return { stale: false, reason: 'never-fired-yet' };
  }

  const lastRunDate = new Date(lastRun.timestamp);
  const expectedNext = nextFireTime(cronExpr, lastRunDate);
  if (!expectedNext.ok) {
    // Cron parser rejected the expression — the doctor's schema-validation
    // section surfaces the real problem. Stay quiet here.
    return { stale: false, reason: 'recent-run' };
  }

  const cutoffMs = expectedNext.next.getTime() + graceMinutes * 60_000;

  // Within the grace window for the most recent expected fire.
  if (now.getTime() < cutoffMs) {
    return { stale: false, reason: 'recent-run' };
  }

  // Grace window has closed without a fresh state.md line. Two sub-cases:
  //   (a) wrapper recorded a fire at-or-after the expected fire time — process
  //       ran but agent stayed silent. Not STALE; failure-detection surfaces.
  if (lastFireMtimeMs !== undefined && lastFireMtimeMs >= expectedNext.next.getTime()) {
    return { stale: false, reason: 'recent-fire' };
  }
  //   (b) no signal at all → STALE missed-window.
  return {
    stale: true,
    reason: 'missed-window',
    expectedBeforeUtc: new Date(cutoffMs).toISOString(),
  };
}
