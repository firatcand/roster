// ROS-54 — fixture-driven golden-snapshot harness for the guided agent-creation
// dialogue (see skills/chief-of-staff/SKILL.md).
//
// Each assertion below targets a distinct failure class. Together they prevent
// the silent-no-op failure mode where a snapshot test "passes" while neither
// the renderer nor the golden tree actually covers anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAllDocuments } from 'yaml';

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
      if (stats.isDirectory()) walk(absPath);
      else out.push(relative(GOLDEN_ROOT, absPath));
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

test('byte-identical: every rendered file matches the golden bytes exactly', () => {
  const output = renderForFixture();
  const expectations: Array<[string, string]> = [];
  for (const [relPath, content] of output.files) expectations.push([relPath, content]);
  expectations.push([output.slashCommand.path, output.slashCommand.content]);

  for (const [relPath, content] of expectations) {
    const goldenAbsPath = join(GOLDEN_ROOT, relPath);
    const goldenContent = readFileSync(goldenAbsPath, 'utf8');
    assert.equal(
      content,
      goldenContent,
      `${relPath}: render() output differs from golden. ` +
        'Run `pnpm test:update-golden` after intentional contract changes; otherwise the renderer regressed.',
    );
  }
});

// Every generated *.yaml must be parseable. Would have caught the original
// bug where multi-line `description: |` block scalars were emitted with their
// continuation lines at column 0 — invalid YAML the renderer locked in as the
// golden because the byte-identical test only compared against itself.
// parseAllDocuments accepts both single-doc YAML and frontmatter-style
// multi-doc YAML (no current files use the multi-doc form post-ROS-82, but
// the parser handles both transparently).
test('yaml validity: every rendered *.yaml parses without error', () => {
  const output = renderForFixture();
  for (const [relPath, content] of output.files) {
    if (relPath.endsWith('.yaml')) {
      const docs = parseAllDocuments(content);
      for (const doc of docs) {
        if (doc.errors.length > 0) {
          assert.fail(
            `${relPath}: rendered YAML is not parseable — likely a block-scalar indentation bug.\n` +
              doc.errors.map((e) => `  ${e.message}`).join('\n'),
          );
        }
      }
    }
  }
});

// Tamper test: corrupting a field that DOES flow into agent.md must diverge.
// Guards against the "snapshot is a silent no-op" trap from
// contract-tests-mirror-document-form (ROS-20 learning).
test('tamper: a corrupted fixture diverges from the golden', () => {
  const fixture = loadFixture(FIXTURE_PATH);
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

// Purity check — catches dynamic imports, side-effect imports, re-exports.
// The render call path must remain free of I/O so output is a pure function
// of fixture data. fixture-schema.ts is included in RENDER_SOURCES; the loader
// (which DOES import fs) lives in fixture-loader.ts and is intentionally not
// imported by render.ts.
const FORBIDDEN_MODULES = ['node:fs', 'node:fs/promises', 'node:readline', 'node:process'];

test('purity: render() and its deps import no fs / readline / process modules', () => {
  for (const sourcePath of RENDER_SOURCES) {
    const src = readFileSync(sourcePath, 'utf8');
    for (const mod of FORBIDDEN_MODULES) {
      // Match: `from 'mod'`, `import('mod')`, `require('mod')`, bare `import 'mod'`,
      // and `export * from 'mod'`. The capture group accepts either quote style.
      const pattern = new RegExp(
        `(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+|export\\s+\\*\\s+from\\s+)['"]${mod.replace(
          /\//g,
          '\\/',
        )}['"]`,
      );
      assert.doesNotMatch(
        src,
        pattern,
        `${relative(repoRoot, sourcePath)}: must not import ${mod}. ` +
          'If you genuinely need fs (e.g., the loader), put it in a separate module outside the render() call path.',
      );
    }
  }
});

test('purity narrow: render.ts itself imports nothing from node:fs', () => {
  const src = readFileSync(join(repoRoot, 'src/lib/create-agent/render.ts'), 'utf8');
  assert.doesNotMatch(src, /node:fs/);
});

test('host-independence: two render() calls produce byte-identical output', () => {
  const a = renderForFixture();
  const b = renderForFixture();
  assert.deepEqual([...a.files.entries()], [...b.files.entries()], 'files map differs across two renders');
  assert.equal(a.slashCommand.path, b.slashCommand.path, 'slash command path differs');
  assert.equal(a.slashCommand.content, b.slashCommand.content, 'slash command content differs');
  assert.deepEqual(a.dirs, b.dirs, 'dirs list differs');
});

// Schema-level rejections — slash description format + uniqueness for subagents / tools / plans / step ids.

test('schema rejects slash command description with TODO:', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const bad = { ...fixture, slash_command: { description: 'TODO: write description' } };
  assert.equal(GuidedAgentFixtureSchema.safeParse(bad).success, false);
});

test('schema rejects slash command description containing <', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const bad = { ...fixture, slash_command: { description: 'agent — drafts <something>' } };
  assert.equal(GuidedAgentFixtureSchema.safeParse(bad).success, false);
});

test('schema rejects slash command description > 80 chars', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const bad = { ...fixture, slash_command: { description: 'x'.repeat(81) } };
  assert.equal(GuidedAgentFixtureSchema.safeParse(bad).success, false);
});

test('schema rejects duplicate subagent names', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const dup = fixture.uncertain_answers.subagents[0];
  const bad = {
    ...fixture,
    uncertain_answers: {
      ...fixture.uncertain_answers,
      subagents: [dup, dup],
    },
  };
  assert.equal(GuidedAgentFixtureSchema.safeParse(bad).success, false);
});

test('schema rejects duplicate plan names', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const dup = fixture.uncertain_answers.plans[0];
  const bad = {
    ...fixture,
    uncertain_answers: {
      ...fixture.uncertain_answers,
      plans: [dup, dup],
    },
  };
  assert.equal(GuidedAgentFixtureSchema.safeParse(bad).success, false);
});

test('schema rejects duplicate grounded.step ids', () => {
  const fixture = loadFixture(FIXTURE_PATH);
  const dup = fixture.grounded.steps[0];
  const bad = { ...fixture, grounded: { ...fixture.grounded, steps: [dup, dup] } };
  assert.equal(GuidedAgentFixtureSchema.safeParse(bad).success, false);
});

