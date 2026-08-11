import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BRAIN_RUNTIME_URL_ENV,
  PER_SELECTOR_ARM_LIMIT,
  TOTAL_CANDIDATE_LIMIT,
  retrieveBrainContextEvidenceWithTelemetry,
} from '../../src/lib/brain/context-retrieval.ts';
import { setConfig } from '../../src/lib/brain/config.ts';
import { deriveChunkId, deriveExtractionId } from '../../src/lib/brain/extractors.ts';
import { deriveEmbeddingSpecId } from '../../src/lib/brain/embedding-index.ts';
import type { EmbeddingAdapterRegistry } from '../../src/lib/brain/embedding-provider.ts';
import { tombstoneBrainSource } from '../../src/lib/brain/source-lifecycle.ts';
import { createVerifiedBrainPool, type VerifiedBrainPool } from '../../src/lib/brain/workspace-authority.ts';
import {
  CONTEXT_RETRIEVAL_FILTER_REASONS,
  type ContextBrainCandidate,
  type ContextRetrievalFilterReason,
  type ContextRetrievalRequest,
} from '../../src/lib/workspace-context.ts';
import {
  createRetrievalCorpus,
  ingestCorpusSource,
  insertMergeFixtureEntities,
  type RetrievalCorpus,
} from './brain-retrieval-corpus.ts';
import {
  createMinioBrainObjectStore,
  freshMinioBucketName,
  minioBrainConfig,
} from './minio-brain-object-store.ts';
import {
  GATE_FAMILIES,
  GOLD_MISS_CLASSES,
  REPOSITORY_ROOT,
  RETRIEVAL_GOLD_WORKSPACE_ID,
  collapseToVersions,
  goldMediaType,
  goldRawBody,
  goldRevisions,
  macroAverage,
  ndcgAt,
  oracleHeadroomAt,
  precisionAt,
  recallAt,
  reciprocalRank,
  roundMetric,
  type GoldMissClass,
  type GoldQuery,
  type GoldQueryFamily,
  type GoldSelector,
  type GoldSet,
} from './retrieval-gold.ts';

export const K_VALUES = [8, 10, 64] as const;
export const BUDGET_TOKENS = 12_000;
export const LATENCY_BUDGET_MS = 2_000;
export const MANIFEST_SCHEMA_VERSION = 1;

// The manifest positions that legitimately differ between two independent
// rebuilds of the same commit. Every other position must compare equal.
export const MANIFEST_COMPARISON_EXCLUSIONS: readonly string[] = Object.freeze([
  '/generated_at',
  '/environment',
  '/timings',
  '/tiers/memory/timings',
  '/tiers/minio/timings',
]);

export const HARNESS_FILES: readonly string[] = Object.freeze([
  'test/support/retrieval-gold.ts',
  'test/support/retrieval-eval-runner.ts',
  'test/support/minio-brain-object-store.ts',
  'scripts/retrieval-eval-report.ts',
]);

export type EvalTier = 'memory' | 'minio';

export type GateResult = Readonly<{ name: string; ok: boolean; detail: string }>;

export type QueryMeasurement = Readonly<{
  id: string;
  family: GoldQueryFamily;
  gated: boolean;
  considered: number;
  returned: number;
  truncated: number;
  delivered_versions: number;
  arm_rows: Readonly<Record<'structured' | 'lexical' | 'embedding', number>>;
  relevant: number;
  membership_misses: number;
  recall_at: Readonly<Record<string, number>>;
  joint_recall_at: Readonly<Record<string, number>>;
  precision_at: Readonly<Record<string, number>>;
  reciprocal_rank: number;
  ndcg_at_10: number;
  headroom_at: Readonly<Record<string, number>>;
  filtered: Readonly<Record<ContextRetrievalFilterReason, number>>;
  expected_filtered: Readonly<Record<ContextRetrievalFilterReason, number>>;
  exclusion_correct: boolean;
  deterministic: boolean;
  contract_violations: readonly string[];
}>;

export type FamilyMeasurement = Readonly<{
  family: GoldQueryFamily;
  gated: boolean;
  queries: number;
  recall_at: Readonly<Record<string, number>>;
  joint_recall_at: Readonly<Record<string, number>>;
  precision_at: Readonly<Record<string, number>>;
  mrr: number;
  ndcg_at_10: number;
  headroom_at: Readonly<Record<string, number>>;
  max_truncated: number;
}>;

export type AliasOracleRow = Readonly<{
  query: string;
  miss_class: GoldMissClass;
  expansions: number;
  baseline_joint_recall_at_64: number;
  oracle_joint_recall_at_64: number;
  delta: number;
  recovered: boolean;
}>;

export type MultiRecordRow = Readonly<{
  query: string;
  anchor_recall_at_64: number;
  joint_recall_at_64: number;
  gap: number;
}>;

// Deterministic cost counters only. The arm's wall-clock samples live in the
// tier's `timings` section, which the rebuild comparison excludes.
export type EmbeddingMechanics = Readonly<{
  status: 'measured' | 'skipped-no-vector-extension';
  embed_invocations: number;
  stored_vectors: number;
  bytes_embedded: number;
  embedding_arm_rows: number;
  delivered_set_changed: boolean;
  truncated: number;
}>;

export type SelfCheckRow = Readonly<{
  selector: string;
  lexical_matches: number;
  structured_matches: number;
  union_matches: number;
  within_arm_limit: boolean;
}>;

export type TierResult = Readonly<{
  tier: EvalTier;
  ingest: Readonly<{
    logical_sources: number;
    versions: number;
    objects: number;
    active_chunks: number;
    inactive_chunks: number;
    entities: number;
    aliases: number;
  }>;
  queries: readonly QueryMeasurement[];
  families: readonly FamilyMeasurement[];
  citations: Readonly<{
    delivered: number;
    complete: number;
    completeness: number;
    text_byte_reslices: number;
    structured_object_proofs: number;
  }>;
  privacy: Readonly<{
    secret_candidates: number;
    legacy_unverified_without_optin: number;
  }>;
  graph_unavailable_everywhere: boolean;
  // Deterministic cost proxy: how many statements one retrieval issues on each
  // family's representative query. Counted, not asserted.
  statements_per_family: Readonly<Record<string, number>>;
  alias_oracle: readonly AliasOracleRow[];
  multi_record: readonly MultiRecordRow[];
  embedding_mechanics: EmbeddingMechanics;
  self_check: readonly SelfCheckRow[];
  gates: readonly GateResult[];
  timings: Readonly<{
    per_family_max_of_five_ms: Readonly<Record<string, number>>;
    connect_ms_samples: readonly number[];
    ingest_ms: number;
    evaluation_ms: number;
    embedding_arm_total_ms: number;
    embedding_embed_ms: number;
    p95_transaction_ms: number;
    p95_samples: number;
  }>;
}>;

type IngestedRevision = {
  fixtureVersionKey: string;
  sourceStableKey: string;
  sourceId: string;
  sourceVersionId: string;
  objectId: string;
  objectBytes: number;
  activeChunkIds: string[];
  inactiveChunkIds: string[];
};

