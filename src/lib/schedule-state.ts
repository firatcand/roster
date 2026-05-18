import { readFileSync, existsSync } from 'node:fs';

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
