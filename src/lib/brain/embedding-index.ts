import { createHash } from 'node:crypto';
import { EXIT_ERROR, RosterError, type JsonValue } from '../errors.ts';
import {
  assertBrainExtractionRegistry,
  assertBrainExtractionWriteAuthority,
  type BrainActivation,
} from './activation.ts';
import { canonicalSourceJson, type SourceJsonValue } from './source-contracts.ts';
import {
  isValidEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingResolution,
} from './embedding-provider.ts';

export const EMBEDDING_SPEC_DOMAIN = 'roster.brain.embedding-spec.v1';

const SHA256_ID = /^sha256:[a-f0-9]{64}$/u;
const EMBED_BATCH = 96;
const MAX_SELECT_LIMIT = 1_000;
const DEFAULT_SELECT_LIMIT = 100;

export type BrainEmbeddingErrorCode =
  | 'BRAIN_EMBEDDING_INPUT_INVALID'
  | 'BRAIN_EMBEDDING_SPEC_CONFLICT'
  | 'BRAIN_EMBEDDING_SECRET_EXCLUDED'
  | 'BRAIN_EMBEDDING_PROVIDER_FAILED';

const REMEDIES: Readonly<Record<BrainEmbeddingErrorCode, string>> = Object.freeze({
  BRAIN_EMBEDDING_INPUT_INVALID: 'Supply a registered embedding spec identifier and bounded options.',
  BRAIN_EMBEDDING_SPEC_CONFLICT: 'Inspect the durable embedding spec; registry rows are immutable.',
  BRAIN_EMBEDDING_SECRET_EXCLUDED: 'Secret-class content is never embedded; report this as a Roster defect.',
  BRAIN_EMBEDDING_PROVIDER_FAILED: 'Retry once the embedding provider is reachable; committed batches are kept.',
});

function embeddingError(
  code: BrainEmbeddingErrorCode,
  body: string,
  details: Record<string, JsonValue> = {},
): RosterError {
  return new RosterError({
    header: 'Brain embedding indexing refused the operation',
    body,
    remedy: REMEDIES[code],
    exitCode: EXIT_ERROR,
    code,
    details,
  });
}

export type BrainEmbeddingSpec = Readonly<{
  embeddingSpecId: string;
  provider: string;
  model: string;
  dimensions: number;
  specVersion: number;
  outcome: 'registered' | 'unchanged';
}>;

export type BrainEmbeddingReindexOptions = Readonly<{ batchSize?: number }>;

export type BrainEmbeddingReindexReport = Readonly<{
  embeddings: EmbeddingResolution['status'];
  reason: string | null;
  embeddingSpecId: string | null;
  targeted: number;
  embedded: number;
  remaining: number;
}>;

export type CurrentChunkEmbedding = Readonly<{
  chunkId: string;
  extractionId: string;
  sourceId: string;
  sourceVersionId: string;
  objectId: string;
  chunkIndex: number;
  content: string;
  contentSha256: string;
  byteStart: number;
  byteEnd: number;
  lineStart: number;
  lineEnd: number;
  extractorName: string;
  extractorVersion: number;
  privacyClass: string;
  trustClass: string;
  mediaType: string;
  dimensions: number;
  embedding: readonly number[];
}>;

export function deriveEmbeddingSpecId(provider: {
  provider: string;
  model: string;
  dimensions: number;
  specVersion: number;
}): string {
  const value: SourceJsonValue = {
    provider: provider.provider,
    model: provider.model,
    dimensions: provider.dimensions,
    spec_version: provider.specVersion,
  };
  const digest = createHash('sha256')
    .update(canonicalSourceJson({ domain: EMBEDDING_SPEC_DOMAIN, value }))
    .digest('hex');
  return `sha256:${digest}`;
}

function assertSpecId(value: string): string {
  if (typeof value !== 'string' || !SHA256_ID.test(value)) {
    throw embeddingError(
      'BRAIN_EMBEDDING_INPUT_INVALID',
      'The embeddingSpecId must be a lowercase SHA-256 identifier.',
      { field: 'embeddingSpecId' },
    );
  }
  return value;
}

