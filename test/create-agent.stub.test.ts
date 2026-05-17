// ROS-55 — stub-mode regression test.
//
// Runs templates/scaffold/scripts/new-agent.sh in a tmp workspace and
// asserts the resulting tree is byte-identical to test/golden/stub-agent/.
// This is the canonical contract for stub mode (mode=stub branch of the
// chief-of-staff create-agent plan). Any drift in new-agent.sh — even a
// single byte — breaks downstream consumers that script against the stub
// layout. Regenerate the golden via `pnpm test:update-golden:stub` after
// intentional changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');

const SOURCE_SCRIPT = join(repoRoot, 'templates/scaffold/scripts/new-agent.sh');
const SOURCE_LIB = join(repoRoot, 'templates/scaffold/scripts/lib');
const GOLDEN_ROOT = join(repoRoot, 'test/golden/stub-agent');

const STUB_FN = 'stub-fn';
const STUB_AGENT = 'stub-agent';

interface Workspace {
  root: string;
  cleanup: () => void;
}

function makeWorkspace(opts: { scriptContent?: string } = {}): Workspace {
  const root = mkdtempSync(join(tmpdir(), 'roster-stub-test-'));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, '.config'), { recursive: true });

  if (opts.scriptContent !== undefined) {
    writeFileSync(join(root, 'scripts/new-agent.sh'), opts.scriptContent, { mode: 0o755 });
  } else {
    cpSync(SOURCE_SCRIPT, join(root, 'scripts/new-agent.sh'));
  }
  cpSync(SOURCE_LIB, join(root, 'scripts/lib'), { recursive: true });
  writeFileSync(
    join(root, '.config/functions.yaml'),
    `functions:\n  - slug: ${STUB_FN}\n    label: Stub Function\n`,
    'utf8',
  );

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function runStub(workspace: Workspace): void {
  execFileSync('bash', ['scripts/new-agent.sh', STUB_FN, STUB_AGENT], {
    cwd: workspace.root,
    env: { ...process.env, AGENT_TEAM_NO_CONFIRM: '1' },
    stdio: 'pipe',
  });
}

// Walk the tree, return a sorted list of file paths relative to root.
function listTreeFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const stats = statSync(abs);
      if (stats.isDirectory()) {
        walk(abs);
      } else {
        out.push(relative(root, abs));
      }
    }
  }
  walk(root);
  return out.sort();
}

// Snapshot just the output tree — the function dir + .claude/commands/.
// Excludes the inputs (scripts/, .config/) we provisioned.
function snapshotOutput(root: string): { paths: string[]; contents: Map<string, string> } {
  const paths: string[] = [];
  const contents = new Map<string, string>();
  for (const subtree of [STUB_FN, '.claude']) {
    const abs = join(root, subtree);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    for (const rel of listTreeFiles(abs)) {
      const full = join(subtree, rel);
      paths.push(full);
      contents.set(full, readFileSync(join(root, full), 'utf8'));
    }
  }
  paths.sort();
  return { paths, contents };
}

test('stub-mode: tree matches golden exactly (paths)', () => {
  const workspace = makeWorkspace();
  try {
    runStub(workspace);
    const actual = snapshotOutput(workspace.root);
    const golden = snapshotOutput(GOLDEN_ROOT);
    assert.deepEqual(
      actual.paths,
      golden.paths,
      'stub output paths and golden paths must match. ' +
        'If you changed scripts/new-agent.sh, run `pnpm test:update-golden:stub` and review the diff.',
    );
  } finally {
    workspace.cleanup();
  }
});

test('stub-mode: every file byte-identical to golden', () => {
  const workspace = makeWorkspace();
  try {
    runStub(workspace);
    const actual = snapshotOutput(workspace.root);
    const golden = snapshotOutput(GOLDEN_ROOT);
    for (const path of golden.paths) {
      assert.equal(
        actual.contents.get(path),
        golden.contents.get(path),
        `${path}: stub output bytes differ from golden. ` +
          'Run `pnpm test:update-golden:stub` after intentional contract changes; otherwise the script regressed.',
      );
    }
  } finally {
    workspace.cleanup();
  }
});

// Tamper guard — proves the assertion is doing work, not silently passing.
// Per contract-tests-mirror-document-form.md (ROS-20): a green run alone
// doesn't prove the regex matches anything; we must show it fails when the
// source is deliberately broken.
test('tamper: a modified script produces a tree that does NOT match golden', () => {
  const original = readFileSync(SOURCE_SCRIPT, 'utf8');
  // Inject a literal extra line into agent.md's purpose section. The
  // injection lands inside the heredoc that writes agent.md, so the
  // generated agent.md will differ from the golden.
  const tamperedScript = original.replace(
    /^## Purpose$/m,
    '## Purpose\n\nDRIFT-CANARY-LINE',
  );
  assert.notEqual(tamperedScript, original, 'tamper substitution must have changed the script');

  const workspace = makeWorkspace({ scriptContent: tamperedScript });
  try {
    runStub(workspace);
    const actual = snapshotOutput(workspace.root);
    const golden = snapshotOutput(GOLDEN_ROOT);
    // The agent.md file's content should differ.
    const agentMdPath = `${STUB_FN}/${STUB_AGENT}/agent.md`;
    assert.notEqual(
      actual.contents.get(agentMdPath),
      golden.contents.get(agentMdPath),
      'tampered script must produce a different agent.md — if this matches, the regression test is a no-op',
    );
  } finally {
    workspace.cleanup();
  }
});
