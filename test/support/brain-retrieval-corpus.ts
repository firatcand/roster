import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { requireBrainActivation, type BrainActivation } from '../../src/lib/brain/activation.ts';
import { createBrainPool } from '../../src/lib/brain/connect.ts';
import { ingestAndExtractBrainSource } from '../../src/lib/brain/extraction.ts';
import { legacyRecordStableKey } from '../../src/lib/brain/source-identity.ts';
import type {
  SourceIngestInput,
  SourceRetrievalLabelInput,
  SourceTrustClass,
} from '../../src/lib/brain/source-contracts.ts';
import {
  bootstrapBrainWorkspaceAuthority,
  createVerifiedBrainPool,
  deriveBrainWorkspaceAuthority,
  type BrainWorkspaceAuthority,
  type VerifiedBrainPool,
} from '../../src/lib/brain/workspace-authority.ts';
import type { BrainObjectReader, BrainObjectStore } from '../../src/lib/brain/object-store.ts';
import type { WorkspaceBrainConfig } from '../../src/lib/workspace-record.ts';
import { createFreshDb, type FreshDb } from '../brain-helpers.ts';
import { MemoryBrainObjectStore } from './brain-memory-object-store.ts';

export const RETRIEVAL_WORKSPACE_ID = 'retrieval-corpus-workspace';

export function retrievalBrainConfig(): WorkspaceBrainConfig {
  return {
    secrets_path: `/${RETRIEVAL_WORKSPACE_ID}`,
    storage: {
      bucket: RETRIEVAL_WORKSPACE_ID,
      region: 'eu-central-1',
      force_path_style: false,
    },
  };
}

export type RetrievalCorpus = Readonly<{
  db: FreshDb;
  authority: BrainWorkspaceAuthority;
  adminPool: VerifiedBrainPool;
  activation: BrainActivation;
  // Exposed so a provenance test can re-slice the exact immutable object bytes
  // a citation locator addresses.
  objectStore: BrainObjectStore & BrainObjectReader;
  runtimeRole: string;
  runtimePassword: string;
  close: () => Promise<void>;
}>;

// The defaults preserve the pre-#355 identity exactly, so every existing
// retrieval suite is untouched. #355 passes the identity a real workspace's
// `roster.yaml` derives, which is what pins the registry↔authority join.
export type RetrievalCorpusOptions = Readonly<{
  workspaceId?: string;
  brainConfig?: WorkspaceBrainConfig;
  // #353's S3 proof tier: the production ContentAddressedBrainObjectStore over a
  // real object service. Omitting it keeps the in-memory store every existing
  // suite already depends on, so the default is byte-for-byte unchanged.
  objectStore?: (namespaceFingerprint: string) => Promise<BrainObjectStore & BrainObjectReader>;
}>;

export async function createRetrievalCorpus(
  options: RetrievalCorpusOptions = {},
): Promise<RetrievalCorpus> {
  const workspaceId = options.workspaceId ?? RETRIEVAL_WORKSPACE_ID;
  const brainConfig = options.brainConfig ?? retrievalBrainConfig();
  const db = await createFreshDb();
  const authority = deriveBrainWorkspaceAuthority(workspaceId, brainConfig);
  const bootstrapPool = createBrainPool('admin', db.url);
  const runtimePassword = `Aa0_${randomBytes(32).toString('base64url')}-A1_`;
  const bootstrap = await bootstrapBrainWorkspaceAuthority(bootstrapPool, authority, {
    runtimeRole: db.role,
    runtimePassword,
  });
  await bootstrapPool.end();
  const adminPool = createVerifiedBrainPool({
    connectionString: db.url,
    authority,
    databaseAuthorityId: bootstrap.databaseAuthorityId,
  });
  const store = options.objectStore === undefined
    ? new MemoryBrainObjectStore(authority.namespaceFingerprint)
    : await options.objectStore(authority.namespaceFingerprint);
  const activation = requireBrainActivation({ pool: adminPool, objectStore: store });
  return Object.freeze({
    db,
    authority,
    adminPool,
    activation,
    objectStore: store,
    runtimeRole: bootstrap.role.roleName,
    runtimePassword,
    close: async () => {
      await adminPool.end().catch(() => undefined);
      try {
        store.close();
      } catch {
        /* a transport that is already torn down must not mask the drop */
      }
      await db.drop();
    },
  });
}

