import { join } from 'node:path';

// #319 finding 7: the local v1→v2 HITL conversion needs a fence the APPEND
// PRIMITIVE itself enforces, not only a pre-flight the migration runs.
//
// The conversion holds `hitl/.lock` exclusively, so nothing can interleave WITH
// it. That is not the whole hazard: a shipped v1 writer that resolved its
// backend BEFORE the migration, then blocked on the lock, appends a v1-format
// record AFTER the conversion released it. The migration is long done (its
// marker says so), every later check short-circuits on that marker, and the v2
// projection reads only v2 kinds — so that record is silently orphaned forever.
//
// The fence is the durable marker itself, read by the writer at append time:
// once a conversion has STARTED (converting) or FINISHED (done) for a
// namespace, its v1 record kinds are refused. That also makes the conversion
// safe to write in bounded chunks (finding 9) — the marker, not the uninterrupted
// lock, is what keeps v1 data out after the first chunk.
//
// Kept in a leaf module with no persistence imports so the ledger (which owns
// the append primitive) and hitl-local-migrate.ts (which owns the marker) can
// share the constants without an import cycle.

export const HITL_MIGRATION_MARKER = '.hitl-v2.json';

// The #318 HITL record kinds. Every v2 record uses a distinct kind
// (hitl-version / hitl-decision-v2), so this set is exactly "the old format".
export const LEGACY_HITL_KINDS: ReadonlySet<string> = new Set(['hitl-request', 'hitl-decision']);

export type FormatFence = { marker: string; kinds: ReadonlySet<string> };

// namespace -> the fence that applies to it. Only namespaces listed here pay
// any cost at all, and only for a matching record kind.
export const FORMAT_FENCES: ReadonlyMap<string, FormatFence> = new Map([
  ['hitl', { marker: HITL_MIGRATION_MARKER, kinds: LEGACY_HITL_KINDS }],
]);

export function fenceMarkerPath(nsDir: string, fence: FormatFence): string {
  return join(nsDir, fence.marker);
}

// A marker in ANY parseable state means the tree has left the v1 format behind
// (`converting` is deliberately included: the chunked conversion releases and
// re-takes nothing, but a partially converted tree must not accept new v1 rows
// either). An unreadable/absent marker means "still v1" — permissive, because
// the conversion itself is what writes the marker.
export function markerFencesLegacyWrites(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const parsed = JSON.parse(raw) as { state?: unknown };
    return parsed !== null && typeof parsed === 'object' && (parsed.state === 'converting' || parsed.state === 'done');
  } catch {
    return false;
  }
}
