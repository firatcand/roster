import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalLedger,
  MAX_RECORD_BYTES,
  ledgerFsSeams,
  tryReclaimStaleLock,
  type LedgerRecord,
} from '../src/lib/persistence/local/ledger.ts';
import { createLocalBackend } from '../src/lib/persistence/local/stores.ts';
import {
  BackendUnavailableError,
  ConflictError,
  InvalidRecordError,
  WorkspaceMismatchError,
  canonicalJson,
  sha256Hex,
} from '../src/lib/persistence/contracts.ts';

// #318 stage 2 section D: durability crash matrix (child-process SIGKILL at
// real protocol boundaries), seal recovery, hash chain, concurrent writers,
// quotas, torn derived state, and fork isolation for the local JSONL ledger.

const LEDGER_URL = new URL('../src/lib/persistence/local/ledger.ts', import.meta.url).href;

// The child appends records and acks each COMPLETED append to an ack file with
// a synchronous write (stdout would lose buffered lines on SIGKILL). killAt
// hooks fire on append number killAppend only.
const CHILD_SOURCE = `
import { LocalLedger } from ${JSON.stringify(LEDGER_URL)};
import { appendFileSync } from 'node:fs';
const [opsRoot, ws, ns, countStr, killAppendStr, killAt, prefix, ackFile] = process.argv.slice(2);
const count = Number(countStr);
const killAppend = Number(killAppendStr);
const kill = () => process.kill(process.pid, 'SIGKILL');
const ledger = new LocalLedger({ opsRoot, workspaceId: ws, lockTimeoutMs: 30000 });
for (let i = 1; i <= count; i++) {
  const hooks =
    i === killAppend
      ? {
          beforeWrite: killAt === 'pre-write' ? kill : undefined,
          midWrite: killAt === 'mid-write' ? kill : undefined,
          beforeFsync: killAt === 'pre-fsync' ? kill : undefined,
          afterFsync: killAt === 'post-fsync' ? kill : undefined,
        }
      : undefined;
  const res = ledger.append(ns, { id: prefix + '-' + i, kind: 'test', payload: { n: i } }, hooks);
  appendFileSync(ackFile, prefix + '-' + i + ' ' + res.record.seq + '\\n');
}
`;

type Env = { dir: string; opsRoot: string; ws: string; script: string; ackFile: string };

function makeEnv(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'roster-ledger-'));
  const script = join(dir, 'child.ts');
  writeFileSync(script, CHILD_SOURCE);
  return { dir, opsRoot: join(dir, 'ops'), ws: randomUUID(), script, ackFile: join(dir, 'acks.txt') };
}

function cleanup(env: Env): void {
  rmSync(env.dir, { recursive: true, force: true });
}

function childArgs(env: Env, ns: string, count: number, killAppend: number, killAt: string, prefix: string): string[] {
  return ['--experimental-strip-types', env.script, env.opsRoot, env.ws, ns, String(count), String(killAppend), killAt, prefix, env.ackFile];
}

function runChildSync(env: Env, ns: string, count: number, killAppend: number, killAt: string, prefix = 'rec') {
  return spawnSync(process.execPath, childArgs(env, ns, count, killAppend, killAt, prefix), { encoding: 'utf8' });
}

function readAcks(env: Env): string[] {
  if (!existsSync(env.ackFile)) return [];
  return readFileSync(env.ackFile, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split(' ')[0]!);
}

function openLedger(env: Env, overrides: { lockTimeoutMs?: number; now?: () => number } = {}): LocalLedger {
  return new LocalLedger({ opsRoot: env.opsRoot, workspaceId: env.ws, ...overrides });
}

function nsDir(env: Env, ns: string): string {
  return join(env.opsRoot, env.ws, ns);
}

function segPath(env: Env, ns: string, index: number): string {
  return join(nsDir(env, ns), `segment-${String(index).padStart(4, '0')}.jsonl`);
}

// ---------------- crash matrix ----------------

test('crash matrix: SIGKILL before any byte is written — clean prefix, no seal, id reusable', () => {
  const env = makeEnv();
  try {
    const r = runChildSync(env, 'events', 5, 3, 'pre-write');
    assert.equal(r.signal, 'SIGKILL');
    assert.deepEqual(readAcks(env), ['rec-1', 'rec-2']);
    const ledger = openLedger(env);
    const { records, lastSeq } = ledger.scan('events');
    assert.deepEqual(records.map((rec) => rec.id), ['rec-1', 'rec-2']);
    assert.equal(lastSeq, 2);
    assert.equal(existsSync(`${segPath(env, 'events', 0)}.seal`), false);
    const res = ledger.append('events', { id: 'rec-3', kind: 'test', payload: { n: 3 } });
    assert.equal(res.replayed, false);
    assert.equal(res.record.seq, 3);
  } finally {
    cleanup(env);
  }
});

