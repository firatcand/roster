import { createHash } from 'node:crypto';
import type pg from 'pg';
import { RosterError } from '../errors.ts';
import {
  assertBrainExtractionWriteAuthority,
  extractionError,
  type BrainActivation,
} from './activation.ts';
import {
  deriveChunkId,
  deriveExtractionId,
  extractBrainSourceBytes,
  type ExtractedChunk,
  type ExtractionRefusalReason,
} from './extractors.ts';
import { ingestBrainSource, type BrainIngestResult } from './source-lifecycle.ts';
import type { SourceIngestInput } from './source-contracts.ts';

const SHA256_ID = /^sha256:[a-f0-9]{64}$/u;
const CHUNK_INSERT_BATCH = 256;
const DEFAULT_REINDEX_BATCH = 32;
const MAX_REINDEX_BATCH = 256;

export type BrainExtractionResult = Readonly<{
  extractionId: string;
  sourceId: string;
  sourceVersionId: string;
  extractorName: string;
  extractorVersion: number;
  status: 'complete' | 'unsupported';
  unsupportedReason: ExtractionRefusalReason | null;
  chunkCount: number;
  textSha256: string | null;
  outcome: 'extracted' | 'unchanged';
}>;

export type BrainExtractionReindexOptions = Readonly<{
  batchSize?: number;
  limit?: number;
}>;

export type BrainExtractionReindexReport = Readonly<{
  targeted: number;
  extracted: number;
  unsupported: number;
  failed: number;
  remaining: number;
}>;

type VersionRow = {
  source_id: string;
  media_type: string;
  object_sha256: string;
  size_bytes: string;
  s3_version_id: string | null;
};

type ExtractionRow = {
  matches: boolean;
};

async function withTransaction<T>(
  activation: BrainActivation,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await activation.pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function assertSourceVersionId(value: string): string {
  if (typeof value !== 'string' || !SHA256_ID.test(value)) {
    throw extractionError(
      'BRAIN_EXTRACTION_INPUT_INVALID',
      'The sourceVersionId must be a lowercase SHA-256 identifier.',
      { field: 'sourceVersionId' },
    );
  }
  return value;
}

function boundedCount(value: number | undefined, fallback: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw extractionError('BRAIN_EXTRACTION_INPUT_INVALID', `The ${field} option is outside its supported bound.`, {
      field,
      maximum,
    });
  }
  return value;
}

// One verification rule for caller-supplied and reader-fetched bytes alike: the
// raw-hex digest must equal brain.source_objects.sha256 and the length must
// equal its recorded size_bytes.
function assertObjectBytes(
  bytes: Uint8Array,
  version: VersionRow,
  sourceVersionId: string,
  origin: 'caller' | 'object-store',
): void {
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== version.object_sha256 || bytes.byteLength !== Number(version.size_bytes)) {
    throw extractionError(
      'BRAIN_EXTRACTION_OBJECT_UNVERIFIED',
      'The supplied bytes are not the exact immutable object recorded for this source version.',
      { source_version_id: sourceVersionId, origin },
    );
  }
}

