import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  executeInit,
  appendGitignoreBlock,
  detectForgeMarkers,
  substitute,
  walkScaffold,
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

test('roster init produces the full scaffold tree (gtm, dreamer, chief-of-staff, conventions, …)', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'acme', silent: true, noGit: true, confirm: yes, logger });

    const expected = [
      'conventions.md',
      'chief-of-staff/agent.md',
      'chief-of-staff/plans/audit-repo.yaml',
      'dreamer/agent.md',
      'dreamer/subagents/lesson-drafter.md',
      'gtm/sdr/agent.md',
      'gtm/sdr/projects/_demo/config/default.yaml',
      'projects/_demo/CLAUDE.md',
      'projects/_demo/config/default.yaml',
      'projects/_demo/guidelines/voice.md',
      'scripts/new-project.sh',
      'scripts/lib/functions.sh',
      '.config/functions.yaml',
      'logs/cron/.gitkeep',
    ];
    for (const rel of expected) {
      assert.ok(existsSync(join(cwd, rel)), `${rel} should exist`);
    }
  } finally {
    cleanup();
  }
});

test('roster init re-run preserves user-edited scaffold files', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'acme', silent: true, noGit: true, confirm: yes, logger });

    const target = join(cwd, 'gtm', 'sdr', 'agent.md');
    const userContent = '# my custom agent contract\n';
    writeFileSync(target, userContent, 'utf8');

    await executeInit({
      cwd,
      name: 'acme',
      silent: true,
      force: true,
      noGit: true,
      confirm: yes,
      logger,
    });

    assert.equal(readFileSync(target, 'utf8'), userContent, 'user edit preserved');
  } finally {
    cleanup();
  }
});

test('walkScaffold substitutes .template files and strips the suffix', () => {
  const { cwd: src, cleanup: cleanSrc } = makeTmp();
  const { cwd: dst, cleanup: cleanDst } = makeTmp();
  try {
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'plain.md'), 'plain {{PROJECT_NAME}}\n', 'utf8');
    writeFileSync(join(src, 'config.template.yaml'), 'name: {{PROJECT_NAME}}\n', 'utf8');
    writeFileSync(join(src, 'sub', 'README.template'), 'project: {{PROJECT_NAME}}\n', 'utf8');

    const written = walkScaffold(src, dst, { PROJECT_NAME: 'acme' });

    assert.equal(readFileSync(join(dst, 'plain.md'), 'utf8'), 'plain {{PROJECT_NAME}}\n', 'plain files copied byte-for-byte');
    assert.equal(readFileSync(join(dst, 'config.yaml'), 'utf8'), 'name: acme\n', 'template substituted, .template stripped');
    assert.equal(readFileSync(join(dst, 'sub', 'README'), 'utf8'), 'project: acme\n', 'template w/o extension substituted');
    assert.ok(!existsSync(join(dst, 'config.template.yaml')), 'template suffix gone');
    assert.ok(written.includes('plain.md'));
    assert.ok(written.includes('config.yaml'));
  } finally {
    cleanSrc();
    cleanDst();
  }
});

test('walkScaffold preserves existing target files', () => {
  const { cwd: src, cleanup: cleanSrc } = makeTmp();
  const { cwd: dst, cleanup: cleanDst } = makeTmp();
  try {
    writeFileSync(join(src, 'a.md'), 'from-scaffold\n', 'utf8');
    writeFileSync(join(dst, 'a.md'), 'user-content\n', 'utf8');

    const written = walkScaffold(src, dst, {});

    assert.equal(readFileSync(join(dst, 'a.md'), 'utf8'), 'user-content\n', 'existing file preserved');
    assert.ok(!written.includes('a.md'), 'preserved file not reported as written');
  } finally {
    cleanSrc();
    cleanDst();
  }
});

test('detectForgeMarkers finds BRIEF.md, spec/PRD.md, and plans/phases.yaml', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    assert.deepEqual(detectForgeMarkers(cwd), []);

    writeFileSync(join(cwd, 'BRIEF.md'), '# brief\n', 'utf8');
    mkdirSync(join(cwd, 'spec'), { recursive: true });
    writeFileSync(join(cwd, 'spec', 'PRD.md'), '# prd\n', 'utf8');
    mkdirSync(join(cwd, 'plans'), { recursive: true });
    writeFileSync(join(cwd, 'plans', 'phases.yaml'), 'phases:\n', 'utf8');

    assert.deepEqual(detectForgeMarkers(cwd), ['BRIEF.md', 'spec/PRD.md', 'plans/phases.yaml']);
  } finally {
    cleanup();
  }
});

test('roster init in a forge dir prompts with forge-aware message and accepts overwrite', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CLAUDE.md'), '# pre-existing\n', 'utf8');
    writeFileSync(join(cwd, 'BRIEF.md'), '# forge brief\n', 'utf8');

    const seen: string[] = [];
    const captureConfirm: ConfirmFn = async (message) => {
      seen.push(message);
      return true;
    };
    const { logger } = silentLogger();

    const result = await executeInit({
      cwd,
      name: 'forge-proj',
      silent: true,
      noGit: true,
      confirm: captureConfirm,
      logger,
    });

    assert.equal(result.status, 'ok');
    assert.equal(seen.length, 1, 'confirm fired once');
    assert.match(seen[0]!, /forge/i, 'message mentions forge');
    assert.match(seen[0]!, /BRIEF\.md/, 'message lists the detected marker');
    const claudeMd = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /forge-proj/);
  } finally {
    cleanup();
  }
});

