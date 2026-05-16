import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import {
  findDuplicateNames,
  flattenZodErrors,
  scheduleFileSchema,
  type FieldError,
} from './schedule-schema.ts';

export type FileStatus = 'pass' | 'fail';

export type FileReport = {
  path: string;
  relativePath: string;
  status: FileStatus;
  entryCount: number;
  errors: FieldError[];
};

export type ValidationReport = {
  ok: boolean;
  cwd: string;
  files: FileReport[];
};

function rosterDir(cwd: string): string {
  return join(cwd, 'roster');
}

export function findScheduleFiles(cwd: string): string[] {
  const root = rosterDir(cwd);
  let topEntries: string[];
  try {
    topEntries = readdirSync(root);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of topEntries) {
    const fnDir = join(root, entry);
    let s;
    try {
      s = statSync(fnDir);
    } catch {
      continue;
    }
    if (!s.isDirectory()) continue;
    const candidate = join(fnDir, 'schedules.yaml');
    try {
      statSync(candidate);
      found.push(candidate);
    } catch {
      // missing schedules.yaml is fine
    }
  }
  return found.sort();
}

function readFile(path: string): { ok: true; content: string } | { ok: false; error: string } {
  try {
    return { ok: true, content: readFileSync(path, 'utf8') };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { ok: false, error: e.code ?? e.message ?? 'unreadable' };
  }
}

function parseYaml(content: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: YAML.parse(content) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.replace(/\n+/g, ' ').trim() };
  }
}

function validateOneFile(cwd: string, absPath: string): FileReport {
  const relativePath = relative(cwd, absPath);

  let stat;
  try {
    stat = statSync(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
    return {
      path: absPath,
      relativePath,
      status: 'fail',
      entryCount: 0,
      errors: [{ path: '<file>', message: `cannot stat: ${code}` }],
    };
  }

  if (!stat.isFile()) {
    return {
      path: absPath,
      relativePath,
      status: 'fail',
      entryCount: 0,
      errors: [
        {
          path: '<file>',
          message: stat.isDirectory()
            ? 'expected file, found directory'
            : 'expected regular file (got non-file entry)',
        },
      ],
    };
  }

  const read = readFile(absPath);
  if (!read.ok) {
    return {
      path: absPath,
      relativePath,
      status: 'fail',
      entryCount: 0,
      errors: [{ path: '<file>', message: `cannot read file: ${read.error}` }],
    };
  }

  const parsed = parseYaml(read.content);
  if (!parsed.ok) {
    return {
      path: absPath,
      relativePath,
      status: 'fail',
      entryCount: 0,
      errors: [{ path: '<file>', message: `YAML parse error: ${parsed.error}` }],
    };
  }

  if (parsed.value === null || parsed.value === undefined) {
    return {
      path: absPath,
      relativePath,
      status: 'fail',
      entryCount: 0,
      errors: [{ path: '<file>', message: 'file is empty or contains only null' }],
    };
  }

  const schemaResult = scheduleFileSchema.safeParse(parsed.value);
  if (!schemaResult.success) {
    return {
      path: absPath,
      relativePath,
      status: 'fail',
      entryCount: 0,
      errors: flattenZodErrors(schemaResult.error),
    };
  }

  const errors = findDuplicateNames(schemaResult.data.schedules);

  return {
    path: absPath,
    relativePath,
    status: errors.length === 0 ? 'pass' : 'fail',
    entryCount: schemaResult.data.schedules.length,
    errors,
  };
}

export function validateSchedulesInCwd(cwd: string): ValidationReport {
  const files = findScheduleFiles(cwd);
  const reports = files.map((f) => validateOneFile(cwd, f));
  const ok = reports.every((r) => r.status === 'pass');
  return { ok, cwd, files: reports };
}
