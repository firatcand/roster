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

export type PutResult = { etag: string };
export type GetResult = { body: Buffer; etag: string };
export type HeadResult = { etag: string; size: number };

export interface FileStore {
  put(key: string, body: Buffer, opts?: PutOpts): Promise<PutResult>;
  // null when the key does not exist (S3 404 / NoSuchKey).
  get(key: string): Promise<GetResult | null>;
  head(key: string): Promise<HeadResult | null>;
  // Idempotent: deleting a missing key is not an error (S3 returns 204).
  del(key: string): Promise<void>;
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
// equal to one stored in real S3.
export class MemoryFileStore implements FileStore {
  private readonly objects = new Map<string, { body: Buffer; etag: string }>();

  private etagOf(body: Buffer): string {
    return createHash('md5').update(body).digest('hex');
  }

  async put(key: string, body: Buffer, opts: PutOpts = {}): Promise<PutResult> {
    const existing = this.objects.get(key);
    if (opts.ifNoneMatch === '*' && existing) throw new ConditionalWriteFailed(key);
    if (opts.ifMatch !== undefined && (!existing || existing.etag !== opts.ifMatch)) {
      throw new ConditionalWriteFailed(key);
    }
    const etag = this.etagOf(body);
    this.objects.set(key, { body: Buffer.from(body), etag });
    return { etag };
  }

  async get(key: string): Promise<GetResult | null> {
    const o = this.objects.get(key);
    return o ? { body: Buffer.from(o.body), etag: o.etag } : null;
  }

  async head(key: string): Promise<HeadResult | null> {
    const o = this.objects.get(key);
    return o ? { etag: o.etag, size: o.body.length } : null;
  }

  async del(key: string): Promise<void> {
    this.objects.delete(key);
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
      return { etag: normalizeEtag(res.ETag ?? '') };
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

  async get(key: string): Promise<GetResult | null> {
    const { GetObjectCommand } = this.sdk;
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await res.Body!.transformToByteArray();
      return { body: Buffer.from(bytes), etag: normalizeEtag(res.ETag ?? '') };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async head(key: string): Promise<HeadResult | null> {
    const { HeadObjectCommand } = this.sdk;
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { etag: normalizeEtag(res.ETag ?? ''), size: res.ContentLength ?? 0 };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async del(key: string): Promise<void> {
    const { DeleteObjectCommand } = this.sdk;
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
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
