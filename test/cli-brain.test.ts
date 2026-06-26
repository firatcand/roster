import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { parseBrainArgs } from '../src/lib/brain-args.ts';
import { HAS_DB, createFreshDb } from './brain-helpers.ts';

const BIN = resolve(process.cwd(), 'bin/roster.js');
const dbOpts = { skip: HAS_DB ? false : 'ROSTER_BRAIN_ADMIN_URL not set' };

function runBin(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env });
}

test('parseBrainArgs: missing subcommand errors', () => {
  const r = parseBrainArgs([]);
  assert.equal(r.kind, 'err');
});

test('parseBrainArgs: unknown subcommand errors', () => {
  const r = parseBrainArgs(['frobnicate']);
  assert.equal(r.kind, 'err');
});

test('parseBrainArgs: init flags', () => {
  const r = parseBrainArgs(['init', '--json', '--embeddings']);
  assert.equal(r.kind, 'ok');
  assert.deepEqual(r, { kind: 'ok', subcommand: 'init', json: true, silent: false, embeddings: true, role: 'roster_brain_rw' });
});

test('parseBrainArgs: doctor rejects --embeddings', () => {
  const r = parseBrainArgs(['doctor', '--embeddings']);
  assert.equal(r.kind, 'err');
});

test('cli: brain unknown subcommand exits non-zero', () => {
  const r = runBin(['brain', 'nope'], { ...process.env });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown 'brain' subcommand/);
});

test('cli: brain init prints runtime URL exactly once; second init is a no-op (case 10)', dbOpts, async () => {
  const fresh = await createFreshDb();
  const env = { ...process.env, ROSTER_BRAIN_ADMIN_URL: fresh.url };
  try {
    const first = runBin(['brain', 'init', '--json', '--role', fresh.role], env);
    assert.equal(first.status, 0, first.stderr);
    const p1 = JSON.parse(first.stdout);
    assert.equal(p1.roleCreated, true);
    assert.ok(typeof p1.runtimeUrl === 'string' && p1.runtimeUrl.includes(fresh.role));
    assert.deepEqual(p1.applied, ['001_init.sql', '002_roles.sql', '003_attribution.sql', '004_documents_mount.sql', '005_dedup_merge.sql']);

    const occurrences = (first.stdout.match(new RegExp(fresh.role, 'g')) ?? []).length;
    assert.equal(occurrences, 1, 'runtime URL printed exactly once');

    const second = runBin(['brain', 'init', '--json', '--role', fresh.role], env);
    assert.equal(second.status, 0, second.stderr);
    const p2 = JSON.parse(second.stdout);
    assert.equal(p2.roleCreated, false);
    assert.equal(p2.runtimeUrl, null, 'second init must not re-print the secret');
    assert.deepEqual(p2.applied, []);
    assert.deepEqual(p2.skipped, ['001_init.sql', '002_roles.sql', '003_attribution.sql', '004_documents_mount.sql', '005_dedup_merge.sql']);
  } finally {
    await fresh.drop();
  }
});

test('cli: brain doctor green after init (case 9/10)', dbOpts, async () => {
  const fresh = await createFreshDb();
  const env = { ...process.env, ROSTER_BRAIN_ADMIN_URL: fresh.url };
  try {
    runBin(['brain', 'init', '--silent', '--role', fresh.role], env);
    const r = runBin(['brain', 'doctor', '--json', '--role', fresh.role], env);
    assert.equal(r.status, 0, r.stderr);
    const p = JSON.parse(r.stdout);
    assert.equal(p.ok, true);
  } finally {
    await fresh.drop();
  }
});
