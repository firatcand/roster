import { HeadObjectCommand, ListObjectVersionsCommand, S3Client } from '@aws-sdk/client-s3';
import {
  createS3NetworkBoundary,
  deriveS3Origin,
  S3NetworkPolicyError,
  type S3EndpointConfig,
} from './s3-network-policy.ts';
import { brainObjectNamespaceFingerprint } from './object-store.ts';
import {
  decodeLegacyS3Cursor,
  encodeLegacyS3Cursor,
  normalizeLegacyObjectPrefix,
  type LegacyObjectHeadVersion,
  type LegacyObjectHistoryObservation,
  type LegacyObjectHistoryPage,
  type LegacyObjectHistoryReader,
} from './legacy-inventory.ts';

export const LEGACY_S3_DEFAULT_PAGE_SIZE = 1_000;

const ETAG_TEXT = /^"?[A-Za-z0-9._-]{1,128}"?$/u;
const VERSION_ID_TEXT = /^[\x21-\x7e]{1,1024}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_KEY_BYTES = 1_024;

export type LegacyObjectHistoryConfig = S3EndpointConfig & {
  prefix: string;
  pageSize?: number;
};

export type RawLegacyObjectVersion = {
  Key?: string;
  VersionId?: string;
  IsLatest?: boolean;
  ETag?: string;
  Size?: number;
};

export type RawLegacyDeleteMarker = {
  Key?: string;
  VersionId?: string;
  IsLatest?: boolean;
};

export type RawLegacyListVersionsResult = {
  Versions?: RawLegacyObjectVersion[];
  DeleteMarkers?: RawLegacyDeleteMarker[];
  CommonPrefixes?: unknown[];
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextVersionIdMarker?: string;
};

export type RawLegacyHeadResult = {
  ETag?: string;
  ContentLength?: number;
  VersionId?: string;
};

export type LegacyS3HistoryTransport = {
  listVersions(input: {
    bucket: string;
    prefix: string | null;
    maxKeys: number;
    keyMarker: string | null;
    versionIdMarker: string | null;
  }): Promise<RawLegacyListVersionsResult>;
  headObject(input: { bucket: string; key: string; versionId: string }): Promise<RawLegacyHeadResult | null>;
  destroy(): void;
};

export class LegacyInventoryS3Error extends Error {
  readonly code = 'LEGACY_INVENTORY_S3_DENIED';
  readonly reason: string;

  constructor(reason: string) {
    super(`legacy inventory S3 read denied (${reason})`);
    this.name = 'LegacyInventoryS3Error';
    this.reason = reason;
  }
}

function providerFailure(error: unknown, fallback: 'list-failed' | 'head-failed'): never {
  if (error instanceof S3NetworkPolicyError) throw new LegacyInventoryS3Error('network-policy-denied');
  throw new LegacyInventoryS3Error(fallback);
}

function isMissing(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (candidate?.name === 'NoSuchBucket') return false;
  return candidate?.name === 'NoSuchKey'
    || candidate?.name === 'NotFound'
    || candidate?.name === 'NoSuchVersion'
    || candidate?.$metadata?.httpStatusCode === 404;
}

function explicitCredentials(env: NodeJS.ProcessEnv): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new LegacyInventoryS3Error('credentials-missing');
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  };
}

class AwsLegacyS3HistoryTransport implements LegacyS3HistoryTransport {
  private readonly client: S3Client;

  constructor(client: S3Client) {
    this.client = client;
  }

  async listVersions(input: {
    bucket: string;
    prefix: string | null;
    maxKeys: number;
    keyMarker: string | null;
    versionIdMarker: string | null;
  }): Promise<RawLegacyListVersionsResult> {
    try {
      const result = await this.client.send(new ListObjectVersionsCommand({
        Bucket: input.bucket,
        MaxKeys: input.maxKeys,
        ...(input.prefix === null ? {} : { Prefix: input.prefix }),
        ...(input.keyMarker === null ? {} : { KeyMarker: input.keyMarker }),
        ...(input.versionIdMarker === null || input.versionIdMarker.length === 0
          ? {}
          : { VersionIdMarker: input.versionIdMarker }),
      }));
      return {
        ...(result.Versions === undefined ? {} : { Versions: result.Versions }),
        ...(result.DeleteMarkers === undefined ? {} : { DeleteMarkers: result.DeleteMarkers }),
        ...(result.CommonPrefixes === undefined ? {} : { CommonPrefixes: result.CommonPrefixes }),
        ...(result.IsTruncated === undefined ? {} : { IsTruncated: result.IsTruncated }),
        ...(result.NextKeyMarker === undefined ? {} : { NextKeyMarker: result.NextKeyMarker }),
        ...(result.NextVersionIdMarker === undefined ? {} : { NextVersionIdMarker: result.NextVersionIdMarker }),
      };
    } catch (error) {
      providerFailure(error, 'list-failed');
    }
  }