test('crash matrix: SIGKILL mid-write — torn tail sealed, valid prefix retained, bytes untouched, new segment for appends', () => {
  const env = makeEnv();
  try {
    const r = runChildSync(env, 'events', 5, 3, 'mid-write');
    assert.equal(r.signal, 'SIGKILL');
    assert.deepEqual(readAcks(env), ['rec-1', 'rec-2']);
    const seg0 = segPath(env, 'events', 0);
    const bytesBefore = readFileSync(seg0);
    const ledger = openLedger(env);
    const { records } = ledger.scan('events');
    assert.deepEqual(records.map((rec) => rec.id), ['rec-1', 'rec-2']);
    // seal sidecar written; original segment bytes never modified
    assert.equal(existsSync(`${seg0}.seal`), true);
    assert.deepEqual(readFileSync(seg0), bytesBefore);
    const seal = JSON.parse(readFileSync(`${seg0}.seal`, 'utf8')) as { lastValidOffset: number; records: number };
    assert.equal(seal.records, 2);
    assert.ok(seal.lastValidOffset < bytesBefore.length);
    // appends after a seal open a new segment
    const res = ledger.append('events', { id: 'rec-3', kind: 'test', payload: { n: 3 } });
    assert.equal(res.record.seq, 3);
    assert.equal(existsSync(segPath(env, 'events', 1)), true);
    assert.deepEqual(readFileSync(seg0), bytesBefore);
    // recovery is idempotent: rescans neither lose nor replay records
    const again = openLedger(env).scan('events');
    assert.deepEqual(again.records.map((rec) => rec.id), ['rec-1', 'rec-2', 'rec-3']);
  } finally {
    cleanup(env);
  }
});

for (const boundary of ['pre-fsync', 'post-fsync'] as const) {
  test(`crash matrix: SIGKILL at ${boundary} — record durable but unacked; retry is idempotent, no replay`, () => {
    const env = makeEnv();
    try {
      const r = runChildSync(env, 'events', 5, 3, boundary);
      assert.equal(r.signal, 'SIGKILL');
      // the full line was written before the kill, so the record IS present…
      assert.deepEqual(readAcks(env), ['rec-1', 'rec-2']);
      const ledger = openLedger(env);
      const { records } = ledger.scan('events');
      assert.deepEqual(records.map((rec) => rec.id), ['rec-1', 'rec-2', 'rec-3']);
      assert.equal(existsSync(`${segPath(env, 'events', 0)}.seal`), false);
      // …and the client retry of the unacked append is an idempotent no-op
      const res = ledger.append('events', { id: 'rec-3', kind: 'test', payload: { n: 3 } });
      assert.equal(res.replayed, true);
      assert.equal(res.record.seq, 3);
      assert.equal(ledger.scan('events').records.length, 3);
    } finally {
      cleanup(env);
    }
  });
}

// ---------------- torn writes via truncation ----------------

function appendN(ledger: LocalLedger, ns: string, n: number, prefix = 'rec'): LedgerRecord[] {
  const out: LedgerRecord[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(ledger.append(ns, { id: `${prefix}-${i}`, kind: 'test', payload: { n: i } }).record);
  }
  return out;
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

test('torn write: truncation mid-final-line seals at the last valid offset; prefix retained', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 3);
    const seg0 = segPath(env, 'events', 0);
    const content = readFileSync(seg0, 'utf8');
    const starts = lineStarts(content);
    const cut = starts[2]! + 10; // 10 bytes into record 3's line
    truncateSync(seg0, cut);
    const ledger = openLedger(env);
    const { records } = ledger.scan('events');
    assert.deepEqual(records.map((rec) => rec.id), ['rec-1', 'rec-2']);
    const seal = JSON.parse(readFileSync(`${seg0}.seal`, 'utf8')) as { lastValidOffset: number };
    assert.equal(seal.lastValidOffset, starts[2]);
    assert.equal(statSync(seg0).size, cut);
    const res = ledger.append('events', { id: 'rec-4', kind: 'test', payload: { n: 4 } });
    assert.equal(res.record.seq, 3);
    assert.equal(existsSync(segPath(env, 'events', 1)), true);
  } finally {
    cleanup(env);
  }
});

test('torn write: truncation exactly at a line boundary leaves a clean unsealed tail', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 3);
    const seg0 = segPath(env, 'events', 0);
    const starts = lineStarts(readFileSync(seg0, 'utf8'));
    truncateSync(seg0, starts[2]!);
    const ledger = openLedger(env);
    assert.deepEqual(ledger.scan('events').records.map((rec) => rec.id), ['rec-1', 'rec-2']);
    assert.equal(existsSync(`${seg0}.seal`), false);
    // clean tail: next append continues in the SAME segment
    ledger.append('events', { id: 'rec-3b', kind: 'test', payload: { n: 33 } });
    assert.equal(existsSync(segPath(env, 'events', 1)), false);
  } finally {
    cleanup(env);
  }
});

// ---------------- corruption & hash chain ----------------

