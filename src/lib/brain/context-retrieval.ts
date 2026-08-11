import type pg from 'pg';
import { RosterError } from '../errors.ts';
import type {
  ContextBrainTrustClass,
  ContextEvidenceInput,
  ContextRetrievalConfigurationReason,
  ContextRetrievalFilterReason,
  ContextRetrievalMode,
  ContextRetrievalModeStatus,
  ContextRetrievalReport,
  ContextRetrievalRequest,
  ContextRetrievalUnavailableReason,
  ContextBrainCandidate,
} from '../workspace-context.ts';
import { assertBrainExtractionRegistryOnClient } from './activation.ts';
import { loadConfig } from './config.ts';
import { deriveEmbeddingSpecId, embeddingVectorLiteral } from './embedding-index.ts';
import {
  loadBrainEmbeddingResolutionOnClient,
  resolveEmbeddingProvider,
  type EmbeddingAdapterRegistry,
  type EmbeddingProvider,
  type EmbeddingResolution,
} from './embedding-provider.ts';
import { createVerifiedBrainPool, type VerifiedBrainPool } from './workspace-authority.ts';

export const BRAIN_RUNTIME_URL_ENV = 'ROSTER_BRAIN_URL';

// The delivered-candidate cap and the per-selector per-arm cap. Together with
// MAX_CONTEXT_EVIDENCE_CANDIDATES and the 16 MiB envelope bound they are what
// keeps the whole pre-cap pool `P` on this side of the boundary.
export const TOTAL_CANDIDATE_LIMIT = 64;
export const PER_SELECTOR_ARM_LIMIT = 8;
const RRF_NUMERATOR = 1_000_000;
const MAX_QUERY_TEXT_BYTES = 32_768;
const SELECTOR_LOCAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// #370's EmbeddingResolution.reason is an unrestricted control-safe string. This
// frozen allowlist is the ONLY way a reason reaches the bundle; anything a
// third-party adapter invents becomes 'unrecognized'.
const CONFIGURATION_REASON_ALLOWLIST: ReadonlySet<string> = new Set<ContextRetrievalConfigurationReason>([
  'provider-name-invalid',
  'model-invalid',
  'unsupported-provider',
  'adapter-failed',
  'adapter-contract-violation',
  'adapter-identity-mismatch',
  'configuration-unreadable',
  'spec-unregistered',
  'spec-changed-in-snapshot',
]);

const AUTHORITY_UNAVAILABLE_REASONS: Readonly<Record<string, ContextRetrievalUnavailableReason>> = Object.freeze({
  BRAIN_WORKSPACE_MISMATCH: 'identity-mismatch',
  BRAIN_IDENTITY_UNINITIALIZED: 'identity-mismatch',
  BRAIN_DATABASE_AUTHORITY_MISMATCH: 'identity-mismatch',
  BRAIN_AUTHORITY_INVALID: 'identity-mismatch',
  BRAIN_NAMESPACE_MISMATCH: 'namespace-mismatch',
  BRAIN_MIGRATION_IN_PROGRESS: 'migration-in-progress',
  BRAIN_EXTRACTION_REGISTRY_DRIFT: 'registry-drift',
});

export type BrainRetrievalTelemetry = Readonly<{
  connectMs: number;
  embedMs: number;
  transactionMs: number;
  totalMs: number;
  armRows: Readonly<Record<ContextRetrievalMode, number>>;
  pool: number;
}>;

export type BrainRetrievalDeps = Readonly<{
  env?: NodeJS.ProcessEnv;
  adapters?: EmbeddingAdapterRegistry;
  // Test-only seam for the §5.4 projection-correlation mutation harness. The
  // label projection is the one obligation the pure assembler cannot discharge,
  // so its exact SQL must be mutable by a test that then MUST fail.
  labelProjectionSql?: string;
  createPool?: (connectionString: string, request: ContextRetrievalRequest) => VerifiedBrainPool;
}>;

function configurationReason(reason: string): ContextRetrievalConfigurationReason {
  return CONFIGURATION_REASON_ALLOWLIST.has(reason)
    ? reason as ContextRetrievalConfigurationReason
    : 'unrecognized';
}

// A resolution alone NEVER yields `used`: resolving a provider is not running an
// arm. `resolved` maps to the caller-supplied status for a provider that
// resolved but produced no executed arm, and `used` is assigned in exactly one
// place — after runEmbeddingArm returns.
function modeStatusFrom(
  resolution: EmbeddingResolution,
  resolvedButNotRun: ContextRetrievalModeStatus,
): ContextRetrievalModeStatus {
  if (resolution.status === 'resolved') return resolvedButNotRun;
  if (resolution.status === 'disabled') return { status: 'disabled' };
  if (resolution.status === 'credential-unavailable') return { status: 'credential-unavailable' };
  return { status: 'invalid-configuration', reason: configurationReason(resolution.reason) };
}

// An embed either produces a COMPLETE, usable vector or a closed reason. There
// is no third state: a thrown call, a non-array, a wrong length, or any
// non-finite component is an adapter-contract failure that drops the embedding
// arm ALONE — the lexical and structured arms proceed untouched, and the report
// can never say `used` for an arm that did not run.
type EmbedOutcome =
  | Readonly<{ status: 'not-attempted' }>
  | Readonly<{ status: 'embedded'; vector: readonly number[] }>
  | Readonly<{ status: 'failed'; reason: ContextRetrievalConfigurationReason }>;

