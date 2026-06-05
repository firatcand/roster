import { existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROSTER_ROOT } from './paths.ts';
import { entryAtPath, probeSymlinkSupport, safeRead, safeReadlink } from './fs-utils.ts';

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? `{{${key}}}`);
}

// Region marker regexes — trim inner whitespace for robustness
const MARKER_RE = /^<!--\s*roster:(managed|user):(start|end)\s+(\S+)\s*-->$/;

export type ParsedRegions = {
  managed: Map<string, string>;
  user: Map<string, string>;
  ok: boolean;
  errors: string[];
};

export function parseRegions(content: string): ParsedRegions {
  const managed = new Map<string, string>();
  const user = new Map<string, string>();
  const errors: string[] = [];

  type OpenRegion = { kind: 'managed' | 'user'; name: string; startLine: number; lines: string[] };
  let open: OpenRegion | null = null;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = MARKER_RE.exec(line.trim());
    if (!m) {
      if (open) open.lines.push(line);
      continue;
    }

    const [, kind, action, name] = m as unknown as [string, 'managed' | 'user', 'start' | 'end', string];

    if (action === 'start') {
      if (open) {
        errors.push(`Line ${i + 1}: start of region '${name}' found while region '${open.name}' is still open`);
        open.lines.push(line);
      } else {
        open = { kind, name, startLine: i + 1, lines: [] };
      }
    } else {
      // action === 'end'
      if (!open) {
        errors.push(`Line ${i + 1}: end marker for '${name}' found with no open region`);
      } else if (open.name !== name) {
        errors.push(`Line ${i + 1}: end marker for '${name}' does not match open region '${open.name}'`);
        open = null;
      } else {
        const innerContent = open.lines.join('\n');
        if (open.kind === 'managed') {
          managed.set(open.name, innerContent);
        } else {
          user.set(open.name, innerContent);
        }
        open = null;
      }
    }
  }

  if (open) {
    errors.push(`End of file: region '${open.name}' (started at line ${open.startLine}) was never closed`);
  }

  return { managed, user, ok: errors.length === 0, errors };
}

export type MergeResult = {
  merged: string;
  warnings: string[];
};

export function mergeRegions(existing: string, fresh: string, opts: { force: boolean }): MergeResult {
  const existingParsed = parseRegions(existing);

  if (!existingParsed.ok) {
    if (!opts.force) {
      throw new Error(
        `roster: CONTEXT.md has malformed region markers:\n` +
          existingParsed.errors.map((e) => `  - ${e}`).join('\n') +
          `\n  Re-run with --force to overwrite, or repair the markers manually.`,
      );
    }
    return {
      merged: fresh,
      warnings: ['Malformed markers in existing CONTEXT.md — overwrote with fresh template.'],
    };
  }

  const freshParsed = parseRegions(fresh);

  // Reconstruct the merged file by walking the fresh template lines,
  // replacing managed region content with fresh content and user region content
  // with existing content (or fresh if new region).
  const warnings: string[] = [];
  const outputLines: string[] = [];
  let inRegion: { kind: 'managed' | 'user'; name: string } | null = null;
  let skipLines = false;

  const freshLines = fresh.split('\n');
  for (const line of freshLines) {
    const m = MARKER_RE.exec(line.trim());
    if (!m) {
      if (!skipLines) outputLines.push(line);
      continue;
    }

    const [, kind, action, name] = m as unknown as [string, 'managed' | 'user', 'start' | 'end', string];

    if (action === 'start') {
      outputLines.push(line);
      inRegion = { kind, name };

      if (kind === 'managed') {
        // Use fresh content — skip whatever is in the template body between markers
        const freshContent = freshParsed.managed.get(name) ?? '';
        outputLines.push(freshContent);
        skipLines = true;
      } else {
        // user region: use existing content if present
        const existingContent = existingParsed.user.get(name);
        if (existingContent !== undefined) {
          outputLines.push(existingContent);
        } else {
          // New region not in existing file: use fresh default content
          const freshContent = freshParsed.user.get(name) ?? '';
          outputLines.push(freshContent);
        }
        skipLines = true;
      }
    } else {
      // end marker
      skipLines = false;
      inRegion = null;
      outputLines.push(line);
    }
  }

  // Append any user regions from existing that are not in the fresh template
  for (const [name, content] of existingParsed.user) {
    if (!freshParsed.user.has(name)) {
      outputLines.push('');
      outputLines.push(`<!-- roster:user:start ${name} -->`);
      outputLines.push(content);
      outputLines.push(`<!-- roster:user:end ${name} -->`);
    }
  }

  void inRegion;
  return { merged: outputLines.join('\n'), warnings };
}

