// Atomic-write transaction for guided agent creation.
//
// Reference implementation of skills/chief-of-staff/SKILL.md § Phase 5
// Steps 1, 4, 5, 7. Step 3 (SIGINT trap) and Step 8 (operation log) are
// caller-managed concerns and intentionally NOT part of this module —
// the caller can install a SIGINT handler that invokes the rollback walk
// returned by atomicWrite() if it needs to. Step 6 (slash command write)
// is optionally performed by this module after Step 5 succeeds; it is
// OUTSIDE the rollback root per the contract.
//
// Pure-by-injection: production callers pass a real fs-backed AtomicFs.
// Tests pass a fake that throws on configured paths. The module itself
// imports nothing from node:fs.

import type { RenderOutput } from './render.ts';
import { validateInvariants } from './invariants.ts';

// fs adapter. Each operation reports whether it actually created a path
// (so the rollback walker can distinguish "we created this" from
// "it already existed"). Errors are thrown.
export interface AtomicFs {
  // Returns { created: true } if the directory was newly created, false if
  // it pre-existed. A pre-existing dir is NOT appended to rollback — per
  // SKILL.md, we only delete paths we created.
  mkdir(path: string): Promise<{ created: boolean }>;
  writeFile(path: string, content: string): Promise<void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
}

export type AtomicOutcome = 'success' | 'rollback' | 'partial-slash-failure';

export interface AtomicWriteResult {
  outcome: AtomicOutcome;
  // Every path the transaction created, in creation order. The rollback
  // walker (and any caller-installed SIGINT trap) walks this in reverse.
  rollback: string[];
  // Paths the rollback walk failed to remove (race / unexpected content).
  // Empty on success.
  residual: string[];
  // On 'rollback': the path whose write triggered the rollback. Will also
  // appear in `rollback` (appended before the write attempt per SKILL.md).
  failureAt?: string;
  // The original error, if any.
  error?: Error;
}

export interface AtomicWriteOptions {
  // When true, skip Step 6 (slash command write). The caller wants to do
  // it separately, or this is a test that doesn't care about the slash.
  skipSlashCommand?: boolean;
}

export async function atomicWrite(
  output: RenderOutput,
  fs: AtomicFs,
  opts: AtomicWriteOptions = {},
): Promise<AtomicWriteResult> {
  // Step 1 — pre-write invariant check. Throws on failure; no fs touched.
  validateInvariants(output);

  // Steps 4 + 5 — the agent-tree transaction. SKILL.md says:
  // - Append every newly-created path to `rollback` in creation order.
  // - For files: append BEFORE the write attempt so a mid-byte failure
  //   leaves the partial path in the cleanup set.
  // - For dirs: append only if mkdir reports `created: true`.
  const rollback: string[] = [];
  const knownDirs = new Set(output.dirs);

  // Step 4 — directories, parent-before-child.
  let mkdirFailureAt: string | undefined;
  try {
    for (const dir of output.dirs) {
      mkdirFailureAt = dir;
      const result = await fs.mkdir(dir);
      if (result.created) rollback.push(dir);
    }
    mkdirFailureAt = undefined;
  } catch (err) {
    return rollbackWalk(fs, rollback, knownDirs, err as Error, 'rollback', mkdirFailureAt);
  }

  // Step 5 — files in canonical write order (agent.md is last).
  for (const [path, content] of output.files) {
    rollback.push(path);
    try {
      await fs.writeFile(path, content);
    } catch (err) {
      return rollbackWalk(fs, rollback, knownDirs, err as Error, 'rollback', path);
    }
  }

  // Step 6 — slash command, outside the rollback root.
  // SKILL.md: write failure here is NOT a rollback trigger. The agent
  // tree is canonical at this point; caller recovers via --slash-only.
  if (!opts.skipSlashCommand) {
    try {
      await fs.writeFile(output.slashCommand.path, output.slashCommand.content);
    } catch (err) {
      return {
        outcome: 'partial-slash-failure',
        rollback,
        residual: [],
        failureAt: output.slashCommand.path,
        error: err as Error,
      };
    }
  }

  return { outcome: 'success', rollback, residual: [] };
}

// Walks `rollback` in reverse (newest first). Per SKILL.md Step 7:
//   - file → unlink
//   - dir  → rmdir (succeeds because children are gone by reverse-walk order)
// Any path the walk fails to remove is collected as residual and surfaced;
// the walk does NOT abort on per-path failure (best-effort cleanup).
async function rollbackWalk(
  fs: AtomicFs,
  rollback: string[],
  knownDirs: Set<string>,
  error: Error,
  outcome: AtomicOutcome,
  failureAt?: string,
): Promise<AtomicWriteResult> {
  const residual: string[] = [];
  for (let i = rollback.length - 1; i >= 0; i--) {
    const path = rollback[i];
    try {
      if (knownDirs.has(path)) {
        await fs.rmdir(path);
      } else {
        await fs.unlink(path);
      }
    } catch (err) {
      // ENOENT on unlink is fine — a write may have failed before any
      // bytes landed. Anything else (EBUSY, ENOTEMPTY, EACCES) is residual.
      if (!isEnoent(err)) residual.push(path);
    }
  }
  return { outcome, rollback, residual, failureAt, error };
}

function isEnoent(err: unknown): boolean {
  return err !== null && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT';
}
