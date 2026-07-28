import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { confinedFunctionDir, confinedWorkspaceDir } from './workspace-path.ts';
import YAML from 'yaml';
import {
  findDuplicateNames,
  flattenZodErrors,
  scheduleFileSchema,
  type FieldError,
} from './schedule-schema.ts';
import { MAX_SCHEDULES_YAML_BYTES } from './schedule-read.ts';
import { readWorkspaceEvidenceFileSync } from './schedule-state.ts';

type FileStatus = 'pass' | 'fail';

type FileReport = {
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

export function findScheduleFiles(cwd: string): string[] {
  // Round-10 finding 1: the walk is confined before it enumerates, so a
  // symlinked `roster/` or `roster/<fn>` reports NO files rather than
  // validating (and legitimizing) a foreign directory's registries.
  const root = confinedWorkspaceDir(join(cwd, 'roster'), cwd);
  if (root === null) return [];
  let topEntries: string[];
  try {
    topEntries = readdirSync(root);
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of topEntries) {
    // Round-11 finding 1: the boundary is roster/, not the workspace — an
    // in-workspace `roster/gtm -> ../archive` used to legitimize a sibling tree.
    const fnDir = confinedFunctionDir(cwd, entry);
    if (fnDir === null) continue;
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

// Hardened bounded read (round-9 finding 1): the registry is workspace state a
// sandboxed agent can write, so `roster schedule validate` — the command a user
// reaches for precisely BECAUSE the file looks wrong — must never block on a
// planted FIFO, follow a symlink out of the workspace, or load an unbounded
// file. The failure stays this module's own per-file `cannot read file: …`
// report row rather than an exception.
function readFile(cwd: string, path: string): { ok: true; content: string } | { ok: false; error: string } {
  const read = readWorkspaceEvidenceFileSync(path, cwd, MAX_SCHEDULES_YAML_BYTES);
  if (read.state === 'ok') return { ok: true, content: read.content };
  if (read.state === 'missing') return { ok: false, error: 'ENOENT' };
  return { ok: false, error: read.reason };
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

  const read = readFile(cwd, absPath);
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