export async function ensureEmbeddingSpec(
  activation: BrainActivation,
  provider: EmbeddingProvider,
): Promise<BrainEmbeddingSpec> {
  if (!isValidEmbeddingProvider(provider)) {
    throw embeddingError(
      'BRAIN_EMBEDDING_INPUT_INVALID',
      'The embedding provider does not declare a bounded provider, model, dimensions, and spec version.',
    );
  }
  await assertBrainExtractionWriteAuthority(activation);
  const embeddingSpecId = deriveEmbeddingSpecId(provider);
  const inserted = await activation.pool.query(
    `INSERT INTO brain.embedding_indexes
       (embedding_spec_id, provider, model, dimensions, spec_version)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [embeddingSpecId, provider.provider, provider.model, provider.dimensions, provider.specVersion],
  );
  const stored = await activation.pool.query<{ matches: boolean }>(
    `SELECT provider = $2 AND model = $3 AND dimensions = $4 AND spec_version = $5 AS matches
       FROM brain.embedding_indexes WHERE embedding_spec_id = $1`,
    [embeddingSpecId, provider.provider, provider.model, provider.dimensions, provider.specVersion],
  );
  if (stored.rows[0]?.matches !== true) {
    throw embeddingError(
      'BRAIN_EMBEDDING_SPEC_CONFLICT',
      'The durable embedding spec disagrees with its deterministic identity.',
      { embedding_spec_id: embeddingSpecId },
    );
  }
  return Object.freeze({
    embeddingSpecId,
    provider: provider.provider,
    model: provider.model,
    dimensions: provider.dimensions,
    specVersion: provider.specVersion,
    outcome: (inserted.rowCount ?? 0) === 1 ? 'registered' : 'unchanged',
  });
}

function vectorLiteral(vector: unknown, dimensions: number): string {
  if (!Array.isArray(vector)
    || vector.length !== dimensions
    || vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw embeddingError(
      'BRAIN_EMBEDDING_PROVIDER_FAILED',
      'The embedding provider returned a vector that is not exactly the registered number of finite dimensions.',
      { dimensions },
    );
  }
  return `[${(vector as number[]).join(',')}]`;
}

const TARGET_PREDICATE = `
  FROM brain.current_source_chunks chunk_row
 WHERE chunk_row.privacy_class <> 'secret'
   AND NOT EXISTS (
     SELECT 1 FROM brain.chunk_embeddings embedding_row
      WHERE embedding_row.chunk_id = chunk_row.chunk_id
        AND embedding_row.embedding_spec_id = $1)`;

async function countTargets(activation: BrainActivation, embeddingSpecId: string): Promise<number> {
  const result = await activation.pool.query<{ targeted: number }>(
    `SELECT count(*)::int AS targeted${TARGET_PREDICATE}`,
    [embeddingSpecId],
  );
  return result.rows[0]?.targeted ?? 0;
}

export async function reindexChunkEmbeddings(
  activation: BrainActivation,
  resolution: EmbeddingResolution,
  options: BrainEmbeddingReindexOptions = {},
): Promise<BrainEmbeddingReindexReport> {
  if (resolution.status !== 'resolved') {
    return Object.freeze({
      embeddings: resolution.status,
      reason: resolution.status === 'invalid-configuration' ? resolution.reason : null,
      embeddingSpecId: null,
      targeted: 0,
      embedded: 0,
      remaining: 0,
    });
  }
  const batchSize = options.batchSize ?? EMBED_BATCH;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > EMBED_BATCH) {
    throw embeddingError('BRAIN_EMBEDDING_INPUT_INVALID', 'The batchSize option is outside its supported bound.', {
      field: 'batchSize',
      maximum: EMBED_BATCH,
    });
  }
  // Before the spec row is written and before any content reaches a provider:
  // under registry drift the current view exposes a different extractor version
  // than this build produced, so embedding it would ship unverified content.
  await assertBrainExtractionWriteAuthority(activation);
  const spec = await ensureEmbeddingSpec(activation, resolution.provider);
  const targeted = await countTargets(activation, spec.embeddingSpecId);
  let embedded = 0;

  for (;;) {
    const batch = await activation.pool.query<{
      chunk_id: string;
      content: string;
      privacy_class: string;
    }>(
      `SELECT chunk_row.chunk_id, chunk_row.content, chunk_row.privacy_class${TARGET_PREDICATE}
       ORDER BY chunk_row.chunk_id
       LIMIT $2`,
      [spec.embeddingSpecId, batchSize],
    );
    if (batch.rows.length === 0) break;
    // Second of three secret-exclusion layers (SQL predicate, this assembly
    // assertion, and the 012 BEFORE INSERT trigger).
    if (batch.rows.some((row) => row.privacy_class === 'secret')) {
      throw embeddingError(
        'BRAIN_EMBEDDING_SECRET_EXCLUDED',
        'A secret-class chunk reached the embedding batch assembly.',
      );
    }
    let vectors: number[][];
    try {
      vectors = await resolution.provider.embed(batch.rows.map((row) => row.content));
    } catch (error) {
      throw embeddingError(
        'BRAIN_EMBEDDING_PROVIDER_FAILED',
        'The embedding provider failed; committed batches are kept and a rerun converges.',
        {
          embedded,
          remaining: await countTargets(activation, spec.embeddingSpecId),
          cause: error instanceof Error ? error.name : 'unknown',
        },
      );
    }
    if (!Array.isArray(vectors) || vectors.length !== batch.rows.length) {
      throw embeddingError(
        'BRAIN_EMBEDDING_PROVIDER_FAILED',
        'The embedding provider returned a different number of vectors than texts.',
        { embedded },
      );
    }
    const literals = vectors.map((vector) => vectorLiteral(vector, spec.dimensions));
    const written = await activation.pool.query(
      `INSERT INTO brain.chunk_embeddings (chunk_id, embedding_spec_id, dimensions, embedding)
       SELECT entry.chunk_id, $2, $3, entry.embedding::vector
         FROM unnest($1::text[], $4::text[]) AS entry(chunk_id, embedding)
       ON CONFLICT DO NOTHING`,
      [batch.rows.map((row) => row.chunk_id), spec.embeddingSpecId, spec.dimensions, literals],
    );
    embedded += written.rowCount ?? 0;
  }

  return Object.freeze({
    embeddings: 'resolved' as const,
    reason: null,
    embeddingSpecId: spec.embeddingSpecId,
    targeted,
    embedded,
    remaining: await countTargets(activation, spec.embeddingSpecId),
  });
}

function parseVector(literal: string, dimensions: number): readonly number[] {
  if (typeof literal !== 'string' || !literal.startsWith('[') || !literal.endsWith(']')) {
    throw embeddingError('BRAIN_EMBEDDING_SPEC_CONFLICT', 'A stored embedding is not a readable vector literal.');
  }
  const body = literal.slice(1, -1);
  const values = body.length === 0 ? [] : body.split(',').map(Number);
  if (values.length !== dimensions || values.some((value) => !Number.isFinite(value))) {
    throw embeddingError('BRAIN_EMBEDDING_SPEC_CONFLICT', 'A stored embedding disagrees with its recorded dimensions.');
  }
  return Object.freeze(values);
}

export async function selectCurrentChunkEmbeddings(
  activation: BrainActivation,
  embeddingSpecId: string,
  bounds: Readonly<{ limit?: number; offset?: number }> = {},
): Promise<readonly CurrentChunkEmbedding[]> {
  const specId = assertSpecId(embeddingSpecId);
  const limit = bounds.limit ?? DEFAULT_SELECT_LIMIT;
  const offset = bounds.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SELECT_LIMIT
    || !Number.isSafeInteger(offset) || offset < 0) {
    throw embeddingError('BRAIN_EMBEDDING_INPUT_INVALID', 'The selection bounds are outside their supported range.', {
      maximum: MAX_SELECT_LIMIT,
    });
  }
  await assertBrainExtractionRegistry(activation);
  const result = await activation.pool.query<{
    chunk_id: string;
    extraction_id: string;
    source_id: string;
    source_version_id: string;
    object_id: string;
    chunk_index: number;
    content: string;
    content_sha256: string;
    byte_start: string;
    byte_end: string;
    line_start: number;
    line_end: number;
    extractor_name: string;
    extractor_version: number;
    privacy_class: string;
    trust_class: string;
    media_type: string;
    dimensions: number;
    embedding: string;
  }>(
    `SELECT chunk_row.chunk_id, chunk_row.extraction_id, chunk_row.source_id,
            chunk_row.source_version_id, chunk_row.object_id, chunk_row.chunk_index,
            chunk_row.content, chunk_row.content_sha256,
            chunk_row.byte_start::text, chunk_row.byte_end::text,
            chunk_row.line_start, chunk_row.line_end,
            chunk_row.extractor_name, chunk_row.extractor_version,
            chunk_row.privacy_class, chunk_row.trust_class, chunk_row.media_type,
            embedding_row.dimensions, embedding_row.embedding::text AS embedding
       FROM brain.current_source_chunks chunk_row
       JOIN brain.chunk_embeddings embedding_row
         ON embedding_row.chunk_id = chunk_row.chunk_id
      WHERE embedding_row.embedding_spec_id = $1
      ORDER BY chunk_row.chunk_id
      LIMIT $2 OFFSET $3`,
    [specId, limit, offset],
  );
  return Object.freeze(result.rows.map((row) => Object.freeze({
    chunkId: row.chunk_id,
    extractionId: row.extraction_id,
    sourceId: row.source_id,
    sourceVersionId: row.source_version_id,
    objectId: row.object_id,
    chunkIndex: row.chunk_index,
    content: row.content,
    contentSha256: row.content_sha256,
    byteStart: Number(row.byte_start),
    byteEnd: Number(row.byte_end),
    lineStart: row.line_start,
    lineEnd: row.line_end,
    extractorName: row.extractor_name,
    extractorVersion: row.extractor_version,
    privacyClass: row.privacy_class,
    trustClass: row.trust_class,
    mediaType: row.media_type,
    dimensions: row.dimensions,
    embedding: parseVector(row.embedding, row.dimensions),
  })));
}
