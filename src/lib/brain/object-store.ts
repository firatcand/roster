import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  createS3NetworkBoundary,
  type S3EndpointConfig,
} from './s3-network-policy.ts';
import { MAX_SOURCE_BYTES } from './source-contracts.ts';
import { fingerprintBrainNamespace } from '../workspace-record.ts';

const SHA256_RE = /^[0-9a-f]{64}$/u;
const CONTENT_TYPE_RE = /^[\x20-\x7e]{1,255}$/u;

export const MAX_BRAIN_OBJECT_BYTES = MAX_SOURCE_BYTES;

export type BrainObjectStoreConfig = S3EndpointConfig & {
  rootPrefix?: string;
};

export type BrainObjectObservation = {
  key: string;
  sha256: string;
  byteLength: number;
  etag: string | null;
  versionId: string | null;
};

export type BrainObjectCreateResult = BrainObjectObservation & {
  outcome: 'stored' | 'exists';
};

export type BrainObjectInspection =
  | ({ status: 'verified' } & BrainObjectObservation)
  | { status: 'missing'; key: string }
  | { status: 'corrupt'; key: string; reason: 'size' | 'digest' | 'body' };

export type BrainObjectRead =
  | ({ status: 'verified'; bytes: Buffer } & BrainObjectObservation)
  | { status: 'missing'; key: string }
  | { status: 'corrupt'; key: string; reason: 'size' | 'digest' | 'body' };

export interface BrainObjectStore {
  readonly namespaceFingerprint: string;
  createOrVerify(input: {
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<BrainObjectCreateResult>;
  inspect(input: {
    sha256: string;
    byteLength: number;
    versionId?: string | null;
  }): Promise<BrainObjectInspection>;
  close(): void;
}

// Additive read surface for callers that must consume the exact immutable bytes
// (extraction, #370). Deliberately separate from BrainObjectStore so existing
// implementors keep their signature.
export interface BrainObjectReader {
  readonly namespaceFingerprint: string;
  readVerified(input: {
    sha256: string;
    byteLength: number;
    versionId?: string | null;
  }): Promise<BrainObjectRead>;
}

type TransportPutInput = {
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  checksumSHA256: string;
};

type TransportObjectInput = {
  bucket: string;
  key: string;
  versionId?: string;
};

export type TransportObservation = {
  etag?: string;
  versionId?: string;
};

export type TransportHeadResult = TransportObservation & {
  contentLength?: number;
};

export type TransportGetResult = TransportHeadResult & {
  body?: unknown;
};

export interface BrainObjectTransport {
  putIfAbsent(input: TransportPutInput): Promise<TransportObservation>;
  head(input: TransportObjectInput): Promise<TransportHeadResult | null>;
  get(input: TransportObjectInput): Promise<TransportGetResult | null>;
  close(): void;
}

export class BrainObjectStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BrainObjectStoreError';
    this.code = code;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertDigest(digest: string): void {
  if (!SHA256_RE.test(digest)) {
    throw new BrainObjectStoreError('INVALID_OBJECT_DIGEST', 'object digest must be lowercase SHA-256 hex');
  }
}

function assertByteLength(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_BRAIN_OBJECT_BYTES) {
    throw new BrainObjectStoreError('INVALID_OBJECT_SIZE', 'object size is outside the supported bound');
  }
}

function normalizeRootPrefix(rootPrefix: string | undefined): string | null {
  if (rootPrefix === undefined) return null;
  if (rootPrefix.length === 0
    || Buffer.byteLength(rootPrefix, 'utf8') > 757
    || rootPrefix.startsWith('/')
    || rootPrefix.endsWith('/')
    || rootPrefix.includes('\\')
    || /[\u0000-\u001f\u007f-\u009f]/u.test(rootPrefix)
    || rootPrefix.split('/').some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new BrainObjectStoreError('INVALID_OBJECT_PREFIX', 'object root prefix is invalid');
  }
  return rootPrefix;
}

export function brainObjectKey(rootPrefix: string | undefined, digest: string): string {
  assertDigest(digest);
  const root = normalizeRootPrefix(rootPrefix);
  const relative = `objects/${digest.slice(0, 2)}/${digest}`;
  return root === null ? relative : `${root}/${relative}`;
}

export function brainObjectNamespaceFingerprint(config: BrainObjectStoreConfig): string {
  return fingerprintBrainNamespace({
    secrets_path: '/roster/brain-object-store',
    storage: {
      bucket: config.bucket,
      region: config.region,
      ...(config.rootPrefix === undefined ? {} : { root_prefix: config.rootPrefix }),
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
      force_path_style: config.forcePathStyle,
    },
  }).fingerprint;
}

function observationValue(value: string | undefined, field: string): string | null {
  if (value === undefined || value.length === 0) return null;
  if (Buffer.byteLength(value, 'utf8') > 1_024 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new BrainObjectStoreError('INVALID_S3_RESPONSE', `S3 returned an invalid ${field} observation`);
  }
  return value;
}

function isMissing(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (candidate?.name === 'NoSuchBucket') return false;
  return candidate?.name === 'NoSuchKey'
    || candidate?.name === 'NotFound'
    || candidate?.$metadata?.httpStatusCode === 404;
}

function isConditionalConflict(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate?.name === 'PreconditionFailed'
    || candidate?.$metadata?.httpStatusCode === 409
    || candidate?.$metadata?.httpStatusCode === 412;
}

function isAmbiguousWriteFailure(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === undefined || status >= 500;
}

function destroyBody(body: unknown): void {
  if (body !== null && typeof body === 'object' && 'destroy' in body) {
    const destroy = (body as { destroy?: unknown }).destroy;
    if (typeof destroy === 'function') destroy.call(body);
  }
}

async function hashBody(
  body: unknown,
  maximum: number,
  collect = false,
): Promise<{ digest: string; byteLength: number; bytes: Buffer | null }> {
  if (body === null || typeof body !== 'object' || !(Symbol.asyncIterator in body)) {
    throw new BrainObjectStoreError('INVALID_S3_RESPONSE', 'S3 returned a non-streaming object body');
  }
  const hash = createHash('sha256');
  const collected: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const rawChunk of body as AsyncIterable<unknown>) {
      if (!(rawChunk instanceof Uint8Array)) {
        throw new BrainObjectStoreError('INVALID_S3_RESPONSE', 'S3 returned an invalid object body chunk');
      }
      byteLength += rawChunk.byteLength;
      if (byteLength > maximum) {
        throw new BrainObjectStoreError('OBJECT_BODY_LIMIT', 'S3 object exceeded its expected byte length');
      }
      hash.update(rawChunk);
      if (collect) collected.push(rawChunk);
    }
  } catch (error) {
    destroyBody(body);
    throw error;
  }
  return {
    digest: hash.digest('hex'),
    byteLength,
    bytes: collect ? Buffer.concat(collected, byteLength) : null,
  };
}

