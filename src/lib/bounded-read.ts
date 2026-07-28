import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// Bounded readers for capped CLI inputs (round-9 finding 2). A cap that is
// checked AFTER the whole input is already in memory is not a cap: `roster run
// report --file <a multi-gigabyte log>` used readFileSync (which additionally
// throws its own 2 GiB buffer limit error instead of the documented cap error),
// and the stdin path buffered an unbounded pipe to completion. Both now stop at
// maxBytes + 1 — one byte past the cap, which is exactly enough to know the cap
// was exceeded without reading the rest.

const CHUNK_BYTES = 64 * 1024;

export type CappedRead =
  | { state: 'ok'; bytes: Buffer }
  // `size` is the real byte length ONLY when the verdict came from the initial
  // fstat of a regular file. When the input streamed past the cap — including a
  // regular file that GREW past it mid-read — the pre-read size is stale and
  // would understate the input, so the contract is `null` (round-10 finding 3:
  // returning the stale `st.size` let the CLI claim a sub-cap file exceeded the
  // cap, and contradicted this very field's documented meaning).
  | { state: 'over-cap'; size: number | null }
  | { state: 'unreadable'; error: string };

// Injectable fs seam — the tests drive the fstat/read interleaving a concurrent
// writer produces (a file that grows past the cap between the stat and the
// read); production passes the real fs.
export type BoundedFs = {
  openSync: typeof openSync;
  fstatSync: typeof fstatSync;
  readSync: typeof readSync;
  closeSync: typeof closeSync;
};

export const realBoundedFs: BoundedFs = { openSync, fstatSync, readSync, closeSync };

// Reads at most maxBytes + 1 bytes. The path is operator-supplied (not agent
// evidence), so symlinks and pipes stay legal — `--file <(gzip -dc log.gz)` is
// a supported way to feed a report — only the allocation is bounded.
export function readCappedFileSync(
  path: string,
  maxBytes: number,
  fs: BoundedFs = realBoundedFs,
): CappedRead {
  let fd: number;
  try {
    fd = fs.openSync(path, 'r');
  } catch (err) {
    return { state: 'unreadable', error: (err as Error).message };
  }
  try {
    const st = fs.fstatSync(fd);
    if (st.isFile() && st.size > maxBytes) return { state: 'over-cap', size: st.size };
    const limit = maxBytes + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    // Size-aware first read for a regular file; a pipe/FIFO reports size 0 and
    // falls through to chunked reads.
    let want = st.isFile() ? Math.min(limit, st.size + 1) : Math.min(limit, CHUNK_BYTES);
    while (total < limit && want > 0) {
      const buf = Buffer.alloc(want);
      let n: number;
      try {
        n = fs.readSync(fd, buf, 0, want, null);
      } catch (err) {
        return { state: 'unreadable', error: (err as Error).message };
      }
      if (n === 0) break;
      chunks.push(n === want ? buf : buf.subarray(0, n));
      total += n;
      want = Math.min(limit - total, CHUNK_BYTES);
    }
    // Reaching here means the STAT said under-cap and the READ said over-cap —
    // the input grew, so no size we hold is the truth. Report the condition we
    // actually observed, not the stale pre-read stat.
    if (total > maxBytes) return { state: 'over-cap', size: null };
    return { state: 'ok', bytes: Buffer.concat(chunks, total) };
  } finally {
    fs.closeSync(fd);
  }
}

// Consumes at most maxBytes + 1 bytes, then stops pulling — breaking the
// for-await closes the iterator, so an unbounded producer is abandoned rather
// than drained. The one byte past the cap is what makes `bytes.byteLength >
// maxBytes` a reliable over-cap verdict. `maxBytes: null` keeps the unbounded
// behavior for inputs with their own large-input policy (declare-artifact's
// digest-verified bytes).
export async function readCappedStream(
  stream: AsyncIterable<Buffer | string>,
  maxBytes: number | null,
): Promise<Buffer> {
  const limit = maxBytes === null ? Number.POSITIVE_INFINITY : maxBytes + 1;
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    chunks.push(buf);
    total += buf.byteLength;
    if (total >= limit) break;
  }
  return Buffer.concat(chunks, Number.isFinite(limit) ? Math.min(total, limit) : total);
}
