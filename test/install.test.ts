import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installToTool, RosterPermissionError, type ConfirmFn, type InstallLogger } from '../src/lib/install.ts';
import { getToolByKey } from '../src/lib/tools.ts';

type Fixture = {
  root: string;
  source: string;
  claudeHome: string;
  cleanup: () => void;
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'roster-install-'));
  const source = join(root, 'source');
  const claudeHome = join(root, 'claude-home');

  mkdirSync(join(source, 'skills', 'sample-skill'), { recursive: true });
  writeFileSync(join(source, 'skills', 'sample-skill', 'SKILL.md'), '# sample\n');
  writeFileSync(join(source, 'skills', 'sample-skill', 'asset.txt'), 'hello\n');

  mkdirSync(join(source, 'skills', 'other-skill'), { recursive: true });
  writeFileSync(join(source, 'skills', 'other-skill', 'SKILL.md'), '# other\n');

  mkdirSync(join(source, 'agents'), { recursive: true });
  writeFileSync(join(source, 'agents', 'lesson-drafter.md'), '# lesson-drafter\n');
  writeFileSync(join(source, 'agents', 'ignored.txt'), 'should not copy\n');

  return {
    root,
    source,
    claudeHome,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function silentLogger(): { logger: InstallLogger; logs: string[]; warns: string[] } {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    logger: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
    logs,
    warns,
  };
}

const skillsSrc = (f: Fixture): string => join(f.source, 'skills');
const agentsSrc = (f: Fixture): string => join(f.source, 'agents');

test('ROSTER_CLAUDE_HOME env var redirects writes to the override path', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude');
    assert.ok(tool, 'claude tool definition exists');
    assert.equal(tool.skillsTarget, join(f.claudeHome, 'skills'));

    const { logger } = silentLogger();
    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
    });

    assert.equal(result.skillsCount, 2);
    assert.equal(result.agentsCount, 1);
    assert.equal(result.skillsTarget, join(f.claudeHome, 'skills'));
    assert.equal(result.agentsTarget, join(f.claudeHome, 'agents'));
    assert.ok(existsSync(join(f.claudeHome, 'skills', 'sample-skill', 'SKILL.md')));
    assert.ok(existsSync(join(f.claudeHome, 'skills', 'sample-skill', 'asset.txt')));
    assert.ok(existsSync(join(f.claudeHome, 'skills', 'other-skill', 'SKILL.md')));
    assert.ok(existsSync(join(f.claudeHome, 'agents', 'lesson-drafter.md')));
    assert.ok(!existsSync(join(f.claudeHome, 'agents', 'ignored.txt')));
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('installToTool is idempotent — re-running produces identical files', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;
    const { logger } = silentLogger();

    const first = await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    const firstSnap = readFileSync(join(f.claudeHome, 'skills', 'sample-skill', 'SKILL.md'), 'utf8');

    const second = await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    const secondSnap = readFileSync(join(f.claudeHome, 'skills', 'sample-skill', 'SKILL.md'), 'utf8');

    assert.deepEqual(first, second);
    assert.equal(firstSnap, secondSnap);
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('symlink at target path: decline-preserve leaves symlink intact + prints notice', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;

    mkdirSync(join(f.claudeHome, 'skills'), { recursive: true });
    const elsewhere = join(f.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'marker.txt'), 'live\n');
    symlinkSync(elsewhere, join(f.claudeHome, 'skills', 'sample-skill'), 'dir');

    const { logger, warns } = silentLogger();
    const declineConfirm: ConfirmFn = async () => false;

    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
      confirm: declineConfirm,
    });

    assert.ok(lstatSync(join(f.claudeHome, 'skills', 'sample-skill')).isSymbolicLink(), 'symlink preserved');
    assert.ok(existsSync(join(elsewhere, 'marker.txt')), 'symlink target untouched');
    assert.equal(result.skillsCount, 1, 'only the non-symlink skill counted');
    assert.ok(warns.some((w) => w.includes('preserved symlink')), 'warned about preservation');
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('symlink at target path: accept-overwrite removes symlink + writes real file', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;

    mkdirSync(join(f.claudeHome, 'skills'), { recursive: true });
    const elsewhere = join(f.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(f.claudeHome, 'skills', 'sample-skill'), 'dir');

    const { logger } = silentLogger();
    const acceptConfirm: ConfirmFn = async () => true;

    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
      confirm: acceptConfirm,
    });

    const stat = lstatSync(join(f.claudeHome, 'skills', 'sample-skill'));
    assert.ok(stat.isDirectory(), 'replaced symlink with a real directory');
    assert.ok(!stat.isSymbolicLink(), 'no symlink left');
    assert.ok(existsSync(join(f.claudeHome, 'skills', 'sample-skill', 'SKILL.md')), 'real content written');
    assert.equal(result.skillsCount, 2);
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('EACCES is caught and rethrown as RosterPermissionError with a remedy', async () => {
  // Skip on root since chmod won't induce EACCES.
  if (process.getuid && process.getuid() === 0) return;

  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    mkdirSync(f.claudeHome, { recursive: true });
    // Make claudeHome read-only so ensureDir(skills) hits EACCES.
    const { chmodSync } = await import('node:fs');
    chmodSync(f.claudeHome, 0o500);

    const tool = getToolByKey('claude')!;
    const { logger } = silentLogger();

    await assert.rejects(
      () => installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger }),
      (err: unknown) => {
        assert.ok(err instanceof RosterPermissionError, 'is RosterPermissionError');
        assert.match(err.message, /Permission denied/);
        assert.match(err.message, /sudo/, 'includes sudo remedy');
        assert.match(err.message, new RegExp(f.claudeHome.replace(/[/\\]/g, '.')), 'includes target path');
        return true;
      },
    );

    // Restore perms so cleanup can rm the dir.
    chmodSync(f.claudeHome, 0o700);
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});