export function renderTemplate(projectName: string): string {
  const raw = readFileSync(join(ROSTER_ROOT, 'templates', 'CONTEXT.template.md'), 'utf8');
  return substitute(raw, { PROJECT_NAME: projectName });
}

export type WorkspaceWriteResult = {
  filesWritten: string[];
  filesUpdated: string[];
  filesSkipped: string[];
  filesLinked: string[];
  warnings: string[];
};

function ensureSymlink(
  cwd: string,
  linkName: string,
  target: string,
  force: boolean,
  result: WorkspaceWriteResult,
): void {
  const linkPath = join(cwd, linkName);
  const entry = entryAtPath(linkPath);

  if (entry.unreadable) {
    throw new Error(
      `roster: could not stat ${linkPath}: ${entry.error ?? 'unknown error'}`,
    );
  }

  if (entry.isDirectory) {
    throw new Error(
      `roster: cannot create symlink at ${linkPath} — a directory exists at that path. Remove it and re-run.`,
    );
  }

  if (!entry.exists) {
    symlinkSync(target, linkPath);
    result.filesLinked.push(linkName);
    return;
  }

  if (entry.isSymlink) {
    const actual = safeReadlink(linkPath);
    if (actual === null) {
      throw new Error(`roster: could not read symlink at ${linkPath}`);
    }
    if (actual === target) {
      result.filesSkipped.push(linkName);
      return;
    }
    // Wrong target
    if (!force) {
      throw new Error(
        `roster: ${linkPath} is a symlink pointing to '${actual}', expected '${target}'. ` +
          `Re-run with --force to re-link.`,
      );
    }
    unlinkSync(linkPath);
    symlinkSync(target, linkPath);
    result.filesLinked.push(linkName);
    return;
  }

  // Regular file at link path
  if (!force) {
    throw new Error(
      `roster: ${linkPath} is a regular file. Re-run with --force to replace it with a symlink.`,
    );
  }
  unlinkSync(linkPath);
  symlinkSync(target, linkPath);
  result.filesLinked.push(linkName);
}