async function loadVersion(
  activation: BrainActivation,
  sourceVersionId: string,
): Promise<VersionRow> {
  const result = await activation.pool.query<VersionRow>(
    `SELECT version_row.source_id,
            version_row.media_type,
            object_row.sha256 AS object_sha256,
            object_row.size_bytes::text AS size_bytes,
            object_row.s3_version_id
       FROM brain.source_versions version_row
       JOIN brain.source_objects object_row ON object_row.object_id = version_row.object_id
      WHERE version_row.source_version_id = $1`,
    [sourceVersionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw extractionError(
      'BRAIN_EXTRACTION_SOURCE_NOT_FOUND',
      'No immutable source version with that identifier exists in this Brain.',
      { source_version_id: sourceVersionId },
    );
  }
  return row;
}

async function resolveBytes(
  activation: BrainActivation,
  sourceVersionId: string,
  version: VersionRow,
  supplied: Uint8Array | undefined,
): Promise<Uint8Array> {
  if (supplied !== undefined) {
    assertObjectBytes(supplied, version, sourceVersionId, 'caller');
    return supplied;
  }
  const read = await activation.objectStore.readVerified({
    sha256: version.object_sha256,
    byteLength: Number(version.size_bytes),
    ...(version.s3_version_id === null ? {} : { versionId: version.s3_version_id }),
  });
  if (read.status !== 'verified') {
    throw extractionError(
      'BRAIN_EXTRACTION_OBJECT_UNVERIFIED',
      'The immutable object bytes for this source version are missing or corrupt.',
      {
        source_version_id: sourceVersionId,
        object_status: read.status,
        ...(read.status === 'corrupt' ? { reason: read.reason } : {}),
      },
    );
  }
  assertObjectBytes(read.bytes, version, sourceVersionId, 'object-store');
  return read.bytes;
}

// The stored content_sha256 is a CLAIM about the stored content, and the schema
// only checks its format. Equivalence therefore carries two independent digest
// positions — one recomputed by the database over the stored bytes, one the
// stored column — so a row whose content diverges from either the extractor
// output or its own claimed digest can never replay as equivalent.
function chunkFingerprint(extractionId: string, chunks: readonly ExtractedChunk[]): string {
  const joined = chunks
    .map((chunk) => [
      deriveChunkId(extractionId, chunk.chunkIndex),
      String(chunk.chunkIndex),
      createHash('sha256').update(Buffer.from(chunk.content, 'utf8')).digest('hex'),
      chunk.contentSha256,
      String(chunk.byteStart),
      String(chunk.byteEnd),
      String(chunk.lineStart),
      String(chunk.lineEnd),
    ].join(':'))
    .join('|');
  return createHash('md5').update(joined).digest('hex');
}

async function insertChunks(
  client: pg.PoolClient,
  extractionId: string,
  sourceVersionId: string,
  chunks: readonly ExtractedChunk[],
): Promise<void> {
  for (let offset = 0; offset < chunks.length; offset += CHUNK_INSERT_BATCH) {
    const batch = chunks.slice(offset, offset + CHUNK_INSERT_BATCH);
    await client.query(
      `INSERT INTO brain.source_chunks
         (chunk_id, extraction_id, source_version_id, chunk_index, content, content_sha256,
          byte_start, byte_end, line_start, line_end)
       SELECT entry.chunk_id, $1, $2, entry.chunk_index, entry.content, entry.content_sha256,
              entry.byte_start, entry.byte_end, entry.line_start, entry.line_end
         FROM unnest($3::text[], $4::int[], $5::text[], $6::text[], $7::bigint[], $8::bigint[],
                     $9::int[], $10::int[])
           AS entry(chunk_id, chunk_index, content, content_sha256, byte_start, byte_end,
                    line_start, line_end)
       ON CONFLICT DO NOTHING`,
      [
        extractionId,
        sourceVersionId,
        batch.map((chunk) => deriveChunkId(extractionId, chunk.chunkIndex)),
        batch.map((chunk) => chunk.chunkIndex),
        batch.map((chunk) => chunk.content),
        batch.map((chunk) => chunk.contentSha256),
        batch.map((chunk) => String(chunk.byteStart)),
        batch.map((chunk) => String(chunk.byteEnd)),
        batch.map((chunk) => chunk.lineStart),
        batch.map((chunk) => chunk.lineEnd),
      ],
    );
  }
}

export async function extractBrainSourceVersion(
  activation: BrainActivation,
  input: { sourceVersionId: string; bytes?: Uint8Array },
): Promise<BrainExtractionResult> {
  const sourceVersionId = assertSourceVersionId(input.sourceVersionId);
  await assertBrainExtractionWriteAuthority(activation);
  const version = await loadVersion(activation, sourceVersionId);
  const bytes = await resolveBytes(activation, sourceVersionId, version, input.bytes);
  const outcome = extractBrainSourceBytes(version.media_type, bytes);
  const extractionId = deriveExtractionId(sourceVersionId, outcome.extractorName, outcome.extractorVersion);
  const chunks = outcome.status === 'complete' ? outcome.chunks : [];
  const structured = outcome.status === 'complete' ? outcome.structured : null;
  const textSha256 = outcome.status === 'complete' ? outcome.textSha256 : null;
  const unsupportedReason = outcome.status === 'unsupported' ? outcome.reason : null;

  const inserted = await withTransaction(activation, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [extractionId]);
    const extraction = await client.query(
      `INSERT INTO brain.source_extractions
         (extraction_id, source_id, source_version_id, extractor_name, extractor_version,
          status, unsupported_reason, chunk_count, text_sha256, structured)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT DO NOTHING`,
      [
        extractionId,
        version.source_id,
        sourceVersionId,
        outcome.extractorName,
        outcome.extractorVersion,
        outcome.status,
        unsupportedReason,
        chunks.length,
        textSha256,
        structured === null ? null : JSON.stringify(structured),
      ],
    );
    await insertChunks(client, extractionId, sourceVersionId, chunks);

    const equivalent = await client.query<ExtractionRow>(
      `SELECT source_id = $2
              AND source_version_id = $3
              AND extractor_name = $4
              AND extractor_version = $5
              AND status = $6
              AND unsupported_reason IS NOT DISTINCT FROM $7
              AND chunk_count = $8
              AND text_sha256 IS NOT DISTINCT FROM $9
              AND structured IS NOT DISTINCT FROM $10::jsonb AS matches
         FROM brain.source_extractions WHERE extraction_id = $1`,
      [
        extractionId,
        version.source_id,
        sourceVersionId,
        outcome.extractorName,
        outcome.extractorVersion,
        outcome.status,
        unsupportedReason,
        chunks.length,
        textSha256,
        structured === null ? null : JSON.stringify(structured),
      ],
    );
    if (equivalent.rows[0]?.matches !== true) {
      throw extractionError(
        'BRAIN_EXTRACTION_INTEGRITY_CONFLICT',
        'The durable extraction disagrees with the deterministic extractor output.',
        { extraction_id: extractionId },
      );
    }
    const stored = await client.query<{ stored: number; fingerprint: string }>(
      `SELECT count(*)::int AS stored,
              md5(coalesce(string_agg(
                chunk_id || ':' || chunk_index::text || ':' ||
                encode(sha256(convert_to(content, 'UTF8')), 'hex') || ':' || content_sha256 || ':' ||
                byte_start::text || ':' || byte_end::text || ':' || line_start::text || ':' ||
                line_end::text, '|' ORDER BY chunk_index), '')) AS fingerprint
         FROM brain.source_chunks WHERE extraction_id = $1`,
      [extractionId],
    );
    if (stored.rows[0]?.stored !== chunks.length
      || stored.rows[0]?.fingerprint !== chunkFingerprint(extractionId, chunks)) {
      throw extractionError(
        'BRAIN_EXTRACTION_INTEGRITY_CONFLICT',
        'The durable chunks disagree with the deterministic extractor output.',
        { extraction_id: extractionId },
      );
    }
    return (extraction.rowCount ?? 0) === 1;
  });

  return Object.freeze({
    extractionId,
    sourceId: version.source_id,
    sourceVersionId,
    extractorName: outcome.extractorName,
    extractorVersion: outcome.extractorVersion,
    status: outcome.status,
    unsupportedReason,
    chunkCount: chunks.length,
    textSha256,
    outcome: inserted ? 'extracted' : 'unchanged',
  });
}

