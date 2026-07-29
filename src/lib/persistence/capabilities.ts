import { join } from 'node:path';
import {
  InvalidRecordError,
  VersionSkewError,
  type OpsBackendKind,
} from './contracts.ts';
import { isUuidV4 } from './config-schema.ts';
import { assertSafeSegment } from './safe-path.ts';
import { ledgerBoundaryFor, readLedgerMeta } from './local/ledger.ts';

// Capability discovery / version negotiation (#318 section H). Components
// version independently (schemas migrate independently); the CLI declares a
// supported range and required capabilities per operation and refuses with an
// actionable VersionSkewError BEFORE any write when a component is newer (or
// older) than it understands. Unknown EXTRA capabilities are ignored
// (forward-compat).
//
// All of this metadata is admin-authored — setup and migrations write it (the
// local meta.json, the PG meta tables) — and RUNTIME-READ-ONLY: nothing in the
// runtime path ever mutates a component version or capability list, which is
// why every exported shape here is deeply Readonly.

export const OPS_COMPONENTS = ['roster_ops', 'hitl', 'objects'] as const;
export type OpsComponent = (typeof OPS_COMPONENTS)[number];

export type ComponentInfo = {
  readonly version: number;
  readonly capabilities: readonly string[];
};

export type BackendInfo = {
  readonly backend: OpsBackendKind;
  readonly components: Readonly<Record<OpsComponent, ComponentInfo>>;
};

// The version a fresh postgres-s3 migration mints, and the offline default
// localBackendInfo reports for a tree with no meta.json. #319 raises hitl to 2
// on BOTH backends: the PG schema carries the state machine (002_state_machine.sql)
// and the local JSONL store implements the same shared machine over its ledger,
// so neither backend advertises a capability it does not provide.
export const CURRENT_COMPONENT_VERSIONS: Readonly<Record<OpsComponent, number>> = {
  roster_ops: 2,
  hitl: 2,
  objects: 2,
};

// Capabilities this CLI knows each component version provides. A version
// absent from this table (a future one) reports an empty capability list —
// backendInfo() still DESCRIBES it for doctor visibility, but every
// assert helper refuses it before any write. v2 is a superset of v1: run-ledger
// (declarations + sanitized projections) for roster_ops; version-id + list-prefix
// (object version tracking + repair listing) for objects (#323).
const KNOWN_COMPONENT_CAPABILITIES: Readonly<Record<OpsComponent, Readonly<Record<number, readonly string[]>>>> = {
  roster_ops: {
    1: ['runs', 'artifacts', 'outbox', 'checkpoint'],
    2: ['runs', 'artifacts', 'outbox', 'checkpoint', 'run-ledger'],
  },
  // hitl v2 (#319) adds the packet/generation state machine: the request_state
  // + request_index projections, the decision-enforcing trigger, and the
  // sealed-generation identity columns.
  hitl: {
    1: ['requests', 'decisions'],
    2: ['requests', 'decisions', 'state-machine'],
  },
  objects: {
    1: ['content-addressed', 'create-only'],
    2: ['content-addressed', 'create-only', 'version-id', 'list-prefix'],
  },
};

export const SUPPORTED_COMPONENT_RANGES: Readonly<Record<OpsComponent, { readonly min: number; readonly max: number }>> = {
  roster_ops: { min: 1, max: 2 },
  hitl: { min: 1, max: 2 },
  objects: { min: 1, max: 2 },
};