test('corruption: a complete interior line that fails validation is a hard error naming the segment', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 3);
    const seg0 = segPath(env, 'events', 0);
    const lines = readFileSync(seg0, 'utf8').split('\n');
    const tampered = lines[0]!.replace('"n":1', '"n":7');
    assert.notEqual(tampered, lines[0]);
    writeFileSync(seg0, [tampered, ...lines.slice(1)].join('\n'));
    assert.throws(
      () => openLedger(env).scan('events'),
      (err: unknown) => err instanceof InvalidRecordError && /segment-0000\.jsonl/.test((err as Error).message),
    );
  } finally {
    cleanup(env);
  }
});

test('corruption: tear inside an already-sealed region is a hard error, not a re-seal', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 3);
    const seg0 = segPath(env, 'events', 0);
    const starts = lineStarts(readFileSync(seg0, 'utf8'));
    truncateSync(seg0, starts[2]! + 10);
    openLedger(env).scan('events'); // writes the seal at starts[2]
    assert.equal(existsSync(`${seg0}.seal`), true);
    truncateSync(seg0, starts[1]! + 5); // now tear INSIDE the sealed valid region
    assert.throws(
      () => openLedger(env).scan('events'),
      (err: unknown) => err instanceof InvalidRecordError && /before the seal point/.test((err as Error).message),
    );
  } finally {
    cleanup(env);
  }
});

test('hash chain: prev fields link each record to the prior line; scan enforces the chain', () => {
  const env = makeEnv();
  try {
    const written = appendN(openLedger(env), 'events', 4);
    const seg0 = segPath(env, 'events', 0);
    const lines = readFileSync(seg0, 'utf8').split('\n').filter((l) => l.length > 0);
    assert.equal(written[0]!.prev, null);
    for (let i = 1; i < lines.length; i++) {
      const rec = JSON.parse(lines[i]!) as LedgerRecord;
      assert.equal(rec.prev, sha256Hex(lines[i - 1]!));
      assert.equal(rec.checksum, sha256Hex(JSON.stringify(rec.payload)));
    }
    // swapping two intact lines breaks the chain even though each line is self-consistent
    writeFileSync(seg0, [lines[0], lines[2], lines[1], lines[3]].join('\n') + '\n');
    assert.throws(() => openLedger(env).scan('events'), InvalidRecordError);
  } finally {
    cleanup(env);
  }
});

test('hash chain: spans segments — first record of a new segment links to the sealed prefix', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 2);
    const seg0 = segPath(env, 'events', 0);
    const content = readFileSync(seg0, 'utf8');
    const starts = lineStarts(content);
    truncateSync(seg0, starts[1]! + 5); // tear record 2
    const ledger = openLedger(env);
    ledger.append('events', { id: 'rec-2b', kind: 'test', payload: { n: 22 } });
    const seg1Lines = readFileSync(segPath(env, 'events', 1), 'utf8').split('\n').filter((l) => l.length > 0);
    const first = JSON.parse(seg1Lines[0]!) as LedgerRecord;
    const seg0FirstLine = content.slice(0, starts[1]! - 1);
    assert.equal(first.prev, sha256Hex(seg0FirstLine));
    assert.equal(first.seq, 2);
    assert.deepEqual(openLedger(env).scan('events').records.map((r) => r.seq), [1, 2]);
  } finally {
    cleanup(env);
  }
});

// ---------------- torn derived state (sidecars) ----------------

test('sidecar: invalid seal over a fully valid segment is discarded and removed', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 3);
    const sealFile = `${segPath(env, 'events', 0)}.seal`;
    writeFileSync(sealFile, 'not json at all');
    const { records } = openLedger(env).scan('events');
    assert.equal(records.length, 3);
    assert.equal(existsSync(sealFile), false);
  } finally {
    cleanup(env);
  }
});

test('sidecar: torn/checksum-invalid seal over a torn segment is recomputed from the segment scan', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 3);
    const seg0 = segPath(env, 'events', 0);
    const starts = lineStarts(readFileSync(seg0, 'utf8'));
    truncateSync(seg0, starts[2]! + 10);
    const sealFile = `${seg0}.seal`;
    writeFileSync(sealFile, '{"segment":"segment-0000.jsonl","lastValidOffset":1,"records":9,"lastHash":null,"checksum":"beef"}');
    const { records } = openLedger(env).scan('events');
    assert.deepEqual(records.map((r) => r.id), ['rec-1', 'rec-2']);
    const seal = JSON.parse(readFileSync(sealFile, 'utf8')) as { lastValidOffset: number; records: number };
    assert.equal(seal.lastValidOffset, starts[2]);
    assert.equal(seal.records, 2);
  } finally {
    cleanup(env);
  }
});

// ---------------- concurrency & locking ----------------

