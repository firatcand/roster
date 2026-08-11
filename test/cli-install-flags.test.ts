import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, existsSync, lstatSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseGeneratedMarkdown,
  renderClaudeProjectInstructions,
  renderGeneratedMarkdown,
  renderRosterBootstrap,
  resolveActivationAssurance,
} from '../src/lib/generated-artifacts.ts';

const BIN = resolve('src/bin/roster.ts');

type Run = { status: number; stdout: string; stderr: string };

type Homes = {
  root: string;
  claude: string;
  codex: string;
  gemini: string;
  cleanup: () => void;
};

function makeHomes(present: ReadonlyArray<'claude' | 'codex' | 'gemini'>): Homes {
  const root = mkdtempSync(join(tmpdir(), 'roster-cli-'));
  const claude = join(root, 'claude');
  const codex = join(root, 'codex');
  const gemini = join(root, 'gemini');
  for (const key of present) {
    mkdirSync(join(root, key), { recursive: true });
  }
  return { root, claude, codex, gemini, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runCli(
  args: readonly string[],
  envOverrides: Record<string, string>,
  cwd?: string,
): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...envOverrides, FORCE_COLOR: '0', NO_COLOR: '1' },
      ...(cwd !== undefined ? { cwd } : {}),
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
}

function makeWorkspace(root: string): string {
  const ws = mkdtempSync(join(root, 'ws-'));
  writeFileSync(
    join(ws, 'roster.yaml'),
    'schema_version: 2\nworkspace_id: test\ntool_uses: []\nfunctions: {}\nhosts: {}\n',
  );
  writeFileSync(join(ws, 'ROSTER.md'), renderRosterBootstrap());
  return ws;
}

test('install --all installs to every detected tool', () => {
  const h = makeHomes(['claude', 'codex', 'gemini']);
  try {
    const r = runCli(['install', '--all', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(h.claude, 'skills')), 'claude skills dir written');
    assert.ok(existsSync(join(h.root, '.agents', 'skills')), 'codex skills dir written');
    assert.ok(existsSync(join(h.gemini, 'extensions')), 'gemini extensions dir written');
  } finally {
    h.cleanup();
  }
});

test('install --tool claude writes only to Claude home', () => {
  const h = makeHomes(['claude', 'codex', 'gemini']);
  try {
    const r = runCli(['install', '--tool', 'claude', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(h.claude, 'skills')), 'claude written');
    assert.ok(!existsSync(join(h.root, '.agents', 'skills')), 'codex NOT written');
    assert.ok(!existsSync(join(h.gemini, 'extensions')), 'gemini NOT written');
  } finally {
    h.cleanup();
  }
});