  async headObject(input: { bucket: string; key: string; versionId: string }): Promise<RawLegacyHeadResult | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        VersionId: input.versionId,
      }));
      return {
        ...(result.ETag === undefined ? {} : { ETag: result.ETag }),
        ...(result.ContentLength === undefined ? {} : { ContentLength: result.ContentLength }),
        ...(result.VersionId === undefined ? {} : { VersionId: result.VersionId }),
      };
    } catch (error) {
      if (isMissing(error)) return null;
      providerFailure(error, 'head-failed');
    }
  }

  destroy(): void {
    this.client.destroy();
  }
}

function requireVersionId(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  if (!VERSION_ID_TEXT.test(raw)) throw new LegacyInventoryS3Error('invalid-version-id');
  return raw;
}

function requireKey(raw: string | undefined, prefixSlash: string): string {
  if (
    typeof raw !== 'string'
    || raw.length === 0
    || Buffer.byteLength(raw, 'utf8') > MAX_KEY_BYTES
    || CONTROL_CHARS.test(raw)
  ) {
    throw new LegacyInventoryS3Error('invalid-key');
  }
  if (prefixSlash.length > 0 && !raw.startsWith(prefixSlash)) {
    throw new LegacyInventoryS3Error('prefix-escape');
  }
  return raw;
}

class BoundedLegacyObjectHistoryReader implements LegacyObjectHistoryReader {
  readonly bucket: string;
  readonly prefix: string;
  readonly namespaceFingerprint: string;
  private readonly transport: LegacyS3HistoryTransport;
  private readonly pageSize: number;
  private readonly prefixSlash: string;

  constructor(
    transport: LegacyS3HistoryTransport,
    bucket: string,
    prefix: string,
    pageSize: number,
    namespaceFingerprint: string,
  ) {
    this.transport = transport;
    this.bucket = bucket;
    this.prefix = prefix;
    this.pageSize = pageSize;
    this.prefixSlash = prefix.length === 0 ? '' : `${prefix}/`;
    this.namespaceFingerprint = namespaceFingerprint;
  }