test('concurrent writers: two processes interleave under the lock without corruption', async () => {
  const env = makeEnv();
  try {
    const spawnChild = (prefix: string) =>
      spawn(process.execPath, childArgs(env, 'events', 25, 0, 'none', prefix), { stdio: 'ignore' });
    const a = spawnChild('aa');
    const b = spawnChild('bb');
    const [[codeA], [codeB]] = await Promise.all([once(a, 'exit'), once(b, 'exit')]);
    assert.equal(codeA, 0);
    assert.equal(codeB, 0);
    const { records, lastSeq } = openLedger(env).scan('events');
    assert.equal(records.length, 50);
    assert.equal(lastSeq, 50);
    assert.deepEqual(records.map((r) => r.seq), Array.from({ length: 50 }, (_, i) => i + 1));
    for (const prefix of ['aa', 'bb']) {
      const ids = records.filter((r) => r.id.startsWith(`${prefix}-`)).map((r) => r.id);
      assert.equal(ids.length, 25);
    }
    for (const r of records) assert.equal(r.producerSeq, r.seq);
  } finally {
    cleanup(env);
  }
});

test('lock: a live holder blocks appends with BackendUnavailableError until released', () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env, { lockTimeoutMs: 200 });
    appendN(ledger, 'events', 1);
    const lockPath = join(nsDir(env, 'events'), '.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    assert.throws(
      () => ledger.append('events', { id: 'rec-2', kind: 'test', payload: { n: 2 } }),
      BackendUnavailableError,
    );
    unlinkSync(lockPath);
    assert.equal(ledger.append('events', { id: 'rec-2', kind: 'test', payload: { n: 2 } }).record.seq, 2);
  } finally {
    cleanup(env);
  }
});

test('lock: a stale lock from a dead process is reclaimed automatically', () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env);
    appendN(ledger, 'events', 1);
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    writeFileSync(join(nsDir(env, 'events'), '.lock'), JSON.stringify({ pid: dead.pid, acquiredAt: Date.now() - 60_000 }));
    const res = ledger.append('events', { id: 'rec-2', kind: 'test', payload: { n: 2 } });
    assert.equal(res.record.seq, 2);
  } finally {
    cleanup(env);
  }
});

// ---------------- quotas ----------------

test('quota: a record over the 1 MiB line limit is refused with a typed error and no state change', () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env);
    appendN(ledger, 'events', 1);
    assert.throws(
      () => ledger.append('events', { id: 'big', kind: 'test', payload: { blob: 'x'.repeat(MAX_RECORD_BYTES) } }),
      InvalidRecordError,
    );
    const { records } = ledger.scan('events');
    assert.equal(records.length, 1);
    assert.equal(ledger.append('events', { id: 'rec-2', kind: 'test', payload: { n: 2 } }).record.seq, 2);
  } finally {
    cleanup(env);
  }
});

test('quota: undefined and non-serializable payloads are refused before touching the segment', () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env);
    assert.throws(() => ledger.append('events', { id: 'x', kind: 'test', payload: undefined }), InvalidRecordError);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    assert.throws(() => ledger.append('events', { id: 'x', kind: 'test', payload: cyclic }), InvalidRecordError);
    assert.equal(existsSync(segPath(env, 'events', 0)), false);
  } finally {
    cleanup(env);
  }
});

// ---------------- identity, meta, fork isolation ----------------

test('append: same id with a different payload or kind is a ConflictError; identical replay is not', () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env);
    ledger.append('events', { id: 'one', kind: 'test', payload: { n: 1 } });
    assert.throws(() => ledger.append('events', { id: 'one', kind: 'test', payload: { n: 2 } }), ConflictError);
    assert.throws(() => ledger.append('events', { id: 'one', kind: 'other', payload: { n: 1 } }), ConflictError);
    assert.equal(ledger.append('events', { id: 'one', kind: 'test', payload: { n: 1 } }).replayed, true);
  } finally {
    cleanup(env);
  }
});

test('meta: minted once with producer identity; corrupt or foreign meta refuses loudly', () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env);
    appendN(ledger, 'events', 1);
    const metaPath = join(env.opsRoot, env.ws, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
      configVersion: number;
      workspaceId: string;
      producerId: string;
      componentVersions: Record<string, number>;
    };
    assert.equal(meta.workspaceId, env.ws);
    assert.equal(meta.configVersion, 1);
    assert.match(meta.producerId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(meta.componentVersions, { hitl: 1, roster_ops: 1, objects: 1 });
    writeFileSync(metaPath, 'garbage{');
    assert.throws(() => openLedger(env).append('events', { id: 'y', kind: 'test', payload: {} }), InvalidRecordError);
    writeFileSync(metaPath, JSON.stringify({ ...meta, workspaceId: randomUUID() }));
    assert.throws(() => openLedger(env).append('events', { id: 'y', kind: 'test', payload: {} }), WorkspaceMismatchError);
  } finally {
    cleanup(env);
  }
});

