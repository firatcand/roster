import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { syncFounderSkills } from '../src/lib/founder-skills/sync.ts';
import type { SkillsInstaller, AddSpec } from '../src/lib/founder-skills/installer.ts';

// Fake installer: records calls AND materializes a SKILL.md into each tool
// target so hashing + prune behave end-to-end without touching the network.
function makeFakeInstaller(): { installer: SkillsInstaller; calls: AddSpec[] } {
  const calls: AddSpec[] = [];
  const targetSub: Record<'claude' | 'codex', string[]> = {
    claude: ['.claude', 'skills'],
    codex: ['.agents', 'skills'],
  };
  const installer: SkillsInstaller = {
    async add(spec, opts) {
      calls.push(spec);
      for (const tool of spec.tools) {
        const dir = join(opts.cwd, ...targetSub[tool], spec.skill);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'SKILL.md'),
          `---\nname: ${spec.skill}\ndescription: ${spec.skill} skill\n---\nbody\n`,
        );
      }
    },
  };
  return { installer, calls };
}

function withWorkspace<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> | T {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-fs-sync-'));
  const claudeHome = join(cwd, '.fakehome-claude');
  const codexHome = join(cwd, '.fakehome-codex');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  // config/project.yaml → detectWorkspace() true
  mkdirSync(join(cwd, 'config'), { recursive: true });
  writeFileSync(join(cwd, 'config', 'project.yaml'), 'name: test\n');
  const saved = {
    c: process.env['ROSTER_CLAUDE_HOME'],
    x: process.env['ROSTER_CODEX_HOME'],
    g: process.env['ROSTER_GEMINI_HOME'],
  };
  process.env['ROSTER_CLAUDE_HOME'] = claudeHome;
  process.env['ROSTER_CODEX_HOME'] = codexHome;
  process.env['ROSTER_GEMINI_HOME'] = join(cwd, '.nonexistent-gemini');
  const restore = (): void => {
    saved.c === undefined ? delete process.env['ROSTER_CLAUDE_HOME'] : (process.env['ROSTER_CLAUDE_HOME'] = saved.c);
    saved.x === undefined ? delete process.env['ROSTER_CODEX_HOME'] : (process.env['ROSTER_CODEX_HOME'] = saved.x);
    saved.g === undefined ? delete process.env['ROSTER_GEMINI_HOME'] : (process.env['ROSTER_GEMINI_HOME'] = saved.g);
    rmSync(cwd, { recursive: true, force: true });
  };
  const result = fn(cwd);
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return result;
}

function writeManifest(cwd: string, body: string): void {
  writeFileSync(join(cwd, 'founder-skills.yaml'), body);
}

test('no manifest → no-op opt-in', async () => {
  await withWorkspace(async (cwd) => {
    const { installer, calls } = makeFakeInstaller();
    const r = await syncFounderSkills({ cwd, installer });
    assert.equal(r.status, 'no-manifest');
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(cwd, 'founder-skills.lock')), false);
  });
});

test('sync installs declared skills project-local into claude + codex, writes lock', async () => {
  await withWorkspace(async (cwd) => {
    writeManifest(cwd, 'ref: v1.0.0\nskills:\n  - pricing\n  - sales-skill\n');
    const { installer, calls } = makeFakeInstaller();
    const r = await syncFounderSkills({ cwd, installer });
    assert.equal(r.status, 'synced');
    assert.equal(calls.length, 2);
    assert.ok(existsSync(join(cwd, '.claude', 'skills', 'pricing', 'SKILL.md')));
    assert.ok(existsSync(join(cwd, '.agents', 'skills', 'sales-skill', 'SKILL.md')));
    // NOT installed to a home dir
    assert.equal(existsSync(join(cwd, '.fakehome-claude', 'skills', 'pricing')), false);
    const lock = parseYaml(readFileSync(join(cwd, 'founder-skills.lock'), 'utf8'));
    assert.equal(lock.skills.length, 2);
    assert.equal(lock.skills[0].ref, 'v1.0.0');
    assert.ok(lock.skills[0].contentHash.startsWith('sha256:'));
  });
});

test('removing a skill from the manifest prunes it on re-sync (full reconcile)', async () => {
  await withWorkspace(async (cwd) => {
    writeManifest(cwd, 'ref: v1.0.0\nskills:\n  - pricing\n  - sales-skill\n');
    const { installer } = makeFakeInstaller();
    await syncFounderSkills({ cwd, installer });
    assert.ok(existsSync(join(cwd, '.claude', 'skills', 'sales-skill')));

    writeManifest(cwd, 'ref: v1.0.0\nskills:\n  - pricing\n');
    const r = await syncFounderSkills({ cwd, installer });
    assert.equal(r.status, 'synced');
    if (r.status === 'synced') assert.deepEqual(r.pruned, ['sales-skill']);
    assert.equal(existsSync(join(cwd, '.claude', 'skills', 'sales-skill')), false);
    assert.equal(existsSync(join(cwd, '.agents', 'skills', 'sales-skill')), false);
    assert.ok(existsSync(join(cwd, '.claude', 'skills', 'pricing')));
  });
});

test('manifest present but not a workspace → refuses', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-fs-noworkspace-'));
  try {
    writeManifest(cwd, 'skills:\n  - pricing\n');
    const { installer } = makeFakeInstaller();
    await assert.rejects(() => syncFounderSkills({ cwd, installer }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('SECURITY: a hand-edited lock with a traversal name never deletes outside the target', async () => {
  await withWorkspace(async (cwd) => {
    // Sentinel dir well outside any tool target.
    const sentinel = join(cwd, 'DO-NOT-DELETE');
    mkdirSync(sentinel, { recursive: true });
    // Forge a malicious lock: name escapes .claude/skills/ up to the sentinel.
    const evilName = `../../../${'DO-NOT-DELETE'}`;
    writeFileSync(
      join(cwd, 'founder-skills.lock'),
      `version: 1\nsource: github:firatcand/founder-skills\nskills:\n  - name: "${evilName}"\n    ref: v1\n    contentHash: sha256:x\n    tools:\n      - claude\n`,
    );
    writeManifest(cwd, 'skills:\n  - pricing\n');
    const { installer } = makeFakeInstaller();
    const r = await syncFounderSkills({ cwd, installer });
    assert.equal(r.status, 'synced');
    if (r.status === 'synced') assert.deepEqual(r.pruned, []); // evil name dropped at read boundary
    assert.ok(existsSync(sentinel), 'sentinel dir must survive');
  });
});
