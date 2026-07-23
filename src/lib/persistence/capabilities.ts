import { join } from 'node:path';
import {
  InvalidRecordError,
  VersionSkewError,
  type OpsBackendKind,
} from './contracts.ts';
import { isUuidV4 } from './config-schema.ts';
import { assertSafeSegment } from './safe-path.ts';
import { readLedgerMeta } from './local/ledger.ts';

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

export const CURRENT_COMPONENT_VERSIONS: Readonly<Record<OpsComponent, number>> = {
  roster_ops: 1,
  hitl: 1,
  objects: 1,
};

// Capabilities this CLI knows each component version provides. A version
// absent from this table (a future one) reports an empty capability list —
// backendInfo() still DESCRIBES it for doctor visibility, but every
// assert helper refuses it before any write.
const KNOWN_COMPONENT_CAPABILITIES: Readonly<Record<OpsComponent, Readonly<Record<number, readonly string[]>>>> = {
  roster_ops: { 1: ['runs', 'artifacts', 'outbox', 'checkpoint'] },
  hitl: { 1: ['requests', 'decisions'] },
  objects: { 1: ['content-addressed', 'create-only'] },
};

export const SUPPORTED_COMPONENT_RANGES: Readonly<Record<OpsComponent, { readonly min: number; readonly max: number }>> = {
  roster_ops: { min: 1, max: 1 },
  hitl: { min: 1, max: 1 },
  objects: { min: 1, max: 1 },
};

// Complete per-operation gate table — READS INCLUDED. An operation is gated
// only on the components it actually touches, so e.g. a future hitl version
// never blocks runs.appendEvent.
export const OPERATION_REQUIREMENTS = {
  'hitl.createRequest': { hitl: ['requests'] },
  'hitl.getRequest': { hitl: ['requests'] },
  'hitl.listRequests': { hitl: ['requests'] },
  'hitl.appendDecision': { hitl: ['decisions'] },
  'hitl.count': { hitl: ['requests'] },
  'runs.appendEvent': { roster_ops: ['runs'] },
  'runs.getRun': { roster_ops: ['runs'] },
  'runs.listRuns': { roster_ops: ['runs'] },
  'runs.count': { roster_ops: ['runs'] },
  'artifacts.putArtifact': { roster_ops: ['artifacts'], objects: ['content-addressed', 'create-only'] },
  'artifacts.getArtifact': { roster_ops: ['artifacts'], objects: ['content-addressed'] },
  'artifacts.head': { roster_ops: ['artifacts'] },
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

// backendInfo() for the local backend: reads meta.json componentVersions
// read-only (no minting). A tree that does not exist yet reports the CLI's
// current baseline (the versions a fresh tree would be minted with); corrupt
// meta refuses loudly; a component the meta predates defaults to version 1
// (versions only ever grow — a missing key can never be a FUTURE version).
export function localBackendInfo(opsRoot: string, workspaceId: string): BackendInfo {
  if (!isUuidV4(workspaceId)) {
    throw new InvalidRecordError(`workspace id must be a UUID v4 (got '${workspaceId}')`);
  }
  assertSafeSegment('workspace id', workspaceId);
  const meta = readLedgerMeta(join(opsRoot, workspaceId), workspaceId);
  const versions = meta?.componentVersions ?? CURRENT_COMPONENT_VERSIONS;
  const components = {} as Record<OpsComponent, ComponentDescriptor>;
  for (const name of OPS_COMPONENTS) {
    const raw = versions[name];
    if (raw !== undefined && (!Number.isInteger(raw) || raw < 1)) {
      throw new InvalidRecordError(
        `meta.json componentVersions.${name} must be a positive integer (got ${String(raw)})`,
      );
    }
    components[name] = { version: raw ?? 1 };
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
