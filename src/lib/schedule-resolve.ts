import { join, resolve } from 'node:path';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import YAML from 'yaml';
import { scheduleEntrySchema, type ScheduleEntry } from './schedule-schema.ts';
import { scheduleNotFoundError, scheduleAmbiguousError } from './errors.ts';

// Resolve a bare <name> argument across all roster/<fn>/schedules.yaml files,
// or short-circuit when --function is supplied. Shared by remove/status/run.

export type ResolvedSchedule = {
  workspacePath: string;
  functionName: string;
  schedulesYamlPath: string;
  entry: ScheduleEntry;
};

function listFunctionDirs(workspacePath: string, only: string | undefined): string[] {
  if (only !== undefined) return [only];
  const rosterDir = join(workspacePath, 'roster');
  if (!existsSync(rosterDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(rosterDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    const full = join(rosterDir, name);
    try {
      if (statSync(full).isDirectory()) out.push(name);
    } catch {
      // skip
    }
  }
  return out.sort();
}

function readEntries(workspacePath: string, functionName: string): ScheduleEntry[] {
  const path = join(workspacePath, 'roster', functionName, 'schedules.yaml');
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  if (content.trim().length === 0) return [];
  const doc = YAML.parseDocument(content);
  if (doc.errors.length > 0) return [];
  const data = doc.toJS();
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { schedules?: unknown }).schedules)) {
    return [];
  }
  const entries = (data as { schedules: unknown[] }).schedules;
  const out: ScheduleEntry[] = [];
  for (const raw of entries) {
    const parsed = scheduleEntrySchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

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
    const entries = readEntries(workspacePath, fn);
    for (const entry of entries) {
      allNames.push(entry.name);
      if (entry.name === opts.name) matches.push({ functionName: fn, entry });
    }
  }

  if (matches.length === 0) {
    const unique = Array.from(new Set(allNames)).sort();
    throw scheduleNotFoundError(opts.name, unique);
  }
  if (matches.length > 1) {
    throw scheduleAmbiguousError(opts.name, matches.map((m) => m.functionName));
  }

  const match = matches[0]!;
  return {
    workspacePath,
    functionName: match.functionName,
    schedulesYamlPath: join(workspacePath, 'roster', match.functionName, 'schedules.yaml'),
    entry: match.entry,
  };
}
