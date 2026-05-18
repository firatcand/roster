import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import YAML from 'yaml';
import chalk from 'chalk';
import { SCHEDULES_YAML_VERSION, type ScheduleEntry } from './schedule-schema.ts';
import { RosterError, EXIT_ERROR, permissionError } from './errors.ts';

export function atomicWriteFile(absPath: string, content: string): void {
  const dir = absPath.slice(0, absPath.lastIndexOf(sep));
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EACCES' || e.code === 'EPERM') throw permissionError(dir, e);
    throw err;
  }
  const tmp = `${absPath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o644 });
    renameSync(tmp, absPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EACCES' || e.code === 'EPERM') throw permissionError(absPath, e);
    throw err;
  }
}

export function readExistingSchedulesDoc(path: string): { doc: YAML.Document; existedBefore: boolean } {
  if (!existsSync(path)) {
    const doc = new YAML.Document({
      version: SCHEDULES_YAML_VERSION,
      schedules: [],
    });
    return { doc, existedBefore: false };
  }

  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} cannot read existing schedules.yaml`,
      body: `  ${e.code ?? e.message ?? 'unreadable'} reading ${path}`,
      remedy: `  Fix file permissions and re-run.`,
      exitCode: EXIT_ERROR,
    });
  }

  if (content.trim().length === 0) {
    const doc = new YAML.Document({
      version: SCHEDULES_YAML_VERSION,
      schedules: [],
    });
    return { doc, existedBefore: true };
  }

  const doc = YAML.parseDocument(content);
  if (doc.errors.length > 0) {
    const first = doc.errors[0]!;
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} existing schedules.yaml is malformed`,
      body: `  ${first.message} (in ${path})`,
      remedy: `  Run ${chalk.bold('roster schedule validate')} for details, or fix the file by hand.`,
      exitCode: EXIT_ERROR,
    });
  }

  return { doc, existedBefore: true };
}

// Tool mismatch on same-name upsert is a real footgun (codex review finding,
// ROS-35): without this guard, `roster schedule install --tool codex foo`
// would silently overwrite an existing `--tool claude foo` entry. Reject
// explicitly with a remediation pointer.
export function upsertEntryInDoc(
  doc: YAML.Document,
  entry: ScheduleEntry,
): { action: 'created' | 'updated' } {
  if (!doc.has('version')) {
    doc.set('version', SCHEDULES_YAML_VERSION);
  }

  let schedules = doc.get('schedules', true);
  if (schedules === undefined || schedules === null) {
    doc.set('schedules', []);
    schedules = doc.get('schedules', true);
  }

  if (!YAML.isSeq(schedules)) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} existing schedules.yaml has the wrong shape`,
      body: `  Expected 'schedules' to be a list; got ${typeof schedules}.`,
      remedy: `  Run ${chalk.bold('roster schedule validate')} to inspect.`,
      exitCode: EXIT_ERROR,
    });
  }

  let existingIndex = -1;
  let existingTool: string | undefined;
  for (let i = 0; i < schedules.items.length; i++) {
    const item = schedules.items[i];
    if (YAML.isMap(item)) {
      const itemName = item.get('name');
      if (itemName === entry.name) {
        existingIndex = i;
        const t = item.get('tool');
        existingTool = typeof t === 'string' ? t : undefined;
        break;
      }
    }
  }

  if (existingIndex >= 0 && existingTool !== undefined && existingTool !== entry.tool) {
    throw new RosterError({
      header: `${chalk.red.bold('roster:')} schedule '${entry.name}' already exists with a different tool`,
      body: `  Existing entry uses tool=${chalk.yellow(existingTool)}; refusing to overwrite with tool=${chalk.yellow(entry.tool)}.`,
      remedy: `  Use ${chalk.bold('--name')} to disambiguate, or run ${chalk.bold(`roster schedule remove ${entry.name}`)} first.`,
      exitCode: EXIT_ERROR,
    });
  }

  const newMap = doc.createNode(entry);
  if (existingIndex >= 0) {
    schedules.items[existingIndex] = newMap;
    return { action: 'updated' };
  } else {
    schedules.add(newMap);
    return { action: 'created' };
  }
}

export function removeEntryFromDoc(
  doc: YAML.Document,
  name: string,
): { removed: boolean } {
  const schedules = doc.get('schedules', true);
  if (!YAML.isSeq(schedules)) return { removed: false };

  for (let i = 0; i < schedules.items.length; i++) {
    const item = schedules.items[i];
    if (YAML.isMap(item)) {
      const itemName = item.get('name');
      if (itemName === name) {
        schedules.items.splice(i, 1);
        return { removed: true };
      }
    }
  }
  return { removed: false };
}