test('roster init in a forge dir declines → cancelled, no scaffold written', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CLAUDE.md'), '# pre-existing\n', 'utf8');
    mkdirSync(join(cwd, 'plans'), { recursive: true });
    writeFileSync(join(cwd, 'plans', 'phases.yaml'), 'phases:\n', 'utf8');

    const { logger, logs } = silentLogger();
    const result = await executeInit({
      cwd,
      name: 'x',
      silent: true,
      noGit: true,
      confirm: no,
      logger,
    });

    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.filesWritten, []);
    assert.ok(!existsSync(join(cwd, 'projects')), 'projects/ not created');
    assert.ok(!existsSync(join(cwd, 'gtm')), 'gtm/ not created');
    assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8'), '# pre-existing\n');
    // logs may include the 'Cancelled' info line — not asserted here
    void logs;
  } finally {
    cleanup();
  }
});

test('roster init with forge marker but no CLAUDE.md warns and proceeds', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'BRIEF.md'), '# forge brief\n', 'utf8');

    const warns: string[] = [];
    const logger: InitLogger = { log: () => {}, warn: (m) => warns.push(m) };

    const result = await executeInit({
      cwd,
      name: 'x',
      silent: false, // non-silent: warn must fire
      noGit: true,
      confirm: yes,
      logger,
    });

    assert.equal(result.status, 'ok');
    assert.equal(warns.length, 1, 'one warn line');
    assert.match(warns[0]!, /forge/i);
    assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md written');
    assert.ok(existsSync(join(cwd, 'gtm', 'sdr', 'agent.md')), 'scaffold written');
  } finally {
    cleanup();
  }
});

test('roster init with forge marker but no CLAUDE.md AND --silent suppresses the warn', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'BRIEF.md'), '# forge brief\n', 'utf8');

    const warns: string[] = [];
    const logger: InitLogger = { log: () => {}, warn: (m) => warns.push(m) };

    const result = await executeInit({
      cwd,
      name: 'x',
      silent: true,
      noGit: true,
      confirm: yes,
      logger,
    });

    assert.equal(result.status, 'ok');
    assert.equal(warns.length, 0, '--silent suppresses informational warns');
    assert.ok(existsSync(join(cwd, 'gtm', 'sdr', 'agent.md')), 'scaffold still written');
  } finally {
    cleanup();
  }
});

test('walkScaffold throws on a non-regular source entry (packaging hazard)', () => {
  const { cwd: src, cleanup: cleanSrc } = makeTmp();
  const { cwd: dst, cleanup: cleanDst } = makeTmp();
  try {
    writeFileSync(join(src, 'real.md'), 'ok\n', 'utf8');
    symlinkSync(join(src, 'real.md'), join(src, 'link.md'));

    assert.throws(
      () => walkScaffold(src, dst, {}),
      /unexpected entry type/,
    );
  } finally {
    cleanSrc();
    cleanDst();
  }
});

test('walkScaffold preserves a symlink at non-template destination (including broken links)', () => {
  const { cwd: src, cleanup: cleanSrc } = makeTmp();
  const { cwd: dst, cleanup: cleanDst } = makeTmp();
  try {
    writeFileSync(join(src, 'good.md'), 'from-scaffold\n', 'utf8');
    writeFileSync(join(src, 'broken.md'), 'from-scaffold\n', 'utf8');

    const externalTarget = join(src, 'external.txt');
    writeFileSync(externalTarget, 'user content\n', 'utf8');
    symlinkSync(externalTarget, join(dst, 'good.md'));
    symlinkSync(join(dst, 'does-not-exist'), join(dst, 'broken.md'));

    const written = walkScaffold(src, dst, {});

    assert.ok(lstatSync(join(dst, 'good.md')).isSymbolicLink(), 'valid symlink preserved');
    assert.ok(lstatSync(join(dst, 'broken.md')).isSymbolicLink(), 'broken symlink preserved');
    assert.equal(readFileSync(externalTarget, 'utf8'), 'user content\n', 'symlink target untouched');
    assert.ok(!written.includes('good.md'));
    assert.ok(!written.includes('broken.md'));
  } finally {
    cleanSrc();
    cleanDst();
  }
});

test('walkScaffold refuses to overwrite a symlink at a template destination', () => {
  const { cwd: src, cleanup: cleanSrc } = makeTmp();
  const { cwd: dst, cleanup: cleanDst } = makeTmp();
  try {
    writeFileSync(join(src, 'config.template.yaml'), 'name: {{PROJECT_NAME}}\n', 'utf8');

    const externalTarget = join(src, 'external.yaml');
    writeFileSync(externalTarget, 'untouchable\n', 'utf8');
    symlinkSync(externalTarget, join(dst, 'config.yaml'));

    assert.throws(
      () => walkScaffold(src, dst, { PROJECT_NAME: 'acme' }),
      /refusing to overwrite symlink/,
    );
    assert.equal(readFileSync(externalTarget, 'utf8'), 'untouchable\n', 'symlink target not modified');
  } finally {
    cleanSrc();
    cleanDst();
  }
});

test('roster init completes within the 3s budget on local filesystem', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    const start = performance.now();
    await executeInit({ cwd, name: 'perf', silent: true, noGit: true, confirm: yes, logger });
    const ms = performance.now() - start;
    assert.ok(ms < 3000, `init took ${ms.toFixed(0)}ms, expected <3000ms`);
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