test('fork isolation: two workspace UUID trees under one opsRoot are fully independent', () => {
  const env = makeEnv();
  try {
    const wsB = randomUUID();
    const a = openLedger(env);
    const b = new LocalLedger({ opsRoot: env.opsRoot, workspaceId: wsB });
    appendN(a, 'events', 3);
    assert.equal(b.scan('events').records.length, 0);
    b.append('events', { id: 'b-1', kind: 'test', payload: { n: 1 } });
    assert.equal(b.scan('events').records.length, 1);
    assert.equal(b.scan('events').lastSeq, 1);
    assert.equal(a.scan('events').records.length, 3);
    const metaA = JSON.parse(readFileSync(join(env.opsRoot, env.ws, 'meta.json'), 'utf8')) as { producerId: string };
    const metaB = JSON.parse(readFileSync(join(env.opsRoot, wsB, 'meta.json'), 'utf8')) as { producerId: string };
    assert.notEqual(metaA.producerId, metaB.producerId);
    for (const rec of a.scan('events').records) assert.equal(rec.ws, env.ws);
    for (const rec of b.scan('events').records) assert.equal(rec.ws, wsB);
  } finally {
    cleanup(env);
  }
});

test('permissions: workspace tree dirs are 0700 and ledger files 0600', { skip: process.platform === 'win32' }, () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env);
    appendN(ledger, 'events', 1);
    assert.equal(statSync(join(env.opsRoot, env.ws)).mode & 0o777, 0o700);
    assert.equal(statSync(nsDir(env, 'events')).mode & 0o777, 0o700);
    assert.equal(statSync(segPath(env, 'events', 0)).mode & 0o777, 0o600);
    assert.equal(statSync(join(env.opsRoot, env.ws, 'meta.json')).mode & 0o777, 0o600);
  } finally {
    cleanup(env);
  }
});

test('segments: a numbering gap is tamper-evidence and refuses loudly', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 1);
    const dir = nsDir(env, 'events');
    const renamed = join(dir, 'segment-0002.jsonl');
    writeFileSync(renamed, readFileSync(segPath(env, 'events', 0)));
    unlinkSync(segPath(env, 'events', 0));
    assert.throws(
      () => openLedger(env).scan('events'),
      (err: unknown) => err instanceof InvalidRecordError && /gap/.test((err as Error).message),
    );
  } finally {
    cleanup(env);
  }
});

test('clock injection: record ts comes from the injected clock', () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env, { now: () => 42 });
    const res = ledger.append('events', { id: 'one', kind: 'test', payload: {} });
    assert.equal(res.record.ts, 42);
  } finally {
    cleanup(env);
  }
});

test('constructor: non-UUID workspace ids are refused before any filesystem access', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-ledger-'));
  try {
    assert.throws(() => new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: 'not-a-uuid' }), InvalidRecordError);
    assert.throws(
      () => new LocalLedger({ opsRoot: join(dir, 'ops'), workspaceId: '../escape' }),
      InvalidRecordError,
    );
    assert.equal(existsSync(join(dir, 'ops')), false);
    assert.equal(readdirSync(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scan: a namespace that was never written reads empty without creating directories', () => {
  const env = makeEnv();
  try {
    mkdirSync(env.opsRoot, { recursive: true });
    const ledger = openLedger(env);
    assert.deepEqual(ledger.scan('events'), { records: [], lastSeq: 0 });
    assert.equal(existsSync(nsDir(env, 'events')), false);
  } finally {
    cleanup(env);
  }
});

// ---------------- symlink containment (reviewer PoC) ----------------

test('symlink escape PoC: .roster symlinked outside the workspace — every ledger write refuses, nothing lands outside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-ledger-poc-'));
  try {
    const cwd = join(dir, 'workspace');
    const outside = join(dir, 'outside');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(cwd, '.roster'));
    const ws = randomUUID();
    const ledger = new LocalLedger({ opsRoot: join(cwd, '.roster', 'ops'), workspaceId: ws });
    assert.throws(
      () => ledger.append('events', { id: 'x', kind: 'test', payload: { n: 1 } }),
      (err: unknown) => err instanceof InvalidRecordError && /symbolic link/.test((err as Error).message),
    );
    assert.deepEqual(readdirSync(outside), [], 'neither meta.json nor a segment may land outside');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlink TOCTOU: a segment swapped to a symlink between validation and open refuses (no-follow open)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-ledger-toctou-'));
  try {
    const outside = join(dir, 'outside.jsonl');
    writeFileSync(outside, '');
    const cwd = join(dir, 'workspace');
    mkdirSync(cwd, { recursive: true });
    const ws = randomUUID();
    const opsRoot = join(cwd, '.roster', 'ops');
    const ledger = new LocalLedger({ opsRoot, workspaceId: ws });
    const seg = join(opsRoot, ws, 'events', 'segment-0000.jsonl');
    // A concurrent adversary replaces the (not-yet-existing) segment path with a
    // symlink to outside the workspace AFTER the pre-open validation.
    assert.throws(
      () =>
        ledger.append(
          'events',
          { id: 'x', kind: 'test', payload: { n: 1 } },
          { beforeOpen: () => symlinkSync(outside, seg) },
        ),
      (err: unknown) =>
        err instanceof InvalidRecordError && /symbolic link|ELOOP/i.test((err as Error).message),
    );
    // The append must NOT have followed the symlink and written outside.
    assert.equal(readFileSync(outside, 'utf8'), '', 'nothing may be written through the swapped symlink');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlink: a segment file replaced by a symlink refuses recovery', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 2);
    const seg0 = segPath(env, 'events', 0);
    const copied = join(env.dir, 'stolen-segment.jsonl');
    writeFileSync(copied, readFileSync(seg0));
    unlinkSync(seg0);
    symlinkSync(copied, seg0);
    assert.throws(
      () => openLedger(env).scan('events'),
      (err: unknown) => err instanceof InvalidRecordError && /symbolic link/.test((err as Error).message),
    );
  } finally {
    cleanup(env);
  }
});

