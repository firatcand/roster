import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseFrontMatter } from './front-matter.ts';
import { readWorkspaceEvidenceFileSync } from './schedule-state.ts';
import {
  resolveConfinedPath,
  resolveFunctionDir,
  workspaceRelative,
} from './workspace-path.ts';

// Pending items are agent-written evidence (pending-sync synthesizes them, the
// SessionStart banner counts them on every chat start), so they get the sweep's
// bounded no-follow read too (round-9 finding 1). An item whose shape can never
// hold a decision — non-regular, symlinked, or past the cap — is skipped
// exactly like today's unreadable one rather than blocking the banner or being
// pulled wholly into memory.
const MAX_PENDING_ITEM_BYTES = 4 * 1024 * 1024;

export type PendingItem = {
  function: string;
  path: string;
  filename: string;
  frontMatter: Record<string, unknown>;
  body: string;
};

function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function listPendingFiles(pendingDir: string): string[] {
  try {
    return readdirSync(pendingDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// A missing directory is normal; a REFUSED one — outside the workspace, or
// reached through a symlinked component (round-12 finding 1: the link target
// staying inside the workspace no longer excuses it) — must be reported, never
// silently followed.
function confinedDirOrReport(path: string, cwd: string, refused?: string[]): string | null {
  const res = resolveConfinedPath(path, cwd);
  if (res.status === 'refused') {
    refused?.push(
      `${workspaceRelative(path, cwd)} resolves outside the workspace (${describeRefusal(res.reason)}) — skipped`,
    );
    return null;
  }
  return res.status === 'ok' && res.stat.isDirectory() ? res.path : null;
}

function describeRefusal(reason: 'outside-boundary' | 'symlink-component' | 'unreadable-component'): string {
  if (reason === 'symlink-component') return 'a symlinked path component';
  if (reason === 'unreadable-component') return 'an unreadable path component';
  return 'the path escapes the boundary';
}

// Same skip-with-report contract, one boundary tighter (round-11 finding 1): a
// function dir must resolve beneath roster/, not merely beneath the workspace.
// Only a path that IS something — a diverted link, a non-kebab name — is
// reported; a plain missing directory stays silent (the walker's normal case,
// and what `scanPending(cwd, '<unknown-fn>')` produces).
function confinedFunctionDirOrReport(cwd: string, rosterDir: string, fn: string, refused?: string[]): string | null {
  const res = resolveFunctionDir(cwd, fn);
  if (res === null) return null; // not a legal function NAME — nothing exists to report
  const path = join(rosterDir, fn);
  if (res.status === 'refused') {
    refused?.push(
      res.reason === 'outside-boundary'
        ? `${workspaceRelative(path, cwd)} resolves outside the workspace — skipped`
        : `${workspaceRelative(path, cwd)} does not resolve beneath roster/ (${describeRefusal(res.reason)}) — skipped`,
    );
    return null;
  }
  return res.status === 'ok' && res.stat.isDirectory() ? res.path : null;
}

// `refused` collects a skipped-with-report line per directory that resolves
// outside the workspace (round-10 finding 1). The walker's contract is
// skip-malformed, so a diverted directory must not throw — but it must never
// pass silently either: `roster review` prints them on stderr, which keeps the
// `--json` stdout contract (a flat item array) byte-stable for /inbox.
export function scanPending(cwd: string, fn?: string, refused?: string[]): PendingItem[] {
  const rosterDir = confinedDirOrReport(join(cwd, 'roster'), cwd, refused);
  if (rosterDir === null) return [];

  const functions = fn !== undefined ? [fn] : listDirNames(rosterDir);
  const items: PendingItem[] = [];

  for (const f of functions) {
    // A symlinked FUNCTION dir and a symlinked `pending/` dir are both refused:
    // O_NOFOLLOW on the item file protects only the file's own final component,
    // so without this an item discovered under a diverted directory would be
    // listed by `roster review` — and UNLINKED by `--reject` — outside the
    // workspace entirely.
    // Round-11 finding 1: the function dir is confined to roster/, not merely
    // to the workspace — an in-workspace `roster/gtm -> ../archive` satisfied
    // the wider boundary and still walked a tree outside the registry.
    const fnDir = confinedFunctionDirOrReport(cwd, rosterDir, f, refused);
    if (fnDir === null) continue;
    const pendingDir = confinedDirOrReport(join(fnDir, 'pending'), cwd, refused);
    if (pendingDir === null) continue;

    for (const filename of listPendingFiles(pendingDir)) {
      const itemPath = join(pendingDir, filename);
      const read = readWorkspaceEvidenceFileSync(itemPath, cwd, MAX_PENDING_ITEM_BYTES);
      if (read.state !== 'ok') {
        if (read.state === 'malformed' && read.reason === 'outside-workspace') {
          refused?.push(`${workspaceRelative(itemPath, cwd)} resolves outside the workspace — skipped`);
        }
        continue;
      }
      const { frontMatter, body } = parseFrontMatter(read.content);
      items.push({
        function: f,
        path: itemPath,
        filename: basename(itemPath),
        frontMatter,
        body,
      });
    }
  }

  return items;
}

export function countPending(cwd: string): number {
  return scanPending(cwd).length;
}