async function embedQueryVector(
  provider: EmbeddingProvider,
  text: string,
): Promise<EmbedOutcome> {
  let vectors: unknown;
  try {
    vectors = await provider.embed([text]);
  } catch {
    return { status: 'failed', reason: 'adapter-failed' };
  }
  if (!Array.isArray(vectors) || vectors.length !== 1) {
    return { status: 'failed', reason: 'adapter-contract-violation' };
  }
  const first: unknown = vectors[0];
  if (!Array.isArray(first) || first.length !== provider.dimensions) {
    return { status: 'failed', reason: 'adapter-contract-violation' };
  }
  // Every component must be a finite number: a NaN or an Infinity would reach
  // the vector literal and abort the whole retrieval instead of one arm.
  for (const component of first as readonly unknown[]) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      return { status: 'failed', reason: 'adapter-contract-violation' };
    }
  }
  return { status: 'embedded', vector: Object.freeze([...first as readonly number[]]) };
}

function emptyFiltered(): Record<ContextRetrievalFilterReason, number> {
  return {
    superseded: 0,
    tombstoned: 0,
    'scope-ineligible': 0,
    'privacy-incompatible': 0,
    'legacy-unverified': 0,
    'extractor-inactive': 0,
  };
}

function freeze<T>(value: T): T {
  const walk = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object' || Object.isFrozen(entry)) return;
    for (const child of Object.values(entry as Record<string, unknown>)) walk(child);
    Object.freeze(entry);
  };
  walk(value);
  return value;
}

function unavailable(
  reason: ContextRetrievalUnavailableReason,
  modes: Readonly<Record<ContextRetrievalMode, ContextRetrievalModeStatus>>,
): ContextEvidenceInput {
  return freeze({
    status: 'unavailable' as const,
    candidates: [] as ContextBrainCandidate[],
    report: {
      modes,
      graph: { status: 'unavailable' as const, reasons: ['no-cited-edge-relation', 'unmeasured'] },
      filtered: emptyFiltered(),
      considered: 0,
      returned: 0,
      truncated: 0,
      required_selectors_with_matches: [] as string[],
      unavailable_reason: reason,
    },
  }) satisfies ContextEvidenceInput;
}

// No arm ran, so no mode may read `used`. The credential path has an exact
// closed value; every other unavailable cause (authority, transaction, service)
// is carried precisely by `unavailable_reason`, and the modes state only the
// mode-level truth: this arm did not run.
function unavailableModes(
  status: 'disabled' | 'credential-unavailable',
): Record<ContextRetrievalMode, ContextRetrievalModeStatus> {
  return {
    structured: { status },
    lexical: { status },
    embedding: { status },
  };
}

function unavailableReasonFor(error: unknown): ContextRetrievalUnavailableReason {
  if (error instanceof RosterError) {
    const mapped = AUTHORITY_UNAVAILABLE_REASONS[error.code];
    if (mapped !== undefined) return mapped;
  }
  return 'service-unavailable';
}

// The allowlist is a bound array of EXACT generated label_key strings. Retrieval
// can never construct a predicate that reaches a label outside it.
function labelAllowlist(request: ContextRetrievalRequest): string[] {
  return [
    'workspace',
    `function:${request.target.functionId}`,
    `agent:${request.target.functionId}/${request.target.agentId}`,
    ...request.planClosureQualifiedIds.map((qualified) => `plan:${qualified}`),
  ];
}

// websearch_to_tsquery ANDs the words of ONE segment and ORs across its literal
// `or` operator, so the segments are joined by ` or `: a chunk qualifies when it
// matches the selector id, OR one of its authored descriptions, OR the request
// text. ANDing all three would make every arm vacuous. The `or` operator and the
// segment words are the only grammar this composition uses; websearch_to_tsquery
// is total over arbitrary text, so no escaping question arises.
function boundedText(parts: readonly string[], separator = ' '): string {
  let text = parts
    .map((part) => part.replace(/[\r\n]+/gu, ' ').trim())
    .filter((part) => part.length > 0)
    .join(separator);
  while (Buffer.byteLength(text, 'utf8') > MAX_QUERY_TEXT_BYTES) {
    text = text.slice(0, Math.floor(text.length / 2));
  }
  return text;
}

// MEMBERSHIP is selector-scoped — the selector id OR any of its authored
// descriptions — so a selector that nothing is about contributes nothing to `P`
// and therefore nothing to M. Folding the request text into membership would
// make every catalog selector match whatever the request matches and turn M into
// a constant.
function selectorMembershipText(
  selector: { selector: string; descriptions: readonly string[] },
): string {
  return boundedText([selector.selector, ...selector.descriptions], ' or ');
}

// RANKING adds the request query and step hint, so within a selector's arm the
// host's request decides the order.
function selectorLexicalText(
  selector: { selector: string; descriptions: readonly string[] },
  request: ContextRetrievalRequest,
): string {
  return boundedText([
    selector.selector,
    ...selector.descriptions,
    request.query,
    request.stepHint ?? '',
  ], ' or ');
}

// Value-equality only: jsonb_path_ops hashes path-to-VALUE pairs, so a
// key-existence path is not indexable by it. The three addressable equality keys
// of a v2 structured record are `envelope`, `kind`, and `identity`.
const STRUCTURED_EQUALITY_KEYS = ['envelope', 'kind', 'identity'] as const;