// ---------------- bounded recovery reads ----------------

test('recovery: an oversized complete line is a hard error naming the segment, never loaded', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 1);
    appendFileSync(segPath(env, 'events', 0), 'x'.repeat(MAX_RECORD_BYTES + 16) + '\n');
    assert.throws(
      () => openLedger(env).scan('events'),
      (err: unknown) =>
        err instanceof InvalidRecordError &&
        /segment-0000\.jsonl/.test((err as Error).message) &&
        /record limit/.test((err as Error).message),
    );
  } finally {
    cleanup(env);
  }
});

test('recovery: an oversized unterminated tail is rejected, not buffered without bound', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 1);
    appendFileSync(segPath(env, 'events', 0), 'y'.repeat(MAX_RECORD_BYTES + 16));
    assert.throws(
      () => openLedger(env).scan('events'),
      (err: unknown) => err instanceof InvalidRecordError && /record limit/.test((err as Error).message),
    );
  } finally {
    cleanup(env);
  }
});

// ---------------- segment numbering beyond 4 digits ----------------

test('segments: index 10000 (5 digits) is recognized by recovery, never silently ignored', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 1);
    // Synthesize the filename (no need to create 10000 segments): recovery
    // must MATCH it — proven by the gap error naming it, instead of a silent
    // scan that ignores the file and reuses stale sequence state.
    writeFileSync(join(nsDir(env, 'events'), 'segment-10000.jsonl'), '');
    assert.throws(
      () => openLedger(env).scan('events'),
      (err: unknown) =>
        err instanceof InvalidRecordError &&
        /gap/.test((err as Error).message) &&
        /segment-10000\.jsonl/.test((err as Error).message),
    );
  } finally {
    cleanup(env);
  }
});

// ---------------- false seal (forged sidecar) ----------------

function forgeSeal(segFile: string, lastValidOffset: number, records: number, lastHash: string | null): string {
  const body = { segment: segFile, lastValidOffset, records, lastHash };
  return JSON.stringify({ ...body, checksum: sha256Hex(JSON.stringify(body)) }) + '\n';
}

test('false seal: a self-consistent sidecar hiding valid records is discarded — all records reappear', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 3);
    const seg0 = segPath(env, 'events', 0);
    const content = readFileSync(seg0, 'utf8');
    const starts = lineStarts(content);
    const line0 = content.slice(0, starts[1]! - 1);
    // Checksum-valid sidecar claiming the segment ends after record 1.
    writeFileSync(`${seg0}.seal`, forgeSeal('segment-0000.jsonl', starts[1]!, 1, sha256Hex(line0)));
    const { records } = openLedger(env).scan('events');
    assert.deepEqual(records.map((r) => r.id), ['rec-1', 'rec-2', 'rec-3'], 'hidden records recovered');
    assert.equal(existsSync(`${seg0}.seal`), false, 'the lying sidecar is discarded');
    // Appends continue in the SAME (unsealed, fully valid) segment.
    const res = openLedger(env).append('events', { id: 'rec-4', kind: 'test', payload: { n: 4 } });
    assert.equal(res.record.seq, 4);
    assert.equal(existsSync(segPath(env, 'events', 1)), false);
  } finally {
    cleanup(env);
  }
});

test('false seal: a sidecar whose count/hash do not match the segment prefix is discarded and recomputed', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 3);
    const seg0 = segPath(env, 'events', 0);
    const content = readFileSync(seg0, 'utf8');
    const starts = lineStarts(content);
    truncateSync(seg0, starts[2]! + 10); // genuinely torn record 3
    // Offset is right but records/lastHash lie: verification recomputes.
    writeFileSync(`${seg0}.seal`, forgeSeal('segment-0000.jsonl', starts[2]!, 9, sha256Hex('nonsense')));
    const { records } = openLedger(env).scan('events');
    assert.deepEqual(records.map((r) => r.id), ['rec-1', 'rec-2']);
    const seal = JSON.parse(readFileSync(`${seg0}.seal`, 'utf8')) as { records: number; lastValidOffset: number };
    assert.equal(seal.records, 2, 'recomputed sidecar tells the truth');
    assert.equal(seal.lastValidOffset, starts[2]);
  } finally {
    cleanup(env);
  }
});

