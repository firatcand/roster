import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCappedFileSync, readCappedStream, realBoundedFs, type BoundedFs } from '../src/lib/bounded-read.ts';

// Round-9 finding 2: the 1 MiB report/event cap used to be enforced AFTER the
// input was fully in memory (readFileSync for --file, an unbounded chunk
// accumulator for --stdin), so a multi-gigabyte log or an endless pipe
// exhausted memory instead of returning the documented cap error. These
// readers stop at maxBytes + 1.

const CAP = 1024; // small cap keeps the assertions exact; run.ts passes 1 MiB

function tmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'roster-bounded-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('readCappedFileSync: a file under the cap reads whole', () => {
  const t = tmp();
  try {
    const p = join(t.dir, 'small.txt');
    writeFileSync(p, 'hello world', 'utf8');
    const r = readCappedFileSync(p, CAP);
    assert.equal(r.state, 'ok');
    assert.equal(r.state === 'ok' ? r.bytes.toString('utf8') : '', 'hello world');
  } finally {
    t.cleanup();
  }
});

test('readCappedFileSync: a file exactly at the cap still reads whole', () => {
  const t = tmp();
  try {
    const p = join(t.dir, 'exact.txt');
    writeFileSync(p, 'x'.repeat(CAP), 'utf8');
    const r = readCappedFileSync(p, CAP);
    assert.equal(r.state, 'ok');
    assert.equal(r.state === 'ok' ? r.bytes.byteLength : -1, CAP);
  } finally {
    t.cleanup();
  }
});

test('readCappedFileSync: one byte over the cap is refused with its real size', () => {
  const t = tmp();
  try {
    const p = join(t.dir, 'over.txt');
    writeFileSync(p, 'x'.repeat(CAP + 1), 'utf8');
    const r = readCappedFileSync(p, CAP);
    assert.equal(r.state, 'over-cap');
    assert.equal(r.state === 'over-cap' ? r.size : -1, CAP + 1);
  } finally {
    t.cleanup();
  }
});

// The memory-safety property: a file far larger than any buffer Node can
// allocate is rejected from its STAT, without a byte being read. Pre-fix, the
// same input went through readFileSync — which does not even reach the cap
// check for a >2 GiB file, it throws its own buffer-limit error and the CLI
// reported an unreadable file instead of the documented cap.
test('readCappedFileSync: a 3 GiB (sparse) file is refused from its stat — never allocated', () => {
  const t = tmp();
  try {
    const p = join(t.dir, 'huge.log');
    const size = 3 * 1024 * 1024 * 1024;
    const fd = openSync(p, 'w');
    try {
      ftruncateSync(fd, size);
    } finally {
      closeSync(fd);
    }
    assert.equal(statSync(p).size, size, 'sparse file really is 3 GiB long');
    const r = readCappedFileSync(p, 1024 * 1024);
    assert.equal(r.state, 'over-cap');
    assert.equal(r.state === 'over-cap' ? r.size : -1, size);
  } finally {
    t.cleanup();
  }
});

// ── round-10 finding 3: a file that GROWS past the cap mid-read ─────────────
//
// The over-cap branch after the read loop returned the STALE pre-read
// `st.size`, so a regular file that was under the cap at fstat time and grew
// past it while being read reported its OLD size: the CLI then claimed a
// sub-cap file "is 900 bytes; the cap is 1024" — an error that contradicts
// itself — and it broke CappedRead's own contract that a verdict reached by
// streaming past the cap carries `size: null`. The seam drives the race
// deterministically: the append lands after the reader has sized the file.
test('readCappedFileSync: a file that grows past the cap mid-read reports size null, never the stale stat', () => {
  const t = tmp();
  try {
    const p = join(t.dir, 'growing.txt');
    const initial = CAP - 124; // comfortably under the cap at fstat time
    writeFileSync(p, 'a'.repeat(initial), 'utf8');

    let grown = false;
    const racingFs: BoundedFs = {
      ...realBoundedFs,
      fstatSync: ((fd: number) => {
        const st = realBoundedFs.fstatSync(fd);
        if (!grown) {
          grown = true;
          appendFileSync(p, 'b'.repeat(CAP), 'utf8');
        }
        return st;
      }) as typeof realBoundedFs.fstatSync,
    };

    const r = readCappedFileSync(p, CAP, racingFs);
    assert.equal(grown, true, 'the race must actually have been injected');
    assert.equal(r.state, 'over-cap', 'the grown file really does exceed the cap');
    assert.equal(
      r.state === 'over-cap' ? r.size : -1,
      null,
      'a verdict reached by the READ carries no size — the pre-read stat is stale',
    );
    assert.ok(statSync(p).size > CAP, 'and the file on disk is genuinely over the cap now');
  } finally {
    t.cleanup();
  }
});

test('readCappedFileSync: a missing path is unreadable, not a throw', () => {
  const t = tmp();
  try {
    const r = readCappedFileSync(join(t.dir, 'nope.txt'), CAP);
    assert.equal(r.state, 'unreadable');
  } finally {
    t.cleanup();
  }
});

// A stream-like path (pipe, device) reports size 0 from fstat, so the bound has
// to come from the READ LOOP, not the stat — `--file <(cmd)` is a supported way
// to feed a report. /dev/zero is the endless case: unbounded before the fix.
test('readCappedFileSync: an endless stream-like path is refused by the read bound, not the stat', { timeout: 10000, skip: process.platform === 'win32' ? 'POSIX only' : false }, () => {
  const r = readCappedFileSync('/dev/zero', CAP);
  assert.equal(r.state, 'over-cap');
  assert.equal(r.state === 'over-cap' ? r.size : -1, null, 'a stream has no knowable size');
});

// The stream seam: an ENDLESS producer must be abandoned after maxBytes + 1,
// not drained. Counting the chunks it was asked for is the proof that the
// reader stopped early.
test('readCappedStream: an unbounded producer is stopped one byte past the cap', async () => {
  let yielded = 0;
  async function* endless(): AsyncGenerator<Buffer> {
    for (;;) {
      yielded++;
      yield Buffer.alloc(64, 0x61);
    }
  }
  const bytes = await readCappedStream(endless(), CAP);
  assert.equal(bytes.byteLength, CAP + 1, 'exactly one byte past the cap — enough to know it was exceeded');
  assert.ok(yielded <= Math.ceil((CAP + 1) / 64), `stopped pulling early (pulled ${yielded} chunks)`);
});

test('readCappedStream: a producer under the cap is read whole', async () => {
  async function* small(): AsyncGenerator<Buffer> {
    yield Buffer.from('abc', 'utf8');
    yield Buffer.from('def', 'utf8');
  }
  const bytes = await readCappedStream(small(), CAP);
  assert.equal(bytes.toString('utf8'), 'abcdef');
});

test('readCappedStream: maxBytes null keeps the unbounded (artifact) policy', async () => {
  async function* big(): AsyncGenerator<Buffer> {
    yield Buffer.alloc(CAP * 3, 0x62);
  }
  const bytes = await readCappedStream(big(), null);
  assert.equal(bytes.byteLength, CAP * 3);
});
