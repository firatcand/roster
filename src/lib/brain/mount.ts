import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type pg from 'pg';
import { type Embedder, toVectorLiteral } from './embed.ts';

const MAX_CHUNK_CHARS = 1500;

export type MountResult = {
  mounted: boolean;
  reason?: 'unchanged';
  sourcePath: string;
  fileHash: string;
  chunks: number;
  embedded: boolean;
};

export type MountBytesResult = MountResult & { mountId: string };

export type Chunk = {
  content: string;
  contentHash: string;
};

function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function parseFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!text.startsWith('---')) return { frontmatter: {}, body: text };
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { frontmatter: {}, body: text };
  const frontmatter = parseSimpleYaml(match[1]!);
  return { frontmatter, body: text.slice(match[0].length) };
}

function parseSimpleYaml(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    let raw = trimmed.slice(colon + 1).trim();
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      raw = raw.slice(1, -1);
    }
    out[key] = coerceScalar(raw);
  }
  return out;
}

function coerceScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null' || raw === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function hardWindow(text: string, out: string[]): void {
  for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
    out.push(text.slice(i, i + MAX_CHUNK_CHARS));
  }
}

function splitLongSection(section: string): string[] {
  if (section.length <= MAX_CHUNK_CHARS) return [section];
  const out: string[] = [];
  const lines = section.split('\n');
  let buf = '';
  const flush = () => {
    if (buf.length === 0) return;
    if (buf.length > MAX_CHUNK_CHARS) hardWindow(buf, out);
    else out.push(buf);
    buf = '';
  };
  for (const line of lines) {
    const candidate = buf.length === 0 ? line : buf + '\n' + line;
    if (candidate.length > MAX_CHUNK_CHARS) {
      flush();
      buf = line;
    } else {
      buf = candidate;
    }
  }
  flush();
  return out;
}

function chunkMarkdown(body: string): string[] {
  const lines = body.split('\n');
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.length > 0) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join('\n'));

  const out: string[] = [];
  for (const section of sections) {
    const trimmed = section.replace(/^\n+|\n+$/g, '');
    if (trimmed.length === 0) continue;
    out.push(...splitLongSection(trimmed));
  }
  return out;
}

function chunkFixed(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
    const slice = text.slice(i, i + MAX_CHUNK_CHARS);
    if (slice.length > 0) out.push(slice);
  }
  return out;
}

export function chunkFile(
  filePath: string,
  raw: string,
): { chunks: Chunk[]; frontmatter: Record<string, unknown> } {
  const ext = extname(filePath).toLowerCase();
  const isMarkdown = ext === '.md' || ext === '.markdown';
  let frontmatter: Record<string, unknown> = {};
  let contents: string[];
  if (isMarkdown) {
    const parsed = parseFrontmatter(raw);
    frontmatter = parsed.frontmatter;
    contents = chunkMarkdown(parsed.body);
  } else {
    contents = chunkFixed(raw);
  }
  if (contents.length === 0) contents = [''];
  const chunks = contents.map((content) => ({ content, contentHash: sha256(content) }));
  return { chunks, frontmatter };
}

// Index bytes under an arbitrary source_path (a local absolute path from
// `mountFile`, or an `s3://…` URI from `brain fs put`). Runs INSIDE the caller's
// transaction — no BEGIN/COMMIT here — but takes the per-source_path advisory
// lock itself so concurrent mounts of one path can never interleave. On an
// unchanged hash it returns the EXISTING latest mount id (zero paid embedding
// calls, no new rows), which is what lets a `fs put` after an `fs rm` resurrect
// chunks without re-embedding.
export async function mountBytesTx(
  client: pg.PoolClient | pg.Client,
  sourcePath: string,
  rawBytes: Buffer,
  embedder: Embedder | null = null,
): Promise<MountBytesResult> {
  const fileHash = sha256(rawBytes);
  const raw = rawBytes.toString('utf8');
  const { chunks, frontmatter } = chunkFile(sourcePath, raw);
  const frontmatterJson = JSON.stringify(frontmatter);

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [sourcePath]);

  const latest = await client.query<{ id: string; file_hash: string }>(
    `SELECT id, file_hash FROM brain.mounts WHERE source_path = $1 ORDER BY id DESC LIMIT 1`,
    [sourcePath],
  );
  // No-op guard runs BEFORE embedding: an unchanged re-mount incurs zero paid
  // embedding calls and reuses the existing mount id.
  if (latest.rowCount !== 0 && latest.rows[0]!.file_hash === fileHash) {
    return {
      mounted: false,
      reason: 'unchanged',
      sourcePath,
      fileHash,
      chunks: 0,
      embedded: false,
      mountId: latest.rows[0]!.id,
    };
  }

  const mount = await client.query<{ id: string }>(
    `INSERT INTO brain.mounts (source_path, file_hash) VALUES ($1, $2) RETURNING id`,
    [sourcePath, fileHash],
  );
  const mountId = mount.rows[0]!.id;

  // Embed at INSERT time (append-only: embeddings are never UPDATEd in). On a
  // provider error the mount still succeeds with NULL embeddings — ROS-142
  // reindex backfills them later. Chunks mounted while embeddings were off also
  // stay NULL until reindex.
  let vectors: (string | null)[] = chunks.map(() => null);
  let model: string | null = null;
  let embedded = false;
  if (embedder && chunks.length > 0) {
    try {
      const raws = await embedder.embed(chunks.map((c) => c.content));
      vectors = raws.map((v) => toVectorLiteral(v));
      model = embedder.model;
      embedded = true;
    } catch (e) {
      process.stderr.write(
        `roster brain mount: embedding failed (${(e as Error).message}); stored chunks without vectors — run \`roster brain reindex\` to backfill\n`,
      );
    }
  }

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    await client.query(
      `INSERT INTO brain.documents
         (source_path, chunk_index, content, content_hash, mount_id, frontmatter, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::vector, $8)`,
      [sourcePath, i, c.content, c.contentHash, mountId, frontmatterJson, vectors[i], model],
    );
  }

  return { mounted: true, sourcePath, fileHash, chunks: chunks.length, embedded, mountId };
}

export async function mountFile(
  client: pg.PoolClient | pg.Client,
  filePath: string,
  embedder: Embedder | null = null,
): Promise<MountResult> {
  const sourcePath = resolve(filePath);
  const rawBytes = readFileSync(sourcePath);

  await client.query('BEGIN');
  try {
    const { mountId: _mountId, ...result } = await mountBytesTx(client, sourcePath, rawBytes, embedder);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
