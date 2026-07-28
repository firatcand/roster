import { createHash } from 'node:crypto';

// Generic S3-compatible object store machinery, shared by the brain file system
// and the ops backends. FileStore is the narrow port callers talk to — small
// enough that MemoryFileStore can stand in for hermetic tests and doctor
// injection, and every backend is held to one contract. Anything policy- or
// config-aware (e.g. brain's filesConfig) stays with its owner.

export type PutOpts = {
  contentType?: string;
  // Create-only: fail if the key already exists.
  ifNoneMatch?: '*';
  // Compare-and-swap: fail unless the live object has exactly this etag.
  ifMatch?: string;
};

// objectVersionId is the store's version handle for the immutable bytes just
// written/read (S3 x-amz-version-id; MemoryFileStore synthesizes a stable
// monotonic id per write). It is a STORE-ASSIGNED OBSERVATION — never part of
// any outbox payload hash or delivery-ledger dedup key (#323) — so a queued
// write survives delivery with its recorded version unchanged. Optional on the
// shared FileStore port (not every consumer — e.g. brain — needs it); the real
// MemoryFileStore / S3FileStore always populate it, and the ops-facing
// CreateOnlyObjectStore surfaces it as a required (nullable) field.
export type PutResult = { etag: string; objectVersionId?: string | null };
export type GetResult = { body: Buffer; etag: string; objectVersionId?: string | null };
export type HeadResult = { etag: string; size: number; objectVersionId?: string | null };

// One (key, version) pair from a prefix listing; versionId is null on a store
// without versioning.
export type ObjectVersionEntry = { key: string; versionId: string | null };
export type ObjectListPage = { items: ObjectVersionEntry[]; cursor: string | null };
export type ListPrefixOpts = { cursor?: string | null; limit?: number };

export const DEFAULT_LIST_PAGE = 1000;

export interface FileStore {
  put(key: string, body: Buffer, opts?: PutOpts): Promise<PutResult>;
  // null when the key does not exist (S3 404 / NoSuchKey). An optional recorded
  // versionId fetches that exact immutable version (S3 VersionId; MemoryFileStore
  // keeps prior versions) rather than the latest.
  get(key: string, versionId?: string | null): Promise<GetResult | null>;
  head(key: string, versionId?: string | null): Promise<HeadResult | null>;
  // Idempotent: deleting a missing key is not an error (S3 returns 204).
  del(key: string): Promise<void>;
  // Admin/read-scoped prefix enumeration for repair/doctor ONLY (the runtime IAM
  // has no bucket-wide list). Optional on the shared port; MemoryFileStore and
  // S3FileStore implement it. Returns current (latest, non-deleted) objects and
  // their version ids, paginated by an opaque cursor.
  listPrefix?(prefix: string, opts?: ListPrefixOpts): Promise<ObjectListPage>;
}

// A conditional put (ifNoneMatch / ifMatch) lost the race — the object already
// exists, or its live etag no longer matches. The caller re-reads and retries.
export class ConditionalWriteFailed extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`conditional write failed for '${key}' (object changed underneath us)`);
    this.name = 'ConditionalWriteFailed';
    this.key = key;
  }
}

// Etags are compared across put/head/get (doctor drift check), so normalize away
// the surrounding quotes S3 wraps single-part etags in.
export function normalizeEtag(raw: string): string {
  return raw.replace(/^"|"$/g, '');
}

// ---------- MemoryFileStore: hermetic reference implementation ----------

// In-process FileStore backing tests and doctor injection. It honors the same
// conditional-write contract as S3, and its etag (md5 hex of the body) matches
// what S3 returns for a single-part upload — so a value stored here compares
// equal to one stored in real S3. It retains prior versions per key (like a
// versioned S3 bucket) and synthesizes a stable, monotonic version id per write
// so version-specific get/head and prefix listing behave as they do on S3.
type MemVersion = { body: Buffer; etag: string; versionId: string };

export class MemoryFileStore implements FileStore {
  // Every write appends a version; the last element is the current one.
  private readonly objects = new Map<string, MemVersion[]>();
  private versionCounter = 0;

  private etagOf(body: Buffer): string {
    return createHash('md5').update(body).digest('hex');
  }