test('install --tool foo exits 1 with a clear error', () => {
  const h = makeHomes(['claude']);
  try {
    const r = runCli(['install', '--tool', 'foo'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /foo/);
    assert.match(r.stderr, /claude/);
  } finally {
    h.cleanup();
  }
});

test('install --all --tool claude exits 1 (mutually exclusive)', () => {
  const h = makeHomes(['claude']);
  try {
    const r = runCli(['install', '--all', '--tool', 'claude'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mutually exclusive/i);
  } finally {
    h.cleanup();
  }
});

test('install --tool claude when Claude is not detected exits 3', () => {
  // Only codex home exists; claude home is absent.
  const h = makeHomes(['codex']);
  try {
    const r = runCli(['install', '--tool', 'claude'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 3, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /claude/);
    assert.match(r.stderr, /not detected/i);
  } finally {
    h.cleanup();
  }
});

test('install --all --silent produces no stdout on success', () => {
  const h = makeHomes(['claude', 'codex', 'gemini']);
  try {
    const r = runCli(['install', '--all', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', `stdout was: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('install --all preserves symlinked skills deterministically (no prompt, no hang)', () => {
  const h = makeHomes(['claude']);
  try {
    // Pre-create a symlinked skill inside the claude home; --all must not
    // hang on stdin waiting for confirmation when stdin is non-TTY.
    const skillsDir = join(h.claude, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    const elsewhere = join(h.root, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'marker.txt'), 'live\n');
    symlinkSync(elsewhere, join(skillsDir, 'chief-of-staff'), 'dir');

    const r = runCli(['install', '--all'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Symlink must be preserved (decline default), not silently replaced.
    assert.ok(
      lstatSync(join(skillsDir, 'chief-of-staff')).isSymbolicLink(),
      'symlink preserved by non-interactive default',
    );
    assert.ok(existsSync(join(elsewhere, 'marker.txt')), 'symlink target untouched');
  } finally {
    h.cleanup();
  }
});

test('install --help shows --all and --tool flags', () => {
  const r = runCli(['--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--all/);
  assert.match(r.stdout, /--tool/);
});

test('--help documents the global --debug flag', () => {
  const r = runCli(['--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--debug/);
});

test('install with no detected tools exits 3 and lists every tool with install link', () => {
  const h = makeHomes([]);
  try {
    const r = runCli(['install'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 3, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /no AI tools detected/i, 'header present');
    assert.match(r.stderr, /Claude Code/);
    assert.match(r.stderr, /https:\/\/claude\.ai\/code/);
    assert.match(r.stderr, /Codex CLI/);
    assert.match(r.stderr, /github\.com\/openai\/codex/);
    assert.match(r.stderr, /Gemini CLI/);
    assert.match(r.stderr, /google-gemini/);
  } finally {
    h.cleanup();
  }
});

test('install --debug on success exits 0 with no extra stderr stack output', () => {
  const h = makeHomes(['claude']);
  try {
    const r = runCli(['install', '--all', '--silent', '--debug'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // No stack frames printed on a successful run, regardless of --debug.
    assert.doesNotMatch(r.stderr, /\bat\s+.+:\d+:\d+\)/);
  } finally {
    h.cleanup();
  }
});

test('install --tool unknown exits 1 and stderr header is structured (no stack without --debug)', () => {
  const h = makeHomes(['claude']);
  try {
    const r = runCli(['install', '--tool', 'foo'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /roster:/i, 'has roster: prefix');
    assert.doesNotMatch(r.stderr, /\bat\s+.+:\d+:\d+\)/, 'no stack without --debug');
  } finally {
    h.cleanup();
  }
});

// ROS-109 acceptance tests — install scope + --yes + comma-separated --tool.

test('install --scope project from a non-workspace dir exits 1 with the v2 sentinel remedy', () => {
  const h = makeHomes(['claude']);
  // CWD is the tmpdir root which has no roster.yaml.
  try {
    const r = runCli(['install', '--scope', 'project', '--yes'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    }, h.root);
    assert.equal(r.status, 1, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /project-level install requires a roster workspace/i);
    assert.match(r.stderr, /roster\.yaml/);
    assert.match(r.stderr, /--scope user/);
  } finally {
    h.cleanup();
  }
});

test('ROS-109: install --tool all --scope user --yes writes to home-dir paths via ROSTER_*_HOME', () => {
  const h = makeHomes(['claude', 'codex', 'gemini']);
  try {
    const r = runCli(['install', '--all', '--scope', 'user', '--yes', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(h.claude, 'skills')), 'claude skills under user-scope home');
    assert.ok(existsSync(join(h.root, '.agents', 'skills')), 'codex skills under user-scope home');
    assert.ok(existsSync(join(h.gemini, 'extensions')), 'gemini extensions under user-scope home');
  } finally {
    h.cleanup();
  }
});

test('install --scope project from a v2 workspace writes minimal generated activation', () => {
  const h = makeHomes(['claude']);
  try {
    const ws = makeWorkspace(h.root);
    const r = runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    }, ws);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(ws, '.claude', 'CLAUDE.md')), 'workspace Claude bootstrap written');
    assert.ok(existsSync(join(ws, '.roster', 'generated-manifest.json')), 'generated manifest written');
    assert.ok(!existsSync(join(ws, '.claude', 'agents')), 'legacy agent forest not written');
    assert.ok(!existsSync(join(h.claude, 'skills')), 'user-scope claude NOT touched');
  } finally {
    h.cleanup();
  }
});

test('project install is refused and rolled back while a stale generated shadow exists', () => {
  const h = makeHomes(['claude']);
  try {
    const ws = makeWorkspace(h.root);
    const canonical = renderClaudeProjectInstructions(
      'claude-project-instructions',
      resolveActivationAssurance({ host: 'claude', artifact: 'claude-project-instructions' }),
    );
    const parsed = parseGeneratedMarkdown(canonical)!;
    const { content_hash: _contentHash, ...header } = parsed.header;
    const shadowBytes = renderGeneratedMarkdown(
      { ...header, generator_version: '0.0.0-prior' },
      parsed.body,
      parsed.prefix,
    );
    writeFileSync(join(ws, 'CLAUDE.md'), shadowBytes);
    const registryBefore = readFileSync(join(ws, 'roster.yaml'), 'utf8');

    const r = runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    }, ws);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /GENERATED_SHADOW|stale Roster-generated contract/);
    assert.equal(existsSync(join(ws, '.claude', 'CLAUDE.md')), false, 'own writes rolled back');
    assert.equal(readFileSync(join(ws, 'roster.yaml'), 'utf8'), registryBefore);
    assert.equal(readFileSync(join(ws, 'CLAUDE.md'), 'utf8'), shadowBytes, 'shadow bytes untouched');
  } finally {
    h.cleanup();
  }
});

test('v2 project install preflights unsupported Gemini before writing any supported host', () => {
  const h = makeHomes(['claude', 'gemini']);
  try {
    const ws = makeWorkspace(h.root);
    const r = runCli(['install', '--yes', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    }, ws);
    assert.equal(r.status, 3, r.stderr);
    assert.match(r.stderr, /Gemini project activation is not available/);
    assert.equal(existsSync(join(ws, '.roster')), false);
    assert.equal(existsSync(join(ws, '.claude')), false);
    assert.equal(existsSync(join(ws, 'AGENTS.md')), false);
  } finally {
    h.cleanup();
  }
});

test('ROS-109: install --tool claude,codex writes to both and skips gemini', () => {
  const h = makeHomes(['claude', 'codex', 'gemini']);
  try {
    const r = runCli(['install', '--tool', 'claude,codex', '--yes', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(h.claude, 'skills')), 'claude written');
    assert.ok(existsSync(join(h.root, '.agents', 'skills')), 'codex written');
    assert.ok(!existsSync(join(h.gemini, 'extensions')), 'gemini NOT written');
  } finally {
    h.cleanup();
  }
});

test('ROS-109: install --tool claude,foo (one bad key in list) exits 1 with usage error', () => {
  const h = makeHomes(['claude']);
  try {
    const r = runCli(['install', '--tool', 'claude,foo'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /foo/);
  } finally {
    h.cleanup();
  }
});

test('ROS-109: install --scope foo exits 1 with a clear error', () => {
  const h = makeHomes(['claude']);
  try {
    const r = runCli(['install', '--scope', 'foo'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /scope/i);
    assert.match(r.stderr, /project/);
    assert.match(r.stderr, /user/);
  } finally {
    h.cleanup();
  }
});

test('--yes from inside a v2 workspace defaults to project scope', () => {
  const h = makeHomes(['claude']);
  try {
    const ws = makeWorkspace(h.root);
    // No --scope flag — relies on --yes safe default + workspace presence.
    const r = runCli(['install', '--tool', 'claude', '--yes', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    }, ws);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Should land under workspace, not home.
    assert.ok(existsSync(join(ws, '.claude', 'CLAUDE.md')), 'workspace activation under --yes default');
    assert.ok(!existsSync(join(h.claude, 'skills')), 'user home NOT used');
  } finally {
    h.cleanup();
  }
});

test('ROS-109: --yes outside a workspace defaults to user scope', () => {
  const h = makeHomes(['claude']);
  try {
    // CWD has no roster.yaml.
    const r = runCli(['install', '--tool', 'claude', '--yes', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    }, h.root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(h.claude, 'skills')), 'home-dir install under --yes default outside workspace');
  } finally {
    h.cleanup();
  }
});

test('ROS-109: help text documents --scope and --yes', () => {
  const r = runCli(['--help'], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--scope/);
  assert.match(r.stdout, /--yes/);
  assert.match(r.stdout, /-y/);
  assert.match(r.stdout, /project\|user/);
});

test('v2 project install --json works without a user host home and reports assurance', () => {
  const h = makeHomes([]);
  try {
    const ws = makeWorkspace(h.root);
    const r = runCli(
      ['install', '--tool', 'claude', '--scope', 'project', '--yes', '--json'],
      {
        ROSTER_CLAUDE_HOME: h.claude,
        ROSTER_CODEX_HOME: h.codex,
        ROSTER_GEMINI_HOME: h.gemini,
        PATH: '',
      },
      ws,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      scope: string;
      hosts: Array<{ host: string; activation: { assurance: string; registryUpdated: boolean } }>;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.scope, 'project');
    assert.equal(payload.hosts[0]?.host, 'claude');
    assert.equal(payload.hosts[0]?.activation.assurance, 'advisory-manual');
    assert.equal(payload.hosts[0]?.activation.registryUpdated, true);
  } finally {
    h.cleanup();
  }
});

// #386 pinning test. Before the io-ambiguous fix, an unreadable sibling of the
// cwd classified the directory as `unsafe` and `install` refused outright. Now
// it classifies as `none`, so an implicit (no --scope) non-interactive install
// falls through to the user-scope default. This pins where those writes land:
// exclusively under the configured tool install root, resolved from
// ROSTER_*_HOME and never from cwd. That root CAN be a descendant of cwd (it is
// here: ROSTER_CLAUDE_HOME is <cwd>/claude), so the guarantee is not "outside
// this tree" but "nothing is resolved relative to cwd" — cwd's own entry list
// is therefore unchanged, and the unreadable sibling is never written through.
test('install --yes outside a workspace with an unreadable sibling writes only under the configured install root (#386)', () => {
  if (process.getuid && process.getuid() === 0) return;
  const h = makeHomes(['claude']);
  const candidate = join(h.root, 'private-cache');
  try {
    mkdirSync(candidate);
    chmodSync(candidate, 0o000);
    const before = readdirSync(h.root).sort();

    const r = runCli(
      ['install', '--tool', 'claude', '--yes', '--silent'],
      {
        ROSTER_CLAUDE_HOME: h.claude,
        ROSTER_CODEX_HOME: h.codex,
        ROSTER_GEMINI_HOME: h.gemini,
      },
      h.root,
    );

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.ok(existsSync(join(h.claude, 'skills')), 'home-dir install proceeded under --yes default');
    assert.deepEqual(readdirSync(h.root).sort(), before, 'no new entry written into the probed cwd');
  } finally {
    chmodSync(candidate, 0o755);
    h.cleanup();
  }
});
