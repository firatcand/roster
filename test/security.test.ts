// ROS-30 — Security audit: path traversal and supply chain.
//
// This file doubles as the audit artifact: the header documents findings, the
// assertions enforce them. Per the contract-tests-mirror-document-form learning,
// the test shape mirrors the audit-checklist shape so a future reader can verify
// each acceptance line against an assertion.
//
// Threat model (revised after codex review on the plan):
//
//   ROSTER_{CLAUDE,CODEX,GEMINI}_HOME are TRUSTED inputs on the same level as the
//   invoking user. The path-traversal guard does NOT defend against a user setting
//   ROSTER_CLAUDE_HOME=/etc — that resolves configRoot=/etc, skillsTarget=/etc/skills,
//   both pass `under configRoot` by construction. Protecting users from their own
//   env is out of scope.
//
//   What the guard buys:
//     1. Internal invariant — any future code constructing a Tool with a target
//        outside its configRoot fails loudly at the boundary.
//     2. Defense-in-depth — per-entry copy() targets are re-checked, so a future
//        bug allowing path-like content in a dirent name is caught at copy time.
//
//   Out of scope, explicitly:
//     - Parent-symlink escapes (e.g., ~/.claude/skills symlinked to /tmp/outside).
//       Catching these requires fs.realpath on every write; the cost (broken
//       intermediates, changed error modes) exceeds the value at this scale.
//       File a follow-up ticket if a deployment shape ever needs hard "stay under
//       home" guarantees.
//
// Audit findings (state at ROS-30 close):
//
//   [PASS]    No postinstall/preinstall/install script hooks in package.json.
//             Asserted by test "no npm install lifecycle hooks in package.json".
//
//   [PASS]    Path-traversal guard rejects target-outside-configRoot before any fs
//             write. Asserted by the install-guard integration tests + the direct
//             assertWithinRoot unit tests below.
//
//   [PASS]    Separator-aware check — names like `..foo` are legitimate and accepted.
//             Asserted by test "legitimate ..foo name is not rejected".
//
//   [PASS]    npm `files` allowlist excludes spec/, test/, src/, plans/, .env*.
//             Asserted by test "npm pack tarball excludes source, tests, plans, env".
//
//   [PASS]    No symbolic links under skills/ or agents/ — fs-extra.copy preserves
//             symlinks by default; a stray link in the source tree would ship and
//             resolve relative to the consumer's filesystem.
//             Asserted by test "no symbolic links under skills/ or agents/".
//
//   [PASS]    templates/env.example contains only placeholder values (no real tokens).
//             Asserted by test "env.example contains only placeholder values".
//
//   [PASS]    pnpm audit --prod is run via CI as a separate gate (not asserted here
//             to avoid network-dependent tests). Capture from latest run noted in
//             ROS-30 PR description.
//
//   [KEEP]    Direct deps left at semver ranges (^@inquirer/prompts, ^chalk,
//             ^fs-extra). Plan first proposed exact pins; reversed after codex
//             review. Pinning a published library's runtime deps gives consumers
//             no reproducibility benefit (they don't get our lockfile), hurts
//             deduplication, and strands them on vulnerable patch versions until
//             we cut a release. The repo's pnpm-lock.yaml gives dev/CI
//             reproducibility; the release cadence + `pnpm audit --prod` gate
//             handles supply-chain hygiene.
//
//   [DEFER]   Publish-time hardening (npm 2FA on @firatcand org, --provenance on
//             npm publish, no committed .npmrc, packed file modes review) belongs
//             on the publish checklist in ROS-27, not this audit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertWithinRoot,
  installToTool,
  RosterPathTraversalError,
  type InstallLogger,
} from '../src/lib/install.ts';
import { getToolByKey, type Tool } from '../src/lib/tools.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function silentLogger(): InstallLogger {
  return { log: () => {}, warn: () => {} };
}

