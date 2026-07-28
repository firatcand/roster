import type { ArtifactDeclaration, ArtifactRecord, RunEventEnvelope } from './contracts.ts';
import { promotesExternalSuccess, promotesLifecycle, type RunEventSource } from './run-events.ts';

// Deterministic read-time composition of a run (#323 section B). Folds the raw
// event stream + artifact declarations into a single view that HONORS the trust
// taxonomy: a lifecycle fact (start/end/exit status + timestamps) is promoted
// ONLY from a trusted source ('cli' | 'host-attested'); a "successful external
// action" ONLY from a 'host-attested', correlated tool result; agent report
// prose is ALWAYS rendered unverified and never parsed for success. Duration is
// DERIVED here (ended_at − started_at) from the observation columns, never a
// materialized field — so a retry can never change it. A crafted agent-source
// event therefore cannot masquerade as host/lifecycle truth.

export type RunStatus = 'unknown' | 'running' | 'completed' | 'errored';

export type ComposedLifecycle = {
  status: RunStatus;
  startedAt: number | null;
  endedAt: number | null;
};

export type ComposedReport = {
  // The raw report data (unverified narrative — never parsed for success).
  data: unknown;
  // The internally-produced sanitized projection (safe index input).
  sanitizedText: string | null;
  source: RunEventSource;
  // Report prose is ALWAYS unverified, regardless of the claimed source.
  verified: false;
} | null;

export type ComposedToolCall = {
  correlationId: string;
  call: RunEventEnvelope | null;
  result: RunEventEnvelope | null;
  // A "successful external action" is promoted ONLY from a host-attested,
  // correlated tool result (#322). A 'cli'/'agent' result stays unverified.
  externalSuccessPromoted: boolean;
};

export type ComposedArtifactState = 'resolved' | 'pending' | 'external';

export type ComposedArtifact = {
  declaration: ArtifactDeclaration;
  // The resolved content blob (internal, committed); null while pending/external.
  blob: ArtifactRecord | null;
  state: ComposedArtifactState;
  verified: boolean;
};

export type ComposedRun = {
  runId: string;
  lifecycle: ComposedLifecycle;
  report: ComposedReport;
  toolCalls: ComposedToolCall[];
  artifacts: ComposedArtifact[];
  approvals: RunEventEnvelope[];
  errors: RunEventEnvelope[];
  retries: RunEventEnvelope[];
  // ended_at − started_at from the trusted lifecycle observations; null unless
  // BOTH a trusted run-start and run-end contributed a timestamp.
  durationDerived: number | null;
};

// Resolves an internal declaration's digest to a committed content blob (or null
// when the blob is not yet committed — the artifact renders 'pending' and
// converges once the blob lands). May be sync or async.
export type BlobResolver = (digest: string) => ArtifactRecord | null | Promise<ArtifactRecord | null>;

function firstTrusted(events: RunEventEnvelope[], kind: string): RunEventEnvelope | undefined {
  return events.find((e) => e.kind === kind && promotesLifecycle(e.source));
}

// Fail-closed structured success gate (finding: {success:true,status:'failed'}
// and {ok:true,errors:[...]} were promoted). A "successful external action" is
// promoted ONLY on a conservative allowlist: the LITERAL `ok === true`, with NO
// error signal of any shape. `success` is NOT accepted as a positive (only the
// explicit `ok` contract), and the presence of ANY of {error, errors,
// status ∈ failed/error/denied} rejects. A result whose shape is unknown until
// #322 finalizes the schema is NOT promoted; prose/strings/nulls never promote.
const FAILURE_STATUSES: ReadonlySet<string> = new Set(['failed', 'error', 'denied']);

function isTruthySignal(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && value !== false && value !== '';
}

function isStructuredSuccess(data: unknown): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  // Require the explicit ok:true contract — `success:true` alone never promotes.
  if (d.ok !== true) return false;
  // Reject on ANY error signal: singular `error`, an `errors` array/value, or a
  // failure `status`.
  if (isTruthySignal(d.error)) return false;
  if (isTruthySignal(d.errors)) return false;
  if (typeof d.status === 'string' && FAILURE_STATUSES.has(d.status.toLowerCase())) return false;
  return true;
}

export async function composeRun(
  runId: string,
  events: RunEventEnvelope[],
  declarations: ArtifactDeclaration[],
  blobResolver: BlobResolver,
): Promise<ComposedRun> {
  const ordered = [...events].sort((a, b) => {
    const sa = a.seq ?? Number.MAX_SAFE_INTEGER;
    const sb = b.seq ?? Number.MAX_SAFE_INTEGER;
    return sa === sb ? a.createdAt - b.createdAt : sa - sb;
  });

  // ---- lifecycle (trusted sources only) ----
  const start = firstTrusted(ordered, 'run-start');
  const end = firstTrusted(ordered, 'run-end');
  const errored = ordered.some((e) => e.kind === 'error' && promotesLifecycle(e.source));
  const status: RunStatus = errored ? 'errored' : end ? 'completed' : start ? 'running' : 'unknown';
  const startedAt = start?.startedAt ?? null;
  const endedAt = end?.endedAt ?? null;
  const durationDerived = startedAt !== null && endedAt !== null ? endedAt - startedAt : null;
  const lifecycle: ComposedLifecycle = { status, startedAt, endedAt };

  // ---- report (agent prose, always unverified) ----
  const reportEvent = ordered.find((e) => e.kind === 'report');
  const report: ComposedReport = reportEvent
    ? { data: reportEvent.data, sanitizedText: reportEvent.sanitizedReport, source: reportEvent.source, verified: false }
    : null;

  // ---- tool calls (host-attested-correlated for success) ----
  const byCorrelation = new Map<string, ComposedToolCall>();
  for (const e of ordered) {
    if (e.kind !== 'tool-call' && e.kind !== 'tool-result') continue;
    const key = e.correlationId ?? e.dedupeKey;
    let tc = byCorrelation.get(key);
    if (tc === undefined) {
      tc = { correlationId: key, call: null, result: null, externalSuccessPromoted: false };
      byCorrelation.set(key, tc);
    }
    if (e.kind === 'tool-call') tc.call = e;
    else tc.result = e;
  }
  const toolCalls = [...byCorrelation.values()].map((tc) => ({
    ...tc,
    externalSuccessPromoted:
      tc.call !== null &&
      tc.result !== null &&
      promotesExternalSuccess(tc.result.source) &&
      isStructuredSuccess(tc.result.data),
  }));

  // ---- artifacts (declarations resolved to blobs/externals) ----
  const artifacts: ComposedArtifact[] = [];
  for (const declaration of declarations) {
    if (declaration.kind === 'external') {
      artifacts.push({ declaration, blob: null, state: 'external', verified: declaration.verified });
      continue;
    }
    const blob = declaration.digest === null ? null : await blobResolver(declaration.digest);
    if (blob === null) {
      // Blob not yet committed (queued) — pending, converges once it lands.
      artifacts.push({ declaration, blob: null, state: 'pending', verified: false });
    } else {
      artifacts.push({ declaration, blob, state: 'resolved', verified: declaration.verified });
    }
  }

  return {
    runId,
    lifecycle,
    report,
    toolCalls,
    artifacts,
    approvals: ordered.filter((e) => e.kind === 'approval-ref'),
    errors: ordered.filter((e) => e.kind === 'error'),
    retries: ordered.filter((e) => e.kind === 'retry'),
    durationDerived,
  };
}
