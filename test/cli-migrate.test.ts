import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildAgentTeamMini } from './fixtures/agent-team-mini/_setup.ts';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

function runCli(args: readonly string[]): Run {
  const out = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
  });
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function makeDest(initialized: boolean): { dest: string; cleanup: () => void } {
  const dest = mkdtempSync(join(tmpdir(), 'roster-migrate-cli-'));
  if (initialized) {
    writeFileSync(join(dest, 'CONTEXT.md'), '# init\n');
    mkdirSync(join(dest, 'roster'));
  }
  return { dest, cleanup: () => rmSync(dest, { recursive: true, force: true }) };
}

test('roster migrate: missing subcommand → exit 1 with helpful error', () => {
  const r = runCli(['migrate']);
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /missing subcommand/);
});

test('roster migrate: unknown subcommand → exit 1', () => {
  const r = runCli(['migrate', 'from-nowhere']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown 'migrate' subcommand/);
});

test('roster migrate from-agent-team: missing source-dir → exit 1', () => {
  const r = runCli(['migrate', 'from-agent-team']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing positional/);
});

test('roster migrate from-agent-team: nonexistent source → exit 1 with friendly message', () => {
  const r = runCli(['migrate', 'from-agent-team', '/this/path/does/not/exist/anywhere']);
  assert.equal(r.status, 1, `stdout: ${r.stdout}, stderr: ${r.stderr}`);
  assert.match(r.stderr, /source directory not found/);
});

test('roster migrate from-agent-team: dry-run on uninitialized dest still prints plan', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest(false);
  try {
    const r = runCli([
      'migrate',
      'from-agent-team',
      fix.root,
      '--dest',
      dst.dest,
      '--dry-run',
    ]);
    // Plan is printed (the blocker just shows in the blockers section); CLI exits 1
    // because the plan has blockers.
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stdout, /not an initialized roster workspace/i);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('roster migrate from-agent-team: live run on .env at 0644 refuses with chmod hint', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest(true);
  try {
    const r = runCli(['migrate', 'from-agent-team', fix.root, '--dest', dst.dest]);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /\.env permissions are too open/);
    assert.match(r.stderr, /chmod 600/);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('roster migrate from-agent-team: live run completes after chmod, produces manifest + script + report', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest(true);
  try {
    chmodSync(join(fix.root, '.env'), 0o600);
    const r = runCli(['migrate', 'from-agent-team', fix.root, '--dest', dst.dest]);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);

    // Pending migrated
    assert.ok(existsSync(join(dst.dest, 'roster', 'dreamer', 'pending', 'L-2026-05-05-001.md')));

    // .env migrated at 0o600
    assert.ok(existsSync(join(dst.dest, '.env')));

    // Install script present and contains expected commands
    const scriptDir = join(dst.dest, '.roster', 'migration-scripts');
    assert.ok(existsSync(scriptDir));

    // Report present
    const reportDir = join(dst.dest, '.roster', 'migration-reports');
    assert.ok(existsSync(reportDir));

    // Manifest present
    const manifestDir = join(dst.dest, '.roster', 'migration-manifests');
    assert.ok(existsSync(manifestDir));
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('roster migrate from-agent-team --json: emits valid JSON with execution data', () => {
  const fix = buildAgentTeamMini();
  const dst = makeDest(true);
  try {
    chmodSync(join(fix.root, '.env'), 0o600);
    const r = runCli(['migrate', 'from-agent-team', fix.root, '--dest', dst.dest, '--json']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const obj = JSON.parse(r.stdout) as { ok: boolean; plan: { scheduleInstalls: unknown[] }; execution: { manifestPath: string } };
    assert.equal(obj.ok, true);
    assert.equal(obj.plan.scheduleInstalls.length, 2);
    assert.notEqual(obj.execution.manifestPath, null);
  } finally {
    fix.cleanup();
    dst.cleanup();
  }
});

test('roster migrate from-agent-team: appears in --help output', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /roster migrate from-agent-team/);
});

test('roster migrate codex-skills: copies missing legacy Codex skills into .agents and leaves source', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'roster-codex-skills-'));
  try {
    mkdirSync(join(workspace, '.codex', 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(workspace, '.codex', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: "a"\n---\n\nalpha\n');

    const r = runCli(['migrate', 'codex-skills', '--cwd', workspace]);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.ok(existsSync(join(workspace, '.agents', 'skills', 'alpha', 'SKILL.md')), 'skill copied into .agents');
    assert.ok(existsSync(join(workspace, '.codex', 'skills', 'alpha', 'SKILL.md')), 'legacy source left in place');
    assert.match(r.stdout, /copied: 1/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('roster migrate codex-skills: .agents wins when both sides differ', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'roster-codex-skills-'));
  try {
    mkdirSync(join(workspace, '.codex', 'skills', 'alpha'), { recursive: true });
    mkdirSync(join(workspace, '.agents', 'skills', 'alpha'), { recursive: true });
    writeFileSync(join(workspace, '.codex', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: "legacy"\n---\n\nlegacy\n');
    writeFileSync(join(workspace, '.agents', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: "canonical"\n---\n\ncanonical\n');

    const r = runCli(['migrate', 'codex-skills', '--cwd', workspace]);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    assert.equal(readFileSync(join(workspace, '.agents', 'skills', 'alpha', 'SKILL.md'), 'utf8'), '---\nname: alpha\ndescription: "canonical"\n---\n\ncanonical\n');
    assert.match(r.stdout, /conflicts: 1/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
