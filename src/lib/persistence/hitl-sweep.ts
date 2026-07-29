import { InvalidRecordError, type HitlStore } from './contracts.ts';

// #319 section D: the expiry sweep.
//
// Expiry is enforced in TWO independent ways and the split matters:
//
//   1. `effective_status` (the projection, both backends) reports `expired` the
//      moment the clock passes `expires_at` with no terminal decision. Authority
//      (`canAuthorizeExecution`) and the actionable queue read THAT, so a request
//      whose expiry has never been swept is already non-authorizable and already
//      out of the queue. Correctness NEVER depends on this sweep running.
//
//   2. This sweep MATERIALIZES the durable `expired` decision so the history is
//      complete and the generation is sealed by a row, not only by a clock.
//
// The sweep is therefore bookkeeping, not enforcement — which is exactly why it
// can be bounded, throttled, best-effort and concurrent-safe: the system-expiry
// id is deterministic in (workspace, request, generation, version), so two
// sweeps racing the same candidate converge (one writes, the other no-ops)
// instead of one of them failing.

export const DEFAULT_SWEEP_LIMIT = 200;
export const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export type SweepResult = {
  // Durable `expired` decisions written by THIS sweep.
  expired: number;
  // Candidates another writer resolved first (a concurrent sweep, or a decision
  // that landed between the scan and the insert). Never an error.
  conflicts: number;
  // true when the candidate scan filled its page — more work remains.
  remaining: boolean;
};

export type SweepOptions = { limit?: number };

export async function sweepExpired(
  store: HitlStore,
  now: number,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const limit = opts.limit ?? DEFAULT_SWEEP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvalidRecordError(`sweep limit must be a positive integer (got ${String(limit)})`);
  }
  const candidates = await store.listExpiryCandidates(now, limit);
  let expired = 0;
  let conflicts = 0;
  for (const candidate of candidates) {
    const outcome = await store.insertSystemExpiry(candidate, now);
    if (outcome === 'expired') expired += 1;
    else conflicts += 1;
  }
  return { expired, conflicts, remaining: candidates.length >= limit };
}

// Per-process throttle. Every HITL mutating verb and the actionable list/count
// call this; it is deliberately fire-and-forget-shaped (a failure is swallowed)
// because nothing depends on it — see the note at the top.
const lastSweepAt = new WeakMap<HitlStore, number>();

export function resetSweepThrottle(store: HitlStore): void {
  lastSweepAt.delete(store);
}

export async function maybeSweep(
  store: HitlStore,
  now: number,
  opts: SweepOptions & { intervalMs?: number } = {},
): Promise<SweepResult | null> {
  const interval = opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const previous = lastSweepAt.get(store);
  if (previous !== undefined && now - previous < interval) return null;
  lastSweepAt.set(store, now);
  try {
    return await sweepExpired(store, now, opts);
  } catch {
    // A sweep is never load-bearing: a transient failure must not turn a
    // successful decision or listing into an error.
    return null;
  }
}
