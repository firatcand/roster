import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditFounderSkillsDrift } from '../src/lib/founder-skills/drift.ts';
import { syncFounderSkills } from '../src/lib/founder-skills/sync.ts';
import type { SkillsInstaller } from '../src/lib/founder-skills/installer.ts';

function fakeInstaller(opts?: { malformed?: boolean }): SkillsInstaller {
  const sub: Record<'claude' | 'codex', string[]> = {
    claude: ['.claude', 'skills'],
    codex: ['.agents', 'skills'],
  };
  return {
    async add(spec, o) {
      for (const tool of spec.tools) {
        const dir = join(o.cwd, ...sub[tool], spec.skill);
        mkdirSync(dir, { recursive: true });
        const fm = opts?.malformed
          ? `---\ndescription: missing name\n---\nbody\n`
          : `---\nname: ${spec.skill}\ndescription: x\n---\nbody\n`;
        writeFileSync(join(dir, 'SKILL.md'), fm);
      }
    },
  };
}

async function withWorkspace(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-fs-drift-'));
  const claudeHome = join(cwd, '.h-claude');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(join(cwd, 'config'), { recursive: true });
  writeFileSync(join(cwd, 'config', 'project.yaml'), 'name: t\n');
  const saved = {
    c: process.env['ROSTER_CLAUDE_HOME'],
    x: process.env['ROSTER_CODEX_HOME'],
    g: process.env['ROSTER_GEMINI_HOME'],
  };
  process.env['ROSTER_CLAUDE_HOME'] = claudeHome;
  process.env['ROSTER_CODEX_HOME'] = join(cwd, '.none-codex');
  process.env['ROSTER_GEMINI_HOME'] = join(cwd, '.none-gemini');
  try {
    await fn(cwd);
  } finally {
    saved.c === undefined ? delete process.env['ROSTER_CLAUDE_HOME'] : (process.env['ROSTER_CLAUDE_HOME'] = saved.c);
    saved.x === undefined ? delete process.env['ROSTER_CODEX_HOME'] : (process.env['ROSTER_CODEX_HOME'] = saved.x);
    saved.g === undefined ? delete process.env['ROSTER_GEMINI_HOME'] : (process.env['ROSTER_GEMINI_HOME'] = saved.g);
    rmSync(cwd, { recursive: true, force: true });
  }
}

const manifest = (cwd: string, body: string): void =>
  writeFileSync(join(cwd, 'founder-skills.yaml'), body);

test('no manifest → not-applicable, no findings', async () => {
  await withWorkspace(async (cwd) => {
    const r = auditFounderSkillsDrift(cwd);
    assert.equal(r.status, 'not-applicable');
  });
});

test('healthy synced workspace → no drift', async () => {
  await withWorkspace(async (cwd) => {
    manifest(cwd, 'ref: v1\nskills:\n  - pricing\n');
    await syncFounderSkills({ cwd, installer: fakeInstaller() });
    const r = auditFounderSkillsDrift(cwd);
    assert.equal(r.status, 'checked');
    if (r.status === 'checked') assert.equal(r.hasFailure, false);
  });
});

test('manifest present but never synced → no-lock failure (fail-loud)', async () => {
  await withWorkspace(async (cwd) => {
    manifest(cwd, 'skills:\n  - pricing\n');
    const r = auditFounderSkillsDrift(cwd);
    assert.equal(r.status, 'checked');
    if (r.status === 'checked') {
      assert.equal(r.hasFailure, true);
      assert.ok(r.findings.some((f) => f.kind === 'no-lock'));
    }
  });
});

test('orphan: skill in lock but dropped from manifest → failure', async () => {
  await withWorkspace(async (cwd) => {
    manifest(cwd, 'ref: v1\nskills:\n  - pricing\n  - seo\n');
    await syncFounderSkills({ cwd, installer: fakeInstaller() });
    manifest(cwd, 'ref: v1\nskills:\n  - pricing\n');
    const r = auditFounderSkillsDrift(cwd);
    if (r.status === 'checked') {
      assert.ok(r.findings.some((f) => f.kind === 'orphan-install' && f.skill === 'seo'));
      assert.equal(r.hasFailure, true);
    }
  });
});

test('ref mismatch between lock and manifest → failure', async () => {
  await withWorkspace(async (cwd) => {
    manifest(cwd, 'ref: v1\nskills:\n  - pricing\n');
    await syncFounderSkills({ cwd, installer: fakeInstaller() });
    manifest(cwd, 'ref: v2\nskills:\n  - pricing\n');
    const r = auditFounderSkillsDrift(cwd);
    if (r.status === 'checked') {
      assert.ok(r.findings.some((f) => f.kind === 'ref-mismatch'));
    }
  });
});

test('malformed SKILL.md frontmatter → failure', async () => {
  await withWorkspace(async (cwd) => {
    manifest(cwd, 'ref: v1\nskills:\n  - pricing\n');
    await syncFounderSkills({ cwd, installer: fakeInstaller({ malformed: true }) });
    const r = auditFounderSkillsDrift(cwd);
    if (r.status === 'checked') {
      assert.ok(r.findings.some((f) => f.kind === 'malformed-frontmatter'));
      assert.equal(r.hasFailure, true);
    }
  });
});

test('invalid manifest → parse-error failure', async () => {
  await withWorkspace(async (cwd) => {
    manifest(cwd, 'skills: []\n');
    const r = auditFounderSkillsDrift(cwd);
    if (r.status === 'checked') {
      assert.ok(r.findings.some((f) => f.kind === 'manifest-parse-error'));
    }
  });
});
