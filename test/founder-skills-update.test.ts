import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  realRefResolver,
  updateFounderSkills,
  type RefResolver,
} from '../src/lib/founder-skills/update.ts';
import type { SkillsInstaller, AddSpec } from '../src/lib/founder-skills/installer.ts';

const SOURCE = 'github:firatcand/founder-skills';

const networkGate = {
  skip:
    process.env['ROSTER_NETWORK_SMOKE'] !== '1' &&
    'set ROSTER_NETWORK_SMOKE=1 to run the live founder-skills tag resolution',
};

// Fake installer: records calls AND materializes a SKILL.md into each tool
// target so hashing behaves end-to-end without touching the network.
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

// Same env setup as founder-skills-sync.test.ts: fake Claude/Codex homes so
// detectTools() resolves both tools. Without them detectTools() can yield
// nothing on a bare machine and every fan-out assertion goes vacuous.
function withWorkspace<T>(fn: (cwd: string) => Promise<T> | T): Promise<T> | T {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-fs-update-'));
  const claudeHome = join(cwd, '.fakehome-claude');
  const codexHome = join(cwd, '.fakehome-codex');
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
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

function writeManifest(cwd: string): void {
  writeFileSync(
    join(cwd, 'founder-skills.yaml'),
    `source: ${SOURCE}\nref: main\nskills:\n  - pricing\n  - name: sales-skill\n    ref: v0.0.1\n`,
  );
}

// The full --latest bump chain: manifest rewritten to the tag (per-skill
// overrides collapsed), installer invoked WITH the tag for every skill into
// both tools, lockfile pinned to the tag with the right source.
function assertFullChain(cwd: string, calls: AddSpec[], tag: string): void {
  const manifest = parseYaml(readFileSync(join(cwd, 'founder-skills.yaml'), 'utf8')) as {
    source: string;
    ref: string;
    skills: unknown[];
  };
  assert.equal(manifest.source, SOURCE);
  assert.equal(manifest.ref, tag);
  assert.deepEqual(manifest.skills, ['pricing', 'sales-skill']);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.skill).sort(), ['pricing', 'sales-skill']);
  for (const call of calls) {
    assert.equal(call.ref, tag, `installer must receive the resolved tag for ${call.skill}`);
    assert.deepEqual(call.source, { owner: 'firatcand', repo: 'founder-skills' });
    assert.deepEqual([...call.tools].sort(), ['claude', 'codex']);
  }

  for (const skill of ['pricing', 'sales-skill']) {
    for (const toolDir of ['.claude', '.agents']) {
      assert.ok(
        existsSync(join(cwd, toolDir, 'skills', skill, 'SKILL.md')),
        `${skill} must be materialized under ${toolDir}/skills`,
      );
    }
  }

  const lock = parseYaml(readFileSync(join(cwd, 'founder-skills.lock'), 'utf8')) as {
    source: string;
    skills: Array<{ name: string; ref: string; contentHash: string; tools: string[] }>;
  };
  assert.equal(lock.source, SOURCE);
  assert.deepEqual(lock.skills.map((s) => s.name), ['pricing', 'sales-skill']);
  for (const skill of lock.skills) {
    assert.equal(skill.ref, tag, `lockfile must pin ${skill.name} to the resolved tag`);
    assert.ok(skill.contentHash.startsWith('sha256:'));
    assert.deepEqual([...skill.tools].sort(), ['claude', 'codex']);
  }
}

test('no manifest → no-op, resolver never consulted', async () => {
  await withWorkspace(async (cwd) => {
    const { installer, calls } = makeFakeInstaller();
    const resolver: RefResolver = {
      latest() {
        throw new Error('resolver must not run without a manifest');
      },
    };
    const r = await updateFounderSkills({ cwd, latest: true, resolver, installer });
    assert.equal(r.status, 'no-manifest');
    assert.equal(calls.length, 0);
  });
});

test('--latest with a fake resolver bumps manifest + installer + lock (hermetic)', async () => {
  await withWorkspace(async (cwd) => {
    writeManifest(cwd);
    const { installer, calls } = makeFakeInstaller();
    const resolver: RefResolver = { latest: async () => 'v9.9.9' };
    const r = await updateFounderSkills({ cwd, latest: true, resolver, installer });
    assert.equal(r.status, 'synced');
    if (r.status === 'synced') assert.deepEqual([...r.tools].sort(), ['claude', 'codex']);
    assertFullChain(cwd, calls, 'v9.9.9');
  });
});

test('LIVE: realRefResolver resolves a v* tag for founder-skills', networkGate, async () => {
  const tag = await realRefResolver.latest(SOURCE);
  assert.match(tag, /^v\d+\.\d+\.\d+$/, `expected a semver tag, got '${tag}'`);
});

test('LIVE: --latest with the real resolver bumps the full chain to the newest tag', networkGate, async () => {
  await withWorkspace(async (cwd) => {
    writeManifest(cwd);
    const { installer, calls } = makeFakeInstaller();
    const r = await updateFounderSkills({
      cwd,
      latest: true,
      resolver: realRefResolver,
      installer,
    });
    assert.equal(r.status, 'synced');
    if (r.status === 'synced') {
      assert.deepEqual([...r.tools].sort(), ['claude', 'codex']);
      assert.deepEqual(r.installed.sort(), ['pricing', 'sales-skill']);
    }
    // Single resolution chain: read the tag updateFounderSkills itself resolved
    // back from the rewritten manifest — a second ls-remote could race a tag
    // pushed mid-test.
    const manifest = parseYaml(readFileSync(join(cwd, 'founder-skills.yaml'), 'utf8')) as {
      ref: string;
    };
    assert.match(manifest.ref, /^v\d+\.\d+\.\d+$/, `expected a semver tag, got '${manifest.ref}'`);
    assertFullChain(cwd, calls, manifest.ref);
  });
});
