import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditTool } from '../src/lib/audit.ts';
import { installToTool, type InstallLogger } from '../src/lib/install.ts';
import { getToolByKey } from '../src/lib/tools.ts';

type Fixture = {
  root: string;
  source: string;
  claudeHome: string;
  codexHome: string;
  geminiHome: string;
  cleanup: () => void;
};

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'roster-audit-'));
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
  writeFileSync(join(source, 'agents', 'lesson-drafter.md'), '# lesson-drafter\n');

  return {
    root,
    source,
    claudeHome,
    codexHome,
    geminiHome,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const silentLogger: InstallLogger = { log: () => {}, warn: () => {} };
const skillsSrc = (f: Fixture): string => join(f.source, 'skills');
const agentsSrc = (f: Fixture): string => join(f.source, 'agents');
const sources = (f: Fixture): { skills: string; agents: string } => ({
  skills: skillsSrc(f),
  agents: agentsSrc(f),
});

test('audit (claude/dir): fresh install reports every item ok', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;
    await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger: silentLogger,
    });

    const result = auditTool(tool, sources(f));
    assert.equal(result.ok, true);
    assert.equal(result.tool, 'claude');
    assert.equal(result.toolName, 'Claude Code');
    assert.equal(result.configRoot, f.claudeHome);
    assert.ok(result.items.length > 0);
    for (const item of result.items) {
      assert.equal(item.status, 'ok', `${item.kind} ${item.name} should be ok`);
    }
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('audit (claude/dir): deleting a skill dir reports MISSING for that skill only', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;
    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger: silentLogger });

    rmSync(join(f.claudeHome, 'skills', 'sample-skill'), { recursive: true, force: true });

    const result = auditTool(tool, sources(f));
    assert.equal(result.ok, false);
    const sample = result.items.find((i) => i.kind === 'skill' && i.name === 'sample-skill');
    assert.ok(sample);
    assert.equal(sample.status, 'missing');
    const other = result.items.find((i) => i.kind === 'skill' && i.name === 'other-skill');
    assert.ok(other);
    assert.equal(other.status, 'ok');
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('audit (claude/dir): modifying a file reports STALE with a reason', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;
    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger: silentLogger });

    writeFileSync(join(f.claudeHome, 'skills', 'sample-skill', 'SKILL.md'), '# tampered\n');

    const result = auditTool(tool, sources(f));
    assert.equal(result.ok, false);
    const sample = result.items.find((i) => i.name === 'sample-skill')!;
    assert.equal(sample.status, 'stale');
    assert.match(sample.reason ?? '', /SKILL\.md/);
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('audit (claude/dir): a missing source file inside an installed skill reports STALE', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;
    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger: silentLogger });

    rmSync(join(f.claudeHome, 'skills', 'sample-skill', 'asset.txt'));

    const result = auditTool(tool, sources(f));
    const sample = result.items.find((i) => i.name === 'sample-skill')!;
    assert.equal(sample.status, 'stale');
    assert.match(sample.reason ?? '', /asset\.txt/);
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('audit (claude/dir): extra user file inside skill dir does NOT trigger STALE', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;
    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger: silentLogger });

    writeFileSync(join(f.claudeHome, 'skills', 'sample-skill', 'user-notes.md'), 'user content\n');

    const result = auditTool(tool, sources(f));
    assert.equal(result.ok, true);
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('audit (codex/file): deleting flat .md reports MISSING', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    const tool = getToolByKey('codex')!;
    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger: silentLogger });

    rmSync(join(f.codexHome, 'prompts', 'sample-skill.md'));

    const result = auditTool(tool, sources(f));
    const sample = result.items.find((i) => i.name === 'sample-skill')!;
    assert.equal(sample.status, 'missing');
    assert.equal(result.ok, false);
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('audit (codex/file): modifying flat .md reports STALE', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    const tool = getToolByKey('codex')!;
    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger: silentLogger });

    writeFileSync(join(f.codexHome, 'prompts', 'sample-skill.md'), '# tampered\n');

    const result = auditTool(tool, sources(f));
    const sample = result.items.find((i) => i.name === 'sample-skill')!;
    assert.equal(sample.status, 'stale');
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('audit (codex/file): source skill without SKILL.md is excluded from the report', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CODEX_HOME'] = f.codexHome;
    mkdirSync(join(f.source, 'skills', 'no-body'), { recursive: true });
    writeFileSync(join(f.source, 'skills', 'no-body', 'README.md'), 'not a skill body\n');

    const tool = getToolByKey('codex')!;
    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger: silentLogger });

    const result = auditTool(tool, sources(f));
    const noBody = result.items.find((i) => i.kind === 'skill' && i.name === 'no-body');
    assert.equal(noBody, undefined, 'no-body should not appear');
  } finally {
    delete process.env['ROSTER_CODEX_HOME'];
    f.cleanup();
  }
});

test('audit agents: delete one → MISSING; modify one → STALE', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;
    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger: silentLogger });

    rmSync(join(f.claudeHome, 'agents', 'lesson-drafter.md'));
    const r1 = auditTool(tool, sources(f));
    const a1 = r1.items.find((i) => i.kind === 'agent' && i.name === 'lesson-drafter.md')!;
    assert.equal(a1.status, 'missing');

    writeFileSync(join(f.claudeHome, 'agents', 'lesson-drafter.md'), 'tampered\n');
    const r2 = auditTool(tool, sources(f));
    const a2 = r2.items.find((i) => i.kind === 'agent' && i.name === 'lesson-drafter.md')!;
    assert.equal(a2.status, 'stale');
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('audit (claude/dir): symlinked skill with matching content reports OK (no prompt path)', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_CLAUDE_HOME'] = f.claudeHome;
    const tool = getToolByKey('claude')!;

    mkdirSync(join(f.claudeHome, 'skills'), { recursive: true });
    const replica = join(f.root, 'replica');
    mkdirSync(replica, { recursive: true });
    writeFileSync(join(replica, 'SKILL.md'), '# sample\n');
    writeFileSync(join(replica, 'asset.txt'), 'hello\n');
    symlinkSync(replica, join(f.claudeHome, 'skills', 'sample-skill'), 'dir');

    // Install other-skill normally so the audit has > 1 item.
    await installToTool(tool, {
      skills: skillsSrc(f),
      agents: agentsSrc(f),
      silent: true,
      logger: silentLogger,
      confirm: async () => false,
    });

    const result = auditTool(tool, sources(f));
    const sample = result.items.find((i) => i.name === 'sample-skill')!;
    assert.equal(sample.status, 'ok', `symlinked-with-matching-content should be ok, got ${sample.status} (${sample.reason ?? 'no reason'})`);
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    f.cleanup();
  }
});

test('audit (gemini/dir): fresh install reports ok', async () => {
  const f = makeFixture();
  try {
    process.env['ROSTER_GEMINI_HOME'] = f.geminiHome;
    const tool = getToolByKey('gemini')!;
    await installToTool(tool, { skills: skillsSrc(f), agents: agentsSrc(f), silent: true, logger: silentLogger });

    const result = auditTool(tool, sources(f));
    assert.equal(result.ok, true);
    assert.equal(result.tool, 'gemini');
  } finally {
    delete process.env['ROSTER_GEMINI_HOME'];
    f.cleanup();
  }
});
