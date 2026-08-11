import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createGeneratedManifest,
  parseGeneratedManifest,
  parseGeneratedMarkdown,
  renderGeneratedManifest,
  renderGeneratedMarkdown,
} from '../src/lib/generated-artifacts.ts';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[], cwd: string, env: Record<string, string> = {}): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

test('update: in a v2 workspace synchronizes activation and the vendor-skill map', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-'));
  const claudeHome = join(root, '.h-claude');
  const fakeHome = join(root, '.home');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  try {
    // Scaffold a real workspace first.
    assert.equal(runCli(['init', 'tw', '--silent'], root).status, 0);
    const env = { HOME: fakeHome, ROSTER_CLAUDE_HOME: claudeHome };
    const install = runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], root, env);
    assert.equal(install.status, 0, install.stderr);
    rmSync(join(root, '.claude', 'CLAUDE.md'));
    const r = runCli(['update'], root, env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(root, '.claude', 'CLAUDE.md')), 'missing generated activation is recreated');
    assert.ok(existsSync(join(root, '.roster', 'generated-manifest.json')), 'portable generated manifest exists');
    assert.equal(existsSync(join(root, '.roster', 'scaffold-manifest.json')), false);
    assert.equal(existsSync(join(root, '.claude', 'skills', 'inbox', 'SKILL.md')), false);
    assert.match(r.stdout, /v2 activation \+ vendor-skill map/);
    assert.ok(existsSync(join(root, '.roster', 'vendor-skill-map.json')));
    assert.doesNotMatch(r.stdout, /Founder skills|Scaffold files|hooks/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: an incomplete tool draft blocks every activation and map write', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-draft-'));
  const claudeHome = join(root, '.h-claude');
  const fakeHome = join(root, '.home');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  try {
    const env = { HOME: fakeHome, ROSTER_CLAUDE_HOME: claudeHome };
    assert.equal(runCli(['init', 'tw', '--silent'], root, env).status, 0);
    assert.equal(runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], root, env).status, 0);
    assert.equal(runCli([
      'scaffold',
      'tool-use',
      'search',
      '--scope',
      'workspace',
      '--purpose',
      'Search public sources.',
    ], root, env).status, 0);
    const manifestPath = join(root, '.roster', 'generated-manifest.json');
    const manifestBefore = readFileSync(manifestPath);
    const activationPath = join(root, '.claude', 'CLAUDE.md');
    rmSync(activationPath);

    const result = runCli(['update'], root, env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /TOOL_USE_DRAFT_INCOMPLETE|incomplete scaffold draft/i);
    assert.equal(existsSync(activationPath), false);
    assert.equal(existsSync(join(root, '.roster', 'vendor-skill-map.json')), false);
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: a symlinked vendor map target fails before activation and preserves outside bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-map-link-'));
  const claudeHome = join(root, '.h-claude');
  const fakeHome = join(root, '.home');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  try {
    const env = { HOME: fakeHome, ROSTER_CLAUDE_HOME: claudeHome };
    assert.equal(runCli(['init', 'tw', '--silent'], root, env).status, 0);
    assert.equal(
      runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], root, env).status,
      0,
    );
    const activationPath = join(root, '.claude', 'CLAUDE.md');
    const manifestPath = join(root, '.roster', 'generated-manifest.json');
    const activationBefore = readFileSync(activationPath);
    const manifestBefore = readFileSync(manifestPath);
    const outside = join(root, 'outside-map.json');
    const sentinel = 'outside bytes must remain untouched\n';
    writeFileSync(outside, sentinel);
    symlinkSync(outside, join(root, '.roster', 'vendor-skill-map.json'));

    const result = runCli(['update'], root, env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/i);
    assert.deepEqual(readFileSync(activationPath), activationBefore);
    assert.deepEqual(readFileSync(manifestPath), manifestBefore);
    assert.equal(readFileSync(outside, 'utf8'), sentinel);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: converges an old-generator workspace and is idempotent afterwards', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-upgrade-'));
  const claudeHome = join(root, '.h-claude');
  const fakeHome = join(root, '.home');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  try {
    const env = { HOME: fakeHome, ROSTER_CLAUDE_HOME: claudeHome };
    assert.equal(runCli(['init', 'tw', '--silent'], root, env).status, 0);
    assert.equal(
      runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], root, env).status,
      0,
    );
    const paths = [join(root, 'ROSTER.md'), join(root, '.claude', 'CLAUDE.md')];
    const canonical = paths.map((path) => readFileSync(path, 'utf8'));
    for (const path of paths) {
      const parsed = parseGeneratedMarkdown(readFileSync(path, 'utf8'))!;
      const { content_hash: _contentHash, ...header } = parsed.header;
      writeFileSync(path, renderGeneratedMarkdown(
        { ...header, generator_version: '0.0.0-stale' },
        parsed.body,
        parsed.prefix,
      ));
    }
    const manifestPath = join(root, '.roster', 'generated-manifest.json');
    const manifest = parseGeneratedManifest(readFileSync(manifestPath, 'utf8'))!;
    const { manifest_hash: _manifestHash, ...draft } = manifest;
    writeFileSync(manifestPath, renderGeneratedManifest(createGeneratedManifest({
      ...draft,
      generator_version: '0.0.0-stale',
      files: draft.files.map((entry) => {
        const parsed = parseGeneratedMarkdown(
          readFileSync(join(root, ...entry.path.split('/')), 'utf8'),
        )!;
        return { ...entry, content_hash: parsed.header.content_hash };
      }),
    })));

    const first = runCli(['update'], root, env);
    assert.equal(first.status, 0, first.stderr);
    paths.forEach((path, index) => {
      assert.equal(readFileSync(path, 'utf8'), canonical[index]);
    });
    const second = runCli(['update', '--json'], root, env);
    assert.equal(second.status, 0, second.stderr);
    const payload = JSON.parse(second.stdout) as {
      results: Array<{ files: Array<{ status: string }> }>;
    };
    assert.ok(payload.results.flatMap((result) => result.files)
      .every((file) => file.status === 'unchanged'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: a generated-contract shadow exits 1 while canonical files are still synced', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-shadow-'));
  const claudeHome = join(root, '.h-claude');
  const fakeHome = join(root, '.home');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  try {
    const env = { HOME: fakeHome, ROSTER_CLAUDE_HOME: claudeHome };
    assert.equal(runCli(['init', 'tw', '--silent'], root, env).status, 0);
    assert.equal(
      runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], root, env).status,
      0,
    );
    const activationPath = join(root, '.claude', 'CLAUDE.md');
    const shadowBytes = readFileSync(activationPath);
    writeFileSync(join(root, 'CLAUDE.md'), shadowBytes);
    rmSync(activationPath);

    const result = runCli(['update'], root, env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /GENERATED_SHADOW/);
    assert.ok(existsSync(activationPath), 'canonical activation is still recreated');
    assert.deepEqual(readFileSync(join(root, 'CLAUDE.md')), shadowBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: a generated copy under .claude/rules exits 1 and is never touched', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-rules-shadow-'));
  const claudeHome = join(root, '.h-claude');
  const fakeHome = join(root, '.home');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  try {
    const env = { HOME: fakeHome, ROSTER_CLAUDE_HOME: claudeHome };
    assert.equal(runCli(['init', 'tw', '--silent'], root, env).status, 0);
    assert.equal(
      runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], root, env).status,
      0,
    );
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
    const copied = readFileSync(join(root, '.claude', 'CLAUDE.md'));
    const shadowPath = join(root, '.claude', 'rules', 'extra.md');
    writeFileSync(shadowPath, copied);

    const result = runCli(['update'], root, env);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /GENERATED_SHADOW/);
    assert.match(result.stdout, /\.claude\/rules\/extra\.md/);
    assert.deepEqual(readFileSync(shadowPath), copied);
    assert.deepEqual(readFileSync(join(root, '.claude', 'CLAUDE.md')), copied);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: outside a workspace → refuses (non-zero)', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-bare-'));
  try {
    const r = runCli(['update'], root);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /requires a roster workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: unknown flag → exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-flag-'));
  try {
    const r = runCli(['update', '--bogus'], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('update: removed --exclude flag fails loudly instead of becoming a no-op', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-update-exclude-'));
  try {
    const r = runCli(['update', '--exclude', 'guidelines'], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag '--exclude'/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