// Complete per-operation gate table — READS INCLUDED. An operation is gated
// only on the components it actually touches, so e.g. a future hitl version
// never blocks runs.appendEvent.
export const OPERATION_REQUIREMENTS = {
  // #319: every HITL verb now allocates or reads generation/version identity and
  // the sweep-independent effective status, all of which live behind the v2
  // `state-machine` capability. A v1 backend must get an actionable
  // VersionSkewError, never a missing-column SQL error.
  'hitl.createRequest': { hitl: ['requests', 'state-machine'] },
  'hitl.getRequest': { hitl: ['requests', 'state-machine'] },
  'hitl.listRequests': { hitl: ['requests', 'state-machine'] },
  'hitl.appendDecision': { hitl: ['decisions', 'state-machine'] },
  'hitl.count': { hitl: ['requests', 'state-machine'] },
  'hitl.replaces': { hitl: ['requests', 'state-machine'] },
  'hitl.listVersions': { hitl: ['requests', 'state-machine'] },
  'hitl.listGenerations': { hitl: ['requests', 'state-machine'] },
  'hitl.listDecisions': { hitl: ['decisions', 'state-machine'] },
  'hitl.sweepExpired': { hitl: ['requests', 'decisions', 'state-machine'] },
  // Run-event ops read/write the v2 provenance columns (source/agent/pid/…) and
  // are therefore gated on the v2 `run-ledger` capability, NOT the base v1 `runs`
  // (finding: capability gates authorize v2 SQL against a v1 PostgreSQL — a v1
  // backend must get an actionable VersionSkewError, not a missing-column SQL
  // error). The local JSONL backend reports roster_ops v2 (its code implements
  // the run ledger unconditionally), so this never blocks a local workspace.
  'runs.appendEvent': { roster_ops: ['run-ledger'] },
  'runs.getRun': { roster_ops: ['run-ledger'] },
  'runs.listRuns': { roster_ops: ['run-ledger'] },
  'runs.count': { roster_ops: ['run-ledger'] },
  // putArtifact ALWAYS records object_version_id (a v2 objects column) and, when
  // a declaration is supplied, writes the v2 artifact_declarations table — so it
  // is gated on the v2 `run-ledger` + objects `version-id` capabilities, checked
  // BEFORE any object upload or blob write (finding: declare-artifact against a
  // v1 PG backend uploaded the object + committed the blob, THEN failed on
  // v2-only SQL; the gate must refuse with VersionSkewError before side effects).
  'artifacts.putArtifact': { roster_ops: ['run-ledger'], objects: ['content-addressed', 'create-only', 'version-id'] },
  'artifacts.getArtifact': { roster_ops: ['artifacts'], objects: ['content-addressed'] },
  'artifacts.head': { roster_ops: ['artifacts'] },
  // #323 declaration surface reads/writes the v2 artifact_declarations table, so
  // it is gated on `run-ledger` (not the base v1 `artifacts`).
  'artifacts.putExternal': { roster_ops: ['run-ledger'] },
  'artifacts.getByRun': { roster_ops: ['run-ledger'] },
  'artifacts.getDeclaration': { roster_ops: ['run-ledger'] },
  // `roster run doctor` / `repair --fill-version-ids` bypass the store wrappers:
  // they run declaration/version SQL (v2 tables + columns) on the runtime pool
  // and enumerate the bucket through the admin object store. Gate them on the
  // same v2 capabilities every other run-ledger op needs plus the objects
  // listing (round-8 finding 4: against a supported v1 postgres-s3 backend these
  // two verbs emitted a raw missing-relation DB error instead of an actionable
  // VersionSkewError).
  'runs.doctor': { roster_ops: ['run-ledger'], objects: ['content-addressed', 'version-id', 'list-prefix'] },
  'runs.repair': { roster_ops: ['run-ledger'], objects: ['content-addressed', 'version-id', 'list-prefix'] },
  'outbox.enqueue': { roster_ops: ['outbox'] },
  'outbox.drain': { roster_ops: ['outbox', 'checkpoint'] },
} as const satisfies Record<string, Partial<Record<OpsComponent, readonly string[]>>>;

export type OpsOperation = keyof typeof OPERATION_REQUIREMENTS;

export function requiredCapabilities(operation: OpsOperation): Partial<Record<OpsComponent, readonly string[]>> {
  return OPERATION_REQUIREMENTS[operation];
}

export function knownCapabilities(component: OpsComponent, version: number): readonly string[] {
  return KNOWN_COMPONENT_CAPABILITIES[component][version] ?? [];
}

export type ComponentDescriptor = { version: number; capabilities?: readonly string[] };

// Build a BackendInfo from per-component descriptors. Local callers derive
// capabilities from the known-version table; the postgres-s3 backend (stage 4)
// passes the capability list its admin-authored meta tables report.
export function makeBackendInfo(
  backend: OpsBackendKind,
  components: Readonly<Record<OpsComponent, ComponentDescriptor>>,
): BackendInfo {
  const out = {} as Record<OpsComponent, ComponentInfo>;
  for (const name of OPS_COMPONENTS) {
    const c = components[name];
    if (!Number.isInteger(c.version) || c.version < 1) {
      throw new InvalidRecordError(`component ${name} version must be a positive integer (got ${String(c.version)})`);
    }
    out[name] = {
      version: c.version,
      capabilities: [...(c.capabilities ?? knownCapabilities(name, c.version))],
    };
  }
  return { backend, components: out };
}