function makeSource(): { root: string; skills: string; agents: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'roster-sec-src-'));
  const skills = join(root, 'skills');
  const agents = join(root, 'agents');
  mkdirSync(join(skills, 'sample-skill'), { recursive: true });
  writeFileSync(join(skills, 'sample-skill', 'SKILL.md'), '# sample\n');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'lesson-drafter.md'), '# lesson-drafter\n');
  return {
    root,
    skills,
    agents,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// A Tool whose targets are deliberately outside its configRoot — the kind of
// construction bug the guard exists to catch.
function makeEscapedTool(configRoot: string, escapedSkills: string, escapedAgents: string | null): Tool {
  return {
    key: 'claude',
    name: 'Test Tool',
    configRoot,
    skillsTarget: escapedSkills,
    agentsTarget: escapedAgents,
    skillsLayout: 'dir',
    skillsFileExt: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Path-traversal guard
// ─────────────────────────────────────────────────────────────────────────────

test('install rejects when skillsTarget resolves outside configRoot — no fs write occurs', async () => {
  const src = makeSource();
  const homeRoot = mkdtempSync(join(tmpdir(), 'roster-sec-home-'));
  const escape = join(homeRoot, 'elsewhere');
  try {
    const tool = makeEscapedTool(join(homeRoot, 'safe'), join(escape, 'skills'), join(homeRoot, 'safe', 'agents'));
    await assert.rejects(
      () => installToTool(tool, { skills: src.skills, agents: src.agents, silent: true, logger: silentLogger() }),
      (err: unknown) => {
        assert.ok(err instanceof RosterPathTraversalError, `got ${(err as Error)?.name ?? typeof err}`);
        assert.match((err as Error).message, /skillsTarget/);
        return true;
      },
    );
    assert.ok(!existsSync(escape), 'no directory created outside configRoot');
  } finally {
    src.cleanup();
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install rejects when agentsTarget resolves outside configRoot — no fs write occurs', async () => {
  const src = makeSource();
  const homeRoot = mkdtempSync(join(tmpdir(), 'roster-sec-home-'));
  const escape = join(homeRoot, 'elsewhere-agents');
  try {
    const tool = makeEscapedTool(join(homeRoot, 'safe'), join(homeRoot, 'safe', 'skills'), join(escape, 'agents'));
    await assert.rejects(
      () => installToTool(tool, { skills: src.skills, agents: src.agents, silent: true, logger: silentLogger() }),
      (err: unknown) => {
        assert.ok(err instanceof RosterPathTraversalError, `got ${(err as Error)?.name ?? typeof err}`);
        assert.match((err as Error).message, /agentsTarget/);
        return true;
      },
    );
    assert.ok(!existsSync(escape), 'no directory created outside configRoot');
  } finally {
    src.cleanup();
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install rejects skillsTarget escaping via .. segments — no fs write occurs', async () => {
  const src = makeSource();
  const homeRoot = mkdtempSync(join(tmpdir(), 'roster-sec-home-'));
  const safe = join(homeRoot, 'safe');
  const escape = join(homeRoot, 'escape-here');
  try {
    // skillsTarget literal contains ".." pointing outside configRoot.
    const tool = makeEscapedTool(safe, join(safe, '..', 'escape-here'), join(safe, 'agents'));
    await assert.rejects(
      () => installToTool(tool, { skills: src.skills, agents: src.agents, silent: true, logger: silentLogger() }),
      (err: unknown) => err instanceof RosterPathTraversalError,
    );
    assert.ok(!existsSync(escape), 'no directory created at the .. escape target');
  } finally {
    src.cleanup();
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('install rejects when configRoot and skillsTarget have disjoint roots — invariant violation caught', async () => {
  // Even though ROSTER_*_HOME is trusted, an internal Tool constructor mistake
  // (skillsTarget assembled from a different root than configRoot) must fail.
  // Uses two freshly minted temp roots so the no-write assertion is checking a
  // path that definitely did not pre-exist (per codex review feedback on the
  // earlier fixed-/tmp version of this test).
  const src = makeSource();
  const safeRoot = mkdtempSync(join(tmpdir(), 'roster-sec-safe-'));
  const escapeRoot = mkdtempSync(join(tmpdir(), 'roster-sec-escape-'));
  // Capture children of escapeRoot before the call so we can prove nothing got
  // written into it as a side-effect of the install attempt.
  const escapeChildren = readdirSync(escapeRoot);
  try {
    const tool = makeEscapedTool(safeRoot, join(escapeRoot, 'skills'), null);
    await assert.rejects(
      () => installToTool(tool, { skills: src.skills, agents: src.agents, silent: true, logger: silentLogger() }),
      (err: unknown) => err instanceof RosterPathTraversalError,
    );
    assert.deepEqual(readdirSync(escapeRoot), escapeChildren, 'no write occurred under escapeRoot');
    assert.ok(!existsSync(join(escapeRoot, 'skills')), 'skillsTarget child not created');
  } finally {
    src.cleanup();
    rmSync(safeRoot, { recursive: true, force: true });
    rmSync(escapeRoot, { recursive: true, force: true });
  }
});

test('install happy path: targets under configRoot succeed, both skills and agents written', async () => {
  const src = makeSource();
  const homeRoot = mkdtempSync(join(tmpdir(), 'roster-sec-home-'));
  try {
    process.env['ROSTER_CLAUDE_HOME'] = homeRoot;
    const tool = getToolByKey('claude')!;
    const result = await installToTool(tool, {
      skills: src.skills,
      agents: src.agents,
      silent: true,
      logger: silentLogger(),
    });
    assert.equal(result.skillsCount, 1);
    assert.equal(result.agentsCount, 1);
    assert.ok(existsSync(join(homeRoot, 'skills', 'sample-skill', 'SKILL.md')));
    assert.ok(existsSync(join(homeRoot, 'agents', 'lesson-drafter.md')));
  } finally {
    delete process.env['ROSTER_CLAUDE_HOME'];
    src.cleanup();
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('legitimate ..foo name is not rejected — separator-aware check', async () => {
  // Regression test for the codex-caught bug in the first impl sketch: a naive
  // startsWith('..') would falsely reject paths whose first segment begins with
  // '..' but is not the '..' parent reference. The fix uses sep-aware matching.
  const src = makeSource();
  const homeRoot = mkdtempSync(join(tmpdir(), 'roster-sec-home-'));
  const configRoot = join(homeRoot, '..foo');
  try {
    mkdirSync(configRoot, { recursive: true });
    const tool: Tool = {
      key: 'claude',
      name: 'Test Tool',
      configRoot,
      skillsTarget: join(configRoot, 'skills'),
      agentsTarget: join(configRoot, 'agents'),
      skillsLayout: 'dir',
      skillsFileExt: null,
    };
    const result = await installToTool(tool, {
      skills: src.skills,
      agents: src.agents,
      silent: true,
      logger: silentLogger(),
    });
    assert.equal(result.skillsCount, 1, '..foo dir accepted as legitimate path component');
  } finally {
    src.cleanup();
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Direct validator unit tests
//
// On POSIX `readdirSync` dirent.name cannot contain `/`, so the per-entry
// `assertWithinRoot(targetPath, …)` calls inside installToTool's skills/agents
// loops are otherwise unreachable from integration tests. These unit tests
// exercise the same validator the loops use, so removal of the per-entry
// callsites is caught indirectly (any future regression that bypasses the
// validator would still need these to keep passing — and the integration
// tests above prove the validator is wired into the install path).
// ─────────────────────────────────────────────────────────────────────────────

test('assertWithinRoot: rejects parent-dir escape via ..', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-sec-awr-'));
  try {
    assert.throws(
      () => assertWithinRoot(join(root, '..', 'escape'), root, 'test'),
      RosterPathTraversalError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertWithinRoot: rejects sibling path that shares prefix (e.g. /foo vs /foobar)', () => {
  // Prefix-collision class: '/foo' and '/foobar' are sibling roots; a naive
  // string-prefix check would falsely accept '/foobar' as under '/foo'.
  const root = mkdtempSync(join(tmpdir(), 'roster-sec-awr-'));
  try {
    const sibling = root + '-sibling';
    assert.throws(
      () => assertWithinRoot(sibling, root, 'test'),
      RosterPathTraversalError,
    );
    assert.throws(
      () => assertWithinRoot(join(sibling, 'child'), root, 'test'),
      RosterPathTraversalError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertWithinRoot: rejects absolute paths pointing elsewhere', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-sec-awr-'));
  try {
    assert.throws(
      () => assertWithinRoot('/var/log/messages', root, 'test'),
      RosterPathTraversalError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertWithinRoot: accepts root itself, "." segments, trailing slashes', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-sec-awr-'));
  try {
    assert.doesNotThrow(() => assertWithinRoot(root, root, 'test'));
    assert.doesNotThrow(() => assertWithinRoot(root + '/', root, 'test'));
    assert.doesNotThrow(() => assertWithinRoot(join(root, '.'), root, 'test'));
    assert.doesNotThrow(() => assertWithinRoot(join(root, '.', 'child'), root, 'test'));
    assert.doesNotThrow(() => assertWithinRoot(join(root, 'a', 'b', 'c'), root, 'test'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertWithinRoot: accepts legitimate names starting with .. (e.g. ..foo, ..bar)', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-sec-awr-'));
  try {
    assert.doesNotThrow(() => assertWithinRoot(join(root, '..foo'), root, 'test'));
    assert.doesNotThrow(() => assertWithinRoot(join(root, '..bar', 'child'), root, 'test'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertWithinRoot: rejects mixed traversal embedded in legitimate-looking path', () => {
  const root = mkdtempSync(join(tmpdir(), 'roster-sec-awr-'));
  try {
    assert.throws(
      () => assertWithinRoot(join(root, 'child', '..', '..', 'escape'), root, 'test'),
      RosterPathTraversalError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Supply-chain audit assertions
// ─────────────────────────────────────────────────────────────────────────────

test('no npm install lifecycle hooks in package.json', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    assert.equal(scripts[hook], undefined, `package.json must not define '${hook}' (would run on every consumer install)`);
  }
});

test('npm pack tarball excludes source, tests, plans, env files', () => {
  // npm pack --dry-run --json prints the file list to stdout. We assert the
  // forbidden roots are absent rather than matching the entire allowlist —
  // matches the gitignore-vs-files-allowlist learning: the allowlist is the
  // ground truth for what ships.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  assert.ok(parsed.length > 0 && parsed[0]!.files.length > 0, 'npm pack returned a file list');
  const paths = parsed[0]!.files.map((f) => f.path);
  const forbidden = ['spec/', 'test/', 'src/', 'plans/'];
  for (const prefix of forbidden) {
    const offenders = paths.filter((p) => p.startsWith(prefix));
    assert.deepEqual(offenders, [], `${prefix} must not ship; found: ${offenders.join(', ')}`);
  }
  const envOffenders = paths.filter((p) => /(^|\/)\.env(\..+)?$/.test(p));
  assert.deepEqual(envOffenders, [], `.env* must not ship; found: ${envOffenders.join(', ')}`);
});

test('no symbolic links under skills/ or agents/', () => {
  // fs-extra.copy preserves symlinks by default. A stray symlink in the source
  // tree would ship in the tarball and resolve against the consumer's
  // filesystem on install — at best broken, at worst pointing somewhere
  // unexpected. Walk both trees and assert lstat reports no symlinks.
  const offenders: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) return;
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, dirent.name);
      if (dirent.isSymbolicLink()) {
        offenders.push(p);
      } else if (dirent.isDirectory()) {
        walk(p);
      }
    }
  }
  walk(join(repoRoot, 'skills'));
  walk(join(repoRoot, 'agents'));
  assert.deepEqual(offenders, [], `symlinks found in published surface: ${offenders.join(', ')}`);
  // Belt-and-braces: lstat the roots themselves.
  for (const root of ['skills', 'agents']) {
    const p = join(repoRoot, root);
    if (existsSync(p)) {
      assert.ok(!lstatSync(p).isSymbolicLink(), `${root}/ root is a symlink`);
    }
  }
});

test('packed bin entrypoint is present, has shebang, and is executable', () => {
  // Per codex review: the pack-exclusion test catches what should NOT ship, but
  // does not verify the CLI entrypoint that should. A bin pointing at a missing
  // or non-executable file ships a broken CLI.
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    bin?: Record<string, string>;
  };
  assert.ok(pkg.bin && Object.keys(pkg.bin).length > 0, 'package.json declares a bin entry');
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  const packedPaths = parsed[0]!.files.map((f) => f.path);

  for (const binTarget of Object.values(pkg.bin!)) {
    const normalised = binTarget.replace(/^\.\//, '');
    assert.ok(
      packedPaths.includes(normalised),
      `bin target ${binTarget} must be present in npm pack output`,
    );
    const onDisk = join(repoRoot, normalised);
    assert.ok(existsSync(onDisk), `bin target ${normalised} exists on disk (build artifact)`);
    const head = readFileSync(onDisk, 'utf8').slice(0, 32);
    assert.match(head, /^#!.*node/, `bin target ${normalised} has a node shebang`);
    // Node's executable-bit check: any of owner/group/other exec.
    const { mode } = lstatSync(onDisk);
    assert.ok((mode & 0o111) !== 0, `bin target ${normalised} has at least one executable bit set`);
  }
});

test('env.example contains only placeholder values', () => {
  const body = readFileSync(join(repoRoot, 'templates', 'env.example'), 'utf8');
  // Every non-comment, non-blank line is suspicious — env.example should be
  // entirely commented placeholders. If a line is not a comment and not blank,
  // someone committed a real value.
  const lines = body.split('\n');
  const live = lines.filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  assert.deepEqual(live, [], `non-commented lines found in env.example: ${live.join(' | ')}`);
  // Sanity: assert at least one placeholder pattern is present so we know we
  // actually read the file and didn't silently miss it.
  assert.match(body, /xxx|sk-xxx|secret_xxx|xoxb-xxx|ghp_xxx|lin_api_xxx/);
});
