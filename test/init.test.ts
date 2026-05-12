import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeInit,
  appendGitignoreBlock,
  substitute,
  GITIGNORE_MARKER_START,
  type ConfirmFn,
  type InitLogger,
} from '../src/commands/init.ts';

function makeTmp(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-init-'));
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

function silentLogger(): { logger: InitLogger; logs: string[] } {
  const logs: string[] = [];
  return {
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    logs,
  };
}

const yes: ConfirmFn = async () => true;
const no: ConfirmFn = async () => false;

test('substitute() replaces all {{KEY}} occurrences and leaves unknown tokens', () => {
  assert.equal(substitute('hello {{NAME}}', { NAME: 'world' }), 'hello world');
  assert.equal(
    substitute('a={{X}} b={{Y}} c={{X}}', { X: '1', Y: '2' }),
    'a=1 b=2 c=1',
  );
  assert.equal(substitute('{{UNKNOWN}}', {}), '{{UNKNOWN}}');
  assert.equal(substitute('no tokens here', { X: '1' }), 'no tokens here');
});

test('roster init in an empty dir creates CLAUDE.md with project name substituted', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    const result = await executeInit({
      cwd,
      name: 'acme-corp',
      silent: true,
      noGit: true,
      confirm: yes,
      logger,
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.projectName, 'acme-corp');
    assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md exists');
    const claudeMd = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /acme-corp/, 'project name substituted');
    assert.ok(!claudeMd.includes('{{PROJECT_NAME}}'), 'no unresolved tokens');
    assert.ok(existsSync(join(cwd, '.env.example')), '.env.example exists');
    assert.ok(existsSync(join(cwd, '.gitignore')), '.gitignore exists');
    assert.ok(existsSync(join(cwd, 'projects', '_demo', 'README.md')), 'projects/_demo/README.md exists');
  } finally {
    cleanup();
  }
});

test('roster init with existing CLAUDE.md prompts and declining exits cancelled, no files written', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CLAUDE.md'), '# pre-existing\n', 'utf8');
    const { logger } = silentLogger();

    const result = await executeInit({
      cwd,
      name: 'foo',
      silent: true,
      noGit: true,
      confirm: no, // decline overwrite
      logger,
    });

    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.filesWritten, []);
    const claudeMd = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.equal(claudeMd, '# pre-existing\n', 'CLAUDE.md unchanged');
    assert.ok(!existsSync(join(cwd, '.env.example')), '.env.example not written');
    assert.ok(!existsSync(join(cwd, 'projects')), 'projects/ not created');
  } finally {
    cleanup();
  }
});

test('--force skips the overwrite confirmation', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CLAUDE.md'), '# pre-existing\n', 'utf8');
    const { logger } = silentLogger();

    let prompted = false;
    const confirm: ConfirmFn = async () => {
      prompted = true;
      return true;
    };

    const result = await executeInit({
      cwd,
      name: 'forced',
      silent: true,
      force: true,
      noGit: true,
      confirm,
      logger,
    });

    assert.equal(result.status, 'ok');
    assert.equal(prompted, false, 'no confirmation prompt when --force');
    const claudeMd = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /forced/);
  } finally {
    cleanup();
  }
});

test('.gitignore has Roster defaults block appended exactly once on repeated runs', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger });
    await executeInit({ cwd, name: 'x', silent: true, force: true, noGit: true, confirm: yes, logger });
    await executeInit({ cwd, name: 'x', silent: true, force: true, noGit: true, confirm: yes, logger });

    const gi = readFileSync(join(cwd, '.gitignore'), 'utf8');
    const occurrences = (gi.match(new RegExp(GITIGNORE_MARKER_START, 'g')) ?? []).length;
    assert.equal(occurrences, 1, 'marker present exactly once');
  } finally {
    cleanup();
  }
});

test('appendGitignoreBlock preserves existing .gitignore content', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const existing = 'node_modules/\n*.log\n';
    writeFileSync(join(cwd, '.gitignore'), existing, 'utf8');

    appendGitignoreBlock(cwd);

    const after = readFileSync(join(cwd, '.gitignore'), 'utf8');
    assert.ok(after.startsWith(existing), 'pre-existing rules preserved at top');
    assert.ok(after.includes(GITIGNORE_MARKER_START), 'roster block appended');
  } finally {
    cleanup();
  }
});

test('init creates .env.example with placeholder values only', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger });

    const env = readFileSync(join(cwd, '.env.example'), 'utf8');
    // Every uncommented line ought to be empty; everything else starts with #.
    for (const line of env.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      assert.ok(trimmed.startsWith('#'), `non-comment line in .env.example: ${line}`);
    }
  } finally {
    cleanup();
  }
});

test('init does not write .git/ when noGit is true', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    const result = await executeInit({
      cwd,
      name: 'x',
      silent: true,
      noGit: true,
      confirm: yes,
      logger,
    });
    assert.equal(result.gitInitialized, false);
    assert.ok(!existsSync(join(cwd, '.git')), '.git/ not created');
  } finally {
    cleanup();
  }
});

test('init preserves existing .env.example (no overwrite)', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const customEnv = '# my custom env\nMY_VAR=value\n';
    writeFileSync(join(cwd, '.env.example'), customEnv, 'utf8');

    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger });

    const after = readFileSync(join(cwd, '.env.example'), 'utf8');
    assert.equal(after, customEnv, '.env.example unchanged');
  } finally {
    cleanup();
  }
});
