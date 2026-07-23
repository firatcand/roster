import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import type pg from 'pg';
import { RosterError, EXIT_ERROR } from '../errors.ts';
import { assertSafeSegment } from '../persistence/safe-path.ts';
import { type Embedder } from './embed.ts';
import { mountBytesTx } from './mount.ts';
import { ConditionalWriteFailed, type FileStore } from './s3.ts';

export { assertSafeSegment };

// The `brain fs` verbs: S3 holds the bytes, the brain.files ledger records every
// event. Files hang off the brain's existing kind/slug entity taxonomy, so a
// mounted document is reachable through everything the brain already exposes.

export type FileAddress = { kind: string; slug: string; filename: string };
export type FilesTarget = { bucket: string; prefix: string };

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function deriveKey(prefix: string, addr: FileAddress): string {
  return `${prefix}files/${addr.kind}/${addr.slug}/${addr.filename}`;
}

export function sourceUri(bucket: string, key: string): string {
  return `s3://${bucket}/${key}`;
}

// The advisory-lock key for a file address. put and rm serialize on this so a
// concurrent pair can't interleave their S3 write/delete with the other's
// ledger commit. It is the ADDRESS (not the source_path URI) because rm must
// lock BEFORE it reads the head — and the head's URI is unknown until read, and
// may sit under an old bucket after a config change.
function addressLockKey(kind: string, slug: string, filename: string): string {
  return `brain.files:${kind}/${slug}/${filename}`;
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
    // operation (S3 put + ledger insert) serializes per address against both
    // other puts AND concurrent rm. Without this, two concurrent writers to one
    // address could order their S3 write/delete and ledger commit differently,
    // leaving current_files pointing at bytes not in S3. The lock is
    // cluster-wide (serializes across processes); it is released at COMMIT. The
    // trade-off — an open txn spanning the S3 call — only contends for
    // concurrent writers to the SAME file, which is rare.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      addressLockKey(spec.kind, spec.slug, filename),
    ]);

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

// Reads run under the SAME per-address advisory lock as put/rm, held across the
// S3 fetch. So a concurrent rm can't delete the object between the head read and
// the fetch: get either sees the current bytes or (if rm won the lock first) the
// tombstone → a clean "no current file". A null fetch UNDER the lock therefore
// means genuine drift (the object vanished out-of-band), not a lost race — which
// is what makes the "run doctor" message trustworthy.
export async function getFile(
  client: pg.PoolClient | pg.Client,
  store: FileStore,
  spec: GetSpec,
): Promise<GetFileResult> {
  const addr = { kind: spec.kind, slug: spec.slug, filename: spec.filename };
  return withAddressLock(client, spec.kind, spec.slug, spec.filename, async () => {
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
  });
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

type LedgerHead = { op: string; source_path: string; bucket: string; s3_key: string };

// Run `fn` inside a transaction holding the per-address advisory xact lock (auto
// released at COMMIT/ROLLBACK — pool-safe, unlike a session lock). Serializes
// against put/get/rm on the same address.
async function withAddressLock<T>(
  client: pg.PoolClient | pg.Client,
  kind: string,
  slug: string,
  filename: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [addressLockKey(kind, slug, filename)]);
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function readHead(client: pg.PoolClient | pg.Client, spec: RmSpec): Promise<LedgerHead | null> {
  const r = await client.query<LedgerHead>(
    `SELECT op, source_path, bucket, s3_key FROM brain.files
      WHERE kind = $1 AND slug = $2 AND filename = $3
      ORDER BY id DESC LIMIT 1`,
    [spec.kind, spec.slug, spec.filename],
  );
  return r.rowCount === 0 ? null : r.rows[0]!;
}

// Remove a file in TWO locked transactions so the ledger truth is durable before
// any bytes are destroyed:
//
//   Phase 1 — tombstone (durable). Append an op='rm' row (unless already
//     tombstoned) and COMMIT. After this the file is gone from every reader's
//     view, whether or not the S3 delete ever succeeds.
//   Phase 2 — delete bytes. Re-acquire the lock, RE-READ the head, and delete
//     the object only if the head is still a tombstone. If a put re-added the
//     file between phases, the head is now a 'put' and we leave its bytes alone.
//
// Splitting the phases (vs. delete-before-commit) means a crash/commit-failure
// can never strand current_files pointing at deleted bytes: the worst case is a
// committed tombstone with an orphaned S3 object, which doctor flags and a re-run
// (phase 2 again) cleans up. Both phases use auto-released xact locks — no
// session-lock lifetime to leak onto a pooled connection.
export async function rmFile(
  client: pg.PoolClient | pg.Client,
  store: FileStore,
  spec: RmSpec,
): Promise<RmFileResult> {
  const addr = { kind: spec.kind, slug: spec.slug, filename: spec.filename };

  // Phase 1: durable tombstone.
  const head = await withAddressLock(client, spec.kind, spec.slug, spec.filename, async () => {
    const h = await readHead(client, spec);
    if (h === null) throw notFound(addr);
    if (h.op === 'put') {
      await client.query(
        `INSERT INTO brain.files (kind, slug, filename, op, source_path, bucket, s3_key, actor)
         VALUES ($1, $2, $3, 'rm', $4, $5, $6, $7)`,
        [spec.kind, spec.slug, spec.filename, h.source_path, h.bucket, h.s3_key, spec.actor ?? null],
      );
    }
    return h;
  });

  // Phase 2: best-effort delete, re-checked under the lock.
  const s3Deleted = await withAddressLock(client, spec.kind, spec.slug, spec.filename, async () => {
    const h = await readHead(client, spec);
    // Only delete when the current head is still a tombstone — a concurrent put
    // may have re-added the file, and its bytes must survive.
    if (h !== null && h.op === 'rm') {
      return tryDelete(store, h.s3_key);
    }
    return false;
  });

  return { op: 'rm', sourcePath: head.source_path, s3Deleted };
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