function structuredJsonPaths(selector: string): string[] {
  if (!SELECTOR_LOCAL_ID.test(selector) && !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(selector)) return [];
  const literal = JSON.stringify(selector);
  return STRUCTURED_EQUALITY_KEYS.map((key) => `$.${key} ? (@ == ${literal})`);
}

const ELIGIBILITY_PREDICATE = `EXISTS (
      SELECT 1 FROM brain.source_version_labels l
       WHERE l.source_version_id = chunk_row.source_version_id
         AND l.label_key = ANY($1::text[])
    )`;

export const BRAIN_LABEL_PROJECTION_SQL = `LEFT JOIN LATERAL (
      SELECT array_agg(l2.label_key ORDER BY l2.label_key COLLATE "C") AS label_keys
        FROM brain.source_version_labels l2
       WHERE l2.source_version_id = chunk_row.source_version_id
    ) labels ON true`;

type ArmHit = { selector: string; chunkId: string; rank: number };

// `executed` is what licenses a `used` mode status: an arm with no selector to
// run for issues no statement and must not claim it did.
type ArmRun = { hits: ArmHit[]; executed: boolean };

type ProjectedChunk = {
  chunkId: string;
  sourceId: string;
  sourceVersionId: string;
  objectId: string;
  extractorName: string;
  extractorVersion: number;
  chunkIndex: number;
  content: string;
  contentSha256: string;
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
  privacyClass: 'public' | 'internal' | 'secret';
  trustClass: ContextBrainTrustClass;
  labelKeys: readonly string[];
};

async function runLexicalArm(
  client: pg.PoolClient,
  request: ContextRetrievalRequest,
  allowed: readonly string[],
): Promise<ArmRun> {
  const selectors = request.selectors.map((entry) => entry.selector);
  const membership = request.selectors.map((entry) => selectorMembershipText(entry));
  const ranking = request.selectors.map((entry) => selectorLexicalText(entry, request));
  if (selectors.length === 0) return { hits: [], executed: false };
  const result = await client.query<{ selector: string; chunk_id: string; rank_in_arm: string }>(
    `SELECT sel.selector, ranked.chunk_id, ranked.rank_in_arm::text AS rank_in_arm
       FROM unnest($2::text[], $3::text[], $6::text[]) AS sel(selector, member_text, rank_text)
       CROSS JOIN LATERAL (
         SELECT scored.chunk_id,
                row_number() OVER (ORDER BY scored.score DESC, scored.chunk_id COLLATE "C" ASC) AS rank_in_arm
           FROM (
             SELECT chunk_row.chunk_id,
                    ts_rank_cd(chunk_row.tsv, websearch_to_tsquery('english', sel.rank_text)) AS score
               FROM brain.current_source_chunks chunk_row
              WHERE chunk_row.privacy_class <> 'secret'
                AND ($4 OR chunk_row.trust_class <> 'legacy-unverified')
                AND chunk_row.tsv @@ websearch_to_tsquery('english', sel.member_text)
                AND ${ELIGIBILITY_PREDICATE}
              ORDER BY score DESC, chunk_row.chunk_id COLLATE "C" ASC
              LIMIT $5
           ) scored
       ) ranked`,
    [allowed, selectors, membership, request.includeLegacyUnverified, PER_SELECTOR_ARM_LIMIT, ranking],
  );
  return {
    executed: true,
    hits: result.rows.map((row) => ({
      selector: row.selector,
      chunkId: row.chunk_id,
      rank: Number(row.rank_in_arm),
    })),
  };
}

async function runStructuredArm(
  client: pg.PoolClient,
  request: ContextRetrievalRequest,
  allowed: readonly string[],
): Promise<ArmRun> {
  const selectors: string[] = [];
  const paths: string[] = [];
  for (const entry of request.selectors) {
    for (const path of structuredJsonPaths(entry.selector)) {
      selectors.push(entry.selector);
      paths.push(path);
    }
  }
  if (selectors.length === 0) return { hits: [], executed: false };
  const result = await client.query<{ selector: string; chunk_id: string; rank_in_arm: string }>(
    `SELECT sel.selector, ranked.chunk_id, ranked.rank_in_arm::text AS rank_in_arm
       FROM unnest($2::text[], $3::text[]) AS sel(selector, json_path)
       CROSS JOIN LATERAL (
         SELECT scored.chunk_id,
                row_number() OVER (ORDER BY scored.chunk_id COLLATE "C" ASC) AS rank_in_arm
           FROM (
             SELECT chunk_row.chunk_id
               FROM brain.current_source_chunks chunk_row
               JOIN brain.source_extractions extraction_row
                 ON extraction_row.extraction_id = chunk_row.extraction_id
              WHERE chunk_row.privacy_class <> 'secret'
                AND ($4 OR chunk_row.trust_class <> 'legacy-unverified')
                AND extraction_row.structured @? sel.json_path::jsonpath
                AND ${ELIGIBILITY_PREDICATE}
              ORDER BY chunk_row.chunk_id COLLATE "C" ASC
              LIMIT $5
           ) scored
       ) ranked`,
    [allowed, selectors, paths, request.includeLegacyUnverified, PER_SELECTOR_ARM_LIMIT],
  );
  return {
    executed: true,
    hits: result.rows.map((row) => ({
      selector: row.selector,
      chunkId: row.chunk_id,
      rank: Number(row.rank_in_arm),
    })),
  };
}

