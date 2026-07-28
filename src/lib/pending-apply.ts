import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { acknowledgePendingId } from './pending-sync.ts';
import type { PendingItem } from './pending.ts';
import { resolveWorkspaceRelativePath, targetWithinWorkspace, workspaceRelative } from './workspace-path.ts';
import { EXIT_ERROR, RosterError } from './errors.ts';
import chalk from 'chalk';

export type ApproveResult = { ok: true; target: string } | { ok: false; reason: string };

export type ResolveResult =
  | { ok: true; item: PendingItem }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'ambiguous'; paths: string[] };

// Second layer under scanPending's walker confinement (round-10 finding 1): the
// item a caller hands us must ITSELF still resolve inside the workspace before
// anything is renamed or unlinked. The walker refuses a diverted directory, so
// this only fires for an item that arrived some other way (a stale list, a
// directory swapped between the scan and the apply) — but rename and unlink are
// the destructive verbs, so they get their own check rather than trusting the
// caller's provenance.
function assertItemWithinWorkspace(item: PendingItem, cwd: string): void {
  if (targetWithinWorkspace(item.path, cwd) !== null) return;
  throw new RosterError({
    header: `${chalk.red.bold('roster:')} refusing to act on a pending item outside the workspace`,
    body: `  ${item.path} resolves outside ${cwd} — a parent directory is a symlink pointing elsewhere.`,
    remedy: `  Inspect ${item.agent ?? `roster/${item.function}`}/pending (and its parents) and replace the symlink with a real directory.`,
    exitCode: EXIT_ERROR,
  });
}

// Where an approved item lands. Error-class items carry an explicit
// target_on_approve. Lesson-class items don't need one: the destination is
// structural — a candidate in <agent>/pending/ is promoted to <agent>/playbook/
// under the same name (conventions.md § "Lesson lifecycle", skills/dreamer).
// An explicit front-matter target still wins, and either way the result goes
// through the same resolveWorkspaceRelativePath confinement below.
export function resolveApproveTarget(item: PendingItem): string | null {
  const explicit = item.frontMatter['target_on_approve'];
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  if (item.class === 'lesson' && item.agent !== undefined) {
    return `${item.agent}/playbook/${item.filename}`;
  }
  return null;
}

export function approveItem(item: PendingItem, cwd: string): ApproveResult {
  assertItemWithinWorkspace(item, cwd);
  const target = resolveApproveTarget(item);
  if (target === null) {
    return { ok: false, reason: 'missing target_on_approve in front-matter' };
  }
  // Round-11 finding 2: existsSync FOLLOWED the final component, so a DANGLING
  // symlink at the approve target probed as absent and the rename then replaced
  // the link. Only a real regular file is 'already exists'; any other shape —
  // including a symlinked ANCESTOR whose target stays inside the workspace
  // (round-12) — is refused rather than clobbered.
  // The one caller-authored RELATIVE input in the codebase: front matter names
  // the destination relative to the workspace, so it resolves through the
  // explicit workspace-relative flavor (round-13 finding 1).
  const res = resolveWorkspaceRelativePath(target, cwd);
  if (res.status === 'refused') {
    return res.reason === 'outside-boundary'
      ? { ok: false, reason: `approve target escapes workspace (got '${target}')` }
      : {
          ok: false,
          reason: `target is not a safe destination (symlink, special file, or diverted parent): ${target}`,
        };
  }
  if (res.status === 'ok') {
    return res.stat.isFile()
      ? { ok: false, reason: `target already exists: ${target}` }
      : {
          ok: false,
          reason: `target is not a safe destination (symlink, special file, or diverted parent): ${target}`,
        };
  }
  const absTarget = res.path;
  mkdirSync(dirname(absTarget), { recursive: true });
  renameSync(item.path, absTarget);
  return { ok: true, target: workspaceRelative(absTarget, cwd) };
}

// Reject = delete, and for an error-class item (`error-<id>.md`, synthesized by
// `roster pending sync` from immutable exit/STALE evidence) ALSO drop the
// acknowledgement sentinel FIRST — without it the next sync re-creates the item
// from the same evidence and the reject silently un-does itself (round-7
// finding 8). Sentinel before unlink: if the process dies between the two, the
// item survives but is acknowledged, so the next reject (or a manual rm)
// finishes the job; the reverse order would resurrect the item.
export function rejectItem(item: PendingItem, cwd: string): void {
  assertItemWithinWorkspace(item, cwd);
  const m = /^error-([a-f0-9]+)\.md$/.exec(item.filename);
  if (m !== null) {
    acknowledgePendingId(cwd, item.function, m[1]!);
  }
  unlinkSync(item.path);
}

// Stable, derived id for an undecided decision: short sha1 of its workspace
// coordinate. No new on-disk state — satisfies the "rebrand only" decision.
// Used so the /inbox skill can name an item in chat and call back to apply it
// headlessly.
//
// The class is part of the coordinate because the two surfaces can hold the
// same filename under the same name: roster/dreamer/pending/x.md (error) and
// dreamer/pending/x.md (lesson) both reduce to `dreamer/x.md` otherwise.
export function computeItemId(item: PendingItem): string {
  const coordinate = `${item.class}/${item.agent ?? item.function}/${item.filename}`;
  return createHash('sha1').update(coordinate).digest('hex').slice(0, 8);
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
