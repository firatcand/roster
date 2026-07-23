import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  WorkspaceMismatchError,
  sha256Hex,
} from './contracts.ts';
import { ConditionalWriteFailed, type FileStore, type S3StoreConfig } from './s3-core.ts';
import { assertSafeSegment } from './safe-path.ts';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import type { ObjectTarget } from './outbox.ts';

// Dedicated-bucket, create-only object layer (#318 section F, owner decision
// 6). CreateOnlyObjectStore is compile-time separated from brain's deletable
// FileStore: no del, no overwrite, no caller-built keys — every key is built
// here from a fixed internal prefix + safe-path-validated segments. The
// workspace marker is the cross-workspace accident tripwire; the 1:1-bound
// database (binding.ts) is the trust root.

export const OPS_OBJECT_PREFIXES = ['hitl', 'runs', 'artifacts', 'outbox'] as const;
export type OpsObjectPrefix = (typeof OPS_OBJECT_PREFIXES)[number];

export const WORKSPACE_MARKER_KEY = 'roster-workspace.json';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export type OpsObjectRef = { prefix: OpsObjectPrefix; segments: readonly string[] };

export function opsObjectKey(ref: OpsObjectRef): string {
  if (!(OPS_OBJECT_PREFIXES as readonly string[]).includes(ref.prefix)) {
    throw new InvalidRecordError(
      `'${String(ref.prefix)}' is not an ops object prefix (expected ${OPS_OBJECT_PREFIXES.join(' | ')})`,
    );
  }
  if (ref.segments.length === 0) {
    throw new InvalidRecordError('an ops object key needs at least one segment under its prefix');
  }
  for (const segment of ref.segments) {
    assertSafeSegment('object key segment', segment);
  }
  return `${ref.prefix}/${ref.segments.join('/')}`;
}

export type PutIfAbsentResult = { outcome: 'stored' | 'exists'; etag: string };
export type ObjectGetResult = { body: Buffer; etag: string };
export type ObjectHeadResult = { size: number; etag: string };

export interface CreateOnlyObjectStore {
  putIfAbsent(ref: OpsObjectRef, bytes: Uint8Array, opts?: { contentType?: string }): Promise<PutIfAbsentResult>;
  get(ref: OpsObjectRef): Promise<ObjectGetResult | null>;
  head(ref: OpsObjectRef): Promise<ObjectHeadResult | null>;
  // The marker sits at the bucket root (outside the data prefixes); runtime
  // creds hold read-only access to exactly this key for resolution-time
  // verification. Exposed as its own method so no caller ever builds the key.
  getMarker(): Promise<ObjectGetResult | null>;
}

export class CreateOnlyFileStore implements CreateOnlyObjectStore {
  private readonly files: FileStore;

  constructor(files: FileStore) {
    this.files = files;
  }

  async putIfAbsent(
    ref: OpsObjectRef,
    bytes: Uint8Array,
    opts: { contentType?: string } = {},
  ): Promise<PutIfAbsentResult> {
    const key = opsObjectKey(ref);
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    try {
      const res = await this.files.put(key, buf, { ifNoneMatch: '*', contentType: opts.contentType });
      return { outcome: 'stored', etag: res.etag };
    } catch (err) {
      if (!(err instanceof ConditionalWriteFailed)) throw err;
      const existing = await this.files.get(key);
      if (existing === null) {
        throw new BackendUnavailableError(
          `lost the create race for '${key}' but the winning object is not readable — retry`,
        );
      }
      if (sha256Hex(existing.body) === sha256Hex(buf)) {
        return { outcome: 'exists', etag: existing.etag };
      }
      throw new ConflictError(
        key,
        'object already exists with different bytes — the create-only store never overwrites',
      );
    }
  }

  async get(ref: OpsObjectRef): Promise<ObjectGetResult | null> {
    return await this.files.get(opsObjectKey(ref));
  }

  async head(ref: OpsObjectRef): Promise<ObjectHeadResult | null> {
    const res = await this.files.head(opsObjectKey(ref));
    return res === null ? null : { size: res.size, etag: res.etag };
  }