async function runEmbeddingArm(
  client: pg.PoolClient,
  request: ContextRetrievalRequest,
  allowed: readonly string[],
  vector: readonly number[],
  provider: EmbeddingProvider,
  specId: string,
): Promise<ArmHit[]> {
  const literal = embeddingVectorLiteral(vector, provider.dimensions);
  const result = await client.query<{ chunk_id: string; rank_in_arm: string }>(
    `SELECT scored.chunk_id,
            row_number() OVER (ORDER BY scored.distance ASC, scored.chunk_id COLLATE "C" ASC)::text AS rank_in_arm
       FROM (
         SELECT chunk_row.chunk_id,
                embedding_row.embedding <=> $2::vector AS distance
           FROM brain.current_source_chunks chunk_row
           JOIN brain.chunk_embeddings embedding_row
             ON embedding_row.chunk_id = chunk_row.chunk_id
            AND embedding_row.embedding_spec_id = $3
          WHERE chunk_row.privacy_class <> 'secret'
            AND ($4 OR chunk_row.trust_class <> 'legacy-unverified')
            AND ${ELIGIBILITY_PREDICATE}
          ORDER BY distance ASC, chunk_row.chunk_id COLLATE "C" ASC
          LIMIT $5
       ) scored`,
    [allowed, literal, specId, request.includeLegacyUnverified, TOTAL_CANDIDATE_LIMIT],
  );
  // The embedding arm is query-shaped, not selector-shaped: it contributes one
  // ranked list attributed to every catalog selector the other arms matched, so
  // it can raise a chunk's fusion score without inventing a selector claim.
  return result.rows.map((row) => ({
    selector: '',
    chunkId: row.chunk_id,
    rank: Number(row.rank_in_arm),
  }));
}

async function projectChunks(
  client: pg.PoolClient,
  chunkIds: readonly string[],
  labelProjectionSql: string,
): Promise<Map<string, ProjectedChunk>> {
  if (chunkIds.length === 0) return new Map();
  const result = await client.query<{
    chunk_id: string;
    source_id: string;
    source_version_id: string;
    object_id: string;
    extractor_name: string;
    extractor_version: number;
    chunk_index: number;
    content: string;
    content_sha256: string;
    byte_start: string;
    byte_end: string;
    line_start: number;
    line_end: number;
    privacy_class: string;
    trust_class: string;
    label_keys: string[] | null;
  }>(
    `SELECT chunk_row.chunk_id, chunk_row.source_id, chunk_row.source_version_id,
            chunk_row.object_id, chunk_row.extractor_name, chunk_row.extractor_version,
            chunk_row.chunk_index, chunk_row.content, chunk_row.content_sha256,
            chunk_row.byte_start::text, chunk_row.byte_end::text,
            chunk_row.line_start, chunk_row.line_end,
            chunk_row.privacy_class, chunk_row.trust_class,
            labels.label_keys
       FROM brain.current_source_chunks chunk_row
       ${labelProjectionSql}
      WHERE chunk_row.chunk_id = ANY($1::text[])
      ORDER BY chunk_row.chunk_id COLLATE "C" ASC`,
    [[...chunkIds]],
  );
  return new Map(result.rows.map((row) => [row.chunk_id, {
    chunkId: row.chunk_id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    objectId: row.object_id,
    extractorName: row.extractor_name,
    extractorVersion: row.extractor_version,
    chunkIndex: row.chunk_index,
    content: row.content,
    contentSha256: row.content_sha256,
    byteStart: Number(row.byte_start),
    byteEnd: Number(row.byte_end),
    lineStart: row.line_start,
    lineEnd: row.line_end,
    privacyClass: row.privacy_class as ProjectedChunk['privacyClass'],
    trustClass: row.trust_class as ContextBrainTrustClass,
    labelKeys: row.label_keys ?? [],
  }]));
}

// An EXACT accounting, never a selection input. Membership is the deterministic
// arms' OWN predicates: one bounded tsquery per selector (mirroring
// `runLexicalArm`'s `sel.member_text`, bounded per selector so no selector can be
// lost to a global re-bounding) UNIONed with one jsonpath per structured path
// (mirroring `runStructuredArm`). `UNION` deduplicates on chunk identity, so a
// chunk matching both arms — or many selectors — is classified and counted
// exactly once. The classification joins the BASE tables rather than
// `brain.current_source_chunks`, because counting what that view hides is the
// whole purpose. The embedding arm has no membership predicate (a distance
// ranking over every embedded chunk), so what it "would have matched" is not
// an exact count; that residue is stated in the report semantics and is
// currently vacuous while EMBEDDING_ADAPTERS is empty.
export const FILTER_ACCOUNTING_SQL = `SELECT reason, count(*)::text AS entries FROM (
       SELECT CASE
                WHEN active_row.extractor_name IS NULL THEN 'extractor-inactive'
                WHEN source_row.active_tombstone_id IS NOT NULL THEN 'tombstoned'
                WHEN source_row.current_version_id IS DISTINCT FROM version_row.source_version_id
                  THEN 'superseded'
                WHEN version_row.privacy_class = 'secret' THEN 'privacy-incompatible'
                WHEN version_row.trust_class = 'legacy-unverified' AND NOT $4
                  THEN 'legacy-unverified'
                WHEN NOT EXISTS (
                       SELECT 1 FROM brain.source_version_labels l
                        WHERE l.source_version_id = chunk_row.source_version_id
                          AND l.label_key = ANY($1::text[])
                     ) THEN 'scope-ineligible'
                ELSE NULL
              END AS reason
         FROM (
           SELECT member_chunk.chunk_id
             FROM unnest($2::text[]) AS sel(member_text)
             JOIN brain.source_chunks member_chunk
               ON member_chunk.tsv @@ websearch_to_tsquery('english', sel.member_text)
           UNION
           SELECT member_chunk.chunk_id
             FROM unnest($3::text[]) AS sel(json_path)
             JOIN brain.source_extractions member_extraction
               ON member_extraction.structured @? sel.json_path::jsonpath
             JOIN brain.source_chunks member_chunk
               ON member_chunk.extraction_id = member_extraction.extraction_id
         ) member
         JOIN brain.source_chunks chunk_row
           ON chunk_row.chunk_id = member.chunk_id
         JOIN brain.source_extractions extraction_row
           ON extraction_row.extraction_id = chunk_row.extraction_id
          AND extraction_row.status = 'complete'
         JOIN brain.source_versions version_row
           ON version_row.source_version_id = extraction_row.source_version_id
         JOIN brain.logical_sources source_row
           ON source_row.source_id = version_row.source_id
         LEFT JOIN brain.active_extractors active_row
           ON active_row.extractor_name = extraction_row.extractor_name
          AND active_row.active_version = extraction_row.extractor_version
     ) accounted
      WHERE reason IS NOT NULL
      GROUP BY reason`;

