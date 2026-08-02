import { createHash } from 'node:crypto';
import { workspaceFailure } from '../workspace-diagnostics.ts';
import type { WorkspaceDiscoveryRecord } from '../workspace-registry.ts';

const COMPLETE_WORKSPACE_SNAPSHOT: unique symbol = Symbol('complete-workspace-snapshot');

export type CompleteWorkspaceSnapshot = {
  readonly [COMPLETE_WORKSPACE_SNAPSHOT]: true;
  readonly records: readonly WorkspaceDiscoveryRecord[];
};

const COMPLETE_SNAPSHOTS = new WeakSet<object>();
const SNAPSHOT_COUNTS = new WeakMap<object, { records: number; content: number }>();

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, cloneValue(entry)])) as T;
  }
  return value;
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) freezeValue(entry);
    Object.freeze(value);
  }
  return value;
}

function snapshotFailure(): never {
  throw workspaceFailure(
    'TOOL_USE_SNAPSHOT_INCOMPLETE',
    'Tool-use resolution requires an attested complete full-content workspace snapshot.',
    'Collect the unfiltered workspace registry with full exact content before resolving tool use.',
    { requirement: 'complete-full-content-snapshot' },
  );
}

function contentHash(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function mintCompleteWorkspaceSnapshot(
  records: readonly WorkspaceDiscoveryRecord[],
): CompleteWorkspaceSnapshot {
  if (records.some((record) => typeof record.content !== 'string'
    || record.content_hash !== contentHash(record.content))) snapshotFailure();
  const copiedRecords = freezeValue(cloneValue([...records])) as readonly WorkspaceDiscoveryRecord[];
  const snapshot = {
    [COMPLETE_WORKSPACE_SNAPSHOT]: true as const,
    records: copiedRecords,
  };
  freezeValue(snapshot);
  COMPLETE_SNAPSHOTS.add(snapshot);
  SNAPSHOT_COUNTS.set(snapshot, { records: copiedRecords.length, content: copiedRecords.length });
  return snapshot;
}

export function assertCompleteWorkspaceSnapshot(value: unknown): asserts value is CompleteWorkspaceSnapshot {
  if (value === null || typeof value !== 'object' || !COMPLETE_SNAPSHOTS.has(value)) snapshotFailure();
  const snapshot = value as CompleteWorkspaceSnapshot;
  const counts = SNAPSHOT_COUNTS.get(value);
  if (counts === undefined
    || !Object.isFrozen(snapshot)
    || !Object.isFrozen(snapshot.records)
    || snapshot.records.length !== counts.records
    || counts.content !== counts.records) snapshotFailure();
}
