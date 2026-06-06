import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { scheduleEntrySchema, type ScheduleEntry } from './schedule-schema.ts';

// Shared schedule-reading helpers (ROS-121). Consolidates copies that lived in
// schedule-list.ts and schedule-resolve.ts.

// List roster/<fn> directories. When `only` is given, short-circuit to just that
// one (schedule-resolve's --function path); otherwise enumerate + sort.
export function listFunctionDirs(workspacePath: string, only?: string): string[] {
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

// Read + schema-validate the schedule entries in roster/<fn>/schedules.yaml.
// When a `warnings` array is supplied, problems (unreadable / malformed /
// missing list / per-entry invalid) are appended as user-facing strings — the
// schedule-list behavior. When it is omitted, problems are silent (malformed →
// []) and an unreadable existing file is allowed to throw — the schedule-resolve
// behavior, preserved exactly.
export function readScheduleEntries(
  workspacePath: string,
  functionName: string,
  warnings?: string[],
): ScheduleEntry[] {
  const path = join(workspacePath, 'roster', functionName, 'schedules.yaml');
  if (!existsSync(path)) return [];

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    if (warnings) {
      const e = err as NodeJS.ErrnoException;
      warnings.push(`roster/${functionName}/schedules.yaml: cannot read (${e.code ?? e.message})`);
      return [];
    }
    throw err;
  }

  if (content.trim().length === 0) return [];

  const doc = YAML.parseDocument(content);
  if (doc.errors.length > 0) {
    warnings?.push(
      `roster/${functionName}/schedules.yaml: malformed (${doc.errors[0]!.message}) — run \`roster schedule validate\``,
    );
    return [];
  }

  const data = doc.toJS();
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { schedules?: unknown }).schedules)) {
    warnings?.push(`roster/${functionName}/schedules.yaml: missing 'schedules:' list`);
    return [];
  }

  const out: ScheduleEntry[] = [];
  const entries = (data as { schedules: unknown[] }).schedules;
  for (let i = 0; i < entries.length; i++) {
    const parsed = scheduleEntrySchema.safeParse(entries[i]);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      warnings?.push(
        `roster/${functionName}/schedules.yaml[${i}]: invalid (${parsed.error.issues[0]?.message ?? 'schema error'}) — run \`roster schedule validate\``,
      );
    }
  }
  return out;
}