  async getMarker(): Promise<ObjectGetResult | null> {
    return await this.files.get(WORKSPACE_MARKER_KEY);
  }
}

// ---------- workspace marker (claim = admin authority, verify = every resolve) ----------

export type WorkspaceMarkerBody = { workspaceId: string; name: string };

// Deterministic body: its sha256 is computable BEFORE the claim, which is what
// lets the canonical tuple (including marker_sha256) be stamped into the DB's
// initial pending transaction (binding.ts).
export function workspaceMarkerBody(workspace: WorkspaceMarkerBody): Buffer {
  return Buffer.from(JSON.stringify({ workspaceId: workspace.workspaceId, name: workspace.name }) + '\n', 'utf8');
}

export function workspaceMarkerSha256(workspace: WorkspaceMarkerBody): string {
  return sha256Hex(workspaceMarkerBody(workspace));
}

export type MarkerClaim = { markerSha256: string; markerEtag: string | null; created: boolean };

function parseMarker(body: Buffer): WorkspaceMarkerBody | null {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as WorkspaceMarkerBody;
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.workspaceId === 'string') {
      return parsed;
    }
  } catch {
    // fall through
  }
  return null;
}

// Admin authority only: takes its own FileStore so setup passes the
// admin-credential store, never the runtime one. If-None-Match makes
// concurrent claims arbitrate at the bucket (one winner).
export async function claimWorkspaceMarker(
  adminFiles: FileStore,
  workspace: WorkspaceMarkerBody,
): Promise<MarkerClaim> {
  const body = workspaceMarkerBody(workspace);
  try {
    const res = await adminFiles.put(WORKSPACE_MARKER_KEY, body, {
      ifNoneMatch: '*',
      contentType: 'application/json',
    });
    return { markerSha256: sha256Hex(body), markerEtag: res.etag || null, created: true };
  } catch (err) {
    if (!(err instanceof ConditionalWriteFailed)) throw err;
    const existing = await adminFiles.get(WORKSPACE_MARKER_KEY);
    if (existing === null) {
      throw new BackendUnavailableError(
        `lost the marker claim race but '${WORKSPACE_MARKER_KEY}' is not readable — retry`,
      );
    }
    const parsed = parseMarker(existing.body);
    if (parsed === null) {
      throw new WorkspaceMismatchError(
        `bucket already holds a '${WORKSPACE_MARKER_KEY}' that is not a roster workspace marker — refusing to claim (dedicated buckets only)`,
      );
    }
    if (parsed.workspaceId !== workspace.workspaceId) {
      throw new WorkspaceMismatchError(
        `bucket already claimed by workspace ${parsed.name ?? '(unnamed)'} (${parsed.workspaceId})`,
      );
    }
    // Same UUID, but the existing marker's BYTES must match this workspace's
    // deterministic marker exactly. A same-UUID marker whose name (hence bytes,
    // hence sha256) differs would make setup finalize the DB against the
    // requested-name digest while the bucket holds a different-name marker —
    // an unusable binding that resolution later rejects. The marker is
    // create-only/immutable, so a same-UUID clone MUST use the same display name.
    const existingSha = sha256Hex(existing.body);
    if (existingSha !== sha256Hex(body)) {
      throw new WorkspaceMismatchError(
        `bucket already holds a marker for workspace ${parsed.workspaceId} whose bytes disagree with this workspace's marker ` +
          `(recorded name '${parsed.name ?? '(unnamed)'}', configuring '${workspace.name}'). ` +
          `The marker is immutable — a same-UUID clone must use the exact same display name (or fork with --new-identity).`,
      );
    }
    return { markerSha256: existingSha, markerEtag: existing.etag || null, created: false };
  }
}

