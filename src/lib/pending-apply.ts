import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { PendingItem } from './pending.ts';

export type ApproveResult = { ok: true; target: string } | { ok: false; reason: string };

export type ResolveResult =
  | { ok: true; item: PendingItem }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'ambiguous'; paths: string[] };

export function workspaceRelative(absPath: string, cwd: string): string {
  const rel = relative(cwd, absPath);
  return rel === '' ? '.' : rel;
}

// Reject a target that resolves to the workspace root, an ancestor, or anywhere
// outside the workspace. Single source of truth for the security boundary
// (interactive walker + headless apply). Two layers:
//   1. Lexical — no `..`, not absolute, not the root itself.
//   2. Real-path — the deepest EXISTING ancestor of the target must resolve
//      inside the workspace's real path, so a renameSync can never follow a
//      symlinked directory out of the workspace (Codex 2nd-pass).
export function targetWithinWorkspace(target: string, cwd: string): string | null {
  const absTarget = isAbsolute(target) ? resolve(target) : resolve(cwd, target);
  const rel = relative(resolve(cwd), absTarget);
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    return null;
  }
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return null;
  }
  let probe = absTarget;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return null; // walked past root without finding an existing ancestor
    probe = parent;
  }
  let realProbe: string;
  try {
    realProbe = realpathSync(probe);
  } catch {
    return null;
  }
  if (realProbe !== realCwd && !realProbe.startsWith(realCwd + sep)) {
    return null;
  }
  return absTarget;
}

export function approveItem(item: PendingItem, cwd: string): ApproveResult {
  const target = item.frontMatter['target_on_approve'];
  if (typeof target !== 'string' || target.length === 0) {
    return { ok: false, reason: 'missing target_on_approve in front-matter' };
  }
  const absTarget = targetWithinWorkspace(target, cwd);
  if (absTarget === null) {
    return { ok: false, reason: `target_on_approve escapes workspace (got '${target}')` };
  }
  if (existsSync(absTarget)) {
    return { ok: false, reason: `target already exists: ${target}` };
  }
  mkdirSync(dirname(absTarget), { recursive: true });
  renameSync(item.path, absTarget);
  return { ok: true, target: workspaceRelative(absTarget, cwd) };
}

export function rejectItem(item: PendingItem): void {
  unlinkSync(item.path);
}

// Stable, derived id for an undecided decision: short sha1 of its workspace
// coordinate (function + filename). No new on-disk state — satisfies the
// "rebrand only" decision. Used so the /inbox skill can name an item in chat
// and call back to apply it headlessly.
export function computeItemId(item: PendingItem): string {
  return createHash('sha1').update(`${item.function}/${item.filename}`).digest('hex').slice(0, 8);
}

// Resolve a user/agent selector to exactly one item. Prefer an exact
// workspace-relative path match (unambiguous), then the derived id. Ambiguity
// (id collision) is surfaced rather than guessed.
export function resolveItemBySelector(
  items: readonly PendingItem[],
  selector: string,
  cwd: string,
): ResolveResult {
  const byPath = items.filter((it) => workspaceRelative(it.path, cwd) === selector);
  if (byPath.length === 1) return { ok: true, item: byPath[0]! };
  if (byPath.length > 1) {
    return { ok: false, reason: 'ambiguous', paths: byPath.map((it) => workspaceRelative(it.path, cwd)) };
  }
  const byId = items.filter((it) => computeItemId(it) === selector);
  if (byId.length === 1) return { ok: true, item: byId[0]! };
  if (byId.length > 1) {
    return { ok: false, reason: 'ambiguous', paths: byId.map((it) => workspaceRelative(it.path, cwd)) };
  }
  return { ok: false, reason: 'not-found' };
}