// The floor the local JSONL backend reports: its code implements the #323 run
// ledger + declarations unconditionally, so a tree minted by an older CLI (which
// recorded roster_ops v1) is clamped UP here — the code IS v2 the moment it runs
// (finding: local mints v1; implement the local meta upgrade). ledger.meta()
// rewrites the stored meta.json to match on the next write; this read path never
// under-reports a capability the code provides.
const LOCAL_MIN_VERSIONS: Readonly<Record<OpsComponent, number>> = { roster_ops: 2, hitl: 2, objects: 2 };

// backendInfo() for the local backend: reads meta.json componentVersions
// read-only (no minting). A tree that does not exist yet reports the CLI's
// current baseline (the versions a fresh tree would be minted with); corrupt
// meta refuses loudly; a component the meta predates defaults to version 1 then
// is clamped up to the local code floor (versions only ever grow).
export function localBackendInfo(opsRoot: string, workspaceId: string): BackendInfo {
  if (!isUuidV4(workspaceId)) {
    throw new InvalidRecordError(`workspace id must be a UUID v4 (got '${workspaceId}')`);
  }
  assertSafeSegment('workspace id', workspaceId);
  const meta = readLedgerMeta(join(opsRoot, workspaceId), workspaceId, ledgerBoundaryFor(opsRoot));
  const versions = meta?.componentVersions ?? CURRENT_COMPONENT_VERSIONS;
  const components = {} as Record<OpsComponent, ComponentDescriptor>;
  for (const name of OPS_COMPONENTS) {
    const raw = versions[name];
    if (raw !== undefined && (!Number.isInteger(raw) || raw < 1)) {
      throw new InvalidRecordError(
        `meta.json componentVersions.${name} must be a positive integer (got ${String(raw)})`,
      );
    }
    components[name] = { version: Math.max(raw ?? 1, LOCAL_MIN_VERSIONS[name]) };
  }
  return makeBackendInfo('local', components);
}

function skewError(component: OpsComponent, detail: string, remedy: string): VersionSkewError {
  return new VersionSkewError(`component ${component}: ${detail} — ${remedy}`);
}

// Range gate — MUST run before any write against the backend. Future/unknown
// component versions refuse with the upgrade remedy; below-range versions
// (an old backend meeting a newer CLI floor) point at setup/migration.
export function assertComponentSupported(info: BackendInfo, component: OpsComponent): void {
  const { version } = info.components[component];
  const range = SUPPORTED_COMPONENT_RANGES[component];
  if (version > range.max) {
    throw skewError(
      component,
      `backend reports version ${version}; this CLI supports ${range.min}..${range.max}`,
      "upgrade the CLI ('npm install -g @firatcand/roster@latest') before writing",
    );
  }
  if (version < range.min) {
    throw skewError(
      component,
      `backend reports version ${version}; this CLI requires at least ${range.min}`,
      "migrate the backend ('roster ops setup') before writing",
    );
  }
}

// Per-operation gate: supported range for every component the operation
// touches, then required capabilities. Capabilities present on the backend
// but unknown to this CLI are ignored — only MISSING required ones refuse.
export function assertOperationSupported(info: BackendInfo, operation: OpsOperation): void {
  const requirements = OPERATION_REQUIREMENTS[operation];
  for (const [component, needed] of Object.entries(requirements) as [OpsComponent, readonly string[]][]) {
    assertComponentSupported(info, component);
    const offered = info.components[component].capabilities;
    for (const capability of needed) {
      if (!offered.includes(capability)) {
        throw skewError(
          component,
          `operation '${operation}' requires capability '${capability}' but the backend offers [${offered.join(', ')}]`,
          "upgrade the backend or the CLI so both sides agree ('roster ops setup' / 'npm install -g @firatcand/roster@latest')",
        );
      }
    }
  }
}

export function assertBackendSupported(info: BackendInfo): void {
  for (const component of OPS_COMPONENTS) assertComponentSupported(info, component);
}

// Non-throwing skew survey for resolution time: components negotiate
// independently, so a skewed component must not block operations on the
// others — resolution records the skew (doctor-visible) and the per-operation
// gates refuse exactly the operations that touch the skewed component.
export function collectComponentSkew(info: BackendInfo): string[] {
  const skew: string[] = [];
  for (const component of OPS_COMPONENTS) {
    try {
      assertComponentSupported(info, component);
    } catch (err) {
      skew.push((err as Error).message);
    }
  }
  return skew;
}
