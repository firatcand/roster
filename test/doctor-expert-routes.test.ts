import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditExpertRoutes, sanitizeRouteForDisplay } from '../src/lib/doctor-expert-routes.ts';
import { syncFounderSkills } from '../src/lib/founder-skills/sync.ts';
import type { SkillsInstaller } from '../src/lib/founder-skills/installer.ts';

const BIN = resolve('src/bin/roster.ts');

function expertMd(routes: string[]): string {
  return [
    '# Expert',
    '',
    '## Skills',
    '',
    '| Task | Skill |',
    '|---|---|',
    ...routes.map((r) => `| some task | ${r} |`),
    '',
    '## Output rules',
    '',
    'prose',
  ].join('\n');
}

function withWorkspace(fn: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), 'roster-expert-routes-'));
  try {
    fn(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function writeExpert(cwd: string, fnName: string, routes: string[]): void {
  mkdirSync(join(cwd, fnName), { recursive: true });
  writeFileSync(join(cwd, fnName, 'EXPERT.md'), expertMd(routes));
}

test('no founder-skills.yaml → not-applicable (no-manifest)', () => {
  withWorkspace((cwd) => {
    writeExpert(cwd, 'gtm', ['pricing']);
    assert.deepEqual(auditExpertRoutes(cwd), { status: 'not-applicable', reason: 'no-manifest' });
  });
});

test('invalid manifest → not-applicable (invalid-manifest); drift owns the failure', () => {
  withWorkspace((cwd) => {
    writeFileSync(join(cwd, 'founder-skills.yaml'), 'skills: []\n');
    writeExpert(cwd, 'gtm', ['pricing']);
    assert.deepEqual(auditExpertRoutes(cwd), { status: 'not-applicable', reason: 'invalid-manifest' });
  });
});

test('all routes covered by the manifest → checked with zero warnings', () => {
  withWorkspace((cwd) => {
    writeFileSync(join(cwd, 'founder-skills.yaml'), 'skills:\n  - pricing\n  - seo\n');
    writeExpert(cwd, 'gtm', ['pricing', 'seo']);
    const r = auditExpertRoutes(cwd);
    assert.equal(r.status, 'checked');
    if (r.status === 'checked') assert.deepEqual(r.warnings, []);
  });
});

test('uncovered route → warning naming file and route', () => {
  withWorkspace((cwd) => {
    writeFileSync(join(cwd, 'founder-skills.yaml'), 'skills:\n  - pricing\n');
    writeExpert(cwd, 'gtm', ['pricing', 'made-up-skill']);
    const r = auditExpertRoutes(cwd);
    assert.equal(r.status, 'checked');
    if (r.status === 'checked') {
      assert.equal(r.warnings.length, 1);
      assert.equal(r.warnings[0]!.file, 'gtm/EXPERT.md');
      assert.equal(r.warnings[0]!.route, 'made-up-skill');
      assert.match(r.warnings[0]!.message, /roster skills sync/);
    }
  });
});

test('frontend-design is a built-in exception — never flagged', () => {
  withWorkspace((cwd) => {
    writeFileSync(join(cwd, 'founder-skills.yaml'), 'skills:\n  - design\n');
    writeExpert(cwd, 'design', ['design', 'frontend-design']);
    const r = auditExpertRoutes(cwd);
    assert.equal(r.status, 'checked');
    if (r.status === 'checked') assert.deepEqual(r.warnings, []);
  });
});

test('EXPERT.md under dot-dirs is ignored', () => {
  withWorkspace((cwd) => {
    writeFileSync(join(cwd, 'founder-skills.yaml'), 'skills:\n  - pricing\n');
    writeExpert(cwd, '.claude', ['bogus-skill']);
    const r = auditExpertRoutes(cwd);
    assert.equal(r.status, 'checked');
    if (r.status === 'checked') assert.deepEqual(r.warnings, []);
  });
});

test('hostile route text is control-escaped in warnings (text + JSON carry the same form)', () => {
  withWorkspace((cwd) => {
    writeFileSync(join(cwd, 'founder-skills.yaml'), 'skills:\n  - pricing\n');
    writeExpert(cwd, 'gtm', ['\u001b[31mevil\u001b[0m']);
    const r = auditExpertRoutes(cwd);
    assert.equal(r.status, 'checked');
    if (r.status === 'checked') {
      assert.equal(r.warnings.length, 1);
      assert.equal(r.warnings[0]!.route, '\\x1b[31mevil\\x1b[0m');
      assert.ok(!r.warnings[0]!.route.includes('\u001b'), 'route must carry no raw ESC byte');
      assert.ok(!r.warnings[0]!.message.includes('\u001b'), 'message must carry no raw ESC byte');
      assert.match(r.warnings[0]!.message, /\\x1b\[31mevil\\x1b\[0m/);
    }
  });
});

test('sanitizeRouteForDisplay: escapes ANSI + newline, truncates, passes kebab through', () => {
  assert.equal(
    sanitizeRouteForDisplay('\u001b[31mevil\u001b[0m\nnext-line'),
    '\\x1b[31mevil\\x1b[0m\\x0anext-line',
  );
  assert.equal(sanitizeRouteForDisplay('sales-skill'), 'sales-skill');
  const long = sanitizeRouteForDisplay(`UPPER-${'a'.repeat(100)}`);
  assert.equal(long.length, 61);
  assert.ok(long.endsWith('…'));
});

// ── executeDoctor-level: warnings render but NEVER flip the exit code ────────

type Run = { status: number; stdout: string; stderr: string };

function runCliInCwd(args: readonly string[], env: Record<string, string>, cwd: string): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
      cwd,
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function fakeInstaller(): SkillsInstaller {
  const sub: Record<'claude' | 'codex', string[]> = {
    claude: ['.claude', 'skills'],
    codex: ['.agents', 'skills'],
  };
  return {
    async add(spec, o) {
      for (const tool of spec.tools) {
        const dir = join(o.cwd, ...sub[tool], spec.skill);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${spec.skill}\ndescription: x\n---\nbody\n`);
      }
    },
  };
}

async function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  }
}

test('doctor: expert-route warnings do not flip the exit code', async () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-doctor-expert-'));
  try {
    const claudeHome = join(root, 'claude');
    mkdirSync(claudeHome, { recursive: true });
    const env = {
      ROSTER_CLAUDE_HOME: claudeHome,
      ROSTER_CODEX_HOME: join(root, 'none-codex'),
      ROSTER_GEMINI_HOME: join(root, 'none-gemini'),
    };
    const ws = join(root, 'ws');
    mkdirSync(join(ws, 'config'), { recursive: true });
    writeFileSync(join(ws, 'config', 'project.yaml'), 'name: t\n');

    const install = runCliInCwd(
      ['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'],
      env,
      ws,
    );
    assert.equal(install.status, 0, `install failed: ${install.stderr}`);

    writeExpert(ws, 'gtm', ['pricing', 'made-up-skill']);

    const before = runCliInCwd(['doctor'], env, ws);
    assert.equal(before.status, 0, `stderr: ${before.stderr}\nstdout: ${before.stdout}`);
    assert.doesNotMatch(before.stdout, /Expert routes/);

    writeFileSync(join(ws, 'founder-skills.yaml'), 'ref: v1\nskills:\n  - pricing\n');
    await withEnv(env, async () => {
      await syncFounderSkills({ cwd: ws, installer: fakeInstaller() });
    });

    const doc = runCliInCwd(['doctor', '--json'], env, ws);
    assert.equal(doc.status, 0, `stderr: ${doc.stderr}\nstdout: ${doc.stdout}`);
    const payload = JSON.parse(doc.stdout) as {
      ok: boolean;
      founder_skills: { status: string };
      expert_routes: {
        status: string;
        warnings: Array<{ file: string; route: string; message: string }>;
      };
    };
    assert.equal(payload.ok, true, 'warnings must not flip doctor ok');
    assert.equal(payload.founder_skills.status, 'checked');
    assert.equal(payload.expert_routes.status, 'checked');
    assert.equal(payload.expert_routes.warnings.length, 1);
    assert.equal(payload.expert_routes.warnings[0]!.route, 'made-up-skill');

    const text = runCliInCwd(['doctor'], env, ws);
    assert.equal(text.status, 0, `stderr: ${text.stderr}\nstdout: ${text.stdout}`);
    assert.match(text.stdout, /Expert routes/);
    assert.match(text.stdout, /made-up-skill/);
    assert.match(text.stdout, /never affects exit code/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
