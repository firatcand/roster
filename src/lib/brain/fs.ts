import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type pg from 'pg';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import { type Embedder } from './embed.ts';
import { mountBytesTx } from './mount.ts';
import { ConditionalWriteFailed, type FileStore } from './s3.ts';

// The `brain fs` verbs: S3 holds the bytes, the brain.files ledger records every
// event. Files hang off the brain's existing kind/slug entity taxonomy, so a
// mounted document is reachable through everything the brain already exposes.

export type FileAddress = { kind: string; slug: string; filename: string };
export type FilesTarget = { bucket: string; prefix: string };

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// A single S3 key + display path segment: alnum start, then alnum/dot/dash/
// underscore, max 128. No '/' (would break the key layout) and no '..'
// (traversal). Applied to kind, slug, and filename before they touch a key.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeSegment(label: string, value: string): void {
  if (value.length === 0 || value.length > 128 || !SAFE_SEGMENT.test(value) || value.includes('..')) {
    throw new RosterError({
      header: `Invalid ${label}`,
      body: `'${value}' is not a valid ${label}. Use letters, digits, '.', '-', '_' (max 128, no '/' or '..').`,
      remedy: `Rename it and retry.`,
      exitCode: EXIT_ERROR,
    });
  }
}

export function deriveKey(prefix: string, addr: FileAddress): string {
  return `${prefix}files/${addr.kind}/${addr.slug}/${addr.filename}`;
}

export function sourceUri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

// Extensions we chunk + index. Everything else is stored as an opaque pointer.
const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.text', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.xml', '.html', '.htm', '.log', '.rst', '.ini', '.toml', '.conf',
]);

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.text': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.zip': 'application/zip',
};

function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

// Indexable = a text extension AND no NUL byte in the first 8 KiB (a cheap
// binary sniff — a stray NUL means it isn't the text we'd chunk usefully).
export function isIndexableText(filename: string, bytes: Buffer): boolean {
  if (!TEXT_EXTS.has(extname(filename).toLowerCase())) return false;
  const window = bytes.subarray(0, 8192);
  return !window.includes(0);
}

export type PutSpec = {
  kind: string;
  slug: string;
  file: string;
  filename?: string;
  actor?: string;
};

export type PutFileResult = {
  op: 'put';
  s3Key: string;
  sourcePath: string;
  indexed: boolean;
  chunks: number;
  embedded: boolean;
  entityExists: boolean;
  supersededUri: string | null;
};

