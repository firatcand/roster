import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const enabled = process.env['ROSTER_HOST_ACTIVATION_SMOKE'] === '1';
const fixtureRoot = resolve('test/fixtures/host-activation');

function run(command: string, args: readonly string[], cwd: string, timeout = 180_000): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join('\n'));
  return result.stdout;
}

function isolatedFixture(name: string): { cwd: string; cleanup: () => void } {
  const temporary = mkdtempSync(join(tmpdir(), `roster-host-${name}-`));
  const cwd = join(temporary, 'project');
  cpSync(join(fixtureRoot, name), cwd, { recursive: true });
  run('git', ['init', '-q', cwd], temporary, 30_000);
  return { cwd, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
}

test('LIVE: exact-patch Claude project activation fixtures auto-load', { skip: !enabled }, () => {
  assert.equal(run('claude', ['--version'], fixtureRoot, 30_000).trim(), '2.1.220 (Claude Code)');
  for (const fixture of [
    { name: 'claude-project', expected: 'ROSTER_CLAUDE_PROJECT_LOADED' },
    { name: 'claude-rule', expected: 'ROSTER_CLAUDE_RULE_LOADED' },
  ]) {
    const isolated = isolatedFixture(fixture.name);
    try {
      const output = run('claude', [
        '-p',
        '--model',
        'haiku',
        '--output-format',
        'text',
        'ROSTER_ACTIVATION_FIXTURE',
      ], isolated.cwd);
      assert.equal(output.trim(), fixture.expected);
    } finally {
      isolated.cleanup();
    }
  }
});

test('LIVE: exact-patch Codex root AGENTS.md auto-loads', { skip: !enabled }, () => {
  assert.equal(run('codex', ['--version'], fixtureRoot, 30_000).trim(), 'codex-cli 0.144.1');
  const isolated = isolatedFixture('codex-project');
  const outputPath = join(isolated.cwd, 'last-message.txt');
  try {
    run('codex', [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--color',
      'never',
      '-o',
      outputPath,
      'ROSTER_ACTIVATION_FIXTURE',
    ], isolated.cwd);
    assert.equal(readFileSync(outputPath, 'utf8').trim(), 'ROSTER_CODEX_PROJECT_LOADED');
  } finally {
    isolated.cleanup();
  }
});
