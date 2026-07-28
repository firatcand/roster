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

// Two decision surfaces, both counted by the SessionStart banner and therefore
// both actionable through `roster review`:
//   error  — roster/<function>/pending/  synthesized by `pending sync`.
//   lesson — <function>/<agent>/pending/ dreamer-drafted lesson candidates, plus
//            <agent>/pending/ for the cross-cutting peers (dreamer/,
//            chief-of-staff/) that sit outside any function.
// Scanning only the first left lesson candidates visible to the banner but
// unreachable by approve/reject — see conventions.md § "Lesson lifecycle".
export type PendingClass = 'error' | 'lesson';

export type PendingItem = {
  function: string;
  // Workspace-relative agent dir; lesson class only. Makes the approve target
  // derivable (see resolveApproveTarget) and disambiguates the item id.
  agent?: string;
  class: PendingClass;
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
// Shared item read for both surfaces: the bounded no-follow read, then
// front-matter parse. `meta` carries whatever distinguishes the surface.
function readPendingItems(
  cwd: string,
  pendingDir: string,
  meta: { function: string; agent?: string; class: PendingClass },
  refused?: string[],
): PendingItem[] {
  const items: PendingItem[] = [];
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
    items.push({ ...meta, path: itemPath, filename: basename(itemPath), frontMatter, body });
  }
  return items;
}

// An agent directory is one holding an agent.md — the structural invariant from
// conventions.md § "Agent contract". lstat-only (resolveConfinedPath), so a
// symlinked agent.md never counts and nothing is read to answer the question.
function isAgentDir(dirAbs: string, cwd: string): boolean {
  const res = resolveConfinedPath(join(dirAbs, 'agent.md'), cwd);
  return res.status === 'ok' && res.stat.isFile();
}

// Lesson surface. Same confinement contract as the error surface — every
// directory component is resolved before it is walked and each item goes
// through the bounded no-follow read — but confined to the WORKSPACE rather
// than to roster/, because agent dirs legitimately live outside roster/.
//
// The speculative probes (is this top-level dir an agent? does it contain
// agents?) deliberately pass no `refused` channel: every workspace has
// unrelated top-level dirs, and reporting a symlinked `docs/` as a skipped
// decision directory would be noise. Refusals are reported only once a real
// pending/ directory is being resolved.
function scanLessonClass(cwd: string, fn?: string, refused?: string[]): PendingItem[] {
  const items: PendingItem[] = [];

  for (const top of listDirNames(cwd)) {
    // roster/ is the error surface; dotted dirs and node_modules never hold agents.
    if (top === 'roster' || top === 'node_modules' || top.startsWith('.')) continue;
    if (fn !== undefined && top !== fn) continue;

    const topDir = confinedDirOrReport(join(cwd, top), cwd);
    if (topDir === null) continue;

    // Cross-cutting peer agent at the workspace root (dreamer/, chief-of-staff/).
    if (isAgentDir(topDir, cwd)) {
      const pendingDir = confinedDirOrReport(join(topDir, 'pending'), cwd, refused);
      if (pendingDir !== null) {
        items.push(
          ...readPendingItems(cwd, pendingDir, { function: top, agent: top, class: 'lesson' }, refused),
        );
      }
      continue;
    }

    // Otherwise treat it as a function dir and look one level down for agents.
    for (const agent of listDirNames(topDir)) {
      const agentDir = confinedDirOrReport(join(topDir, agent), cwd);
      if (agentDir === null || !isAgentDir(agentDir, cwd)) continue;
      const pendingDir = confinedDirOrReport(join(agentDir, 'pending'), cwd, refused);
      if (pendingDir === null) continue;
      items.push(
        ...readPendingItems(
          cwd,
          pendingDir,
          { function: top, agent: `${top}/${agent}`, class: 'lesson' },
          refused,
        ),
      );
    }
  }

  return items;
}

function scanErrorClass(cwd: string, fn?: string, refused?: string[]): PendingItem[] {
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

    items.push(...readPendingItems(cwd, pendingDir, { function: f, class: 'error' }, refused));
  }

  return items;
}

export function scanPending(cwd: string, fn?: string, refused?: string[]): PendingItem[] {
  return [...scanErrorClass(cwd, fn, refused), ...scanLessonClass(cwd, fn, refused)].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

export function countPending(cwd: string): number {
  return scanPending(cwd).length;
}