  async listHistory(cursor: string | null): Promise<LegacyObjectHistoryPage> {
    let keyMarker: string | null = null;
    let versionIdMarker: string | null = null;
    if (cursor !== null) {
      const decoded = decodeLegacyS3Cursor(cursor);
      if (decoded === null) throw new LegacyInventoryS3Error('invalid-cursor');
      if (decoded.namespaceFingerprint !== this.namespaceFingerprint) {
        throw new LegacyInventoryS3Error('cursor-namespace-mismatch');
      }
      keyMarker = decoded.keyMarker;
      versionIdMarker = decoded.versionMarker;
    }
    const result = await this.transport.listVersions({
      bucket: this.bucket,
      prefix: this.prefixSlash.length === 0 ? null : this.prefixSlash,
      maxKeys: this.pageSize,
      keyMarker,
      versionIdMarker,
    });
    if (Array.isArray(result.CommonPrefixes) && result.CommonPrefixes.length > 0) {
      throw new LegacyInventoryS3Error('unexpected-common-prefixes');
    }
    const entries: LegacyObjectHistoryObservation[] = [];
    for (const version of result.Versions ?? []) {
      if (typeof version.IsLatest !== 'boolean') throw new LegacyInventoryS3Error('missing-is-latest');
      if (typeof version.ETag !== 'string' || !ETAG_TEXT.test(version.ETag)) {
        throw new LegacyInventoryS3Error('missing-etag');
      }
      if (!Number.isSafeInteger(version.Size) || (version.Size as number) < 0) {
        throw new LegacyInventoryS3Error('missing-size');
      }
      entries.push({
        kind: 'version',
        key: requireKey(version.Key, this.prefixSlash),
        versionId: requireVersionId(version.VersionId),
        isLatest: version.IsLatest,
        etag: version.ETag,
        sizeBytes: String(version.Size),
      });
    }
    for (const marker of result.DeleteMarkers ?? []) {
      if (typeof marker.IsLatest !== 'boolean') throw new LegacyInventoryS3Error('missing-is-latest');
      entries.push({
        kind: 'delete-marker',
        key: requireKey(marker.Key, this.prefixSlash),
        versionId: requireVersionId(marker.VersionId),
        isLatest: marker.IsLatest,
        etag: null,
        sizeBytes: null,
      });
    }
    if (typeof result.IsTruncated !== 'boolean') {
      throw new LegacyInventoryS3Error('malformed-page');
    }
    if (!result.IsTruncated) {
      return { entries, cursor: null };
    }
    if (typeof result.NextKeyMarker !== 'string' || result.NextKeyMarker.length === 0) {
      throw new LegacyInventoryS3Error('truncated-without-key-marker');
    }
    const nextKeyMarker = requireKey(result.NextKeyMarker, this.prefixSlash);
    const nextVersionMarker = result.NextVersionIdMarker;
    if (nextVersionMarker !== undefined && !VERSION_ID_TEXT.test(nextVersionMarker)) {
      throw new LegacyInventoryS3Error('invalid-version-marker');
    }
    return {
      entries,
      cursor: encodeLegacyS3Cursor({
        namespaceFingerprint: this.namespaceFingerprint,
        keyMarker: nextKeyMarker,
        versionMarker: nextVersionMarker ?? '',
      }),
    };
  }

  async headVersion(input: { key: string; versionId: string }): Promise<LegacyObjectHeadVersion | null> {
    const key = requireKey(input.key, this.prefixSlash);
    if (!VERSION_ID_TEXT.test(input.versionId)) throw new LegacyInventoryS3Error('invalid-version-id');
    const result = await this.transport.headObject({ bucket: this.bucket, key, versionId: input.versionId });
    if (result === null) return null;
    if (result.ETag !== undefined && !ETAG_TEXT.test(result.ETag)) {
      throw new LegacyInventoryS3Error('invalid-etag');
    }
    if (!Number.isSafeInteger(result.ContentLength) || (result.ContentLength as number) < 0) {
      throw new LegacyInventoryS3Error('missing-size');
    }
    const versionId = result.VersionId === undefined ? null : result.VersionId;
    if (versionId !== null && !VERSION_ID_TEXT.test(versionId)) {
      throw new LegacyInventoryS3Error('invalid-version-id');
    }
    return {
      etag: result.ETag ?? null,
      sizeBytes: String(result.ContentLength),
      versionId,
    };
  }
}

export function createLegacyObjectHistoryReader(
  config: LegacyObjectHistoryConfig,
  env: NodeJS.ProcessEnv = process.env,
  deps: { transport?: LegacyS3HistoryTransport } = {},
): { reader: LegacyObjectHistoryReader; close: () => void } {
  if (typeof config.region !== 'string' || config.region.length === 0) {
    throw new LegacyInventoryS3Error('missing-region');
  }
  const prefix = normalizeLegacyObjectPrefix(config.prefix);
  const pageSize = config.pageSize ?? LEGACY_S3_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new LegacyInventoryS3Error('invalid-page-size');
  }
  const endpointConfig: S3EndpointConfig = {
    bucket: config.bucket,
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle,
  };
  deriveS3Origin(endpointConfig);
  const namespaceFingerprint = brainObjectNamespaceFingerprint({
    ...endpointConfig,
    ...(prefix.length === 0 ? {} : { rootPrefix: prefix }),
  });
  let transport = deps.transport;
  if (transport === undefined) {
    const credentials = explicitCredentials(env);
    const { requestHandler } = createS3NetworkBoundary(endpointConfig);
    transport = new AwsLegacyS3HistoryTransport(new S3Client({
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
    }));
  }
  const reader = new BoundedLegacyObjectHistoryReader(transport, config.bucket, prefix, pageSize, namespaceFingerprint);
  return {
    reader,
    close: () => transport.destroy(),
  };
}