const TARGET_PREDICATE = `
  FROM brain.source_versions version_row
  JOIN brain.logical_sources source_row
    ON source_row.source_id = version_row.source_id
   AND source_row.current_version_id = version_row.source_version_id
   AND source_row.active_tombstone_id IS NULL
 WHERE NOT EXISTS (
   SELECT 1
     FROM brain.source_extractions extraction_row
     JOIN brain_meta.active_extractors active_row
       ON active_row.extractor_name = extraction_row.extractor_name
      AND active_row.active_version = extraction_row.extractor_version
    WHERE extraction_row.source_version_id = version_row.source_version_id)`;

async function countTargets(activation: BrainActivation): Promise<number> {
  const result = await activation.pool.query<{ targeted: number }>(
    `SELECT count(*)::int AS targeted${TARGET_PREDICATE}`,
  );
  return result.rows[0]?.targeted ?? 0;
}

export async function reindexBrainExtractions(
  activation: BrainActivation,
  options: BrainExtractionReindexOptions = {},
): Promise<BrainExtractionReindexReport> {
  const batchSize = boundedCount(options.batchSize, DEFAULT_REINDEX_BATCH, MAX_REINDEX_BATCH, 'batchSize');
  const limit = boundedCount(options.limit, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 'limit');
  await assertBrainExtractionWriteAuthority(activation);

  const targeted = await countTargets(activation);
  let extracted = 0;
  let unsupported = 0;
  let failed = 0;
  let processed = 0;
  let cursor = '';

  while (processed < limit) {
    const batch = await activation.pool.query<{ source_version_id: string }>(
      `SELECT version_row.source_version_id${TARGET_PREDICATE}
         AND version_row.source_version_id > $1
       ORDER BY version_row.source_version_id
       LIMIT $2`,
      [cursor, Math.min(batchSize, limit - processed)],
    );
    if (batch.rows.length === 0) break;
    for (const row of batch.rows) {
      cursor = row.source_version_id;
      processed += 1;
      try {
        const result = await extractBrainSourceVersion(activation, {
          sourceVersionId: row.source_version_id,
        });
        if (result.status === 'unsupported') unsupported += 1;
        else extracted += 1;
      } catch (error) {
        if (!(error instanceof RosterError)
          || (error.code !== 'BRAIN_EXTRACTION_OBJECT_UNVERIFIED'
            && error.code !== 'BRAIN_EXTRACTION_SOURCE_NOT_FOUND')) throw error;
        failed += 1;
      }
    }
  }

  return Object.freeze({
    targeted,
    extracted,
    unsupported,
    failed,
    remaining: await countTargets(activation),
  });
}

// The preflight guards the FIRST mutation on this path, not the extraction step:
// ingestion writes 011 lifecycle rows and object-store bytes, so proving write
// authority afterwards would leave durable state behind a refused operation.
export async function ingestAndExtractBrainSource(
  activation: BrainActivation,
  input: SourceIngestInput,
): Promise<Readonly<{ ingest: BrainIngestResult; extraction: BrainExtractionResult }>> {
  await assertBrainExtractionWriteAuthority(activation);
  const ingest = await ingestBrainSource(
    { pool: activation.pool, objectStore: activation.objectStore },
    input,
  );
  const extraction = await extractBrainSourceVersion(activation, {
    sourceVersionId: ingest.sourceVersionId,
    bytes: input.bytes,
  });
  return Object.freeze({ ingest, extraction });
}