// Store bytes in S3 (durable first), then record the ledger row + index in one
// transaction. S3-first means nothing in the ledger can point at bytes that
// never landed; a crash between the two leaves an S3 object with no ledger row,
// which `brain doctor` surfaces and a re-run heals.
export async function putFile(
  client: pg.PoolClient | pg.Client,
  store: FileStore,
  target: FilesTarget,
  spec: PutSpec,
  embedder: Embedder | null = null,
): Promise<PutFileResult> {
  const filename = spec.filename ?? basename(spec.file);
  assertSafeSegment('kind', spec.kind);
  assertSafeSegment('slug', spec.slug);
  assertSafeSegment('filename', filename);

  const localPath = resolve(spec.file);
  const bytes = readFileSync(localPath);
  const key = deriveKey(target.prefix, { kind: spec.kind, slug: spec.slug, filename });
  const uri = sourceUri(target.bucket, key);
  const contentHash = sha256(bytes);
  const contentType = contentTypeFor(filename);
  const indexable = isIndexableText(filename, bytes);

  await client.query('BEGIN');
  try {
    // Take the per-address advisory lock BEFORE the S3 write, so the whole
    // operation (S3 put + ledger insert) serializes per source_path. Without
    // this, two concurrent puts to one address could write S3 in one order but
    // commit their ledger rows in another, leaving current_files pointing at an
    // etag/hash that isn't the bytes now in S3. The lock is cluster-wide, so it
    // serializes across processes; mountBytesTx re-takes the same key (reentrant
    // within this txn). The trade-off — an open txn spanning the S3 network call
    // — only ever contends for concurrent puts to the SAME file, which is rare.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [uri]);

    // Conditional write: create-only if absent, CAS against the live etag if it
    // already exists — so we never clobber a concurrent writer's object.
    const live = await store.head(key);
    let etag: string;
    try {
      const put = live
        ? await store.put(key, bytes, { ifMatch: live.etag, contentType })
        : await store.put(key, bytes, { ifNoneMatch: '*', contentType });
      etag = put.etag;
    } catch (err) {
      if (err instanceof ConditionalWriteFailed) {
        throw new RosterError({
          header: `Concurrent write to ${spec.kind}/${spec.slug}/${filename}`,
          body: `The S3 object changed while this put was in flight.`,
          remedy: `Re-run 'roster brain fs put' to retry.`,
          exitCode: EXIT_ERROR,
        });
      }
      throw err;
    }

    let mountId: string | null = null;
    let chunks = 0;
    let embedded = false;
    if (indexable) {
      const m = await mountBytesTx(client, uri, bytes, embedder);
      mountId = m.mountId;
      chunks = m.chunks;
      embedded = m.embedded;
    }

    // Config-change guard: if this address' previous current row lived at a
    // DIFFERENT source_path (bucket/prefix changed), tombstone the old URI in the
    // same transaction. The view already self-corrects on the address, but the
    // explicit tombstone keeps the ledger honest and lets doctor flag the now
    // orphaned old S3 object.
    const prev = await client.query<{ source_path: string; bucket: string; s3_key: string }>(
      `SELECT source_path, bucket, s3_key FROM brain.current_files
        WHERE kind = $1 AND slug = $2 AND filename = $3`,
      [spec.kind, spec.slug, filename],
    );
    let supersededUri: string | null = null;
    if (prev.rowCount !== 0 && prev.rows[0]!.source_path !== uri) {
      const old = prev.rows[0]!;
      supersededUri = old.source_path;
      await client.query(
        `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, actor)
         VALUES ($1, $2, $3, 'rm', $4, $5, $6, $7)`,
        [spec.kind, spec.slug, filename, old.source_path, old.bucket, old.s3_key, spec.actor ?? null],
      );
    }

    await client.query(
      `INSERT INTO brain.files
         (kind, slug, filename, op, source_path, bucket, s3_key, size_bytes, content_hash, etag, content_type, mount_id, actor)
       VALUES ($1, $2, $3, 'put', $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [spec.kind, spec.slug, filename, uri, target.bucket, key, bytes.length, contentHash, etag, contentType, mountId, spec.actor ?? null],
    );

    const ent = await client.query(
      `SELECT 1 FROM brain.entities WHERE kind = $1 AND slug = $2 LIMIT 1`,
      [spec.kind, spec.slug],
    );
    const entityExists = ent.rowCount !== 0;

    await client.query('COMMIT');
    return { op: 'put', s3Key: key, sourcePath: uri, indexed: indexable, chunks, embedded, entityExists, supersededUri };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export type GetSpec = { kind: string; slug: string; filename: string; out?: string };
export type GetFileResult = { outPath: string; hashMatches: boolean; bytes: number };

function notFound(addr: FileAddress): RosterError {
  return new RosterError({
    header: `No current file ${addr.kind}/${addr.slug}/${addr.filename}`,
    body: `The brain has no current (non-removed) file at that address.`,
    remedy: `List files with 'roster brain fs ls --kind ${addr.kind} --slug ${addr.slug}'.`,
    exitCode: EXIT_ERROR,
  });
}

export async function getFile(
  client: pg.PoolClient | pg.Client,
  store: FileStore,
  spec: GetSpec,
): Promise<GetFileResult> {
  const addr = { kind: spec.kind, slug: spec.slug, filename: spec.filename };
  const row = await client.query<{ s3_key: string; content_hash: string | null }>(
    `SELECT s3_key, content_hash FROM brain.current_files
      WHERE kind = $1 AND slug = $2 AND filename = $3`,
    [spec.kind, spec.slug, spec.filename],
  );
  if (row.rowCount === 0) throw notFound(addr);

  const obj = await store.get(row.rows[0]!.s3_key);
  if (obj === null) {
    throw new RosterError({
      header: `File bytes missing for ${spec.kind}/${spec.slug}/${spec.filename}`,
      body: `The ledger has this file but the S3 object is gone (drift).`,
      remedy: `Run 'roster brain doctor' to reconcile.`,
      exitCode: EXIT_ERROR,
    });
  }

  const outPath = resolve(spec.out ?? `./${spec.filename}`);
  writeFileSync(outPath, obj.body);
  const hashMatches = row.rows[0]!.content_hash === sha256(obj.body);
  return { outPath, hashMatches, bytes: obj.body.length };
}

export type FileEntry = {
  kind: string;
  slug: string;
  filename: string;
  sourcePath: string;
  sizeBytes: number | null;
  indexed: boolean;
};

export async function listFiles(
  client: pg.PoolClient | pg.Client,
  filter: { kind?: string; slug?: string },
): Promise<FileEntry[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.kind !== undefined) {
    params.push(filter.kind);
    where.push(`kind = $${params.length}`);
  }
  if (filter.slug !== undefined) {
    params.push(filter.slug);
    where.push(`slug = $${params.length}`);
  }
  const r = await client.query<{
    kind: string;
    slug: string;
    filename: string;
    source_path: string;
    size_bytes: string | null;
    mount_id: string | null;
  }>(
    `SELECT kind, slug, filename, source_path, size_bytes, mount_id
       FROM brain.current_files
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY kind, slug, filename`,
    params,
  );
  return r.rows.map((row) => ({
    kind: row.kind,
    slug: row.slug,
    filename: row.filename,
    sourcePath: row.source_path,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    indexed: row.mount_id !== null,
  }));
}

export type RmSpec = { kind: string; slug: string; filename: string; actor?: string };
export type RmFileResult = { op: 'rm'; sourcePath: string; s3Deleted: boolean };

// Tombstone FIRST (ledger truth), then delete the S3 object. A failed S3 delete
// is a warning, not an error — the ledger is already correct, doctor surfaces
// the orphan, and a re-run retries the delete. Idempotent: re-running against an
// already-tombstoned file just retries the S3 delete if the object lingers.
export async function rmFile(
  client: pg.PoolClient | pg.Client,
  store: FileStore,
  spec: RmSpec,
): Promise<RmFileResult> {
  const addr = { kind: spec.kind, slug: spec.slug, filename: spec.filename };
  const latest = await client.query<{ op: string; source_path: string; bucket: string; s3_key: string }>(
    `SELECT op, source_path, bucket, s3_key FROM brain.files
      WHERE kind = $1 AND slug = $2 AND filename = $3
      ORDER BY id DESC LIMIT 1`,
    [spec.kind, spec.slug, spec.filename],
  );
  if (latest.rowCount === 0) throw notFound(addr);

  const row = latest.rows[0]!;

  // Already tombstoned: don't append another rm row — just retry the S3 delete
  // if the object is still present (a previously-failed delete).
  if (row.op === 'rm') {
    const present = await store.head(row.s3_key);
    if (present === null) throw notFound(addr);
    const s3Deleted = await tryDelete(store, row.s3_key);
    return { op: 'rm', sourcePath: row.source_path, s3Deleted };
  }

  await client.query(
    `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, actor)
     VALUES ($1, $2, $3, 'rm', $4, $5, $6, $7)`,
    [spec.kind, spec.slug, spec.filename, row.source_path, row.bucket, row.s3_key, spec.actor ?? null],
  );

  const s3Deleted = await tryDelete(store, row.s3_key);
  return { op: 'rm', sourcePath: row.source_path, s3Deleted };
}

async function tryDelete(store: FileStore, key: string): Promise<boolean> {
  try {
    await store.del(key);
    return true;
  } catch (err) {
    process.stderr.write(
      `roster brain fs rm: tombstoned in the ledger, but the S3 delete failed (${(err as Error).message}); ` +
        `run 'roster brain doctor' — the orphan will be flagged and a re-run retries the delete\n`,
    );
    return false;
  }
}
