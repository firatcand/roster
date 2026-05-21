import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  executeInit,
  appendGitignoreBlock,
  detectForgeMarkers,
  detectV04Workspace,
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

test('roster init in an empty dir creates CONTEXT.md and symlinks CLAUDE.md + AGENTS.md (POSIX)', async () => {
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
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    assert.equal(result.projectName, 'acme-corp');

    // CONTEXT.md written as regular file
    assert.ok(existsSync(join(cwd, 'CONTEXT.md')), 'CONTEXT.md exists');
    assert.ok(result.filesWritten.includes('CONTEXT.md'), 'CONTEXT.md in filesWritten');

    // CLAUDE.md and AGENTS.md are symlinks
    assert.ok(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), 'CLAUDE.md is a symlink');
    assert.ok(lstatSync(join(cwd, 'AGENTS.md')).isSymbolicLink(), 'AGENTS.md is a symlink');
    assert.equal(readlinkSync(join(cwd, 'CLAUDE.md')), 'CONTEXT.md', 'CLAUDE.md → CONTEXT.md');
    assert.equal(readlinkSync(join(cwd, 'AGENTS.md')), 'CONTEXT.md', 'AGENTS.md → CONTEXT.md');
    assert.ok(result.filesLinked.includes('CLAUDE.md'), 'CLAUDE.md in filesLinked');
    assert.ok(result.filesLinked.includes('AGENTS.md'), 'AGENTS.md in filesLinked');

    // Content has project name substituted, no unresolved tokens
    const contextMd = readFileSync(join(cwd, 'CONTEXT.md'), 'utf8');
    assert.match(contextMd, /acme-corp/, 'project name substituted');
    assert.ok(!contextMd.includes('{{PROJECT_NAME}}'), 'no unresolved tokens');

    // CLAUDE.md readable through symlink with project name
    const claudeMd = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.match(claudeMd, /acme-corp/, 'CLAUDE.md (via symlink) has project name');

    assert.ok(existsSync(join(cwd, '.env.example')), '.env.example exists');
    assert.ok(existsSync(join(cwd, '.gitignore')), '.gitignore exists');
  } finally {
    cleanup();
  }
});

test('roster init produces the full scaffold tree (gtm, dreamer, chief-of-staff, conventions, …)', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'acme', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });

    const expected = [
      'conventions.md',
      'chief-of-staff/agent.md',
      'chief-of-staff/plans/audit-repo.yaml',
      'dreamer/agent.md',
      'dreamer/subagents/lesson-drafter.md',
      'gtm/EXPERT.md',
      'product/EXPERT.md',
      'design/EXPERT.md',
      'ops/EXPERT.md',
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
    await executeInit({ cwd, name: 'acme', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });

    const target = join(cwd, 'gtm', 'EXPERT.md');
    const userContent = '# my custom expert prompt\n';
    writeFileSync(target, userContent, 'utf8');

    await executeInit({
      cwd,
      name: 'acme',
      silent: true,
      force: true,
      noGit: true,
      confirm: yes,
      logger,
      platform: 'linux',
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

test('roster init in a forge dir with CONTEXT.md already present prompts with forge-aware message', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    // Pre-write CONTEXT.md (simulating previous roster init) plus forge marker
    writeFileSync(join(cwd, 'CONTEXT.md'), '# existing context\n', 'utf8');
    symlinkSync('CONTEXT.md', join(cwd, 'CLAUDE.md'));
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
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    assert.equal(seen.length, 1, 'confirm fired once');
    assert.match(seen[0]!, /forge/i, 'message mentions forge');
    assert.match(seen[0]!, /BRIEF\.md/, 'message lists the detected marker');
    const contextMd = readFileSync(join(cwd, 'CONTEXT.md'), 'utf8');
    assert.match(contextMd, /forge-proj/);
  } finally {
    cleanup();
  }
});

test('roster init in a forge dir declines → cancelled, no scaffold written', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    // Use a post-init workspace (CONTEXT.md + symlink) so forge prompt fires rather than migration guard
    writeFileSync(join(cwd, 'CONTEXT.md'), '# existing context\n', 'utf8');
    symlinkSync('CONTEXT.md', join(cwd, 'CLAUDE.md'));
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
      platform: 'linux',
    });

    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.filesWritten, []);
    assert.ok(!existsSync(join(cwd, 'projects')), 'projects/ not created');
    assert.ok(!existsSync(join(cwd, 'gtm')), 'gtm/ not created');
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
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    assert.equal(warns.length, 1, 'one warn line');
    assert.match(warns[0]!, /forge/i);
    assert.ok(existsSync(join(cwd, 'CLAUDE.md')), 'CLAUDE.md exists (symlink)');
    assert.ok(existsSync(join(cwd, 'gtm', 'EXPERT.md')), 'scaffold written');
  } finally {
    cleanup();
  }
});

