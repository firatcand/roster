// ROS-54 — fixture-driven golden-snapshot harness for the guided agent-creation
// dialogue (see skills/chief-of-staff/SKILL.md).
//
// Five assertions, each catches a specific failure class. Together they prevent
// the silent-no-op failure mode where a snapshot test "passes" while neither
// the renderer nor the golden tree actually covers anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GuidedAgentFixtureSchema } from '../src/lib/create-agent/fixture-schema.ts';
import { loadFixture } from '../src/lib/create-agent/fixture-loader.ts';
import { render } from '../src/lib/create-agent/render.ts';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');

const FIXTURE_PATH = join(repoRoot, 'test/fixtures/guided-content-agent.yaml');
const GOLDEN_ROOT = join(repoRoot, 'test/golden/content-agent');
const RENDER_SOURCES = [
  join(repoRoot, 'src/lib/create-agent/render.ts'),
  join(repoRoot, 'src/lib/create-agent/templates.ts'),
  join(repoRoot, 'src/lib/create-agent/paths.ts'),
  join(repoRoot, 'src/lib/create-agent/fixture-schema.ts'),
];

function listGoldenFiles(): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const absPath = join(dir, entry);
      const stats = statSync(absPath);
      if (stats.isDirectory()) {
        walk(absPath);
      } else {
        out.push(relative(GOLDEN_ROOT, absPath));
      }
    }
  }
  walk(GOLDEN_ROOT);
  return out.sort();
}

function renderForFixture() {
  const fixture = loadFixture(FIXTURE_PATH);
  return render({ fixture, expert: null });
}

function rendererProducedPaths(): string[] {
  const output = renderForFixture();
  const paths: string[] = [...output.files.keys(), output.slashCommand.path];
  return paths.sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 1: golden coverage — golden tree contains exactly the same paths
// render() emits. Catches "added file to render() but forgot the golden" AND
// "left an orphan golden file after a renderer change."
// ─────────────────────────────────────────────────────────────────────────────

test('golden coverage: golden tree paths match render() output paths exactly', () => {
  const goldenPaths = listGoldenFiles();
  const rendered = rendererProducedPaths();
  assert.deepEqual(
    rendered,
    goldenPaths,
    'render() output paths and golden tree paths must be the same set. ' +
      'If you changed render(), run `pnpm test:update-golden` and review the diff.',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 2: byte-identical match for every path render() emits.
// Catches drift between render() output and the locked-in spec.
// ─────────────────────────────────────────────────────────────────────────────

test('byte-identical: every rendered file matches the golden bytes exactly', () => {
  const output = renderForFixture();
  const expectations: Array<[string, string]> = [];
  for (const [relPath, content] of output.files) {
    expectations.push([relPath, content]);
  }
  expectations.push([output.slashCommand.path, output.slashCommand.content]);

  for (const [relPath, content] of expectations) {
    const goldenAbsPath = join(GOLDEN_ROOT, relPath);
    const goldenContent = readFileSync(goldenAbsPath, 'utf8');
    assert.equal(
      content,
      goldenContent,
      `${relPath}: render() output differs from golden. ` +
        `Run \`pnpm test:update-golden\` after intentional contract changes; ` +
        `otherwise the renderer regressed.`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 3: tamper test — corrupting the fixture must cause divergence.
// Guards against the "snapshot is a silent no-op" trap from
// contract-tests-mirror-document-form (ROS-20 learning). If we deliberately
// break the input and the harness STILL passes, the harness is broken.
// ─────────────────────────────────────────────────────────────────────────────

test('tamper: a corrupted fixture diverges from the golden', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  // Mutation: change the purpose. Should ripple into agent.md only.
  const tampered = {
    ...fixture,
    grounded: { ...fixture.grounded, purpose: 'TAMPERED PURPOSE — should never match golden' },
  };
  const tamperedOutput = render({ fixture: tampered, expert: null });
  const agentMdPath = `${fixture.fn}/${fixture.agent}/agent.md`;
  const tamperedAgentMd = tamperedOutput.files.get(agentMdPath);
  assert.ok(tamperedAgentMd, 'tampered render() still produces agent.md');
  const goldenAgentMd = readFileSync(join(GOLDEN_ROOT, agentMdPath), 'utf8');
  assert.notEqual(
    tamperedAgentMd,
    goldenAgentMd,
    'fixture tamper must produce divergent agent.md — if this passes, the harness is a no-op',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 4: purity — render() and its deps must not import side-effecting
// runtime modules. Guards against the renderer becoming impure (e.g., reading
// fs at render time, branching on process.platform, prompting via readline).
// Source-level static check by scanning import statements.
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_IMPORTS = ['node:fs', 'node:fs/promises', 'node:readline', 'node:process'];

test('purity: render() and its deps import no fs / readline / process modules', () => {
  for (const sourcePath of RENDER_SOURCES) {
    const src = readFileSync(sourcePath, 'utf8');
    for (const banned of FORBIDDEN_IMPORTS) {
      // Match `import ... from 'node:fs'` and `import ... from "node:fs"` only.
      const re = new RegExp(`from\\s+['"]${banned.replace('/', '\\/')}['"]`);
      assert.doesNotMatch(
        src,
        re,
        `${relative(repoRoot, sourcePath)}: must not import ${banned}. ` +
          `If you genuinely need fs (e.g., the loader), put it in a separate module ` +
          `outside the render() call path.`,
      );
    }
  }
});

// fixture-schema.ts is allowed to import node:fs (for loadFixture). Verify
// this lives in the loader, not in any module render() reaches transitively.
test('purity narrow: render.ts itself imports nothing from node:fs', () => {
  const src = readFileSync(join(repoRoot, 'src/lib/create-agent/render.ts'), 'utf8');
  assert.doesNotMatch(src, /from\s+['"]node:fs['"]/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Assertion 5: host-independence — re-running render() twice on the same input
// produces byte-identical output. Catches Date.now / Math.random / platform
// branches that would make the test flake across machines/CI.
// ─────────────────────────────────────────────────────────────────────────────

test('host-independence: two render() calls produce byte-identical output', () => {
  const a = renderForFixture();
  const b = renderForFixture();
  assert.deepEqual([...a.files.entries()], [...b.files.entries()], 'files map differs across two renders');
  assert.equal(a.slashCommand.path, b.slashCommand.path, 'slash command path differs');
  assert.equal(a.slashCommand.content, b.slashCommand.content, 'slash command content differs');
  assert.deepEqual(a.dirs, b.dirs, 'dirs list differs');
});

// ─────────────────────────────────────────────────────────────────────────────
// Bonus: fixture schema rejects obvious garbage. Lightweight smoke test that
// the zod schema actually catches the invariants we documented.
// ─────────────────────────────────────────────────────────────────────────────

test('schema rejects slash command description with TODO:', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const bad = { ...fixture, slash_command: { description: 'TODO: write description' } };
  const result = GuidedAgentFixtureSchema.safeParse(bad);
  assert.equal(result.success, false, 'schema must reject TODO: descriptions per invariant 4');
});

test('schema rejects slash command description containing <', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const bad = { ...fixture, slash_command: { description: 'agent — drafts <something>' } };
  const result = GuidedAgentFixtureSchema.safeParse(bad);
  assert.equal(result.success, false, 'schema must reject "<" in description per invariant 4');
});

test('schema rejects slash command description > 80 chars', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const bad = { ...fixture, slash_command: { description: 'x'.repeat(81) } };
  const result = GuidedAgentFixtureSchema.safeParse(bad);
  assert.equal(result.success, false, 'schema must reject descriptions over 80 chars per invariant 4');
});