test('seal: a checksum-valid seal cannot hide a COMPLETE invalid line past its offset (corruption, not a torn tail)', () => {
  const env = makeEnv();
  try {
    // 1 valid record, then a COMPLETE (newline-terminated) invalid-JSON line —
    // NOT a torn tail. A sidecar must never convert this into a valid short
    // segment; the seal is invalid and the segment is corrupt.
    appendN(openLedger(env), 'events', 1);
    const seg0 = segPath(env, 'events', 0);
    const validBytes = readFileSync(seg0);
    const validOffset = validBytes.length; // end of record 1's line (incl. newline)
    appendFileSync(seg0, 'this-is-complete-but-not-json\n');
    const line0 = validBytes.toString('utf8').replace(/\n$/, '');
    // A self-consistent seal claiming the segment ends after record 1.
    writeFileSync(`${seg0}.seal`, forgeSeal('segment-0000.jsonl', validOffset, 1, sha256Hex(line0)));
    // Recovery must HARD-ERROR — never silently accept the 1-record view.
    assert.throws(
      () => openLedger(env).scan('events'),
      (err: unknown) =>
        err instanceof InvalidRecordError &&
        /segment-0000\.jsonl/.test((err as Error).message) &&
        /corrupt|invalid|not valid JSON/i.test((err as Error).message),
    );
  } finally {
    cleanup(env);
  }
});

test('honest seal: a verified sidecar over a genuinely torn tail is trusted (no recompute churn)', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 3);
    const seg0 = segPath(env, 'events', 0);
    const starts = lineStarts(readFileSync(seg0, 'utf8'));
    truncateSync(seg0, starts[2]! + 10);
    openLedger(env).scan('events'); // writes the honest seal
    const sealBytes = readFileSync(`${seg0}.seal`);
    const { records } = openLedger(env).scan('events');
    assert.deepEqual(records.map((r) => r.id), ['rec-1', 'rec-2']);
    assert.deepEqual(readFileSync(`${seg0}.seal`), sealBytes, 'honest sidecar untouched');
  } finally {
    cleanup(env);
  }
});

// ---------------- single canonical serialization ----------------

test('serialization: the payload is serialized exactly once — a stateful toJSON cannot poison the record', () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env);
    let calls = 0;
    const payload = {
      toJSON() {
        calls += 1;
        return { n: calls };
      },
    };
    const res = ledger.append('events', { id: 'stateful', kind: 'test', payload });
    assert.equal(calls, 1, 'toJSON evaluated exactly once');
    assert.deepEqual(res.record.payload, { n: 1 });
    // The record its own recovery would reject was the bug: rescan validates.
    const { records } = openLedger(env).scan('events');
    assert.deepEqual(records[0]!.payload, { n: 1 });
  } finally {
    cleanup(env);
  }
});

test('serialization: canonical key order — reordered-but-equivalent payloads dedup, and the checksum is the shared canonical hash', () => {
  const env = makeEnv();
  try {
    const ledger = openLedger(env);
    const first = ledger.append('events', { id: 'ord', kind: 'test', payload: { b: 2, a: 1 } });
    const replay = ledger.append('events', { id: 'ord', kind: 'test', payload: { a: 1, b: 2 } });
    assert.equal(replay.replayed, true, 'key order never causes a spurious conflict');
    assert.equal(first.record.checksum, sha256Hex(canonicalJson({ a: 1, b: 2 })), 'checksum = canonical hash (PG parity)');
  } finally {
    cleanup(env);
  }
});

// ---------------- directory-fsync failure propagation ----------------

test('fsyncDir: a directory fsync failure fails the append (no ack); retry after repair is an idempotent replay', () => {
  const env = makeEnv();
  const real = ledgerFsSeams.fsyncDirRaw;
  try {
    const ledger = openLedger(env);
    ledgerFsSeams.fsyncDirRaw = (path: string) => {
      if (path === nsDir(env, 'events')) {
        throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
      }
      real(path);
    };
    assert.throws(
      () => ledger.append('events', { id: 'rec-1', kind: 'test', payload: { n: 1 } }),
      (err: unknown) => err instanceof BackendUnavailableError && /injected EIO/.test((err as Error).message),
    );
    ledgerFsSeams.fsyncDirRaw = real;
    const retry = openLedger(env).append('events', { id: 'rec-1', kind: 'test', payload: { n: 1 } });
    assert.equal(retry.replayed, true, 'the durable-but-unacked record replays idempotently');
  } finally {
    ledgerFsSeams.fsyncDirRaw = real;
    cleanup(env);
  }
});

