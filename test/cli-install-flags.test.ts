import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, lstatSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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
  // Minimal workspace fixture: config/project.yaml is the detection signal.
  const ws = mkdtempSync(join(root, 'ws-'));
  mkdirSync(join(ws, 'config'));
  writeFileSync(join(ws, 'config', 'project.yaml'), 'name: test\n');
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

test('ROS-109: install --scope project from a non-workspace dir exits 2 with the documented error', () => {
  const h = makeHomes(['claude']);
  // CWD is the tmpdir root which has no config/project.yaml.
  try {
    const r = runCli(['install', '--scope', 'project', '--yes'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    }, h.root);
    assert.equal(r.status, 2, `stderr: ${r.stderr}`);
    assert.match(r.stderr, /project-level install requires a roster workspace/i);
    assert.match(r.stderr, /config\/project\.yaml/);
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

test('ROS-109: install --scope project from a workspace writes to <workspace>/.tool/ paths', () => {
  const h = makeHomes(['claude']);
  try {
    const ws = makeWorkspace(h.root);
    const r = runCli(['install', '--tool', 'claude', '--scope', 'project', '--yes', '--silent'], {
      ROSTER_CLAUDE_HOME: h.claude,
      ROSTER_CODEX_HOME: h.codex,
      ROSTER_GEMINI_HOME: h.gemini,
    }, ws);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    // Project-scope install: skills land inside the workspace, NOT in claude home.
    assert.ok(existsSync(join(ws, '.claude', 'skills')), 'workspace .claude/skills written');
    assert.ok(existsSync(join(ws, '.claude', 'agents')), 'workspace .claude/agents written');
    assert.ok(!existsSync(join(h.claude, 'skills')), 'user-scope claude NOT touched');
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

test('ROS-109: --yes from inside a workspace defaults to project scope', () => {
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
    assert.ok(existsSync(join(ws, '.claude', 'skills')), 'workspace install under --yes default');
    assert.ok(!existsSync(join(h.claude, 'skills')), 'user home NOT used');
  } finally {
    h.cleanup();
  }
});

test('ROS-109: --yes outside a workspace defaults to user scope', () => {
  const h = makeHomes(['claude']);
  try {
    // CWD has no config/project.yaml.
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
