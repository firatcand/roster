import type { BrainConfig } from './config.ts';

// A file's bytes live in S3 (mutable); the brain.files ledger records every
// event (append-only). The generic store machinery (FileStore port,
// MemoryFileStore, the SigV4 S3 client) lives in persistence/s3-core.ts and is
// re-exported here unchanged; only the BrainConfig-aware wiring below is
// brain-specific.

import { createS3FileStore as createS3FileStoreCore, type FileStore } from '../persistence/s3-core.ts';

export {
  ConditionalWriteFailed,
  MemoryFileStore,
  type FileStore,
  type GetResult,
  type HeadResult,
  type PutOpts,
  type PutResult,
} from '../persistence/s3-core.ts';

// ---------- FilesConfig: resolve S3 wiring from brain config + env ----------

export type FilesConfig = {
  bucket: string;
  region: string | null;
  endpoint: string | null;
  prefix: string;
  forcePathStyle: boolean;
};

// Resolve the S3 file store from config + environment. Returns null (feature
// off) when no bucket is configured or the AWS credentials are absent — never
// throws (the resolveEmbedder precedent). Credentials are ALWAYS env-only; the
// bucket/region/endpoint/prefix come from the non-secret brain config.
//
// fc.prefix is intentionally NOT applied by the store. It is baked into the key
// once, at derivation time, by `brain fs`'s deriveKey (ROS-159), and the
// resulting full key is persisted verbatim as brain.files.s3_key — the same
// verbatim-identity invariant the 009_files.sql source_path column enforces.
export function filesConfig(cfg: BrainConfig, env: NodeJS.ProcessEnv = process.env): FilesConfig | null {
  if (!cfg.filesBucket) return null;
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  return {
    bucket: cfg.filesBucket,
    region: cfg.filesRegion ?? env.AWS_REGION ?? null,
    endpoint: cfg.filesEndpoint,
    prefix: cfg.filesPrefix,
    forcePathStyle: cfg.filesForcePathStyle,
  };
}

export async function createS3FileStore(
  fc: FilesConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FileStore> {
  return createS3FileStoreCore(fc, env);
}
