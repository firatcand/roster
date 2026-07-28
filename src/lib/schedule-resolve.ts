import { join, resolve } from 'node:path';
import { type ScheduleEntry } from './schedule-schema.ts';
import {
  scheduleNotFoundError,
  scheduleAmbiguousError,
  scheduleNotInFunctionError,
} from './errors.ts';
import { listFunctionDirs, readScheduleEntries } from './schedule-read.ts';
import { confinedFunctionDir } from './workspace-path.ts';

// Resolve a bare <name> argument across all roster/<fn>/schedules.yaml files,
// or short-circuit when --function is supplied. Shared by remove/status/run.

export type ResolvedSchedule = {
  workspacePath: string;
  functionName: string;
  schedulesYamlPath: string;
  entry: ScheduleEntry;
};

export type ResolveOptions = {
  cwd: string;
  name: string;
  functionName?: string | undefined;
};

export function resolveScheduleByName(opts: ResolveOptions): ResolvedSchedule {
  const workspacePath = resolve(opts.cwd);
  const fns = listFunctionDirs(workspacePath, opts.functionName);

  const matches: { functionName: string; entry: ScheduleEntry }[] = [];
  const allNames: string[] = [];
  for (const fn of fns) {
    const entries = readScheduleEntries(workspacePath, fn);
    for (const entry of entries) {
      allNames.push(entry.name);
      if (entry.name === opts.name) matches.push({ functionName: fn, entry });
    }
  }

  if (matches.length === 0) {
    // Codex review finding #6 (ROS-36): when --function was supplied and the
    // name wasn't in that function, also scan all other functions. If the
    // name DOES exist elsewhere, surface that — the typical user error is
    // "wrong --function flag," not a missing schedule.
    if (opts.functionName !== undefined) {
      const otherFns = listFunctionDirs(workspacePath, undefined).filter((f) => f !== opts.functionName);
      const foundIn: string[] = [];
      for (const fn of otherFns) {
        const entries = readScheduleEntries(workspacePath, fn);
        if (entries.some((e) => e.name === opts.name)) foundIn.push(fn);
      }
      if (foundIn.length > 0) {
        throw scheduleNotInFunctionError(opts.name, opts.functionName, foundIn);
      }
    }
    const unique = Array.from(new Set(allNames)).sort();
    throw scheduleNotFoundError(opts.name, unique);
  }
  if (matches.length > 1) {
    throw scheduleAmbiguousError(opts.name, matches.map((m) => m.functionName));
  }

  const match = matches[0]!;
  // The registry the mutating verbs (remove) rewrite. listFunctionDirs already
  // proved this function resolves beneath roster/ on BOTH paths (enumerate and
  // --function); re-deriving the path from the confined directory keeps the
  // write target and the proof in one expression rather than two.
  const functionDir = confinedFunctionDir(workspacePath, match.functionName);
  if (functionDir === null) throw scheduleNotFoundError(opts.name, []);
  return {
    workspacePath,
    functionName: match.functionName,
    schedulesYamlPath: join(functionDir, 'schedules.yaml'),
    entry: match.entry,
  };
}