  private nextVersionId(): string {
    // Fixed-width so lexical order matches write order (a stable, monotonic id).
    return `mem-${String(++this.versionCounter).padStart(12, '0')}`;
  }

  private latest(key: string): MemVersion | undefined {
    const versions = this.objects.get(key);
    return versions && versions.length > 0 ? versions[versions.length - 1] : undefined;
  }

  async put(key: string, body: Buffer, opts: PutOpts = {}): Promise<PutResult> {
    const existing = this.latest(key);
    if (opts.ifNoneMatch === '*' && existing) throw new ConditionalWriteFailed(key);
    if (opts.ifMatch !== undefined && (!existing || existing.etag !== opts.ifMatch)) {
      throw new ConditionalWriteFailed(key);
    }
    const version: MemVersion = { body: Buffer.from(body), etag: this.etagOf(body), versionId: this.nextVersionId() };
    const versions = this.objects.get(key);
    if (versions) versions.push(version);
    else this.objects.set(key, [version]);
    return { etag: version.etag, objectVersionId: version.versionId };
  }

  private resolve(key: string, versionId?: string | null): MemVersion | undefined {
    if (versionId === undefined || versionId === null) return this.latest(key);
    return this.objects.get(key)?.find((v) => v.versionId === versionId);
  }

  async get(key: string, versionId?: string | null): Promise<GetResult | null> {
    const o = this.resolve(key, versionId);
    return o ? { body: Buffer.from(o.body), etag: o.etag, objectVersionId: o.versionId } : null;
  }

  async head(key: string, versionId?: string | null): Promise<HeadResult | null> {
    const o = this.resolve(key, versionId);
    return o ? { etag: o.etag, size: o.body.length, objectVersionId: o.versionId } : null;
  }

  async del(key: string): Promise<void> {
    // Drops all versions — brain's delete-then-get-null contract; the ops path
    // is create-only and never deletes.
    this.objects.delete(key);
  }

  async listPrefix(prefix: string, opts: ListPrefixOpts = {}): Promise<ObjectListPage> {
    const limit = opts.limit ?? DEFAULT_LIST_PAGE;
    const after = opts.cursor ?? null;
    const keys = [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix) && (after === null || k > after))
      .sort();
    const page = keys.slice(0, limit);
    const items = page.map((key) => ({ key, versionId: this.latest(key)!.versionId }));
    const cursor = keys.length > page.length && page.length > 0 ? page[page.length - 1]! : null;
    return { items, cursor };
  }
}

// ---------- S3FileStore: the real backend (lazy AWS SDK) ----------

type S3Deps = Awaited<ReturnType<typeof loadS3>>;

async function loadS3() {
  // Lazy so commands that never touch object storage never pay the SDK's import cost.
  return await import('@aws-sdk/client-s3');
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  // NoSuchBucket is ALSO a 404, but it's a config/bucket failure, not a missing
  // object — never swallow it as null (it must surface to doctor/read paths).
  if (e?.name === 'NoSuchBucket') return false;
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

function isPreconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === 'PreconditionFailed' ||
    e?.$metadata?.httpStatusCode === 412 ||
    e?.$metadata?.httpStatusCode === 409
  );
}

function isNotImplemented(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotImplemented' || e?.$metadata?.httpStatusCode === 501;
}

class S3FileStore implements FileStore {
  private readonly sdk: S3Deps;
  private readonly client: InstanceType<S3Deps['S3Client']>;
  private readonly bucket: string;
  constructor(sdk: S3Deps, client: InstanceType<S3Deps['S3Client']>, bucket: string) {
    this.sdk = sdk;
    this.client = client;
    this.bucket = bucket;
  }