test('roster init with forge marker but no CLAUDE.md AND --silent suppresses the warn (still writes scaffold)', async () => {
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
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    assert.equal(warns.length, 0, '--silent suppresses informational warns');
    assert.ok(existsSync(join(cwd, 'gtm', 'EXPERT.md')), 'scaffold still written');
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
    await executeInit({ cwd, name: 'perf', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });
    const ms = performance.now() - start;
    assert.ok(ms < 3000, `init took ${ms.toFixed(0)}ms, expected <3000ms`);
  } finally {
    cleanup();
  }
});

test('CLAUDE.md as regular file + no --force → cancelled with migration message', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CLAUDE.md'), '# pre-existing\n', 'utf8');
    const { logger } = silentLogger();

    const result = await executeInit({
      cwd,
      name: 'foo',
      silent: true,
      noGit: true,
      confirm: no,
      logger,
      platform: 'linux',
    });

    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.filesWritten, []);
    const claudeMd = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    assert.equal(claudeMd, '# pre-existing\n', 'CLAUDE.md unchanged');
    assert.ok(!existsSync(join(cwd, '.env.example')), '.env.example not written');
    assert.ok(!existsSync(join(cwd, 'projects')), 'projects/ not created');
    assert.ok(!existsSync(join(cwd, 'CONTEXT.md')), 'CONTEXT.md not created');
  } finally {
    cleanup();
  }
});

test('CONTEXT.md exists + declining overwrite prompt → cancelled', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# existing\n', 'utf8');
    const { logger } = silentLogger();

    const result = await executeInit({
      cwd,
      name: 'foo',
      silent: true,
      noGit: true,
      confirm: no,
      logger,
      platform: 'linux',
    });

    assert.equal(result.status, 'cancelled');
    assert.deepEqual(result.filesWritten, []);
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
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    assert.equal(prompted, false, 'no confirmation prompt when --force');
    // CLAUDE.md is now a symlink to CONTEXT.md
    assert.ok(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), 'CLAUDE.md replaced with symlink');
    const contextMd = readFileSync(join(cwd, 'CONTEXT.md'), 'utf8');
    assert.match(contextMd, /forced/);
  } finally {
    cleanup();
  }
});

test('.gitignore has Roster defaults block appended exactly once on repeated runs', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });
    await executeInit({ cwd, name: 'x', silent: true, force: true, noGit: true, confirm: yes, logger, platform: 'linux' });
    await executeInit({ cwd, name: 'x', silent: true, force: true, noGit: true, confirm: yes, logger, platform: 'linux' });

    const gi = readFileSync(join(cwd, '.gitignore'), 'utf8');
    const occurrences = (gi.match(new RegExp(GITIGNORE_MARKER_START, 'g')) ?? []).length;
    assert.equal(occurrences, 1, 'marker present exactly once');
  } finally {
    cleanup();
  }
});

test('.gitignore contains anchored /.env and recursive **/.env after init', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });

    const gi = readFileSync(join(cwd, '.gitignore'), 'utf8');
    const markerIdx = gi.indexOf(GITIGNORE_MARKER_START);
    assert.ok(markerIdx >= 0, 'roster marker present');
    const block = gi.slice(markerIdx);

    assert.match(block, /^\/\.env$/m, 'workspace-anchored /.env present in Roster block');
    assert.match(block, /^\*\*\/\.env$/m, 'recursive **/.env present in Roster block');
    assert.match(block, /^\.env$/m, 'pre-v1 .env rule preserved');
    assert.match(block, /^\.env\.local$/m, 'pre-v1 .env.local rule preserved');
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
    await executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });

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
      platform: 'linux',
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
    await executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });

    const after = readFileSync(join(cwd, '.env.example'), 'utf8');
    assert.equal(after, customEnv, '.env.example unchanged');
  } finally {
    cleanup();
  }
});

