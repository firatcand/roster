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

function runCli(args: readonly string[], envOverrides: Record<string, string>): Run {
  const out = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', BIN, ...args],
    {
      encoding: 'utf8',
      env: { ...process.env, ...envOverrides, FORCE_COLOR: '0', NO_COLOR: '1' },
    },
  );
  return { status: out.status ?? -1, stdout: out.stdout, stderr: out.stderr };
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
    assert.ok(existsSync(join(h.codex, 'prompts')), 'codex prompts dir written');
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
    assert.ok(!existsSync(join(h.codex, 'prompts')), 'codex NOT written');
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