async function accountFiltering(
  client: pg.PoolClient,
  request: ContextRetrievalRequest,
  allowed: readonly string[],
): Promise<Record<ContextRetrievalFilterReason, number>> {
  const filtered = emptyFiltered();
  const membership = request.selectors
    .map((entry) => selectorMembershipText(entry))
    .filter((entry) => entry.length > 0);
  const paths = request.selectors.flatMap((entry) => structuredJsonPaths(entry.selector));
  if (membership.length === 0 && paths.length === 0) return filtered;
  const result = await client.query<{ reason: string; entries: string }>(
    FILTER_ACCOUNTING_SQL,
    [allowed, membership, paths, request.includeLegacyUnverified],
  );
  for (const row of result.rows) {
    if (Object.hasOwn(filtered, row.reason)) {
      filtered[row.reason as ContextRetrievalFilterReason] = Number(row.entries);
    }
  }
  return filtered;
}

// Ranking keys only: the chunk body is fetched after selection.
type PoolEntry = {
  chunkId: string;
  selectors: string[];
  modes: Set<ContextRetrievalMode>;
  bestRank: number;
  fused: number;
};

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  while (true) {
    const leftPoint = leftPoints.next();
    const rightPoint = rightPoints.next();
    if (leftPoint.done || rightPoint.done) {
      if (leftPoint.done === rightPoint.done) return 0;
      return leftPoint.done ? -1 : 1;
    }
    const difference = leftPoint.value.codePointAt(0)! - rightPoint.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

// The global key K. Normative in JS; every SQL text ordering additionally uses
// COLLATE "C" so the database collation can never disagree with it.
function compareGlobalKey(
  left: PoolEntry,
  right: PoolEntry,
  required: ReadonlySet<string>,
): number {
  const leftRequired = left.selectors.some((entry) => required.has(entry)) ? 1 : 0;
  const rightRequired = right.selectors.some((entry) => required.has(entry)) ? 1 : 0;
  return rightRequired - leftRequired
    || right.fused - left.fused
    || left.bestRank - right.bestRank
    || compareUnicodeCodePoints(left.selectors[0] ?? '', right.selectors[0] ?? '')
    || compareUnicodeCodePoints(left.chunkId, right.chunkId);
}

function narrowestScopeClaim(
  labelKeys: readonly string[],
  allowed: ReadonlySet<string>,
  workspaceId: string,
): ContextBrainCandidate['scope'] {
  let winner: string | null = null;
  let winnerSpecificity = -1;
  for (const labelKey of labelKeys) {
    if (!allowed.has(labelKey)) continue;
    const specificity = labelKey === 'workspace'
      ? 0
      : labelKey.startsWith('function:')
        ? 1
        : labelKey.startsWith('agent:') ? 2 : 3;
    if (specificity > winnerSpecificity
      || (specificity === winnerSpecificity
        && winner !== null
        && compareUnicodeCodePoints(labelKey, winner) < 0)) {
      winner = labelKey;
      winnerSpecificity = specificity;
    }
  }
  if (winner === null || winner === 'workspace') return { workspace: workspaceId };
  if (winner.startsWith('function:')) {
    return { workspace: workspaceId, function: winner.slice('function:'.length) };
  }
  if (winner.startsWith('agent:')) {
    const [functionId, agentId] = winner.slice('agent:'.length).split('/');
    return { workspace: workspaceId, function: functionId!, agent: agentId! };
  }
  const [owner, planId] = winner.slice('plan:'.length).split('#');
  const [functionId, agentId] = owner!.split('/');
  return { workspace: workspaceId, function: functionId!, agent: agentId!, plan: planId! };
}

function candidateFrom(
  entry: PoolEntry,
  chunk: ProjectedChunk,
  rank: number,
  allowed: ReadonlySet<string>,
  workspaceId: string,
): ContextBrainCandidate {
  // The locator must say TRUTHFULLY what its region denotes. `roster-text`
  // chunks ARE a byte slice of the immutable object, so `@bytes:` promises an
  // exact re-slice: the range hashes to content_hash. `roster-structured`
  // chunks are a RENDERED projection of the whole JSON document — extractors.ts
  // deliberately assigns every such chunk the document's full range, because a
  // projection is not a slice — so claiming `@bytes:` there would be a false
  // provenance claim. Those carry `@object:` instead: the region is the exact
  // citable SOURCE region the projection was derived from, while content_hash
  // continues to cover the rendered content.
  const region = chunk.extractorName === 'roster-structured' ? 'object' : 'bytes';
  const locator = `chunk:${chunk.chunkId}#${chunk.chunkIndex}`
    + `@${region}:${chunk.byteStart}-${chunk.byteEnd};lines:${chunk.lineStart}-${chunk.lineEnd}`;
  return {
    candidate_id: chunk.chunkId,
    selectors: [...entry.selectors].sort(compareUnicodeCodePoints),
    label_keys: [...chunk.labelKeys],
    scope: narrowestScopeClaim(chunk.labelKeys, allowed, workspaceId),
    content: chunk.content,
    current: true,
    tombstoned: false,
    privacy: chunk.privacyClass,
    trust: chunk.trustClass,
    retrieval_modes: (['structured', 'lexical', 'embedding'] as const)
      .filter((mode) => entry.modes.has(mode)),
    retrieval_rank: rank,
    citation: {
      logical_source_id: chunk.sourceId,
      source_version_id: chunk.sourceVersionId,
      object_id: chunk.objectId,
      extractor_id: chunk.extractorName,
      extractor_version: String(chunk.extractorVersion),
      locator,
      content_hash: `sha256:${chunk.contentSha256}`,
    },
  };
}

// §6.1 — reservation with coverage tracking, then fill, then ordinals. A
// selector already covered by a reserved candidate consumes no further slot.
function selectDelivered(
  pool: readonly PoolEntry[],
  matchedRequired: readonly string[],
  required: ReadonlySet<string>,
): PoolEntry[] {
  const ordered = [...pool].sort((left, right) => compareGlobalKey(left, right, required));
  const byId = new Map(ordered.map((entry) => [entry.chunkId, entry]));
  const reserved: PoolEntry[] = [];
  const reservedId = new Set<string>();
  const covered = new Set<string>();
  for (const selector of matchedRequired) {
    if (covered.has(selector)) continue;
    if (reserved.length === TOTAL_CANDIDATE_LIMIT) break;
    const pick = ordered.find((entry) => (
      entry.selectors.includes(selector) && !reservedId.has(entry.chunkId)
    ));
    if (pick === undefined) continue;
    // Provably vacuous: reserving `pick` credits every required selector it
    // carries, so every later selector it could serve `continue`s first.
    if (reservedId.has(pick.chunkId)) {
      throw new Error('roster: reservation pass reused an already-reserved candidate');
    }
    reserved.push(pick);
    reservedId.add(pick.chunkId);
    for (const carried of pick.selectors) if (required.has(carried)) covered.add(carried);
  }
  const delivered = [...reserved];
  for (const entry of ordered) {
    if (delivered.length >= TOTAL_CANDIDATE_LIMIT) break;
    if (reservedId.has(entry.chunkId)) continue;
    delivered.push(entry);
    reservedId.add(entry.chunkId);
  }
  void byId;
  // Reservation affects membership, never order.
  return delivered.sort((left, right) => compareGlobalKey(left, right, required));
}

async function retrieveOnClient(
  client: pg.PoolClient,
  request: ContextRetrievalRequest,
  deps: BrainRetrievalDeps,
  preResolution: EmbeddingResolution,
  embedded: EmbedOutcome,
): Promise<{ evidence: ContextEvidenceInput; armRows: Record<ContextRetrievalMode, number> }> {
  const allowed = labelAllowlist(request);
  const allowedSet = new Set(allowed);
  const armRows: Record<ContextRetrievalMode, number> = { structured: 0, lexical: 0, embedding: 0 };
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await assertBrainExtractionRegistryOnClient(client);
    const configuration = await loadConfig(client);
    const rrfK = Number.isSafeInteger(configuration.rrfK) && configuration.rrfK >= 1
      ? configuration.rrfK
      : 60;
    const transactionResolution = await loadBrainEmbeddingResolutionOnClient(client, {
      ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });
    // The mode status derives from what ACTUALLY happened, never from a
    // resolution alone. `used` is assigned in exactly one place — after the arm
    // executes — so no path can claim an arm that never ran:
    //   failed embed        -> the closed embed reason
    //   no embed attempted  -> the PRE-READ's status, because that is what
    //                          blocked the call (an in-transaction resolution
    //                          cannot retroactively make an uncalled provider
    //                          `used`)
    //   embedded            -> provisionally a contract violation, replaced by a
    //                          precise reason below or upgraded to `used` only
    //                          once runEmbeddingArm returns.
    const notRun: ContextRetrievalModeStatus = {
      status: 'invalid-configuration',
      reason: 'adapter-contract-violation',
    };
    let embeddingStatus: ContextRetrievalModeStatus = embedded.status === 'failed'
      ? { status: 'invalid-configuration', reason: embedded.reason }
      : embedded.status === 'not-attempted'
        ? modeStatusFrom(preResolution, notRun)
        : modeStatusFrom(transactionResolution, notRun);
    let embeddingSpecId: string | null = null;
    const vector = embedded.status === 'embedded' ? embedded.vector : null;
    if (vector !== null
      && preResolution.status === 'resolved'
      && transactionResolution.status === 'resolved') {
      const before = preResolution.provider;
      const after = transactionResolution.provider;
      if (before.provider !== after.provider
        || before.model !== after.model
        || before.dimensions !== after.dimensions
        || before.specVersion !== after.specVersion) {
        embeddingStatus = { status: 'invalid-configuration', reason: 'spec-changed-in-snapshot' };
      } else {
        const specId = deriveEmbeddingSpecId(after);
        const registered = await client.query<{ embedding_spec_id: string }>(
          `SELECT embedding_spec_id FROM brain.embedding_indexes WHERE embedding_spec_id = $1`,
          [specId],
        );
        if (registered.rows.length === 0) {
          embeddingStatus = { status: 'invalid-configuration', reason: 'spec-unregistered' };
        } else {
          embeddingSpecId = specId;
        }
      }
    } else if (vector !== null && transactionResolution.status === 'resolved') {
      embeddingStatus = { status: 'invalid-configuration', reason: 'spec-changed-in-snapshot' };
    }

    const structuredRun = await runStructuredArm(client, request, allowed);
    const lexicalRun = await runLexicalArm(client, request, allowed);
    const structuredHits = structuredRun.hits;
    const lexicalHits = lexicalRun.hits;
    let embeddingHits: ArmHit[] = [];
    if (embeddingSpecId !== null && vector !== null && transactionResolution.status === 'resolved') {
      // Arm-local containment through a SAVEPOINT, not a new transaction: a
      // statement error would otherwise abort the whole transaction and take the
      // already-computed lexical and structured evidence down with it, and
      // ROLLBACK + BEGIN would silently start a SECOND snapshot and break §7's
      // one-snapshot guarantee. ROLLBACK TO SAVEPOINT keeps the original one.
      await client.query('SAVEPOINT roster_embedding_arm');
      try {
        embeddingHits = await runEmbeddingArm(
          client,
          request,
          allowed,
          vector,
          transactionResolution.provider,
          embeddingSpecId,
        );
        await client.query('RELEASE SAVEPOINT roster_embedding_arm');
        embeddingStatus = { status: 'used' };
      } catch {
        await client.query('ROLLBACK TO SAVEPOINT roster_embedding_arm');
        await client.query('RELEASE SAVEPOINT roster_embedding_arm');
        embeddingStatus = { status: 'invalid-configuration', reason: 'adapter-contract-violation' };
        embeddingHits = [];
      }
    }
    armRows.structured = structuredHits.length;
    armRows.lexical = lexicalHits.length;
    armRows.embedding = embeddingHits.length;

    const filtered = await accountFiltering(client, request, allowed);

    const perArm: Array<{ mode: ContextRetrievalMode; hits: readonly ArmHit[] }> = [
      { mode: 'structured', hits: structuredHits },
      { mode: 'lexical', hits: lexicalHits },
      { mode: 'embedding', hits: embeddingHits },
    ];
    const selectorsByChunk = new Map<string, Set<string>>();
    const modesByChunk = new Map<string, Set<ContextRetrievalMode>>();
    const bestRankByChunkArm = new Map<string, number>();
    for (const arm of perArm) {
      for (const hit of arm.hits) {
        if (hit.selector.length > 0) {
          const selectors = selectorsByChunk.get(hit.chunkId) ?? new Set<string>();
          selectors.add(hit.selector);
          selectorsByChunk.set(hit.chunkId, selectors);
        }
        const modes = modesByChunk.get(hit.chunkId) ?? new Set<ContextRetrievalMode>();
        modes.add(arm.mode);
        modesByChunk.set(hit.chunkId, modes);
        const key = `${arm.mode}\u0000${hit.chunkId}`;
        const current = bestRankByChunkArm.get(key);
        if (current === undefined || hit.rank < current) bestRankByChunkArm.set(key, hit.rank);
      }
    }
    // A chunk reached only by the query-shaped embedding arm carries no selector
    // claim and is not admissible evidence for any authored selector.
    const chunkIds = [...selectorsByChunk.keys()].sort(compareUnicodeCodePoints);

    // The pool carries ONLY ranking keys — no content, no labels. Selection
    // needs the global key `K` (required-ness, fused score, best arm rank,
    // selectors, chunk id) and nothing else, so the memory the pre-cap pool
    // holds is bounded by the arm-hit metadata rather than by chunk bodies.
    const pool: PoolEntry[] = [];
    for (const chunkId of chunkIds) {
      const selectors = [...selectorsByChunk.get(chunkId)!].sort(compareUnicodeCodePoints);
      const modes = modesByChunk.get(chunkId) ?? new Set<ContextRetrievalMode>();
      let fused = 0;
      let bestRank = Number.MAX_SAFE_INTEGER;
      for (const arm of perArm) {
        const rank = bestRankByChunkArm.get(`${arm.mode}\u0000${chunkId}`);
        if (rank === undefined) continue;
        fused += Math.floor(RRF_NUMERATOR / (rrfK + rank));
        if (rank < bestRank) bestRank = rank;
      }
      pool.push({ chunkId, selectors, modes, bestRank, fused });
    }

    const required = new Set(request.selectors
      .filter((entry) => entry.required)
      .map((entry) => entry.selector));
    // M — the ONE quantity the assembler provably cannot recompute, because `P`
    // never crosses the boundary. It is derived from the pool's selector sets,
    // which is why the pool must span the whole pre-cap arm output.
    const matchedRequired = [...new Set(pool.flatMap((entry) => (
      entry.selectors.filter((selector) => required.has(selector))
    )))].sort(compareUnicodeCodePoints);

    const delivered = selectDelivered(pool, matchedRequired, required);
    // Content and labels are projected for the POST-SELECTION set only, so at
    // most TOTAL_CANDIDATE_LIMIT chunk bodies are ever materialized regardless
    // of how large the arm pool was.
    const projected = await projectChunks(
      client,
      delivered.map((entry) => entry.chunkId),
      deps.labelProjectionSql ?? BRAIN_LABEL_PROJECTION_SQL,
    );
    await client.query('COMMIT');

    const candidates = delivered
      .flatMap((entry) => {
        const chunk = projected.get(entry.chunkId);
        return chunk === undefined ? [] : [{ entry, chunk }];
      })
      .map(({ entry, chunk }, index) => (
        candidateFrom(entry, chunk, index, allowedSet, request.workspaceId)
      ));

    // Adapter-side containment: { required selectors on delivered } ⊆ M. The
    // envelope re-checks the same containment as V3, so a violation is a caught
    // defect rather than a silent mislabel.
    const matchedSet = new Set(matchedRequired);
    for (const candidate of candidates) {
      for (const selector of candidate.selectors) {
        if (required.has(selector) && !matchedSet.has(selector)) {
          throw new Error('roster: delivered candidate carries a required selector absent from M');
        }
      }
    }

    // `used` is assigned in exactly three places — one per arm — and only after
    // that arm actually executed a statement.
    const modes: Record<ContextRetrievalMode, ContextRetrievalModeStatus> = {
      structured: structuredRun.executed ? { status: 'used' } : { status: 'disabled' },
      lexical: lexicalRun.executed ? { status: 'used' } : { status: 'disabled' },
      embedding: embeddingStatus,
    };
    const report: ContextRetrievalReport = {
      modes,
      graph: { status: 'unavailable', reasons: ['no-cited-edge-relation', 'unmeasured'] },
      filtered,
      considered: pool.length,
      returned: candidates.length,
      truncated: Math.max(0, pool.length - candidates.length),
      required_selectors_with_matches: matchedRequired,
      unavailable_reason: null,
    };
    return {
      evidence: freeze({ status: 'available' as const, candidates, report }),
      armRows,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export async function retrieveBrainContextEvidenceWithTelemetry(
  request: ContextRetrievalRequest,
  deps: BrainRetrievalDeps = {},
): Promise<{ evidence: ContextEvidenceInput; telemetry: BrainRetrievalTelemetry }> {
  const env = deps.env ?? process.env;
  const started = Date.now();
  const armRows: Record<ContextRetrievalMode, number> = { structured: 0, lexical: 0, embedding: 0 };
  const telemetryOf = (connectMs: number, embedMs: number, transactionMs: number, pool: number)
  : BrainRetrievalTelemetry => Object.freeze({
    connectMs,
    embedMs,
    transactionMs,
    totalMs: Date.now() - started,
    armRows: Object.freeze({ ...armRows }),
    pool,
  });
  const connectionString = env[BRAIN_RUNTIME_URL_ENV];
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    return {
      evidence: unavailable('credential-unavailable', unavailableModes('credential-unavailable')),
      telemetry: telemetryOf(0, 0, 0, 0),
    };
  }
  const pool = deps.createPool === undefined
    ? createVerifiedBrainPool({ connectionString, authority: request.brainAuthority })
    : deps.createPool(connectionString, request);
  const connectStarted = Date.now();
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    await pool.end().catch(() => undefined);
    return {
      evidence: unavailable(unavailableReasonFor(error), unavailableModes('disabled')),
      telemetry: telemetryOf(Date.now() - connectStarted, 0, 0, 0),
    };
  }
  const connectMs = Date.now() - connectStarted;
  let embedMs = 0;
  let transactionMs = 0;
  try {
    const preConfiguration = await loadConfig(client);
    const preResolution = resolveEmbeddingProvider(preConfiguration, {
      ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });
    let embedded: EmbedOutcome = { status: 'not-attempted' };
    if (preResolution.status === 'resolved') {
      // Deliberately OUTSIDE the transaction: an external provider call must
      // never hold a snapshot open.
      const embedStarted = Date.now();
      const text = boundedText([
        ...request.selectors.map((entry) => entry.selector),
        request.query,
        request.stepHint ?? '',
      ], ' ');
      embedded = await embedQueryVector(preResolution.provider, text);
      embedMs = Date.now() - embedStarted;
    }
    const transactionStarted = Date.now();
    const result = await retrieveOnClient(client, request, deps, preResolution, embedded);
    transactionMs = Date.now() - transactionStarted;
    armRows.structured = result.armRows.structured;
    armRows.lexical = result.armRows.lexical;
    armRows.embedding = result.armRows.embedding;
    return {
      evidence: result.evidence,
      telemetry: telemetryOf(connectMs, embedMs, transactionMs, result.evidence.report.considered),
    };
  } catch (error) {
    return {
      evidence: unavailable(unavailableReasonFor(error), unavailableModes('disabled')),
      telemetry: telemetryOf(connectMs, embedMs, transactionMs, 0),
    };
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

export async function retrieveBrainContextEvidence(
  request: ContextRetrievalRequest,
  deps: BrainRetrievalDeps = {},
): Promise<ContextEvidenceInput> {
  const { evidence } = await retrieveBrainContextEvidenceWithTelemetry(request, deps);
  return evidence;
}