  async put(key: string, body: Buffer, opts: PutOpts = {}): Promise<PutResult> {
    const { PutObjectCommand } = this.sdk;
    const conditional = Boolean(opts.ifNoneMatch || opts.ifMatch);
    try {
      const res = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: opts.contentType,
          ...(opts.ifNoneMatch ? { IfNoneMatch: opts.ifNoneMatch } : {}),
          ...(opts.ifMatch ? { IfMatch: opts.ifMatch } : {}),
        }),
      );
      return { etag: normalizeEtag(res.ETag ?? ''), objectVersionId: res.VersionId ?? null };
    } catch (err) {
      // A conditional PUT that didn't meet its precondition: 412 (etag mismatch),
      // 409 (concurrent), or a 404/NoSuchKey (If-Match against a missing or
      // concurrently-deleted object). All mean the same thing to the caller —
      // the object changed underneath us — so surface the shared contract error.
      if (conditional && (isPreconditionFailed(err) || isNotFound(err))) {
        throw new ConditionalWriteFailed(key);
      }
      // NEVER silently downgrade a conditional PUT to unconditional: on a
      // provider that can't enforce the header that would overwrite an existing
      // object (ifNoneMatch) or clobber a stale-CAS target (ifMatch). Fail loud.
      if (conditional && isNotImplemented(err)) {
        throw new Error(
          `S3 endpoint does not support conditional writes (If-None-Match/If-Match); cannot safely put '${key}'`,
        );
      }
      throw err;
    }
  }

  async get(key: string, versionId?: string | null): Promise<GetResult | null> {
    const { GetObjectCommand } = this.sdk;
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }),
      );
      const bytes = await res.Body!.transformToByteArray();
      return { body: Buffer.from(bytes), etag: normalizeEtag(res.ETag ?? ''), objectVersionId: res.VersionId ?? null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string, versionId?: string | null): Promise<HeadResult | null> {
    const { HeadObjectCommand } = this.sdk;
    try {
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }),
      );
      return {
        etag: normalizeEtag(res.ETag ?? ''),
        size: res.ContentLength ?? 0,
        objectVersionId: res.VersionId ?? null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async del(key: string): Promise<void> {
    const { DeleteObjectCommand } = this.sdk;
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  // Enumerate the CURRENT (latest, non-delete-marker) objects under a prefix
  // with their version ids, via ListObjectVersions (the only S3 list that
  // returns version ids). Cursor packs the (KeyMarker, VersionIdMarker) pair.
  async listPrefix(prefix: string, opts: ListPrefixOpts = {}): Promise<ObjectListPage> {
    const { ListObjectVersionsCommand } = this.sdk;
    const limit = opts.limit ?? DEFAULT_LIST_PAGE;
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    if (opts.cursor) {
      const decoded = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8')) as {
        k?: string;
        v?: string;
      };
      keyMarker = decoded.k;
      versionIdMarker = decoded.v;
    }
    const res = await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: limit,
        ...(keyMarker ? { KeyMarker: keyMarker } : {}),
        ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
      }),
    );
    const items: ObjectVersionEntry[] = (res.Versions ?? [])
      .filter((v) => v.IsLatest && typeof v.Key === 'string')
      .map((v) => ({ key: v.Key!, versionId: v.VersionId ?? null }));
    const cursor =
      res.IsTruncated && res.NextKeyMarker
        ? Buffer.from(JSON.stringify({ k: res.NextKeyMarker, v: res.NextVersionIdMarker })).toString('base64url')
        : null;
    return { items, cursor };
  }
}

export type S3StoreConfig = {
  bucket: string;
  region: string | null;
  endpoint: string | null;
  forcePathStyle: boolean;
};

// Build a real S3-backed FileStore. Credentials come from the environment
// explicitly (never a ~/.aws profile that could shadow the intended identity —
// the athena vault precedent). Region falls back to us-east-1 for custom
// endpoints (R2/MinIO) that ignore it.
//
// Key prefixes are intentionally NOT applied here. The store treats every key
// as absolute: a prefix is baked into the key once, at derivation time, by the
// caller (brain fs's deriveKey persists the full key verbatim as
// brain.files.s3_key). Applying a prefix dynamically in the store would orphan
// every existing object the moment the configured prefix changed.
export async function createS3FileStore(
  fc: S3StoreConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FileStore> {
  const sdk = await loadS3();
  const client = new sdk.S3Client({
    region: fc.region ?? 'us-east-1',
    ...(fc.endpoint ? { endpoint: fc.endpoint } : {}),
    forcePathStyle: fc.forcePathStyle,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    },
  });
  return new S3FileStore(sdk, client, fc.bucket);
}