function toObservation(
  key: string,
  digest: string,
  byteLength: number,
  transport: TransportObservation,
): BrainObjectObservation {
  return {
    key,
    sha256: digest,
    byteLength,
    etag: observationValue(transport.etag, 'ETag'),
    versionId: observationValue(transport.versionId, 'version ID'),
  };
}

export class ContentAddressedBrainObjectStore implements BrainObjectStore, BrainObjectReader {
  readonly namespaceFingerprint: string;
  private readonly transport: BrainObjectTransport;
  private readonly bucket: string;
  private readonly rootPrefix: string | undefined;

  constructor(transport: BrainObjectTransport, config: BrainObjectStoreConfig) {
    this.transport = transport;
    this.bucket = config.bucket;
    this.rootPrefix = normalizeRootPrefix(config.rootPrefix) ?? undefined;
    this.namespaceFingerprint = brainObjectNamespaceFingerprint(config);
  }

  async createOrVerify(input: {
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<BrainObjectCreateResult> {
    assertDigest(input.sha256);
    assertByteLength(input.bytes.byteLength);
    if (!CONTENT_TYPE_RE.test(input.contentType)) {
      throw new BrainObjectStoreError('INVALID_CONTENT_TYPE', 'object content type is invalid');
    }
    const actualDigest = sha256(input.bytes);
    if (actualDigest !== input.sha256) {
      throw new BrainObjectStoreError('OBJECT_DIGEST_MISMATCH', 'object bytes do not match their declared digest');
    }
    const objectKey = brainObjectKey(undefined, input.sha256);
    const key = brainObjectKey(this.rootPrefix, input.sha256);
    const body = Buffer.from(input.bytes);
    try {
      const stored = await this.transport.putIfAbsent({
        bucket: this.bucket,
        key,
        body,
        contentType: input.contentType,
        checksumSHA256: Buffer.from(input.sha256, 'hex').toString('base64'),
      });
      return {
        outcome: 'stored',
        ...toObservation(objectKey, input.sha256, body.byteLength, stored),
      };
    } catch (error) {
      const conditional = isConditionalConflict(error);
      if (!conditional && !isAmbiguousWriteFailure(error)) throw error;
      let inspection: BrainObjectInspection;
      try {
        inspection = await this.inspect({ sha256: input.sha256, byteLength: body.byteLength });
      } catch {
        throw error;
      }
      if (inspection.status === 'verified') {
        return { outcome: 'exists', ...inspection };
      }
      if (inspection.status === 'corrupt') {
        throw new BrainObjectStoreError(
          'OBJECT_INTEGRITY_CONFLICT',
          'content-addressed object key contains different or invalid bytes',
        );
      }
      if (conditional) {
        throw new BrainObjectStoreError(
          'OBJECT_RACE_UNREADABLE',
          'conditional object create lost but the existing object is not readable',
        );
      }
      throw error;
    }
  }

  async inspect(input: {
    sha256: string;
    byteLength: number;
    versionId?: string | null;
  }): Promise<BrainObjectInspection> {
    const read = await this.load(input, false);
    if (read.status !== 'verified') return read;
    return {
      status: 'verified',
      key: read.key,
      sha256: read.sha256,
      byteLength: read.byteLength,
      etag: read.etag,
      versionId: read.versionId,
    };
  }

  async readVerified(input: {
    sha256: string;
    byteLength: number;
    versionId?: string | null;
  }): Promise<BrainObjectRead> {
    return await this.load(input, true);
  }

  private async load(input: {
    sha256: string;
    byteLength: number;
    versionId?: string | null;
  }, collect: boolean): Promise<BrainObjectRead> {
    assertDigest(input.sha256);
    assertByteLength(input.byteLength);
    const objectKey = brainObjectKey(undefined, input.sha256);
    const key = brainObjectKey(this.rootPrefix, input.sha256);
    const versionId = observationValue(input.versionId ?? undefined, 'version ID');
    const objectInput: TransportObjectInput = {
      bucket: this.bucket,
      key,
      ...(versionId === null ? {} : { versionId }),
    };
    const head = await this.transport.head(objectInput);
    if (head === null) return { status: 'missing', key: objectKey };
    if (!Number.isSafeInteger(head.contentLength) || head.contentLength !== input.byteLength) {
      return { status: 'corrupt', key: objectKey, reason: 'size' };
    }
    const object = await this.transport.get(objectInput);
    if (object === null) return { status: 'missing', key: objectKey };
    if (object.contentLength !== undefined
      && (!Number.isSafeInteger(object.contentLength) || object.contentLength !== input.byteLength)) {
      destroyBody(object.body);
      return { status: 'corrupt', key: objectKey, reason: 'size' };
    }
    let hashed: { digest: string; byteLength: number; bytes: Buffer | null };
    try {
      hashed = await hashBody(object.body, input.byteLength, collect);
    } catch (error) {
      if (error instanceof BrainObjectStoreError && error.code === 'OBJECT_BODY_LIMIT') {
        return { status: 'corrupt', key: objectKey, reason: 'size' };
      }
      if (error instanceof BrainObjectStoreError && error.code === 'INVALID_S3_RESPONSE') {
        return { status: 'corrupt', key: objectKey, reason: 'body' };
      }
      throw error;
    }
    if (hashed.byteLength !== input.byteLength) return { status: 'corrupt', key: objectKey, reason: 'size' };
    if (hashed.digest !== input.sha256) return { status: 'corrupt', key: objectKey, reason: 'digest' };
    return {
      status: 'verified',
      bytes: hashed.bytes ?? Buffer.alloc(0),
      ...toObservation(objectKey, input.sha256, input.byteLength, {
        etag: object.etag ?? head.etag,
        versionId: object.versionId ?? head.versionId,
      }),
    };
  }

  close(): void {
    this.transport.close();
  }
}

class AwsS3ObjectTransport implements BrainObjectTransport {
  private readonly client: S3Client;

  constructor(client: S3Client) {
    this.client = client;
  }

  async putIfAbsent(input: TransportPutInput): Promise<TransportObservation> {
    const result = await this.client.send(new PutObjectCommand({
      Bucket: input.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ChecksumSHA256: input.checksumSHA256,
      IfNoneMatch: '*',
    }));
    return { etag: result.ETag, versionId: result.VersionId };
  }

  async head(input: TransportObjectInput): Promise<TransportHeadResult | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        ...(input.versionId ? { VersionId: input.versionId } : {}),
      }));
      return {
        contentLength: result.ContentLength,
        etag: result.ETag,
        versionId: result.VersionId,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async get(input: TransportObjectInput): Promise<TransportGetResult | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        ...(input.versionId ? { VersionId: input.versionId } : {}),
      }));
      return {
        body: result.Body,
        contentLength: result.ContentLength,
        etag: result.ETag,
        versionId: result.VersionId,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  close(): void {
    this.client.destroy();
  }
}

function explicitCredentials(env: NodeJS.ProcessEnv): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new BrainObjectStoreError(
      'S3_CREDENTIALS_MISSING',
      'S3 credentials are unavailable in the command environment',
    );
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  };
}

export function createBrainObjectStore(
  config: BrainObjectStoreConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrainObjectStore {
  const credentials = explicitCredentials(env);
  const { requestHandler } = createS3NetworkBoundary(config);
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle,
    followRegionRedirects: false,
    useAccelerateEndpoint: false,
    useDualstackEndpoint: false,
    useFipsEndpoint: false,
    useGlobalEndpoint: false,
    useArnRegion: false,
    disableMultiregionAccessPoints: true,
    maxAttempts: 3,
    credentials,
    requestHandler,
  });
  return new ContentAddressedBrainObjectStore(new AwsS3ObjectTransport(client), config);
}