test('win32 dual-write: three regular files with identical content', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    const result = await executeInit({
      cwd,
      name: 'win-proj',
      silent: true,
      noGit: true,
      confirm: yes,
      logger,
      platform: 'win32',
    });

    assert.equal(result.status, 'ok');
    assert.ok(result.filesWritten.includes('CONTEXT.md'), 'CONTEXT.md written');
    assert.ok(result.filesWritten.includes('CLAUDE.md'), 'CLAUDE.md written');
    assert.ok(result.filesWritten.includes('AGENTS.md'), 'AGENTS.md written');
    assert.deepEqual(result.filesLinked, [], 'no symlinks on win32');

    // All three have identical content
    const contextContent = readFileSync(join(cwd, 'CONTEXT.md'), 'utf8');
    const claudeContent = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
    const agentsContent = readFileSync(join(cwd, 'AGENTS.md'), 'utf8');
    assert.equal(claudeContent, contextContent, 'CLAUDE.md matches CONTEXT.md');
    assert.equal(agentsContent, contextContent, 'AGENTS.md matches CONTEXT.md');

    // They must be regular files, not symlinks
    assert.equal(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), false, 'CLAUDE.md is not a symlink');
    assert.equal(lstatSync(join(cwd, 'AGENTS.md')).isSymbolicLink(), false, 'AGENTS.md is not a symlink');
  } finally {
    cleanup();
  }
});

test('re-run idempotency: correct symlinks skipped, CONTEXT.md unchanged → skipped', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'idem', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });

    const second = await executeInit({
      cwd,
      name: 'idem',
      silent: true,
      force: true,
      noGit: true,
      confirm: yes,
      logger,
      platform: 'linux',
    });

    assert.ok(second.filesSkipped.includes('CLAUDE.md'), 'CLAUDE.md symlink skipped on re-run');
    assert.ok(second.filesSkipped.includes('AGENTS.md'), 'AGENTS.md symlink skipped on re-run');
    // CONTEXT.md content is the same (no user edits) — skipped
    assert.ok(
      second.filesSkipped.includes('CONTEXT.md') || second.filesUpdated.includes('CONTEXT.md'),
      'CONTEXT.md skipped or updated on re-run',
    );
  } finally {
    cleanup();
  }
});

test('re-run: user region content preserved across managed-region refresh', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'user-preserve', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });

    // Edit the user region in CONTEXT.md
    const contextPath = join(cwd, 'CONTEXT.md');
    const content = readFileSync(contextPath, 'utf8');
    const edited = content.replace(
      '[Replace this section with project-specific context: domain, goals, constraints.]',
      'This is my custom workspace description.',
    );
    writeFileSync(contextPath, edited, 'utf8');

    await executeInit({
      cwd,
      name: 'user-preserve',
      silent: true,
      force: true,
      noGit: true,
      confirm: yes,
      logger,
      platform: 'linux',
    });

    const afterContent = readFileSync(contextPath, 'utf8');
    assert.ok(afterContent.includes('This is my custom workspace description.'), 'user region preserved');
    assert.ok(
      afterContent.includes('> **You are operating inside a roster-managed workspace.**'),
      'managed region refreshed',
    );
  } finally {
    cleanup();
  }
});

test('CLAUDE.md as regular file + --migrate → symlink created, user content preserved', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const userContent = '# My Custom Section\n\nImportant project details.';
    const oldClaudeMd = `# old-proj — Agent-Team Workspace\n\n${userContent}\n`;
    writeFileSync(join(cwd, 'CLAUDE.md'), oldClaudeMd, 'utf8');

    const { logger } = silentLogger();
    const result = await executeInit({
      cwd,
      name: 'old-proj',
      silent: true,
      noGit: true,
      migrate: true,
      confirm: yes,
      logger,
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    assert.ok(existsSync(join(cwd, 'CONTEXT.md')), 'CONTEXT.md created');
    assert.ok(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), 'CLAUDE.md replaced with symlink');
    const contextContent = readFileSync(join(cwd, 'CONTEXT.md'), 'utf8');
    assert.ok(contextContent.includes('Important project details.'), 'user content preserved in CONTEXT.md');
  } finally {
    cleanup();
  }
});