export function runtimeUrlFor(corpus: RetrievalCorpus): string {
  const url = new URL(corpus.db.url);
  url.username = corpus.runtimeRole;
  url.password = corpus.runtimePassword;
  return url.toString();
}

export type CorpusSourceOptions = Readonly<{
  stableKey: string;
  body: string;
  labels: readonly SourceRetrievalLabelInput[];
  privacy?: 'public' | 'internal' | 'secret';
  trust?: SourceTrustClass;
  mediaType?: string;
  structured?: boolean;
  requestKey?: string;
  expectedTombstoneId?: string | null;
  sourceTimestamp?: string | null;
}>;

function ingestInput(options: CorpusSourceOptions): SourceIngestInput {
  const requestKey = options.requestKey ?? `${options.stableKey}:${options.body.length}`;
  return {
    requestKey,
    ...(options.expectedTombstoneId === undefined
      ? {}
      : { expectedTombstoneId: options.expectedTombstoneId }),
    source: options.structured === true
      ? { kind: 'structured-record', stableKey: options.stableKey }
      : { kind: 'inline-text', stableKey: options.stableKey },
    bytes: Buffer.from(options.body, 'utf8'),
    labels: [...options.labels],
    privacy: options.privacy ?? 'internal',
    trust: options.trust ?? 'brain-extract-untrusted',
    // legacy-unverified evidence must be system-derived migration evidence, so
    // the fixture's actor follows the trust class rather than the reverse.
    actor: options.trust === 'legacy-unverified'
      ? { actorId: 'roster', assurance: 'system-derived', component: 'roster' }
      : {
        actorId: 'retrieval-corpus',
        assurance: 'host-attested',
        host: 'codex',
        sessionId: 'retrieval-corpus',
      },
    mediaType: options.mediaType
      ?? (options.structured === true ? 'application/json' : 'text/markdown'),
    ...(options.sourceTimestamp === undefined ? {} : { sourceTimestamp: options.sourceTimestamp }),
    provenance: { fixture: 'brain-retrieval-corpus', request_key: requestKey },
  };
}

export async function ingestCorpusSource(
  corpus: RetrievalCorpus,
  options: CorpusSourceOptions,
): Promise<Readonly<{ sourceId: string; sourceVersionId: string; chunkIds: readonly string[] }>> {
  const result = await ingestAndExtractBrainSource(corpus.activation, ingestInput(options));
  const chunks = await corpus.adminPool.query<{ chunk_id: string }>(
    `SELECT chunk_id FROM brain.current_source_chunks
      WHERE source_version_id = $1 ORDER BY chunk_index`,
    [result.ingest.sourceVersionId],
  );
  return Object.freeze({
    sourceId: result.ingest.sourceId,
    sourceVersionId: result.ingest.sourceVersionId,
    chunkIds: Object.freeze(chunks.rows.map((row) => row.chunk_id)),
  });
}

// A structured record in the shape #352 §10 pins, so the structured arm's
// value-equality jsonpath over `envelope` / `kind` / `identity` has real rows.
export function structuredRecordBody(
  kind: 'entity' | 'fact' | 'event' | 'edge',
  body: Record<string, unknown>,
  identity: string,
): string {
  return JSON.stringify({ envelope: 'roster.brain.record.v1', kind, identity, body });
}

export function legacyEntityIdentity(entityKind: string, slug: string): string {
  return legacyRecordStableKey({ kind: 'entity', entityKind, slug });
}

export async function insertMergeFixtureEntities(
  client: pg.PoolClient | pg.Client,
  rows: readonly Readonly<{
    kind: string;
    slug: string;
    title: string;
  }>[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const row of rows) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO brain.entities (kind, slug, title, body) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id::text AS id`,
      [row.kind, row.slug, row.title],
    );
    ids.set(`${row.kind}/${row.slug}`, inserted.rows[0]!.id);
  }
  return ids;
}