const EMPTY_FILTERED = (): Record<ContextRetrievalFilterReason, number> => ({
  superseded: 0,
  tombstoned: 0,
  'scope-ineligible': 0,
  'privacy-incompatible': 0,
  'legacy-unverified': 0,
  'extractor-inactive': 0,
});

const SELECTOR_LOCAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// The exact pair the cited engine hard-codes at context-retrieval.ts:169 and
// :922. The report claims graph expansion is unavailable with THESE reasons, so
// the gate proves the reasons and not only the status.
const GRAPH_UNAVAILABLE_REASONS = JSON.stringify(['no-cited-edge-relation', 'unmeasured'].sort());

// Mirrors `selectorMembershipText` / `structuredJsonPaths` in
// src/lib/brain/context-retrieval.ts (lines 235-264). The engine does not export
// them; the authoring self-check needs the same predicates to prove a fixture is
// reachable or unreachable BEFORE a family is trusted as evidence.
function membershipText(selector: GoldSelector): string {
  return [selector.selector, ...selector.descriptions]
    .map((part) => part.replace(/[\r\n]+/gu, ' ').trim())
    .filter((part) => part.length > 0)
    .join(' or ');
}

function structuredPaths(selector: string): string[] {
  if (!SELECTOR_LOCAL_ID.test(selector) && !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/u.test(selector)) return [];
  const literal = JSON.stringify(selector);
  return ['envelope', 'kind', 'identity'].map((key) => `$.${key} ? (@ == ${literal})`);
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function ingestGoldCorpus(
  corpus: RetrievalCorpus,
  gold: GoldSet,
): Promise<Map<string, IngestedRevision>> {
  const ingested = new Map<string, IngestedRevision>();
  for (const source of gold.corpus.sources) {
    for (const revision of source.revisions) {
      const raw = goldRawBody(revision);
      const result = await ingestCorpusSource(corpus, {
        stableKey: source.sourceStableKey,
        requestKey: revision.fixtureVersionKey,
        body: raw,
        labels: revision.labels.map((label) => ({ ...label })),
        privacy: revision.privacy,
        trust: revision.trust,
        structured: revision.kind === 'structured',
        mediaType: goldMediaType(revision),
      });
      const version = await corpus.adminPool.query<{ object_id: string; size_bytes: string }>(
        `SELECT version_row.object_id, object_row.size_bytes::text AS size_bytes
           FROM brain.source_versions version_row
           JOIN brain.source_objects object_row ON object_row.object_id = version_row.object_id
          WHERE version_row.source_version_id = $1`,
        [result.sourceVersionId],
      );
      const objectId = version.rows[0]!.object_id;
      if (objectId !== `sha256:${revision.rawSha256}`) {
        throw new Error(
          `gold revision ${revision.fixtureVersionKey} resolved object ${objectId}, expected sha256:${revision.rawSha256}`,
        );
      }
      const chunks = await corpus.adminPool.query<{ chunk_id: string }>(
        `SELECT chunk_row.chunk_id
           FROM brain.source_chunks chunk_row
           JOIN brain.source_extractions extraction_row
             ON extraction_row.extraction_id = chunk_row.extraction_id
           JOIN brain.active_extractors active_row
             ON active_row.extractor_name = extraction_row.extractor_name
            AND active_row.active_version = extraction_row.extractor_version
          WHERE chunk_row.source_version_id = $1
          ORDER BY chunk_row.chunk_index`,
        [result.sourceVersionId],
      );
      const entry: IngestedRevision = {
        fixtureVersionKey: revision.fixtureVersionKey,
        sourceStableKey: source.sourceStableKey,
        sourceId: result.sourceId,
        sourceVersionId: result.sourceVersionId,
        objectId,
        objectBytes: Number(version.rows[0]!.size_bytes),
        activeChunkIds: chunks.rows.map((row) => row.chunk_id),
        inactiveChunkIds: [],
      };
      if (revision.inactiveExtraction !== undefined) {
        entry.inactiveChunkIds = await insertInactiveExtraction(
          corpus,
          entry,
          revision.inactiveExtraction.extractorVersion,
          revision.inactiveExtraction.content,
        );
      }
      ingested.set(revision.fixtureVersionKey, entry);
    }
    if (source.finalDisposition === 'tombstoned') {
      const last = ingested.get(source.revisions.at(-1)!.fixtureVersionKey)!;
      await tombstoneBrainSource(corpus.adminPool, {
        sourceId: last.sourceId,
        requestKey: `tombstone-${source.sourceStableKey}`,
        reason: 'gold-set lifecycle fixture',
        actor: {
          actorId: 'retrieval-gold',
          assurance: 'host-attested',
          host: 'codex',
          sessionId: 'retrieval-gold',
        },
        provenance: { fixture: 'retrieval-gold' },
      });
    }
  }
  return ingested;
}

// The extractor-inactive construction. Bumping `brain_meta.active_extractors`
// is NOT usable: the activation registry check refuses a mismatched compiled
// registry before filter accounting ever runs. A COMPLETE extraction carrying a
// version the registry does not activate leaves activation untouched, is
// invisible to `brain.current_source_chunks`, and is classified
// `extractor-inactive` by the accounting.
async function insertInactiveExtraction(
  corpus: RetrievalCorpus,
  entry: IngestedRevision,
  extractorVersion: number,
  content: string,
): Promise<string[]> {
  const extractionId = deriveExtractionId(entry.sourceVersionId, 'roster-text', extractorVersion);
  const chunkId = deriveChunkId(extractionId, 0);
  const contentSha256 = sha256Hex(Buffer.from(content, 'utf8'));
  await corpus.adminPool.query(
    `INSERT INTO brain.source_extractions
       (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
        status, unsupported_reason, chunk_count, text_sha256, structured)
     VALUES ($1, $2, $3, 'roster-text', $4, 'complete', NULL, 1, $5, NULL)
     ON CONFLICT DO NOTHING`,
    [extractionId, entry.sourceId, entry.sourceVersionId, extractorVersion, contentSha256],
  );
  await corpus.adminPool.query(
    `INSERT INTO brain.source_chunks
       (chunk_id, extraction_id, source_version_id, chunk_index, content, content_sha256,
        byte_start, byte_end, line_start, line_end)
     VALUES ($1, $2, $3, 0, $4, $5, 0, $6, 1, 1)
     ON CONFLICT DO NOTHING`,
    [chunkId, extractionId, entry.sourceVersionId, content, contentSha256, Buffer.byteLength(content, 'utf8')],
  );
  return [chunkId];
}

async function insertAliasGroundTruth(
  corpus: RetrievalCorpus,
  gold: GoldSet,
): Promise<Map<string, string>> {
  const client = await corpus.adminPool.connect();
  try {
    const ids = await insertMergeFixtureEntities(
      client,
      gold.corpus.aliases.map((entry) => ({
        kind: entry.entityKind,
        slug: entry.canonicalSlug,
        title: entry.canonicalTitle,
      })),
    );
    for (const entry of gold.corpus.aliases) {
      const entityId = ids.get(`${entry.entityKind}/${entry.canonicalSlug}`)!;
      for (const alias of entry.aliases) {
        await client.query(
          `INSERT INTO brain.entity_aliases (entity_id, alias, source, actor)
           VALUES ($1::bigint, $2, 'retrieval-gold', 'retrieval-gold')`,
          [entityId, alias],
        );
      }
    }
    return ids;
  } finally {
    client.release();
  }
}

function buildRequest(
  corpus: RetrievalCorpus,
  gold: GoldSet,
  query: GoldQuery,
  selectors: readonly GoldSelector[],
): ContextRetrievalRequest {
  return {
    workspaceId: corpus.authority.workspaceId,
    brainAuthority: {
      workspaceId: corpus.authority.workspaceId,
      fingerprintFormatVersion: corpus.authority.fingerprintFormatVersion,
      namespaceFingerprint: corpus.authority.namespaceFingerprint,
    },
    target: gold.corpus.target,
    planClosureQualifiedIds: gold.corpus.planClosureQualifiedIds,
    selectors: selectors.map((selector) => ({
      selector: selector.selector,
      origins: ['plan-selector'] as const,
      required: selector.required,
      descriptions: selector.descriptions,
    })),
    query: query.query,
    stepHint: query.stepHint ?? null,
    budgetTokens: BUDGET_TOKENS,
    includeLegacyUnverified: query.includeLegacyUnverified ?? false,
  };
}

type MembershipEligibility = {
  chunkId: string;
  labelScopeEligible: boolean;
  privacyCompatible: boolean;
  versionCurrent: boolean;
  trustAdmissible: boolean;
  extractionActive: boolean;
  labelKeys: string[];
};

// Direct, item-keyed proof that a deliberate membership miss is membership-ONLY.
// The filter accounting cannot answer this: FILTER_ACCOUNTING_SQL selects
// membership-REACHABLE chunks before it applies any reason, so an unreachable
// chunk contributes to no bucket regardless of its eligibility. These predicates
// mirror the engine's eligibility WITHOUT the membership predicate, and
// 'extraction active' mirrors `brain.current_source_chunks`'s own definition:
// registry version match AND status = 'complete'.
async function proveEligibilityWithoutMembership(
  corpus: RetrievalCorpus,
  chunkIds: readonly string[],
  allowedLabels: readonly string[],
  includeLegacyUnverified: boolean,
): Promise<Map<string, MembershipEligibility>> {
  if (chunkIds.length === 0) return new Map();
  const result = await corpus.adminPool.query<{
    chunk_id: string;
    label_scope_eligible: boolean;
    privacy_compatible: boolean;
    version_current: boolean;
    trust_admissible: boolean;
    extraction_active: boolean;
    label_keys: string[] | null;
  }>(
    `SELECT chunk_row.chunk_id,
            EXISTS (
              SELECT 1 FROM brain.source_version_labels label_row
               WHERE label_row.source_version_id = chunk_row.source_version_id
                 AND label_row.label_key = ANY($2::text[])
            ) AS label_scope_eligible,
            version_row.privacy_class <> 'secret' AS privacy_compatible,
            (source_row.current_version_id = version_row.source_version_id
              AND source_row.active_tombstone_id IS NULL) AS version_current,
            ($3 OR version_row.trust_class <> 'legacy-unverified') AS trust_admissible,
            (extraction_row.status = 'complete' AND active_row.extractor_name IS NOT NULL)
              AS extraction_active,
            (SELECT array_agg(label2.label_key ORDER BY label2.label_key COLLATE "C")
               FROM brain.source_version_labels label2
              WHERE label2.source_version_id = chunk_row.source_version_id) AS label_keys
       FROM brain.source_chunks chunk_row
       JOIN brain.source_extractions extraction_row
         ON extraction_row.extraction_id = chunk_row.extraction_id
       JOIN brain.source_versions version_row
         ON version_row.source_version_id = extraction_row.source_version_id
       JOIN brain.logical_sources source_row
         ON source_row.source_id = version_row.source_id
       LEFT JOIN brain.active_extractors active_row
         ON active_row.extractor_name = extraction_row.extractor_name
        AND active_row.active_version = extraction_row.extractor_version
      WHERE chunk_row.chunk_id = ANY($1::text[])`,
    [[...chunkIds], [...allowedLabels], includeLegacyUnverified],
  );
  return new Map(result.rows.map((row) => [row.chunk_id, {
    chunkId: row.chunk_id,
    labelScopeEligible: row.label_scope_eligible,
    privacyCompatible: row.privacy_compatible,
    versionCurrent: row.version_current,
    trustAdmissible: row.trust_admissible,
    extractionActive: row.extraction_active,
    labelKeys: row.label_keys ?? [],
  }]));
}

function labelAllowlistFor(gold: GoldSet): string[] {
  const { functionId, agentId } = gold.corpus.target;
  return [
    'workspace',
    `function:${functionId}`,
    `agent:${functionId}/${agentId}`,
    ...gold.corpus.planClosureQualifiedIds.map((qualified) => `plan:${qualified}`),
  ];
}

async function selectorReachability(
  corpus: RetrievalCorpus,
  selector: GoldSelector,
): Promise<{ lexical: Set<string>; structured: Set<string> }> {
  const lexical = await corpus.adminPool.query<{ chunk_id: string }>(
    `SELECT chunk_id FROM brain.source_chunks
      WHERE tsv @@ websearch_to_tsquery('english', $1)`,
    [membershipText(selector)],
  );
  const paths = structuredPaths(selector.selector);
  const structured = paths.length === 0
    ? { rows: [] as { chunk_id: string }[] }
    : await corpus.adminPool.query<{ chunk_id: string }>(
      `SELECT DISTINCT chunk_row.chunk_id
         FROM unnest($1::text[]) AS selector_path(json_path)
         JOIN brain.source_extractions extraction_row
           ON extraction_row.structured @? selector_path.json_path::jsonpath
         JOIN brain.source_chunks chunk_row
           ON chunk_row.extraction_id = extraction_row.extraction_id`,
      [paths],
    );
  return {
    lexical: new Set(lexical.rows.map((row) => row.chunk_id)),
    structured: new Set(structured.rows.map((row) => row.chunk_id)),
  };
}

type CitationOutcome = { complete: boolean; region: 'bytes' | 'object'; problems: string[] };

const LOCATOR_RE = /^chunk:(?<chunkId>[^#]+)#(?<index>\d+)@(?<region>bytes|object):(?<start>\d+)-(?<end>\d+);lines:(?<lineStart>\d+)-(?<lineEnd>\d+)$/u;

async function verifyCitation(
  candidate: ContextBrainCandidate,
  objectBytesFor: (objectId: string) => Promise<Buffer>,
): Promise<CitationOutcome> {
  const problems: string[] = [];
  const citation = candidate.citation;
  for (const field of [
    'logical_source_id', 'source_version_id', 'object_id',
    'extractor_id', 'extractor_version', 'locator', 'content_hash',
  ] as const) {
    if (typeof citation[field] !== 'string' || citation[field].length === 0) {
      problems.push(`${candidate.candidate_id}: citation field ${field} missing`);
    }
  }
  const contentDigest = sha256Hex(Buffer.from(candidate.content, 'utf8'));
  if (citation.content_hash !== `sha256:${contentDigest}`) {
    problems.push(`${candidate.candidate_id}: content_hash does not cover the delivered content`);
  }
  const match = LOCATOR_RE.exec(citation.locator);
  if (match === null) {
    problems.push(`${candidate.candidate_id}: locator is not the pinned shape`);
    return { complete: false, region: 'bytes', problems };
  }
  const groups = match.groups!;
  const region = groups.region as 'bytes' | 'object';
  const start = Number(groups.start);
  const end = Number(groups.end);
  if (citation.object_id === null) {
    problems.push(`${candidate.candidate_id}: citation names no immutable object`);
    return { complete: false, region, problems };
  }
  const bytes = await objectBytesFor(citation.object_id);
  if (region === 'bytes') {
    if (citation.extractor_id !== 'roster-text') {
      problems.push(`${candidate.candidate_id}: @bytes region claimed by ${citation.extractor_id}`);
    }
    const sliced = Buffer.from(bytes.subarray(start, end));
    if (sha256Hex(sliced) !== contentDigest) {
      problems.push(`${candidate.candidate_id}: @bytes re-slice does not hash to content_hash`);
    }
  } else {
    if (citation.extractor_id !== 'roster-structured') {
      problems.push(`${candidate.candidate_id}: @object region claimed by ${citation.extractor_id}`);
    }
    if (start !== 0 || end !== bytes.byteLength) {
      problems.push(`${candidate.candidate_id}: @object region is not the whole immutable document`);
    }
    if (`sha256:${sha256Hex(bytes)}` !== citation.object_id) {
      problems.push(`${candidate.candidate_id}: immutable object bytes do not hash to object_id`);
    }
  }
  return { complete: problems.length === 0, region, problems };
}

function gradesFor(
  query: GoldQuery,
  versionOf: (key: string) => string,
): Map<string, number> {
  const grades = new Map<string, number>();
  for (const item of query.relevant) grades.set(versionOf(item.fixtureVersionKey), item.grade ?? 1);
  return grades;
}

function kRecord(compute: (k: number) => number): Record<string, number> {
  const record: Record<string, number> = {};
  for (const k of K_VALUES) record[String(k)] = roundMetric(compute(k));
  return record;
}

// Counts the statements ONE retrieval issues, through the same injectable pool
// seam `test/brain-context-retrieval.test.ts` uses for its mid-retrieval flip.
async function countStatements(
  request: ContextRetrievalRequest,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  let statements = 0;
  await retrieveBrainContextEvidenceWithTelemetry(request, {
    env,
    createPool: (connectionString, retrievalRequest) => {
      const pool = createVerifiedBrainPool({
        connectionString,
        authority: retrievalRequest.brainAuthority,
      });
      const connect = pool.connect.bind(pool);
      (pool as unknown as { connect: VerifiedBrainPool['connect'] }).connect = async () => {
        const client = await connect();
        const issue = client.query.bind(client);
        (client as unknown as { query: typeof client.query }).query = ((
          text: unknown,
          values?: unknown,
        ) => {
          statements += 1;
          return (issue as (statement: unknown, parameters?: unknown) => unknown)(text, values);
        }) as typeof client.query;
        return client;
      };
      return pool;
    },
  });
  return statements;
}

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

function evidenceFingerprint(candidates: readonly ContextBrainCandidate[], report: unknown): string {
  return sha256Hex(JSON.stringify({ candidates, report }));
}

export type RunEvaluationOptions = Readonly<{
  tier: EvalTier;
  gold: GoldSet;
}>;

export type EvaluationOutcome = Readonly<{
  result: TierResult;
  versions: Readonly<{ postgres: string; pgvector: string | null }>;
}>;

export async function runRetrievalEvaluation(options: RunEvaluationOptions): Promise<EvaluationOutcome> {
  const { gold, tier } = options;
  const bucket = tier === 'minio' ? freshMinioBucketName() : null;
  const brainConfig = bucket === null ? undefined : minioBrainConfig(bucket);
  const corpus = await createRetrievalCorpus({
    workspaceId: RETRIEVAL_GOLD_WORKSPACE_ID,
    ...(brainConfig === undefined ? {} : { brainConfig }),
    ...(bucket === null ? {} : { objectStore: async () => await createMinioBrainObjectStore(brainConfig!) }),
  });
  try {
    const versions = await readServerVersions(corpus);
    const result = await evaluateOnCorpus(corpus, gold, tier);
    return Object.freeze({ result, versions });
  } finally {
    await corpus.close();
  }
}

async function evaluateOnCorpus(
  corpus: RetrievalCorpus,
  gold: GoldSet,
  tier: EvalTier,
): Promise<TierResult> {
  const gates: GateResult[] = [];
  const gate = (name: string, ok: boolean, detail: string): void => {
    gates.push({ name, ok, detail });
  };

  const ingestStarted = Date.now();
  const ingested = await ingestGoldCorpus(corpus, gold);
  const entityIds = await insertAliasGroundTruth(corpus, gold);
  const ingestMs = Date.now() - ingestStarted;

  const revisions = goldRevisions(gold);
  const versionOf = (key: string): string => {
    const entry = ingested.get(key);
    if (entry === undefined) throw new Error(`gold revision ${key} was never ingested`);
    return entry.sourceVersionId;
  };

  const objectCache = new Map<string, Buffer>();
  const objectSizes = new Map<string, number>();
  for (const entry of ingested.values()) objectSizes.set(entry.objectId, entry.objectBytes);
  const objectBytesFor = async (objectId: string): Promise<Buffer> => {
    const cached = objectCache.get(objectId);
    if (cached !== undefined) return cached;
    const size = objectSizes.get(objectId);
    if (size === undefined) throw new Error(`unknown object ${objectId}`);
    const read = await corpus.objectStore.readVerified({
      sha256: objectId.slice('sha256:'.length),
      byteLength: size,
    });
    if (read.status !== 'verified') throw new Error(`object ${objectId} is ${read.status}`);
    const bytes = Buffer.from(read.bytes);
    objectCache.set(objectId, bytes);
    return bytes;
  };

  const env: NodeJS.ProcessEnv = { [BRAIN_RUNTIME_URL_ENV]: corpus.db.url };
  const allowedLabels = labelAllowlistFor(gold);

  // --- authoring self-check -------------------------------------------------
  const selectorSpecs = new Map<string, GoldSelector>();
  for (const query of gold.queries) {
    for (const selector of query.selectors) {
      selectorSpecs.set(`${selector.selector} ${selector.descriptions.join(' ')}`, selector);
    }
  }
  const reachability = new Map<string, { lexical: Set<string>; structured: Set<string> }>();
  const selfCheck: SelfCheckRow[] = [];
  for (const [key, selector] of selectorSpecs) {
    const reach = await selectorReachability(corpus, selector);
    reachability.set(key, reach);
    const union = new Set([...reach.lexical, ...reach.structured]);
    selfCheck.push({
      selector: selector.selector,
      lexical_matches: reach.lexical.size,
      structured_matches: reach.structured.size,
      union_matches: union.size,
      within_arm_limit: reach.lexical.size <= PER_SELECTOR_ARM_LIMIT
        && reach.structured.size <= PER_SELECTOR_ARM_LIMIT,
    });
  }
  selfCheck.sort((left, right) => (left.selector < right.selector ? -1 : left.selector > right.selector ? 1 : 0));
  const overLimit = selfCheck.filter((row) => !row.within_arm_limit).map((row) => row.selector);
  gate(
    'self-check/per-selector-arm-bound',
    overLimit.length === 0,
    overLimit.length === 0
      ? `every selector stays within PER_SELECTOR_ARM_LIMIT=${PER_SELECTOR_ARM_LIMIT}`
      : `selectors over the arm limit: ${overLimit.join(', ')}`,
  );

  const unreachableRelevant: string[] = [];
  const reachableMisses: string[] = [];
  for (const query of gold.queries) {
    const reachSets = query.selectors.map((selector) => (
      reachability.get(`${selector.selector} ${selector.descriptions.join(' ')}`)!
    ));
    const anyReach = new Set<string>();
    for (const reach of reachSets) {
      for (const chunkId of reach.lexical) anyReach.add(chunkId);
      for (const chunkId of reach.structured) anyReach.add(chunkId);
    }
    for (const item of query.relevant) {
      const entry = ingested.get(item.fixtureVersionKey)!;
      if (!entry.activeChunkIds.some((chunkId) => anyReach.has(chunkId))) {
        unreachableRelevant.push(`${query.id}:${item.fixtureVersionKey}`);
      }
    }
    for (const item of query.membershipMisses ?? []) {
      const entry = ingested.get(item.fixtureVersionKey)!;
      if (entry.activeChunkIds.some((chunkId) => anyReach.has(chunkId))) {
        reachableMisses.push(`${query.id}:${item.fixtureVersionKey}`);
      }
    }
  }
  gate(
    'self-check/relevant-items-are-reachable',
    unreachableRelevant.length === 0,
    unreachableRelevant.length === 0 ? 'every relevant item is arm-reachable' : unreachableRelevant.join(', '),
  );
  gate(
    'self-check/membership-misses-are-unreachable',
    reachableMisses.length === 0,
    reachableMisses.length === 0 ? 'every deliberate miss is arm-unreachable' : reachableMisses.join(', '),
  );

  // --- per-query evaluation -------------------------------------------------
  const evaluationStarted = Date.now();
  const measurements: QueryMeasurement[] = [];
  const citationProblems: string[] = [];
  const gateFailures: string[] = [];
  let deliveredCitations = 0;
  let completeCitations = 0;
  let textReslices = 0;
  let structuredProofs = 0;
  let secretCandidates = 0;
  let legacyWithoutOptIn = 0;
  let graphUnavailableEverywhere = true;
  const connectSamples: number[] = [];
  const evidenceByQuery = new Map<string, { candidates: readonly ContextBrainCandidate[]; report: unknown }>();

  for (const query of gold.queries) {
    const request = buildRequest(corpus, gold, query, query.selectors);
    const first = await retrieveBrainContextEvidenceWithTelemetry(request, { env });
    const second = await retrieveBrainContextEvidenceWithTelemetry(request, { env });
    connectSamples.push(first.telemetry.connectMs);
    const evidence = first.evidence;
    const deterministic = evidenceFingerprint(evidence.candidates, evidence.report)
      === evidenceFingerprint(second.evidence.candidates, second.evidence.report);
    evidenceByQuery.set(query.id, { candidates: evidence.candidates, report: evidence.report });

    if (evidence.status !== 'available' || evidence.report.unavailable_reason !== null) {
      gateFailures.push(`${query.id}: retrieval unavailable (${String(evidence.report.unavailable_reason)})`);
    }
    if (evidence.report.graph.status !== 'unavailable'
      || JSON.stringify([...evidence.report.graph.reasons].sort()) !== GRAPH_UNAVAILABLE_REASONS) {
      graphUnavailableEverywhere = false;
    }

    const collapsed = collapseToVersions(
      evidence.candidates.map((candidate) => ({ sourceVersionId: candidate.citation.source_version_id })),
    );
    const relevantVersions = new Set(query.relevant.map((item) => versionOf(item.fixtureVersionKey)));
    const missVersions = new Set((query.membershipMisses ?? []).map((item) => versionOf(item.fixtureVersionKey)));
    const jointVersions = new Set([...relevantVersions, ...missVersions]);
    const grades = gradesFor(query, versionOf);

    const expectedFiltered = EMPTY_FILTERED();
    for (const item of query.excluded ?? []) {
      const entry = ingested.get(item.fixtureVersionKey)!;
      const chunks = item.reason === 'extractor-inactive' ? entry.inactiveChunkIds : entry.activeChunkIds;
      expectedFiltered[item.reason] += chunks.length;
    }
    const filteredMatches = CONTEXT_RETRIEVAL_FILTER_REASONS
      .every((reason) => evidence.report.filtered[reason] === expectedFiltered[reason]);
    const excludedVersions = (query.excluded ?? []).map((item) => versionOf(item.fixtureVersionKey));
    const excludedDelivered = excludedVersions.filter((versionId) => collapsed.includes(versionId));
    const exclusionCorrect = filteredMatches && excludedDelivered.length === 0;

    const violations: string[] = [];
    const deliveredByVersion = new Map<string, ContextBrainCandidate>();
    for (const candidate of evidence.candidates) {
      if (!deliveredByVersion.has(candidate.citation.source_version_id)) {
        deliveredByVersion.set(candidate.citation.source_version_id, candidate);
      }
      if (candidate.privacy === 'secret') secretCandidates += 1;
      if (candidate.trust === 'legacy-unverified' && query.includeLegacyUnverified !== true) {
        legacyWithoutOptIn += 1;
      }
      deliveredCitations += 1;
      const outcome = await verifyCitation(candidate, objectBytesFor);
      if (outcome.complete) completeCitations += 1;
      else citationProblems.push(`${query.id}: ${outcome.problems.join('; ')}`);
      if (outcome.region === 'bytes') textReslices += 1;
      else structuredProofs += 1;
    }

    for (const item of query.relevant) {
      const versionId = versionOf(item.fixtureVersionKey);
      const candidate = deliveredByVersion.get(versionId);
      if (candidate === undefined) {
        violations.push(`${item.fixtureVersionKey}: expected delivery, absent`);
        continue;
      }
      const expectedSelectors = [...item.expectedSelectors].sort();
      if (JSON.stringify([...candidate.selectors].sort()) !== JSON.stringify(expectedSelectors)) {
        violations.push(`${item.fixtureVersionKey}: selectors ${candidate.selectors.join('+')} != ${expectedSelectors.join('+')}`);
      }
      for (const arm of item.expectedArms) {
        if (!candidate.retrieval_modes.includes(arm)) {
          violations.push(`${item.fixtureVersionKey}: retrieval_modes lacks ${arm}`);
        }
      }
      if (item.expectedLabelKeys !== undefined
        && JSON.stringify([...candidate.label_keys]) !== JSON.stringify([...item.expectedLabelKeys])) {
        violations.push(`${item.fixtureVersionKey}: label_keys ${candidate.label_keys.join('+')}`);
      }
      if (item.expectedScope !== undefined
        && JSON.stringify(candidate.scope) !== JSON.stringify(item.expectedScope)) {
        violations.push(`${item.fixtureVersionKey}: scope ${JSON.stringify(candidate.scope)}`);
      }
      const occurrences = evidence.candidates
        .filter((entry) => entry.citation.source_version_id === versionId).length;
      if (occurrences !== 1) {
        violations.push(`${item.fixtureVersionKey}: delivered ${occurrences} times, expected exactly once`);
      }
    }

    if ((query.membershipMisses ?? []).length > 0) {
      const missChunks = (query.membershipMisses ?? [])
        .flatMap((item) => ingested.get(item.fixtureVersionKey)!.activeChunkIds);
      const eligibility = await proveEligibilityWithoutMembership(
        corpus,
        missChunks,
        allowedLabels,
        query.includeLegacyUnverified ?? false,
      );
      for (const item of query.membershipMisses ?? []) {
        const entry = ingested.get(item.fixtureVersionKey)!;
        for (const chunkId of entry.activeChunkIds) {
          const proof = eligibility.get(chunkId);
          if (proof === undefined) {
            violations.push(`${item.fixtureVersionKey}: miss chunk ${chunkId} has no eligibility row`);
            continue;
          }
          if (!proof.labelScopeEligible || !proof.privacyCompatible || !proof.versionCurrent
            || !proof.trustAdmissible || !proof.extractionActive) {
            violations.push(
              `${item.fixtureVersionKey}: miss is not membership-only `
              + `(labelScope=${proof.labelScopeEligible} privacy=${proof.privacyCompatible} `
              + `current=${proof.versionCurrent} trust=${proof.trustAdmissible} extractor=${proof.extractionActive})`,
            );
          }
          if (JSON.stringify(proof.labelKeys) !== JSON.stringify([...item.expectedLabelKeys])) {
            violations.push(`${item.fixtureVersionKey}: miss label_keys ${proof.labelKeys.join('+')}`);
          }
        }
        if (collapsed.includes(versionOf(item.fixtureVersionKey))) {
          violations.push(`${item.fixtureVersionKey}: deliberate membership miss was delivered`);
        }
      }
    }

    const gated = GATE_FAMILIES.includes(query.family);
    if (gated && violations.length > 0) gateFailures.push(`${query.id}: ${violations.join('; ')}`);
    if (gated && !exclusionCorrect) {
      gateFailures.push(
        `${query.id}: filtered ${JSON.stringify(evidence.report.filtered)} != ${JSON.stringify(expectedFiltered)}`
        + (excludedDelivered.length > 0 ? ` and ${excludedDelivered.length} excluded version(s) delivered` : ''),
      );
    }
    if (!deterministic) gateFailures.push(`${query.id}: two consecutive retrievals disagreed`);
    if (query.family === 'baseline' && recallAt(collapsed, relevantVersions, 64) !== 1) {
      gateFailures.push(`${query.id}: baseline Recall@64 is ${recallAt(collapsed, relevantVersions, 64)}`);
    }
    if ((query.family === 'ordering' || query.family === 'paraphrase-ordering')
      && evidence.report.truncated !== 0) {
      gateFailures.push(`${query.id}: ordering family requires truncated=0, saw ${evidence.report.truncated}`);
    }

    measurements.push({
      id: query.id,
      family: query.family,
      gated,
      considered: evidence.report.considered,
      returned: evidence.report.returned,
      truncated: evidence.report.truncated,
      delivered_versions: collapsed.length,
      arm_rows: { ...first.telemetry.armRows },
      relevant: relevantVersions.size,
      membership_misses: missVersions.size,
      recall_at: kRecord((k) => recallAt(collapsed, relevantVersions, k)),
      joint_recall_at: kRecord((k) => recallAt(collapsed, jointVersions, k)),
      precision_at: kRecord((k) => precisionAt(collapsed, relevantVersions, k)),
      reciprocal_rank: roundMetric(reciprocalRank(collapsed, relevantVersions)),
      ndcg_at_10: roundMetric(ndcgAt(collapsed, grades, 10)),
      headroom_at: kRecord((k) => oracleHeadroomAt(collapsed, relevantVersions, k)),
      filtered: { ...evidence.report.filtered },
      expected_filtered: expectedFiltered,
      exclusion_correct: exclusionCorrect,
      deterministic,
      contract_violations: violations,
    });
  }
  const evaluationMs = Date.now() - evaluationStarted;

  gate('privacy/no-secret-candidate', secretCandidates === 0, `${secretCandidates} secret candidates delivered`);
  gate(
    'privacy/no-legacy-unverified-without-optin',
    legacyWithoutOptIn === 0,
    `${legacyWithoutOptIn} legacy-unverified candidates delivered without the opt-in`,
  );
  gate(
    'citation/completeness',
    deliveredCitations > 0 && completeCitations === deliveredCitations,
    completeCitations === deliveredCitations
      ? `${completeCitations}/${deliveredCitations} delivered citations verified`
      : citationProblems.slice(0, 5).join(' | '),
  );
  gate(
    'graph/unavailable-in-every-query',
    graphUnavailableEverywhere,
    'the cited engine reports graph unavailable with exactly'
      + ' [no-cited-edge-relation, unmeasured] for every gold query',
  );
  gate(
    'families/gates-and-contracts',
    gateFailures.length === 0,
    gateFailures.length === 0 ? 'every gated family assertion holds' : gateFailures.slice(0, 8).join(' | '),
  );

  // --- alias-expansion oracle ----------------------------------------------
  const aliasRows: AliasOracleRow[] = [];
  for (const query of gold.queries) {
    if (query.family !== 'alias-variant') continue;
    const expansions: string[] = [];
    const augmented: GoldSelector[] = [];
    for (const selector of query.selectors) {
      const entities = gold.corpus.selectorEntities[selector.selector] ?? [];
      const aliases: string[] = [];
      for (const entity of entities) {
        const entityId = entityIds.get(entity);
        if (entityId === undefined) continue;
        const rows = await corpus.adminPool.query<{ alias: string }>(
          `SELECT alias FROM brain.entity_aliases WHERE entity_id = $1::bigint ORDER BY lower(alias)`,
          [entityId],
        );
        for (const row of rows.rows) aliases.push(row.alias);
      }
      expansions.push(...aliases);
      augmented.push({ ...selector, descriptions: [...selector.descriptions, ...aliases] });
    }
    const baseline = measurements.find((entry) => entry.id === query.id)!;
    const oracle = await retrieveBrainContextEvidenceWithTelemetry(
      buildRequest(corpus, gold, query, augmented),
      { env },
    );
    const collapsed = collapseToVersions(
      oracle.evidence.candidates.map((candidate) => ({ sourceVersionId: candidate.citation.source_version_id })),
    );
    const joint = new Set([
      ...query.relevant.map((item) => versionOf(item.fixtureVersionKey)),
      ...(query.membershipMisses ?? []).map((item) => versionOf(item.fixtureVersionKey)),
    ]);
    const oracleRecall = roundMetric(recallAt(collapsed, joint, 64));
    const baselineRecall = baseline.joint_recall_at['64']!;
    const missClass = (query.membershipMisses ?? [])[0]?.missClass ?? 'synonym';
    aliasRows.push({
      query: query.id,
      miss_class: missClass,
      expansions: expansions.length,
      baseline_joint_recall_at_64: baselineRecall,
      oracle_joint_recall_at_64: oracleRecall,
      delta: roundMetric(oracleRecall - baselineRecall),
      recovered: oracleRecall === 1,
    });
  }

  const multiRows: MultiRecordRow[] = measurements
    .filter((entry) => entry.family === 'multi-record')
    .map((entry) => ({
      query: entry.id,
      anchor_recall_at_64: entry.recall_at['64']!,
      joint_recall_at_64: entry.joint_recall_at['64']!,
      gap: roundMetric(entry.recall_at['64']! - entry.joint_recall_at['64']!),
    }));

  // --- latency (warm max-of-five per family) + statement cost ---------------
  const perFamilyMax: Record<string, number> = {};
  const statementsPerFamily: Record<string, number> = {};
  const families = [...new Set(gold.queries.map((query) => query.family))];
  for (const family of families) {
    const query = gold.queries.find((entry) => entry.family === family)!;
    const request = buildRequest(corpus, gold, query, query.selectors);
    statementsPerFamily[family] = await countStatements(request, env);
    for (let warmup = 0; warmup < 2; warmup += 1) {
      await retrieveBrainContextEvidenceWithTelemetry(request, { env });
    }
    let worst = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { telemetry } = await retrieveBrainContextEvidenceWithTelemetry(request, { env });
      worst = Math.max(worst, telemetry.transactionMs + telemetry.embedMs);
    }
    perFamilyMax[family] = worst;
  }

  // Report-only p95 over 30 warm runs of one representative query, following
  // the `test/context.benchmark.ts` discipline.
  const representative = gold.queries.find((query) => query.family === 'baseline')!;
  const representativeRequest = buildRequest(corpus, gold, representative, representative.selectors);
  for (let warmup = 0; warmup < 5; warmup += 1) {
    await retrieveBrainContextEvidenceWithTelemetry(representativeRequest, { env });
  }
  const samples: number[] = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { telemetry } = await retrieveBrainContextEvidenceWithTelemetry(representativeRequest, { env });
    samples.push(telemetry.transactionMs);
  }
  // The detail carries no wall-clock value: an independent rebuild must produce
  // an identical gate record, and the measured samples live in `timings`.
  const withinBudget = Object.entries(perFamilyMax).filter(([, value]) => value >= LATENCY_BUDGET_MS);
  gate(
    'latency/warm-max-of-five-under-remote-budget',
    withinBudget.length === 0,
    withinBudget.length === 0
      ? `every family stayed inside the ${LATENCY_BUDGET_MS} ms remote budget`
      : `families over budget: ${withinBudget.map(([family]) => family).join(', ')}`,
  );

  // --- embedding mechanics (hermetic fake adapter) --------------------------
  const embeddingMechanics = await measureEmbeddingMechanics(corpus, gold, env, evidenceByQuery);

  const familyMeasurements = families.map((family) => {
    const rows = measurements.filter((entry) => entry.family === family);
    const average = (pick: (row: QueryMeasurement) => number): number => (
      roundMetric(macroAverage(rows.map(pick)))
    );
    const perK = (pick: (row: QueryMeasurement) => Record<string, number>): Record<string, number> => {
      const record: Record<string, number> = {};
      for (const k of K_VALUES) record[String(k)] = roundMetric(macroAverage(rows.map((row) => pick(row)[String(k)]!)));
      return record;
    };
    return {
      family,
      gated: GATE_FAMILIES.includes(family),
      queries: rows.length,
      recall_at: perK((row) => row.recall_at),
      joint_recall_at: perK((row) => row.joint_recall_at),
      precision_at: perK((row) => row.precision_at),
      mrr: average((row) => row.reciprocal_rank),
      ndcg_at_10: average((row) => row.ndcg_at_10),
      headroom_at: perK((row) => row.headroom_at),
      max_truncated: Math.max(...rows.map((row) => row.truncated), 0),
    } satisfies FamilyMeasurement;
  });

  const inactiveChunks = [...ingested.values()].reduce((total, entry) => total + entry.inactiveChunkIds.length, 0);
  const activeChunks = [...ingested.values()].reduce((total, entry) => total + entry.activeChunkIds.length, 0);

  return Object.freeze({
    tier,
    ingest: {
      logical_sources: gold.corpus.sources.length,
      versions: revisions.size,
      objects: new Set([...ingested.values()].map((entry) => entry.objectId)).size,
      active_chunks: activeChunks,
      inactive_chunks: inactiveChunks,
      entities: gold.corpus.aliases.length,
      aliases: gold.corpus.aliases.reduce((total, entry) => total + entry.aliases.length, 0),
    },
    queries: measurements,
    families: familyMeasurements,
    citations: {
      delivered: deliveredCitations,
      complete: completeCitations,
      completeness: deliveredCitations === 0 ? 0 : roundMetric(completeCitations / deliveredCitations),
      text_byte_reslices: textReslices,
      structured_object_proofs: structuredProofs,
    },
    privacy: {
      secret_candidates: secretCandidates,
      legacy_unverified_without_optin: legacyWithoutOptIn,
    },
    graph_unavailable_everywhere: graphUnavailableEverywhere,
    statements_per_family: statementsPerFamily,
    alias_oracle: aliasRows,
    multi_record: multiRows,
    embedding_mechanics: embeddingMechanics.mechanics,
    self_check: selfCheck,
    gates,
    timings: {
      per_family_max_of_five_ms: perFamilyMax,
      connect_ms_samples: connectSamples,
      ingest_ms: ingestMs,
      evaluation_ms: evaluationMs,
      embedding_arm_total_ms: embeddingMechanics.totalMs,
      embedding_embed_ms: embeddingMechanics.embedMs,
      p95_transaction_ms: percentile(samples, 0.95),
      p95_samples: samples.length,
    },
  });
}

// Synthetic vectors measure the arm's MECHANICS — marginal latency, arm rows and
// whether the delivered SET can move — never semantic quality. The arm carries
// `selector: ''`, so it can only reorder chunks the deterministic arms already
// admitted; this run is the empirical proof of that architectural fact.
async function measureEmbeddingMechanics(
  corpus: RetrievalCorpus,
  gold: GoldSet,
  env: NodeJS.ProcessEnv,
  baseline: ReadonlyMap<string, { candidates: readonly ContextBrainCandidate[]; report: unknown }>,
): Promise<{ mechanics: EmbeddingMechanics; totalMs: number; embedMs: number }> {
  const supportsVector = await corpus.adminPool
    .query(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)
    .then((result) => result.rows.length > 0)
    .catch(() => false);
  const skipped: EmbeddingMechanics = {
    status: 'skipped-no-vector-extension',
    embed_invocations: 0,
    stored_vectors: 0,
    bytes_embedded: 0,
    embedding_arm_rows: 0,
    delivered_set_changed: false,
    truncated: 0,
  };
  if (!supportsVector) return { mechanics: skipped, totalMs: 0, embedMs: 0 };

  const dimensions = 4;
  let embedInvocations = 0;
  let bytesEmbedded = 0;
  const provider = {
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions,
    specVersion: 1,
    embed: async (texts: readonly string[]) => {
      embedInvocations += 1;
      for (const text of texts) bytesEmbedded += Buffer.byteLength(text, 'utf8');
      return texts.map(() => [1, 0, 0, 0]);
    },
  };
  const specId = deriveEmbeddingSpecId(provider);
  await corpus.adminPool.query(
    `INSERT INTO brain.embedding_indexes (embedding_spec_id, provider, model, dimensions, spec_version)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [specId, provider.provider, provider.model, dimensions, provider.specVersion],
  );
  // Secret-class content is never embedded — the database refuses the insert, so
  // the mechanics run must respect the same rule the privacy invariant states.
  const chunks = await corpus.adminPool.query<{ chunk_id: string }>(
    `SELECT chunk_id FROM brain.current_source_chunks
      WHERE privacy_class <> 'secret' ORDER BY chunk_id COLLATE "C"`,
  );
  let stored = 0;
  for (const [index, row] of chunks.rows.entries()) {
    const vector = [0, 0, 0, 0];
    vector[index % dimensions] = 1;
    vector[(index + 1) % dimensions] = 0.5 - (index % 40) * 0.01;
    await corpus.adminPool.query(
      `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
       VALUES ($1, $2, $3, $4::vector) ON CONFLICT DO NOTHING`,
      [row.chunk_id, specId, dimensions, `[${vector.join(',')}]`],
    );
    stored += 1;
  }
  const client = await corpus.adminPool.connect();
  try {
    await setConfig(client, 'embeddings.enabled', 'true');
  } finally {
    client.release();
  }
  const adapters: EmbeddingAdapterRegistry = Object.freeze({
    openai: () => ({ status: 'resolved' as const, provider }),
  });
  const query = gold.queries.find((entry) => entry.family === 'ordering')!;
  const request = buildRequest(corpus, gold, query, query.selectors);
  const withArm = await retrieveBrainContextEvidenceWithTelemetry(request, { env, adapters });
  const before = baseline.get(query.id)!;
  const beforeSet = [...new Set(before.candidates.map((candidate) => candidate.candidate_id))].sort();
  const afterSet = [...new Set(withArm.evidence.candidates.map((candidate) => candidate.candidate_id))].sort();
  return {
    mechanics: {
      status: 'measured',
      embed_invocations: embedInvocations,
      stored_vectors: stored,
      bytes_embedded: bytesEmbedded,
      embedding_arm_rows: withArm.telemetry.armRows.embedding,
      delivered_set_changed: JSON.stringify(beforeSet) !== JSON.stringify(afterSet),
      truncated: withArm.evidence.report.truncated,
    },
    totalMs: withArm.telemetry.totalMs,
    embedMs: withArm.telemetry.embedMs,
  };
}

// ---------------------------------------------------------------------------
// Result manifest
// ---------------------------------------------------------------------------

export type ResultManifest = Readonly<Record<string, unknown>>;

function gitDescribe(root: string): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: '0'.repeat(40), dirty: true };
  }
}

export function harnessDigests(root: string = REPOSITORY_ROOT): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const file of HARNESS_FILES) {
    try {
      digests[file] = `sha256:${sha256Hex(readFileSync(join(root, file)))}`;
    } catch {
      digests[file] = 'sha256:absent';
    }
  }
  return digests;
}

export type ComposeManifestOptions = Readonly<{
  gold: GoldSet;
  tiers: readonly TierResult[];
  postgresVersion: string;
  pgvectorVersion: string | null;
  generatedAt: string;
  root?: string;
}>;

export function composeManifest(options: ComposeManifestOptions): ResultManifest {
  const root = options.root ?? REPOSITORY_ROOT;
  const git = gitDescribe(root);
  const tiers: Record<string, unknown> = {};
  let wallClockMs = 0;
  for (const tier of options.tiers) {
    tiers[tier.tier] = tier;
    wallClockMs += tier.timings.ingest_ms + tier.timings.evaluation_ms;
  }
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    kind: 'retrieval_quality_manifest',
    generated_at: options.generatedAt,
    authoritative: !git.dirty,
    git: { commit: git.commit, dirty: git.dirty },
    fixture: { files: options.gold.files, sha256: options.gold.sha256 },
    harness: harnessDigests(root),
    config: {
      rrf_k: 60,
      total_candidate_limit: TOTAL_CANDIDATE_LIMIT,
      per_selector_arm_limit: PER_SELECTOR_ARM_LIMIT,
      k_values: [...K_VALUES],
      budget_tokens: BUDGET_TOKENS,
      latency_budget_ms: LATENCY_BUDGET_MS,
    },
    environment: {
      node: process.version,
      os: `${process.platform}-${process.arch}`,
      kind: process.env.CI === undefined ? 'dev' : 'ci',
      postgres: options.postgresVersion,
      pgvector: options.pgvectorVersion,
      s3_tier: options.tiers.map((tier) => tier.tier).join('+'),
    },
    comparison_exclusions: [...MANIFEST_COMPARISON_EXCLUSIONS],
    tiers,
    timings: { wall_clock_ms: wallClockMs },
    corpus: {
      sources: options.gold.corpus.sources.length,
      revisions: options.gold.corpus.sources.reduce((total, entry) => total + entry.revisions.length, 0),
      queries: options.gold.queries.length,
      miss_classes: [...GOLD_MISS_CLASSES],
    },
  };
}

function removePointer(value: Record<string, unknown>, pointer: string): void {
  const segments = pointer.split('/').slice(1).map((segment) => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  let cursor: Record<string, unknown> | undefined = value;
  for (const segment of segments.slice(0, -1)) {
    const next: unknown = cursor?.[segment];
    if (next === null || typeof next !== 'object') return;
    cursor = next as Record<string, unknown>;
  }
  if (cursor !== undefined) delete cursor[segments.at(-1)!];
}

// The declared comparison projection: two independent rebuilds of one commit
// must agree everywhere except the timing samples and the environment.
export function manifestComparisonProjection(manifest: ResultManifest): ResultManifest {
  const copy = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  for (const pointer of MANIFEST_COMPARISON_EXCLUSIONS) removePointer(copy, pointer);
  return copy;
}

export async function readServerVersions(corpus: RetrievalCorpus): Promise<{
  postgres: string;
  pgvector: string | null;
}> {
  const server = await corpus.adminPool.query<{ server_version: string }>(`SHOW server_version`);
  const vector = await corpus.adminPool
    .query<{ extversion: string }>(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`)
    .catch(() => ({ rows: [] as { extversion: string }[] }));
  return {
    postgres: server.rows[0]!.server_version,
    pgvector: vector.rows[0]?.extversion ?? null,
  };
}
