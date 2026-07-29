import { computeRecordId, type HitlDecisionStatus, type HitlSupersedesRef } from './contracts.ts';
import type { HitlActionKind, HitlPayloadRef } from './hitl-machine.ts';

// The local ledger's HITL v2 record shapes, in a leaf module so the store and
// the v1→v2 conversion can both use them without an import cycle.
//
// The v1 (#318) kinds `hitl-request` / `hitl-decision` are deliberately NOT
// reused: the conversion appends v2 records ALONGSIDE the untouched v1 lines
// (the ledger is append-only), and readers project only the v2 kinds.

export const HITL_VERSION_KIND = 'hitl-request-version';
export const HITL_DECISION_KIND = 'hitl-decision-record';
export const HITL_PAYLOAD_DIR = 'hitl-payloads';

export type LocalHitlVersionPayload = {
  requestId: string;
  requestKey: string;
  generation: number;
  version: number;
  functionName: string;
  title: string;
  action: string;
  actionKind: HitlActionKind;
  target: string;
  targetHash: string;
  packetHash: string;
  canonicalizationVersion: number;
  contentHash: string;
  body: string | null;
  payloadRef: HitlPayloadRef | null;
  expiresAt: number | null;
  summary: string | null;
  warnings: unknown;
  sideEffects: unknown;
  choices: unknown;
  originRunId: string | null;
  originTaskId: string | null;
  requestingAgent: string | null;
  sanitizedSummary: string | null;
  supersedes: HitlSupersedesRef | null;
};

export type LocalHitlDecisionPayload = {
  requestId: string;
  generation: number;
  requestVersion: number;
  status: HitlDecisionStatus;
  decidedBy: string;
  note: string | null;
  feedback: string | null;
};

// decided_at is a store OBSERVATION, never part of the record checksum: a
// deterministic system expiry replayed by a second concurrent sweep must dedup
// (first-write-wins), not conflict over a millisecond.
export type LocalHitlDecisionObservations = { decidedAt: number };

// The same treatment for a CONVERTED version record's original creation time.
// A live write has no need for it (the record's own timestamp IS the creation
// time), but a v1→v2 conversion re-derives history long after the fact, and the
// postgres backfill preserves the v1 `created_at` — so the local side carries it
// too, out of the checksum, so a roll-forward re-derivation still dedups.
export type LocalHitlVersionObservations = { createdAt: number };

// D5: the PHYSICAL ledger id is composite (request, generation, version). The
// stable LOGICAL id (requestId) is deliberately NOT reused as a dedup key —
// every revision would collide with the base version.
export function hitlVersionRecordId(
  workspaceId: string,
  requestId: string,
  generation: number,
  version: number,
): string {
  return computeRecordId(workspaceId, 'hitl', { kind: HITL_VERSION_KIND, requestId, generation, version });
}
