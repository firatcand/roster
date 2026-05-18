import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MANIFEST_VERSION,
  decideFileAction,
  fileSha256,
  manifestPathFor,
  readManifest,
  sourceHashFor,
  writeManifest,
  type Manifest,
} from '../src/lib/migrate/manifest.ts';

function makeTmp(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('sourceHashFor: stable for identical input', () => {
  assert.equal(sourceHashFor('/a/b/c'), sourceHashFor('/a/b/c'));
  assert.notEqual(sourceHashFor('/a/b/c'), sourceHashFor('/a/b/d'));
});

test('manifestPathFor: stable layout', () => {
  const p = manifestPathFor('/dest', 'abc123');
  assert.match(p, /\.roster\/migration-manifests\/agent-team-abc123\.json$/);
});

test('fileSha256: matches across reads', () => {
  const t = makeTmp('manifest-sha-');
  try {
    const f = join(t.dir, 'file.txt');
    writeFileSync(f, 'hello world', 'utf8');
    assert.equal(fileSha256(f), fileSha256(f));
  } finally {
    t.cleanup();
  }
});

test('writeManifest + readManifest: round-trip', () => {
  const t = makeTmp('manifest-rw-');
  try {
    const path = manifestPathFor(t.dir, 'h1');
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      sourceDir: '/src',
      sourceHash: 'h1',
      migratedAt: '2026-05-18T00:00:00.000Z',
      files: [
        { src: '/a.md', dest: '/x/a.md', srcSha256: 'abc', copiedAtUtc: '2026-05-18T00:00:00.000Z' },
      ],
    };
    writeManifest(path, manifest);
    const read = readManifest(path);
    assert.deepEqual(read, manifest);
  } finally {
    t.cleanup();
  }
});

test('readManifest: returns null for missing or malformed file', () => {
  const t = makeTmp('manifest-missing-');
  try {
    assert.equal(readManifest(join(t.dir, 'nope.json')), null);
    const bad = join(t.dir, 'bad.json');
    writeFileSync(bad, '{not valid json', 'utf8');
    assert.equal(readManifest(bad), null);
  } finally {
    t.cleanup();
  }
});

test('decideFileAction: dest missing → write', () => {
  const t = makeTmp('decide-1-');
  try {
    const r = decideFileAction({
      srcPath: '/src/a.md',
      destPath: join(t.dir, 'missing.md'),
      srcSha: 'sha-a',
      manifestEntry: undefined,
      forceResync: false,
    });
    assert.equal(r.kind, 'write');
  } finally {
    t.cleanup();
  }
});

test('decideFileAction: dest exists with no manifest entry → skip (hand-edit)', () => {
  const t = makeTmp('decide-2-');
  try {
    const dest = join(t.dir, 'existing.md');
    writeFileSync(dest, 'user edit', 'utf8');
    const r = decideFileAction({
      srcPath: '/src/a.md',
      destPath: dest,
      srcSha: 'sha-a',
      manifestEntry: undefined,
      forceResync: false,
    });
    assert.equal(r.kind, 'skip');
    if (r.kind === 'skip') assert.equal(r.reason, 'user-hand-edited-destination');
  } finally {
    t.cleanup();
  }
});

test('decideFileAction: dest exists, manifest matches both src+dest → noop', () => {
  const t = makeTmp('decide-3-');
  try {
    const dest = join(t.dir, 'same.md');
    writeFileSync(dest, 'content', 'utf8');
    const destSha = fileSha256(dest);
    const r = decideFileAction({
      srcPath: '/src/a.md',
      destPath: dest,
      srcSha: destSha, // src unchanged from when we migrated
      manifestEntry: {
        src: '/src/a.md',
        dest,
        srcSha256: destSha,
        copiedAtUtc: '2026-05-17T00:00:00.000Z',
      },
      forceResync: false,
    });
    assert.equal(r.kind, 'noop');
  } finally {
    t.cleanup();
  }
});

test('decideFileAction: dest hand-edited (sha drift) → skip', () => {
  const t = makeTmp('decide-4-');
  try {
    const dest = join(t.dir, 'edited.md');
    writeFileSync(dest, 'user changed this', 'utf8');
    const r = decideFileAction({
      srcPath: '/src/a.md',
      destPath: dest,
      srcSha: 'sha-when-we-migrated',
      manifestEntry: {
        src: '/src/a.md',
        dest,
        srcSha256: 'sha-when-we-migrated',
        copiedAtUtc: '2026-05-17T00:00:00.000Z',
      },
      forceResync: false,
    });
    assert.equal(r.kind, 'skip');
    if (r.kind === 'skip') assert.equal(r.reason, 'user-hand-edited-destination');
  } finally {
    t.cleanup();
  }
});

test('decideFileAction: source changed, no force-resync → skip with hint', () => {
  const t = makeTmp('decide-5-');
  try {
    const dest = join(t.dir, 'changed-src.md');
    writeFileSync(dest, 'old content', 'utf8');
    const destSha = fileSha256(dest);
    const r = decideFileAction({
      srcPath: '/src/a.md',
      destPath: dest,
      srcSha: 'sha-new', // source changed
      manifestEntry: {
        src: '/src/a.md',
        dest,
        srcSha256: destSha, // what we migrated last time
        copiedAtUtc: '2026-05-17T00:00:00.000Z',
      },
      forceResync: false,
    });
    assert.equal(r.kind, 'skip');
    if (r.kind === 'skip') assert.equal(r.reason, 'source-changed-since-last-migration');
  } finally {
    t.cleanup();
  }
});

test('decideFileAction: source changed, force-resync → write', () => {
  const t = makeTmp('decide-6-');
  try {
    const dest = join(t.dir, 'changed-src-force.md');
    writeFileSync(dest, 'old content', 'utf8');
    const destSha = fileSha256(dest);
    const r = decideFileAction({
      srcPath: '/src/a.md',
      destPath: dest,
      srcSha: 'sha-new',
      manifestEntry: {
        src: '/src/a.md',
        dest,
        srcSha256: destSha,
        copiedAtUtc: '2026-05-17T00:00:00.000Z',
      },
      forceResync: true,
    });
    assert.equal(r.kind, 'write');
  } finally {
    t.cleanup();
  }
});
