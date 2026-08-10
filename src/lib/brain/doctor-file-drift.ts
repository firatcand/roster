import type pg from 'pg';
import { loadConfig } from './config.ts';
import { filesConfig, createS3FileStore, type FileStore } from './s3.ts';
import type { DoctorCheck } from './doctor.ts';

// Injection seam: tests supply a MemoryFileStore so the drift check runs against
// a fake object store instead of real S3.
export type DoctorDeps = {
  fileStore?: () => Promise<FileStore>;
};

// Reconcile the brain.files ledger against the S3 object store (ROS-160). Unlike
// every other doctor check this is async + network-bound, so it is appended
// after the SQL checks. It NEVER fails an unconfigured brain: absent ledger, no
// files.bucket, or no credentials all return ok:true with a "skipped" detail.
// Only a CONFIGURED-but-inconsistent brain fails — missing object, etag drift,
// or an object left behind after an rm. A configured-but-unreachable store is a
// real failure (ok:false), distinct from the unconfigured skip.
export async function checkFileDrift(
  client: pg.PoolClient | pg.Client,
  deps: DoctorDeps = {},
  opts: { maxHeads?: number } = {},
): Promise<DoctorCheck> {
  const name = 's3-file-drift';
  const maxHeads = opts.maxHeads ?? 200;

  const hasFiles = await client.query<{ t: string | null }>(`SELECT to_regclass('brain.files')::text AS t`);
  if (!hasFiles.rows[0]?.t) {
    return { name, ok: true, detail: 'skipped — no file ledger (pre-009 brain)' };
  }

  const cfg = await loadConfig(client);
  if (!cfg.filesBucket) {
    return { name, ok: true, detail: 'skipped — files.bucket not configured' };
  }

  let store: FileStore;
  if (deps.fileStore) {
    store = await deps.fileStore();
  } else {
    const fc = filesConfig(cfg);
    if (fc === null) {
      return { name, ok: true, detail: 'skipped — AWS credentials not configured' };
    }
    store = await createS3FileStore(fc);
  }

  // Only objects in the CURRENTLY-configured bucket are reconcilable — the store
  // can't HEAD an object under a bucket the config has since moved away from, so
  // both scans filter on it (else a still-valid object under an old bucket would
  // false-positive as "missing").
  const bucket = cfg.filesBucket;
  const violations: string[] = [];
  let truncated = false;
  try {
    // Current files: the object must exist and its etag must match what the put
    // recorded (an out-of-band edit changes the etag).
    const current = await client.query<{ kind: string; slug: string; filename: string; s3_key: string; etag: string | null }>(
      `SELECT kind, slug, filename, s3_key, etag FROM brain.current_files
        WHERE bucket = $2 ORDER BY kind, slug, filename LIMIT $1`,
      [maxHeads, bucket],
    );
    if (current.rowCount === maxHeads) truncated = true;
    for (const row of current.rows) {
      const head = await store.head(row.s3_key);
      const addr = `${row.kind}/${row.slug}/${row.filename}`;
      if (head === null) {
        violations.push(`missing: ${addr} (${row.s3_key})`);
      } else if (row.etag !== null && head.etag !== row.etag) {
        violations.push(`etag drift: ${addr} (${row.s3_key})`);
      }
    }

    // Orphans: any OBJECT whose latest ledger event is a tombstone should be gone
    // from S3. Keyed per source_path (the object identity), NOT per address — a
    // bucket/prefix change tombstones the old URI and re-puts the address at a new
    // one, so the abandoned old object's ADDRESS-latest is a 'put' even though the
    // object itself was tombstoned.
    const tombstoned = await client.query<{ source_path: string; s3_key: string }>(
      `SELECT source_path, s3_key FROM (
         SELECT DISTINCT ON (source_path) source_path, s3_key, bucket, op
         FROM brain.files ORDER BY source_path, id DESC
       ) h WHERE h.op = 'rm' AND h.bucket = $2 ORDER BY source_path LIMIT $1`,
      [maxHeads, bucket],
    );
    if (tombstoned.rowCount === maxHeads) truncated = true;
    for (const row of tombstoned.rows) {
      const head = await store.head(row.s3_key);
      if (head !== null) {
        violations.push(`orphaned after rm: ${row.source_path} (${row.s3_key})`);
      }
    }
  } catch (err) {
    return { name, ok: false, detail: `S3 store unreachable: ${(err as Error).message}` };
  }

  const scope = truncated ? ` (scan truncated at ${maxHeads} objects/scan — re-run after addressing these)` : '';
  if (violations.length === 0) {
    return { name, ok: true, detail: `bucket ${bucket}: ledger and S3 reconciled${scope}` };
  }
  return { name, ok: false, detail: `drift: ${violations.join(', ')}${scope}` };
}