test('fsyncDir: replay after a dir-fsync failure RE-ATTEMPTS the directory fsync before acking', () => {
  const env = makeEnv();
  const real = ledgerFsSeams.fsyncDirRaw;
  try {
    const ledger = openLedger(env);
    const nsdir = nsDir(env, 'events');
    // First append: the file write + fsync succeed (record lands), but the
    // directory fsync fails — so directory durability was NEVER confirmed.
    ledgerFsSeams.fsyncDirRaw = (path: string) => {
      if (path === nsdir) throw Object.assign(new Error('injected EIO'), { code: 'EIO' });
      real(path);
    };
    assert.throws(
      () => ledger.append('events', { id: 'rec-1', kind: 'test', payload: { n: 1 } }),
      BackendUnavailableError,
    );
    // Repair the seam with a spy; replay the SAME id.
    const fsyncedDirs: string[] = [];
    ledgerFsSeams.fsyncDirRaw = (path: string) => {
      fsyncedDirs.push(path);
      real(path);
    };
    const retry = openLedger(env).append('events', { id: 'rec-1', kind: 'test', payload: { n: 1 } });
    assert.equal(retry.replayed, true, 'the durable-but-unacked record replays idempotently');
    assert.ok(
      fsyncedDirs.includes(nsdir),
      'the replay MUST re-fsync the namespace dir — the first attempt never confirmed directory durability',
    );
  } finally {
    ledgerFsSeams.fsyncDirRaw = real;
    cleanup(env);
  }
});

test('fsyncDir: artifact orphan re-adoption re-fsyncs the blob dir before the index append', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'roster-orphan-'));
  const real = ledgerFsSeams.fsyncDirRaw;
  try {
    const ws = randomUUID();
    const opsRoot = join(dir, '.roster', 'ops');
    const backend = createLocalBackend({ opsRoot, workspaceId: ws });
    const bytes = Buffer.from('orphan-bytes');
    const digest = sha256Hex(bytes);
    const bytesDir = join(opsRoot, ws, 'artifacts');
    // Simulate the crash window: bytes staged, no index record.
    mkdirSync(bytesDir, { recursive: true });
    writeFileSync(join(bytesDir, digest), bytes);
    const fsynced: string[] = [];
    ledgerFsSeams.fsyncDirRaw = (path: string) => {
      fsynced.push(path);
      real(path);
    };
    const res = await backend.artifacts.putArtifact(
      { filename: 'o.bin', contentType: 'application/octet-stream', runId: null },
      bytes,
    );
    assert.equal(res.outcome, 'committed');
    assert.ok(fsynced.includes(bytesDir), 're-adoption must re-fsync the blob dir');
    // Fault-injected variant: the re-adoption fsync failure blocks the index.
    ledgerFsSeams.fsyncDirRaw = (path: string) => {
      if (path === bytesDir) throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' });
      real(path);
    };
    const other = Buffer.from('second-orphan');
    const otherDigest = sha256Hex(other);
    writeFileSync(join(bytesDir, otherDigest), other);
    await assert.rejects(
      backend.artifacts.putArtifact({ filename: 'p.bin', contentType: 'application/octet-stream', runId: null }, other),
      BackendUnavailableError,
    );
    ledgerFsSeams.fsyncDirRaw = real;
    assert.equal(await backend.artifacts.head(otherDigest), null, 'no index record without the durable dir entry');
  } finally {
    ledgerFsSeams.fsyncDirRaw = real;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------- stale-lock reclaim race ----------------

test('stale-lock reclaim: inode re-verification aborts when a live writer takes the path mid-reclaim; nothing is clobbered', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 1);
    const lockPath = join(nsDir(env, 'events'), '.lock');
    const dead = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, acquiredAt: Date.now() - 60_000 }));
    // Interleaving seam: after the dead-holder verdict, a NEW live writer
    // replaces the lock at the pathname (different inode).
    const liveBody = JSON.stringify({ pid: process.pid, acquiredAt: Date.now() });
    const reclaimed = tryReclaimStaleLock(lockPath, {
      beforeRename: () => {
        unlinkSync(lockPath);
        writeFileSync(lockPath, liveBody);
      },
    });
    assert.equal(reclaimed, false, 'the reclaim must abort — the pathname no longer names the dead lock');
    assert.equal(readFileSync(lockPath, 'utf8'), liveBody, 'the live writer lock is untouched');
    unlinkSync(lockPath);
  } finally {
    cleanup(env);
  }
});

test('stale-lock reclaim: the dead lock is renamed aside (never restored) and a fresh acquire wins', () => {
  const env = makeEnv();
  try {
    appendN(openLedger(env), 'events', 1);
    const lockPath = join(nsDir(env, 'events'), '.lock');
    const dead = spawnSync(process.execPath, ['-e', '']);
    writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, acquiredAt: Date.now() - 60_000 }));
    assert.equal(tryReclaimStaleLock(lockPath), true);
    assert.equal(existsSync(lockPath), false, 'pathname freed for a fresh O_EXCL acquire');
    const asides = readdirSync(nsDir(env, 'events')).filter((e) => e.startsWith('.lock.stale-'));
    assert.equal(asides.length, 1, 'the dead lock is abandoned aside, never moved back');
    // Readers ignore the abandoned aside; appends proceed.
    const res = openLedger(env).append('events', { id: 'rec-2', kind: 'test', payload: { n: 2 } });
    assert.equal(res.record.seq, 2);
  } finally {
    cleanup(env);
  }
});