export function writeContextAndLinks(
  cwd: string,
  projectName: string,
  opts: { force: boolean; platform?: string },
): WorkspaceWriteResult {
  const result: WorkspaceWriteResult = {
    filesWritten: [],
    filesUpdated: [],
    filesSkipped: [],
    filesLinked: [],
    warnings: [],
  };

  const fresh = renderTemplate(projectName);
  const contextPath = join(cwd, 'CONTEXT.md');

  let effectiveContent: string;

  if (existsSync(contextPath)) {
    const existing = readFileSync(contextPath, 'utf8');
    const { merged, warnings } = mergeRegions(existing, fresh, { force: opts.force });
    result.warnings.push(...warnings);
    effectiveContent = merged;
    if (merged !== existing) {
      writeFileSync(contextPath, merged, 'utf8');
      result.filesUpdated.push('CONTEXT.md');
    } else {
      result.filesSkipped.push('CONTEXT.md');
    }
  } else {
    writeFileSync(contextPath, fresh, 'utf8');
    result.filesWritten.push('CONTEXT.md');
    effectiveContent = fresh;
  }

  const platform = opts.platform ?? process.platform;

  if (platform === 'win32') {
    for (const name of ['CLAUDE.md', 'AGENTS.md'] as const) {
      writeFileSync(join(cwd, name), effectiveContent, 'utf8');
      result.filesWritten.push(name);
    }
    return result;
  }

  // POSIX: probe symlink support ONCE before creating either link
  if (!probeSymlinkSupport(cwd)) {
    for (const name of ['CLAUDE.md', 'AGENTS.md'] as const) {
      writeFileSync(join(cwd, name), effectiveContent, 'utf8');
      result.filesWritten.push(name);
    }
    result.warnings.push(
      'Symlinks not supported on this filesystem — wrote CLAUDE.md and AGENTS.md as regular files.',
    );
    return result;
  }

  for (const name of ['CLAUDE.md', 'AGENTS.md'] as const) {
    ensureSymlink(cwd, name, 'CONTEXT.md', opts.force, result);
  }

  return result;
}

export type SymlinkStatus =
  | 'ok'
  | 'missing'
  | 'wrong-target'
  | 'not-a-symlink'
  | 'content-diverged'
  | 'is-directory'
  | 'unreadable';

type WorkspaceAuditItem = {
  name: string;
  status: SymlinkStatus;
  reason?: string;
};

export type WorkspaceAuditResult = {
  cwd: string;
  contextMdExists: boolean;
  items: WorkspaceAuditItem[];
  warnings: string[];
  ok: boolean;
};

export function auditWorkspace(cwd: string, opts?: { platform?: string }): WorkspaceAuditResult {
  const contextPath = join(cwd, 'CONTEXT.md');
  const contextMdExists = existsSync(contextPath);
  const items: WorkspaceAuditItem[] = [];
  const warnings: string[] = [];
  const platform = opts?.platform ?? process.platform;

  if (!contextMdExists) {
    return { cwd, contextMdExists: false, items: [], warnings, ok: true };
  }

  for (const linkName of ['CLAUDE.md', 'AGENTS.md'] as const) {
    const linkPath = join(cwd, linkName);
    const entry = entryAtPath(linkPath);

    if (!entry.exists && !entry.unreadable) {
      items.push({ name: linkName, status: 'missing' });
      continue;
    }

    if (entry.unreadable) {
      items.push({ name: linkName, status: 'unreadable', reason: entry.error });
      continue;
    }

    if (entry.isDirectory) {
      items.push({ name: linkName, status: 'is-directory', reason: 'directory found at expected link path' });
      continue;
    }

    if (platform === 'win32') {
      const contextContent = safeRead(contextPath);
      const fileContent = safeRead(linkPath);
      if (contextContent === null || fileContent === null) {
        items.push({ name: linkName, status: 'unreadable', reason: 'could not read file for comparison' });
        continue;
      }
      if (contextContent === fileContent) {
        items.push({ name: linkName, status: 'ok' });
      } else {
        items.push({ name: linkName, status: 'content-diverged', reason: 'file content differs from CONTEXT.md' });
      }
      continue;
    }

    // POSIX
    if (!entry.isSymlink) {
      items.push({ name: linkName, status: 'not-a-symlink', reason: 'regular file, re-run roster init --force to repair' });
      continue;
    }

    const actual = safeReadlink(linkPath);
    if (actual === null) {
      items.push({ name: linkName, status: 'unreadable', reason: 'could not read symlink target' });
      continue;
    }

    if (actual === 'CONTEXT.md') {
      items.push({ name: linkName, status: 'ok' });
    } else {
      items.push({ name: linkName, status: 'wrong-target', reason: `points to '${actual}', expected 'CONTEXT.md'` });
    }
  }

  const ok = items.every((i) => i.status === 'ok');
  return { cwd, contextMdExists, items, warnings, ok };
}
