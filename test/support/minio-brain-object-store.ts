import { randomBytes } from 'node:crypto';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  ContentAddressedBrainObjectStore,
  brainObjectStoreConfigFromRegistry,
  type BrainObjectReader,
  type BrainObjectStore,
  type BrainObjectTransport,
  type TransportGetResult,
  type TransportHeadResult,
  type TransportObservation,
} from '../../src/lib/brain/object-store.ts';
import type { WorkspaceBrainConfig } from '../../src/lib/workspace-record.ts';

export const S3_TEST_ENDPOINT = process.env.ROSTER_TEST_S3_ENDPOINT ?? '';
export const HAS_TEST_S3 = S3_TEST_ENDPOINT.length > 0;
export const S3_SKIP_REASON = 'ROSTER_TEST_S3_ENDPOINT not set';

function isMissing(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate?.name === 'NoSuchKey'
    || candidate?.name === 'NotFound'
    || candidate?.$metadata?.httpStatusCode === 404;
}

// The production factory composes this same transport shape with the strict
// https/global-address network boundary, which by design can never reach a
// loopback MinIO. The boundary lives in the FACTORY, not in the store class, so
// the evaluation composes the production store class with a test transport and
// keeps every content-addressing, digest-verification and key-layout guarantee.
class TestS3ObjectTransport implements BrainObjectTransport {
  private readonly client: S3Client;

  constructor(client: S3Client) {
    this.client = client;
  }

  async putIfAbsent(input: {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
    checksumSHA256: string;
  }): Promise<TransportObservation> {
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

  async head(input: { bucket: string; key: string; versionId?: string }): Promise<TransportHeadResult | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        ...(input.versionId === undefined ? {} : { VersionId: input.versionId }),
      }));
      return { contentLength: result.ContentLength, etag: result.ETag, versionId: result.VersionId };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async get(input: { bucket: string; key: string; versionId?: string }): Promise<TransportGetResult | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        ...(input.versionId === undefined ? {} : { VersionId: input.versionId }),
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

export function minioBrainConfig(bucket: string): WorkspaceBrainConfig {
  return {
    secrets_path: '/retrieval-gold-workspace',
    storage: {
      bucket,
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint: S3_TEST_ENDPOINT,
      force_path_style: true,
    },
  };
}

export function freshMinioBucketName(): string {
  return `roster-gold-${randomBytes(6).toString('hex')}`;
}

export async function createMinioBrainObjectStore(
  brainConfig: WorkspaceBrainConfig,
): Promise<BrainObjectStore & BrainObjectReader> {
  const config = brainObjectStoreConfigFromRegistry(brainConfig);
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint!,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    },
  });
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
  return new ContentAddressedBrainObjectStore(new TestS3ObjectTransport(client), config);
}