test('CLAUDE.md as regular file + --force → symlink created, no content preservation', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CLAUDE.md'), '# very important custom content\n', 'utf8');

    const { logger } = silentLogger();
    const result = await executeInit({
      cwd,
      name: 'force-proj',
      silent: true,
      noGit: true,
      force: true,
      confirm: yes,
      logger,
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    assert.ok(lstatSync(join(cwd, 'CLAUDE.md')).isSymbolicLink(), 'CLAUDE.md is a symlink');
    const contextContent = readFileSync(join(cwd, 'CONTEXT.md'), 'utf8');
    assert.ok(!contextContent.includes('very important custom content'), 'old content not preserved with --force');
  } finally {
    cleanup();
  }
});

test('symlink at wrong target + --force → re-linked to CONTEXT.md', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# ctx\n', 'utf8');
    writeFileSync(join(cwd, 'old-context.md'), '# old\n', 'utf8');
    symlinkSync('old-context.md', join(cwd, 'CLAUDE.md'));
    symlinkSync('CONTEXT.md', join(cwd, 'AGENTS.md'));

    const { logger } = silentLogger();
    const result = await executeInit({
      cwd,
      name: 'x',
      silent: true,
      noGit: true,
      force: true,
      confirm: yes,
      logger,
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    assert.equal(readlinkSync(join(cwd, 'CLAUDE.md')), 'CONTEXT.md', 'CLAUDE.md re-linked');
    assert.ok(result.filesLinked.includes('CLAUDE.md'), 'CLAUDE.md in filesLinked');
  } finally {
    cleanup();
  }
});

test('symlink at wrong target + no --force → throws', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    writeFileSync(join(cwd, 'CONTEXT.md'), '# ctx\n', 'utf8');
    writeFileSync(join(cwd, 'old-context.md'), '# old\n', 'utf8');
    symlinkSync('old-context.md', join(cwd, 'CLAUDE.md'));
    symlinkSync('CONTEXT.md', join(cwd, 'AGENTS.md'));

    const { logger } = silentLogger();
    await assert.rejects(
      () => executeInit({
        cwd,
        name: 'x',
        silent: true,
        noGit: true,
        force: false,
        confirm: yes,
        logger,
        platform: 'linux',
      }),
      /wrong target|re-link|--force/i,
    );
  } finally {
    cleanup();
  }
});

test('InitResult.filesWritten excludes skipped files', async () => {
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
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    // No file should appear in both filesWritten and filesSkipped
    for (const f of result.filesSkipped) {
      assert.ok(!result.filesWritten.includes(f), `${f} must not be in both filesWritten and filesSkipped`);
    }
  } finally {
    cleanup();
  }
});

test('InitResult.filesLinked populated on POSIX', async () => {
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
      platform: 'linux',
    });

    assert.equal(result.status, 'ok');
    assert.ok(result.filesLinked.includes('CLAUDE.md'), 'CLAUDE.md in filesLinked');
    assert.ok(result.filesLinked.includes('AGENTS.md'), 'AGENTS.md in filesLinked');
    assert.ok(!result.filesWritten.includes('CLAUDE.md'), 'CLAUDE.md not in filesWritten');
    assert.ok(!result.filesWritten.includes('AGENTS.md'), 'AGENTS.md not in filesWritten');
  } finally {
    cleanup();
  }
});

test('contract: CLAUDE.md symlink target is the literal string "CONTEXT.md"', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });
    assert.equal(readlinkSync(join(cwd, 'CLAUDE.md')), 'CONTEXT.md');
  } finally {
    cleanup();
  }
});

test('detectV04Workspace returns [] for an empty dir', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    assert.deepEqual(detectV04Workspace(cwd), []);
  } finally {
    cleanup();
  }
});

test('detectV04Workspace flags cwd/projects', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    mkdirSync(join(cwd, 'projects'));
    assert.deepEqual(detectV04Workspace(cwd), ['projects/']);
  } finally {
    cleanup();
  }
});

