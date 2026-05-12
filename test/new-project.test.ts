import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import fsExtra from 'fs-extra';

const { copySync } = fsExtra;

const SCAFFOLD = resolve('templates/scaffold');

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
};

function makeWorkspace(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-newproj-'));
  copySync(join(SCAFFOLD, 'scripts'), join(cwd, 'scripts'));
  copySync(join(SCAFFOLD, '.config'), join(cwd, '.config'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function run(cwd: string, args: string[]): RunResult {
  const out = spawnSync('bash', ['scripts/new-project.sh', ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: out.status ?? -1,
    stdout: out.stdout ?? '',
    stderr: out.stderr ?? '',
  };
}

function assertSubstrate(cwd: string, slug: string): void {
  const root = join(cwd, 'projects', slug);
  assert.ok(existsSync(root), `projects/${slug}/ exists`);
  assert.ok(existsSync(join(root, 'guidelines')), `guidelines/`);
  assert.ok(existsSync(join(root, 'config', 'default.yaml')), `config/default.yaml`);
  assert.ok(existsSync(join(root, 'state.md')), `state.md`);
}

test('normalizes "My Co" to "my-co" and creates substrate', () => {
  const { cwd, cleanup } = makeWorkspace();
  try {
    const r = run(cwd, ['My Co']);
    assert.equal(r.status, 0, r.stderr);
    assertSubstrate(cwd, 'my-co');
    const cfg = readFileSync(join(cwd, 'projects', 'my-co', 'config', 'default.yaml'), 'utf8');
    assert.match(cfg, /project: my-co/);
  } finally {
    cleanup();
  }
});

test('normalizes "foo bar/baz" to "foo-bar-baz"', () => {
  const { cwd, cleanup } = makeWorkspace();
  try {
    const r = run(cwd, ['foo bar/baz']);
    assert.equal(r.status, 0, r.stderr);
    assertSubstrate(cwd, 'foo-bar-baz');
  } finally {
    cleanup();
  }
});

test('exits non-zero when named function is not registered', () => {
  const { cwd, cleanup } = makeWorkspace();
  try {
    const r = run(cwd, ['acme', 'does-not-exist']);
    assert.notEqual(r.status, 0, 'expected non-zero exit');
    assert.match(r.stderr, /function 'does-not-exist' is not registered/);
    assert.ok(!existsSync(join(cwd, 'projects', 'acme')), 'no project created on error');
  } finally {
    cleanup();
  }
});

test('accepts a valid function from .config/functions.yaml', () => {
  const { cwd, cleanup } = makeWorkspace();
  try {
    const r = run(cwd, ['widget', 'gtm']);
    assert.equal(r.status, 0, r.stderr);
    assertSubstrate(cwd, 'widget');
    assert.match(r.stdout, /add-agent-to-project project=widget function=gtm/);
  } finally {
    cleanup();
  }
});

test('exits non-zero on duplicate project', () => {
  const { cwd, cleanup } = makeWorkspace();
  try {
    const first = run(cwd, ['acme']);
    assert.equal(first.status, 0, first.stderr);
    const second = run(cwd, ['acme']);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /already exists/);
  } finally {
    cleanup();
  }
});

test('exits non-zero on empty / all-special-char name', () => {
  const { cwd, cleanup } = makeWorkspace();
  try {
    const r = run(cwd, ['!!!']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /empty after normalization/);
  } finally {
    cleanup();
  }
});

test('prints usage on wrong arg count', () => {
  const { cwd, cleanup } = makeWorkspace();
  try {
    const none = run(cwd, []);
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /Usage:/);
    const tooMany = run(cwd, ['a', 'b', 'c']);
    assert.notEqual(tooMany.status, 0);
    assert.match(tooMany.stderr, /Usage:/);
  } finally {
    cleanup();
  }
});

test('state.md contains an ISO-8601 timestamp', () => {
  const { cwd, cleanup } = makeWorkspace();
  try {
    run(cwd, ['acme']);
    const state = readFileSync(join(cwd, 'projects', 'acme', 'state.md'), 'utf8');
    assert.match(state, /updated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  } finally {
    cleanup();
  }
});
