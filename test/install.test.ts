import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installToTool, type ConfirmFn, type InstallLogger } from '../src/lib/install.ts';
import { getToolByKey } from '../src/lib/tools.ts';
import { RosterError, EXIT_ERROR } from '../src/lib/errors.ts';

type Fixture = {
  root: string;
  source: string;
  claudeHome: string;
  codexHome: string;
  geminiHome: string;
  cleanup: () => void;
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'roster-install-'));
  const source = join(root, 'source');
  const claudeHome = join(root, 'claude-home');
  const codexHome = join(root, 'codex-home');
  const geminiHome = join(root, 'gemini-home');

  mkdirSync(join(source, 'skills', 'sample-skill'), { recursive: true });
  writeFileSync(join(source, 'skills', 'sample-skill', 'SKILL.md'), '# sample\n');
  writeFileSync(join(source, 'skills', 'sample-skill', 'asset.txt'), 'hello\n');

  mkdirSync(join(source, 'skills', 'other-skill'), { recursive: true });
  writeFileSync(join(source, 'skills', 'other-skill', 'SKILL.md'), '# other\n');

  mkdirSync(join(source, 'agents'), { recursive: true });
  writeFileSync(
    join(source, 'agents', 'lesson-drafter.md'),
    [
      '---',
      'name: lesson-drafter',
      'description: "Drafts a lesson candidate from observed outcomes."',
      '---',
      '',
      '# lesson-drafter',
      '',
      'Body content for the lesson-drafter agent.',
      '',
    ].join('\n'),
  );
  writeFileSync(join(source, 'agents', 'ignored.txt'), 'should not copy\n');

  return {
    root,
    source,
    claudeHome,
    codexHome,
    geminiHome,
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

test('EACCES is caught and rethrown as a structured RosterError with a remedy', async () => {
  // Skip on root since chmod won't induce EACCES.
  if (process.getuid && process.getuid() === 0) return;

  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    mkdirSync(f.claudeHome, { recursive: true });
    const { chmodSync } = await import('node:fs');
    chmodSync(f.claudeHome, 0o500);

    const tool = getToolByKey('claude')!;
    const { logger } = silentLogger();

    await assert.rejects(
      () => installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError, 'is RosterError');
        const e = err as RosterError;
        assert.match(e.header, /permission denied/i, 'header mentions permission denied');
        assert.match(e.remedy, /sudo/, 'remedy mentions sudo');
        assert.match(e.body, new RegExp(f.claudeHome.replace(/[/\\]/g, '.')), 'body includes target path');
        assert.equal(e.exitCode, EXIT_ERROR);
        return true;
      },
    );

    chmodSync(f.claudeHome, 0o700);
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Codex CLI — directory-layout skills under ~/.agents/skills/<name>/
// ──────────────────────────────────────────────────────────────────────────────

test('codex: ROSTER_CODEX_HOME redirects writes to the override path', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    const tool = getToolByKey('codex');
    assert.ok(tool, 'codex tool definition exists');
    assert.equal(tool.skillsTarget, join(f.root, '.agents', 'skills'));
    assert.equal(tool.agentsTarget, join(f.codexHome, 'agents'));
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('codex: skills written as directories under ~/.agents/skills/<name>/', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    const tool = getToolByKey('codex')!;
    const { logger } = silentLogger();

    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
    });

    assert.equal(result.skillsCount, 2);
    assert.equal(result.skillsTarget, join(f.root, '.agents', 'skills'));

    assert.ok(existsSync(join(f.root, '.agents', 'skills', 'sample-skill', 'SKILL.md')), 'sample-skill SKILL.md written');
    assert.ok(existsSync(join(f.root, '.agents', 'skills', 'sample-skill', 'asset.txt')), 'sample-skill asset copied');
    assert.ok(existsSync(join(f.root, '.agents', 'skills', 'other-skill', 'SKILL.md')), 'other-skill SKILL.md written');
    assert.ok(!existsSync(join(f.codexHome, 'skills', 'sample-skill', 'SKILL.md')), 'legacy .codex/skills target was not written');

    // Bodies are byte-identical to source (fixture skills have no frontmatter, so
    // no installed_for injection happens — see the frontmatter-injection test
    // in test/orchestrator.test.ts for the rendered-output assertions).
    assert.equal(readFileSync(join(f.root, '.agents', 'skills', 'sample-skill', 'SKILL.md'), 'utf8'), '# sample\n');
    assert.equal(readFileSync(join(f.root, '.agents', 'skills', 'other-skill', 'SKILL.md'), 'utf8'), '# other\n');
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('codex: agents rendered as <name>.toml + <name>.persona.md sidecar; non-.md ignored (ROS-33)', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    const tool = getToolByKey('codex')!;
    const { logger } = silentLogger();

    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
    });

    assert.equal(result.agentsCount, 1);
    assert.equal(result.agentsTarget, join(f.codexHome, 'agents'));
    const tomlPath = join(f.codexHome, 'agents', 'lesson-drafter.toml');
    const personaPath = join(f.codexHome, 'agents', 'lesson-drafter.persona.md');
    assert.ok(existsSync(tomlPath), '.toml file emitted');
    assert.ok(existsSync(personaPath), '.persona.md sidecar emitted');
    assert.ok(!existsSync(join(f.codexHome, 'agents', 'lesson-drafter.md')), 'no .md copy under codex agents');
    assert.ok(!existsSync(join(f.codexHome, 'agents', 'ignored.txt')));

    const toml = readFileSync(tomlPath, 'utf8');
    assert.match(toml, /^name = "lesson-drafter"$/m);
    assert.match(toml, /^developer_instructions = """$/m);
    assert.doesNotMatch(toml, /^instructions\s*=/m, 'no legacy instructions key');
    assert.doesNotMatch(toml, /^reasoning_effort\s*=/m, 'no legacy reasoning_effort key');
    assert.match(toml, /openai\/codex#19399/, 'header cites upstream issue');

    const persona = readFileSync(personaPath, 'utf8');
    assert.ok(persona.startsWith('# lesson-drafter'), 'persona body starts with markdown heading from source');
    assert.ok(!persona.startsWith('---'), 'persona body excludes frontmatter');
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('codex: malformed agent (no frontmatter) is skipped + warns — install continues', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    writeFileSync(join(f.source, 'agents', 'broken.md'), '# missing frontmatter\n');

    const tool = getToolByKey('codex')!;
    const { logger, warns } = silentLogger();

    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
    });

    assert.equal(result.agentsCount, 1, 'only the well-formed agent counted');
    assert.ok(!existsSync(join(f.codexHome, 'agents', 'broken.toml')), 'broken agent emitted no toml');
    assert.ok(warns.some((w) => w.includes('broken.md') && w.includes('skipped')), 'warned about skip');
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('codex: agent install is idempotent — re-running produces byte-identical .toml + .persona.md', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    const tool = getToolByKey('codex')!;
    const { logger } = silentLogger();

    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    const tomlSnap = readFileSync(join(f.codexHome, 'agents', 'lesson-drafter.toml'), 'utf8');
    const personaSnap = readFileSync(join(f.codexHome, 'agents', 'lesson-drafter.persona.md'), 'utf8');

    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    assert.equal(readFileSync(join(f.codexHome, 'agents', 'lesson-drafter.toml'), 'utf8'), tomlSnap);
    assert.equal(readFileSync(join(f.codexHome, 'agents', 'lesson-drafter.persona.md'), 'utf8'), personaSnap);
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('codex: install is idempotent — re-running produces identical files', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    const tool = getToolByKey('codex')!;
    const { logger } = silentLogger();

    const first = await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    const firstSnap = readFileSync(join(f.root, '.agents', 'skills', 'sample-skill', 'SKILL.md'), 'utf8');

    const second = await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    const secondSnap = readFileSync(join(f.root, '.agents', 'skills', 'sample-skill', 'SKILL.md'), 'utf8');

    assert.deepEqual(first, second);
    assert.equal(firstSnap, secondSnap);
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('codex: skill directory without SKILL.md is skipped + warns', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    // Add a skill dir with no SKILL.md inside.
    mkdirSync(join(f.source, 'skills', 'no-body-skill'), { recursive: true });
    writeFileSync(join(f.source, 'skills', 'no-body-skill', 'README.md'), 'not a skill body\n');

    const tool = getToolByKey('codex')!;
    const { logger, warns } = silentLogger();

    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
    });

    assert.equal(result.skillsCount, 2, 'only the two skills with SKILL.md counted');
    assert.ok(!existsSync(join(f.codexHome, 'skills', 'no-body-skill')), 'no-body-skill dir not created');
    assert.ok(
      warns.some((w) => w.includes('no-body-skill') && w.includes('SKILL.md missing')),
      'warns when SKILL.md missing',
    );
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('codex: EACCES is wrapped as RosterError with remedy', async () => {
  if (process.getuid && process.getuid() === 0) return;

  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    mkdirSync(f.codexHome, { recursive: true });
    const { chmodSync } = await import('node:fs');
    chmodSync(f.codexHome, 0o500);

    const tool = getToolByKey('codex')!;
    const { logger } = silentLogger();

    await assert.rejects(
      () => installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError, 'is RosterError');
        const e = err as RosterError;
        assert.match(e.header, /permission denied/i);
        assert.match(e.remedy, /sudo/);
        assert.equal(e.exitCode, EXIT_ERROR);
        return true;
      },
    );

    chmodSync(f.codexHome, 0o700);
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('codex: symlink at skill-dir target — decline-preserve leaves symlink intact', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    const tool = getToolByKey('codex')!;

    mkdirSync(join(f.root, '.agents', 'skills'), { recursive: true });
    const elsewhere = join(f.root, 'codex-elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'SKILL.md'), 'live\n');
    symlinkSync(elsewhere, join(f.root, '.agents', 'skills', 'sample-skill'), 'dir');

    const { logger, warns } = silentLogger();
    const declineConfirm: ConfirmFn = async () => false;

    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
      confirm: declineConfirm,
    });

    assert.ok(lstatSync(join(f.root, '.agents', 'skills', 'sample-skill')).isSymbolicLink(), 'symlink preserved');
    assert.equal(readFileSync(join(elsewhere, 'SKILL.md'), 'utf8'), 'live\n', 'symlink target untouched');
    assert.equal(result.skillsCount, 1, 'only the non-symlink skill counted');
    assert.ok(warns.some((w) => w.includes('preserved symlink')), 'warned about preservation');
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// Gemini CLI (ROS-15) — directory-layout skills under ~/.gemini/extensions
// ──────────────────────────────────────────────────────────────────────────────

test('gemini: ROSTER_GEMINI_HOME redirects writes to the override path', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_GEMINI_HOME'] = f.geminiHome;
    const tool = getToolByKey('gemini');
    assert.ok(tool, 'gemini tool definition exists');
    assert.equal(tool.skillsTarget, join(f.geminiHome, 'extensions'));
    assert.equal(tool.agentsTarget, join(f.geminiHome, 'agents'));
  } finally {
    delete process.env['ROSTER_GEMINI_HOME'];
    f.cleanup();
  }
});

test('gemini: skills copied as directories into extensions/, agents as .md', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_GEMINI_HOME'] = f.geminiHome;
    const tool = getToolByKey('gemini')!;
    const { logger } = silentLogger();

    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
    });

    assert.equal(result.skillsCount, 2);
    assert.equal(result.agentsCount, 1);
    assert.equal(result.skillsTarget, join(f.geminiHome, 'extensions'));
    assert.equal(result.agentsTarget, join(f.geminiHome, 'agents'));
    assert.ok(existsSync(join(f.geminiHome, 'extensions', 'sample-skill', 'SKILL.md')));
    assert.ok(existsSync(join(f.geminiHome, 'extensions', 'sample-skill', 'asset.txt')));
    assert.ok(existsSync(join(f.geminiHome, 'extensions', 'other-skill', 'SKILL.md')));
    assert.ok(existsSync(join(f.geminiHome, 'agents', 'lesson-drafter.md')));
    assert.ok(!existsSync(join(f.geminiHome, 'agents', 'ignored.txt')));
  } finally {
    delete process.env['ROSTER_GEMINI_HOME'];
    f.cleanup();
  }
});

test('gemini: install is idempotent — re-running produces identical files', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_GEMINI_HOME'] = f.geminiHome;
    const tool = getToolByKey('gemini')!;
    const { logger } = silentLogger();

    const first = await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    const firstSnap = readFileSync(join(f.geminiHome, 'extensions', 'sample-skill', 'SKILL.md'), 'utf8');

    const second = await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    const secondSnap = readFileSync(join(f.geminiHome, 'extensions', 'sample-skill', 'SKILL.md'), 'utf8');

    assert.deepEqual(first, second);
    assert.equal(firstSnap, secondSnap);
  } finally {
    delete process.env['ROSTER_GEMINI_HOME'];
    f.cleanup();
  }
});

test('gemini: EACCES is wrapped as RosterError with remedy', async () => {
  if (process.getuid && process.getuid() === 0) return;

  const f = makeFixture();
  try {
    process.env['ROSTER_GEMINI_HOME'] = f.geminiHome;
    mkdirSync(f.geminiHome, { recursive: true });
    const { chmodSync } = await import('node:fs');
    chmodSync(f.geminiHome, 0o500);

    const tool = getToolByKey('gemini')!;
    const { logger } = silentLogger();

    await assert.rejects(
      () => installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger }),
      (err: unknown) => {
        assert.ok(err instanceof RosterError, 'is RosterError');
        const e = err as RosterError;
        assert.match(e.header, /permission denied/i);
        assert.match(e.remedy, /sudo/);
        assert.equal(e.exitCode, EXIT_ERROR);
        return true;
      },
    );

    chmodSync(f.geminiHome, 0o700);
  } finally {
    delete process.env['ROSTER_GEMINI_HOME'];
    f.cleanup();
  }
});

test('env overrides are re-read per call — changing ROSTER_*_HOME mid-process is honoured', async () => {
  const f = makeFixture();
  const secondCodexHome = join(f.root, 'second-parent', 'codex-home-2');
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    const toolA = getToolByKey('codex')!;
    assert.equal(toolA.skillsTarget, join(f.root, '.agents', 'skills'));
    const { logger } = silentLogger();
    await installToTool(toolA, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    assert.ok(existsSync(join(f.root, '.agents', 'skills', 'sample-skill', 'SKILL.md')));

    process.env['ROSTER_CODEX_HOME'] = secondCodexHome;
    const toolB = getToolByKey('codex')!;
    assert.equal(toolB.skillsTarget, join(f.root, 'second-parent', '.agents', 'skills'), 'second call re-reads env');
    await installToTool(toolB, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger });
    assert.ok(existsSync(join(f.root, 'second-parent', '.agents', 'skills', 'sample-skill', 'SKILL.md')));
    assert.ok(!existsSync(join(f.codexHome, 'skills', 'sample-skill', 'SKILL.md')), 'legacy .codex/skills target was not written');
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('gemini: symlink at skill dir — accept-overwrite replaces with real dir', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_GEMINI_HOME'] = f.geminiHome;
    const tool = getToolByKey('gemini')!;

    mkdirSync(join(f.geminiHome, 'extensions'), { recursive: true });
    const elsewhere = join(f.root, 'gemini-elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(f.geminiHome, 'extensions', 'sample-skill'), 'dir');

    const { logger } = silentLogger();
    const acceptConfirm: ConfirmFn = async () => true;

    const result = await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger,
      confirm: acceptConfirm,
    });

    const stat = lstatSync(join(f.geminiHome, 'extensions', 'sample-skill'));
    assert.ok(stat.isDirectory(), 'replaced symlink with a real directory');
    assert.ok(!stat.isSymbolicLink(), 'no symlink left');
    assert.ok(existsSync(join(f.geminiHome, 'extensions', 'sample-skill', 'SKILL.md')));
    assert.equal(result.skillsCount, 2);
  } finally {
    delete process.env['ROSTER_GEMINI_HOME'];
    f.cleanup();
  }
});