// Resolution-time verification (not setup-only): marker body sha256 must equal
// the DB-recorded markerSha256. Digest comparison, never etag — etags are not
// content digests for multipart uploads.
export async function verifyWorkspaceMarker(
  store: CreateOnlyObjectStore,
  expected: { workspaceId: string; markerSha256: string },
): Promise<void> {
  const marker = await store.getMarker();
  if (marker === null) {
    throw new WorkspaceMismatchError(
      `bucket has no '${WORKSPACE_MARKER_KEY}' marker — this is not the bucket setup claimed for workspace ${expected.workspaceId}`,
    );
  }
  if (sha256Hex(marker.body) !== expected.markerSha256) {
    const parsed = parseMarker(marker.body);
    const who = parsed === null ? 'an unrecognized marker' : `workspace ${parsed.name ?? '(unnamed)'} (${parsed.workspaceId})`;
    throw new WorkspaceMismatchError(
      `bucket marker digest mismatch — the bucket carries ${who}, not the marker recorded for workspace ${expected.workspaceId}`,
    );
  }
}

// ---------- stage 3 ObjectTarget over the create-only store ----------

// Content-addressed artifact byte sink for the outbox drain (object-first /
// index-last). 'stored' on first delivery, 'exists' on digest replay,
// ConflictError when the stored bytes mismatch the digest.
export class S3ObjectTarget implements ObjectTarget {
  private readonly store: CreateOnlyObjectStore;

  constructor(store: CreateOnlyObjectStore) {
    this.store = store;
  }

  async deliver(digest: string, bytes: Buffer): Promise<'stored' | 'exists'> {
    if (!SHA256_HEX_RE.test(digest)) {
      throw new InvalidRecordError('artifact digest must be a full-length lowercase sha256 hex digest');
    }
    if (sha256Hex(bytes) !== digest) {
      throw new ConflictError(digest, 'artifact bytes do not match their digest');
    }
    const res = await this.store.putIfAbsent({ prefix: 'artifacts', segments: [digest] }, bytes, {
      contentType: 'application/octet-stream',
    });
    return res.outcome;
  }
}

// ---------- setup-time bucket validation (admin creds; consumed by stage 5) ----------

type S3AdminDeps = {
  client: import('@aws-sdk/client-s3').S3Client;
  sdk: typeof import('@aws-sdk/client-s3');
};

async function adminS3(cfg: S3StoreConfig, env: NodeJS.ProcessEnv): Promise<S3AdminDeps> {
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    region: cfg.region ?? 'us-east-1',
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    forcePathStyle: cfg.forcePathStyle,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    },
  });
  return { client, sdk };
}

export async function verifyBucketVersioning(
  cfg: S3StoreConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const { client, sdk } = await adminS3(cfg, env);
  try {
    const res = await client.send(new sdk.GetBucketVersioningCommand({ Bucket: cfg.bucket }));
    if (res.Status !== 'Enabled') {
      throw new RosterError({
        header: 'roster: bucket versioning is not enabled',
        body: `  bucket '${cfg.bucket}' reports versioning status '${res.Status ?? 'unset'}'. The ops object store requires versioning so create-only history survives administrative mistakes.`,
        remedy: `  Enable it (admin credentials):\n    aws s3api put-bucket-versioning --bucket ${cfg.bucket} --versioning-configuration Status=Enabled${cfg.endpoint ? ` --endpoint-url ${cfg.endpoint}` : ''}`,
        exitCode: EXIT_ERROR,
      });
    }
  } finally {
    client.destroy();
  }
}

// Object Lock availability is recorded as a negotiated objects capability at
// setup; absence is not an error (MinIO/R2 buckets without lock still work).
export async function detectObjectLockCapability(
  cfg: S3StoreConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const { client, sdk } = await adminS3(cfg, env);
  try {
    const res = await client.send(new sdk.GetObjectLockConfigurationCommand({ Bucket: cfg.bucket }));
    return res.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
  } catch (err) {
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (
      e?.name === 'ObjectLockConfigurationNotFoundError' ||
      e?.name === 'NotImplemented' ||
      e?.$metadata?.httpStatusCode === 404 ||
      e?.$metadata?.httpStatusCode === 501
    ) {
      return false;
    }
    throw err;
  } finally {
    client.destroy();
  }
}