test('detectV04Workspace flags <function>/projects (one level)', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    mkdirSync(join(cwd, 'gtm', 'projects'), { recursive: true });
    assert.deepEqual(detectV04Workspace(cwd), ['gtm/projects/']);
  } finally {
    cleanup();
  }
});

test('detectV04Workspace flags <function>/<agent>/projects (two levels)', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    mkdirSync(join(cwd, 'gtm', 'sdr', 'projects'), { recursive: true });
    assert.deepEqual(detectV04Workspace(cwd), ['gtm/sdr/projects/']);
  } finally {
    cleanup();
  }
});

test('detectV04Workspace skips node_modules/dist/build/coverage and hidden dirs', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    for (const skip of ['node_modules', 'dist', 'build', 'coverage', 'lib', 'bin']) {
      mkdirSync(join(cwd, skip, 'projects'), { recursive: true });
    }
    mkdirSync(join(cwd, '.forge', 'projects'), { recursive: true });
    mkdirSync(join(cwd, '.git', 'projects'), { recursive: true });
    assert.deepEqual(detectV04Workspace(cwd), []);
  } finally {
    cleanup();
  }
});

test('detectV04Workspace returns multiple hits when multiple match', () => {
  const { cwd, cleanup } = makeTmp();
  try {
    mkdirSync(join(cwd, 'projects'));
    mkdirSync(join(cwd, 'gtm', 'projects'), { recursive: true });
    mkdirSync(join(cwd, 'gtm', 'sdr', 'projects'), { recursive: true });
    const hits = detectV04Workspace(cwd);
    assert.ok(hits.includes('projects/'));
    assert.ok(hits.includes('gtm/projects/'));
    assert.ok(hits.includes('gtm/sdr/projects/'));
    assert.equal(hits.length, 3);
  } finally {
    cleanup();
  }
});

test('executeInit refuses to scaffold on a v0.4 workspace (throws v04WorkspaceDetectedError)', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    mkdirSync(join(cwd, 'projects'));
    const { logger } = silentLogger();
    await assert.rejects(
      () => executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' }),
      (err: Error & { exitCode?: number; header?: string; body?: string }) => {
        assert.equal(err.exitCode, 2, 'exitCode is EXIT_CANCELLED');
        assert.match(err.header ?? err.message, /detected v0\.4 workspace/i);
        assert.match(err.body ?? err.message, /projects\//);
        return true;
      },
    );
    // No scaffold should have been written
    assert.ok(!existsSync(join(cwd, 'CONTEXT.md')), 'CONTEXT.md not created');
    assert.ok(!existsSync(join(cwd, 'gtm', 'EXPERT.md')), 'scaffold not created');
  } finally {
    cleanup();
  }
});

test('executeInit substitutes PROJECT_NAME and DISPLAY_NAME into config/project.yaml', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'acme-co', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });

    const yaml = readFileSync(join(cwd, 'config', 'project.yaml'), 'utf8');
    assert.match(yaml, /^name: acme-co\b/m, 'name substituted');
    assert.match(yaml, /^display_name: "acme-co"/m, 'display_name substituted (pass-through)');
    assert.ok(!yaml.includes('{{PROJECT_NAME}}'), 'no PROJECT_NAME placeholder left');
    assert.ok(!yaml.includes('{{DISPLAY_NAME}}'), 'no DISPLAY_NAME placeholder left');
    // The `.template` suffix is stripped on output
    assert.ok(!existsSync(join(cwd, 'config', 'project.yaml.template')), '.template suffix stripped');
  } finally {
    cleanup();
  }
});

test('contract: CONTEXT.md contains roster:managed:start orchestrator blockquote', async () => {
  const { cwd, cleanup } = makeTmp();
  try {
    const { logger } = silentLogger();
    await executeInit({ cwd, name: 'x', silent: true, noGit: true, confirm: yes, logger, platform: 'linux' });
    const content = readFileSync(join(cwd, 'CONTEXT.md'), 'utf8');
    assert.ok(
      content.includes('> **You are operating inside a roster-managed workspace.**'),
      'orchestrator blockquote present',
    );
  } finally {
    cleanup();
  }
});
