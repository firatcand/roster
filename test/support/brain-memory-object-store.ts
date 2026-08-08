import { createHash } from 'node:crypto';
import type {
  BrainObjectCreateResult,
  BrainObjectInspection,
  BrainObjectRead,
  BrainObjectReader,
  BrainObjectStore,
} from '../../src/lib/brain/object-store.ts';

export function objectKeyFor(sha256: string): string {
  return `objects/${sha256.slice(0, 2)}/${sha256}`;
}

export function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class MemoryBrainObjectStore implements BrainObjectStore, BrainObjectReader {
  readonly namespaceFingerprint: string;
  readonly objects = new Map<string, Buffer>();
  readonly versionIds = new Map<string, string>();
  readonly readCalls: { sha256: string; versionId: string | null }[] = [];
  readonly createCalls: string[] = [];
  private readonly corrupted = new Set<string>();
  private readonly withheld = new Set<string>();

  constructor(namespaceFingerprint: string) {
    this.namespaceFingerprint = namespaceFingerprint;
  }

  corrupt(sha256: string): void {
    this.corrupted.add(sha256);
  }

  repair(sha256: string): void {
    this.corrupted.delete(sha256);
    this.withheld.delete(sha256);
  }

  withhold(sha256: string): void {
    this.withheld.add(sha256);
  }

  async createOrVerify(input: {
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<BrainObjectCreateResult> {
    this.createCalls.push(input.sha256);
    const bytes = Buffer.from(input.bytes);
    const existing = this.objects.get(input.sha256);
    if (existing === undefined) this.objects.set(input.sha256, bytes);
    const versionId = this.versionIds.get(input.sha256) ?? null;
    return {
      outcome: existing === undefined ? 'stored' : 'exists',
      key: objectKeyFor(input.sha256),
      sha256: input.sha256,
      byteLength: bytes.byteLength,
      etag: null,
      versionId,
    };
  }

  async inspect(input: {
    sha256: string;
    byteLength: number;
    versionId?: string | null;
  }): Promise<BrainObjectInspection> {
    const read = await this.readVerified(input);
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
    this.readCalls.push({ sha256: input.sha256, versionId: input.versionId ?? null });
    const key = objectKeyFor(input.sha256);
    if (this.withheld.has(input.sha256)) return { status: 'missing', key };
    const stored = this.objects.get(input.sha256);
    if (stored === undefined) return { status: 'missing', key };
    if (this.corrupted.has(input.sha256)) return { status: 'corrupt', key, reason: 'digest' };
    if (stored.byteLength !== input.byteLength) return { status: 'corrupt', key, reason: 'size' };
    if (digestOf(stored) !== input.sha256) return { status: 'corrupt', key, reason: 'digest' };
    return {
      status: 'verified',
      bytes: stored,
      key,
      sha256: input.sha256,
      byteLength: stored.byteLength,
      etag: null,
      versionId: this.versionIds.get(input.sha256) ?? null,
    };
  }

  close(): void {}
}
