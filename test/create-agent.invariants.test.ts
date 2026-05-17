// ROS-55 — unit tests for the 5 cross-file invariants from
// skills/chief-of-staff/SKILL.md § Cross-file invariants.
//
// Each test constructs a deliberately-broken RenderOutput in memory
// (starting from the happy-path golden fixture) and asserts the specific
// validator trips with the expected error message prefix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixture } from '../src/lib/create-agent/fixture-loader.ts';
import { render, type RenderOutput } from '../src/lib/create-agent/render.ts';
import {
  validateInvariants,
  validateSubagentManifest,
  validateStepIdsMatchOutput,
  validateToolBindings,
  validateSlashDescription,
  validateNoPlaceholders,
} from '../src/lib/create-agent/invariants.ts';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
const FIXTURE_PATH = join(repoRoot, 'test/fixtures/guided-content-agent.yaml');

function happyPathOutput(): RenderOutput {
  const fixture = loadFixture(FIXTURE_PATH);
  return render({ fixture, expert: null });
}

function cloneOutput(output: RenderOutput): RenderOutput {
  return {
    dirs: [...output.dirs],
    files: new Map(output.files),
    slashCommand: { ...output.slashCommand },
  };
}

// Happy path — every invariant passes against the golden fixture.
test('validateInvariants: happy-path fixture passes all five', () => {
  const output = happyPathOutput();
  assert.doesNotThrow(() => validateInvariants(output));
});

// Invariant 1 — subagent manifest

test('Invariant 1: subagent declared in agent.md but file missing trips with "no file at"', () => {
  const output = cloneOutput(happyPathOutput());
  for (const path of output.files.keys()) {
    if (path.endsWith('/subagents/critic.md')) {
      output.files.delete(path);
      break;
    }
  }
  assert.throws(
    () => validateSubagentManifest(output),
    /Invariant 1 \(subagent manifest\): subagent "critic" listed in agent\.md but no file at/,
  );
});

test('Invariant 1: subagent file missing a required section trips with "missing required section"', () => {
  const output = cloneOutput(happyPathOutput());
  let path = '';
  let content = '';
  for (const [p, c] of output.files) {
    if (p.endsWith('/subagents/critic.md')) {
      path = p;
      content = c;
      break;
    }
  }
  // Strip the ## Quality bar heading (and its body) — section disappears entirely.
  const tampered = content.replace(/## Quality bar\n[\s\S]*$/, '');
  output.files.set(path, tampered);
  assert.throws(
    () => validateSubagentManifest(output),
    /Invariant 1 \(subagent manifest\): subagent "critic" missing required section "## Quality bar"/,
  );
});

test('Invariant 1: subagent file with empty required section trips with "empty section"', () => {
  const output = cloneOutput(happyPathOutput());
  let path = '';
  let content = '';
  for (const [p, c] of output.files) {
    if (p.endsWith('/subagents/critic.md')) {
      path = p;
      content = c;
      break;
    }
  }
  // Replace the Quality bar body with whitespace only — heading remains.
  const tampered = content.replace(/(## Quality bar\n)[\s\S]*$/, '$1\n   \n');
  output.files.set(path, tampered);
  assert.throws(
    () => validateSubagentManifest(output),
    /Invariant 1 \(subagent manifest\): subagent "critic" has empty section "## Quality bar"/,
  );
});

test('Invariant 1: orphan subagent file (not in agent.md) trips with "exists but"', () => {
  const output = cloneOutput(happyPathOutput());
  let prefix = '';
  for (const path of output.files.keys()) {
    const m = path.match(/^(.+)\/subagents\/_template\.md$/);
    if (m) {
      prefix = m[1];
      break;
    }
  }
  output.files.set(`${prefix}/subagents/orphan.md`, '# Orphan');
  assert.throws(
    () => validateSubagentManifest(output),
    /Invariant 1 \(subagent manifest\): file .+\/subagents\/orphan\.md exists but "orphan" is not listed/,
  );
});

// Invariant 2 — step ids match (output level)

test('Invariant 2: plan step id absent from agent.md trips with "not in agent.md ## Steps"', () => {
  const output = cloneOutput(happyPathOutput());
  let planPath = '';
  let planContent = '';
  for (const [path, content] of output.files) {
    if (path.match(/\/plans\/[^/]+\.yaml$/)) {
      planPath = path;
      planContent = content;
      break;
    }
  }
  assert.ok(planPath, 'fixture must include at least one plan file');
  // Inject a ghost step id into the plan yaml that does not appear in agent.md.
  const tampered = planContent.replace(/steps:\n/, 'steps:\n  - id: ghost-step\n    title: Ghost\n');
  output.files.set(planPath, tampered);
  assert.throws(
    () => validateStepIdsMatchOutput(output),
    /Invariant 2 \(step ids match\): plan ".+" references step id "ghost-step" not in agent\.md ## Steps/,
  );
});

test('Invariant 2: agent.md step missing from plan trips with "not in plan"', () => {
  const output = cloneOutput(happyPathOutput());
  let agentMdPath = '';
  let agentMdContent = '';
  for (const [path, content] of output.files) {
    if (path.endsWith('/agent.md')) {
      agentMdPath = path;
      agentMdContent = content;
      break;
    }
  }
  // Inject a ghost step id at the top of ## Steps that no plan file has.
  const tampered = agentMdContent.replace(
    /## Steps\n\n/,
    '## Steps\n\n- `ghost-step` — **Ghost.** Not in any plan.\n',
  );
  output.files.set(agentMdPath, tampered);
  assert.throws(
    () => validateStepIdsMatchOutput(output),
    /Invariant 2 \(step ids match\): agent\.md ## Steps id "ghost-step" not in plan/,
  );
});

// Invariant 3 — tool bindings

test('Invariant 3: tool in ## Tools without bindings entry trips with "no entry in"', () => {
  const output = cloneOutput(happyPathOutput());
  let agentMdPath = '';
  let agentMdContent = '';
  for (const [path, content] of output.files) {
    if (path.endsWith('/agent.md')) {
      agentMdPath = path;
      agentMdContent = content;
      break;
    }
  }
  // Add a tool to ## Tools without adding a matching binding block.
  const tampered = agentMdContent.replace(
    /## Tools\n\n- /,
    '## Tools\n\n- `unbound` — Required tool with no binding (required)\n- ',
  );
  output.files.set(agentMdPath, tampered);
  assert.throws(
    () => validateToolBindings(output),
    /Invariant 3 \(tool bindings\): tool "unbound" listed in agent\.md ## Tools but no entry in ## Tools and bindings/,
  );
});

test('Invariant 3: empty-description binding trips with "empty description"', () => {
  const output = cloneOutput(happyPathOutput());
  let agentMdPath = '';
  let agentMdContent = '';
  for (const [path, content] of output.files) {
    if (path.endsWith('/agent.md')) {
      agentMdPath = path;
      agentMdContent = content;
      break;
    }
  }
  // Blank out the description in the drive binding block.
  const tampered = agentMdContent.replace(
    /drive:\n  required: true\n  description: ".*?"/,
    'drive:\n  required: true\n  description: ""',
  );
  output.files.set(agentMdPath, tampered);
  assert.throws(
    () => validateToolBindings(output),
    /Invariant 3 \(tool bindings\): tool "drive" bindings block has empty description/,
  );
});

// Invariant 4 — slash description

test('Invariant 4: slash description containing "<" trips with "contains "<""', () => {
  const output = cloneOutput(happyPathOutput());
  output.slashCommand = {
    ...output.slashCommand,
    content: output.slashCommand.content.replace(
      /^description:.*$/m,
      'description: content-agent — drafts <something>',
    ),
  };
  assert.throws(
    () => validateSlashDescription(output.slashCommand.content),
    /Invariant 4 \(slash description\): description contains "<" character/,
  );
});

test('Invariant 4: slash description > 80 chars trips with "is N chars (max 80)"', () => {
  const output = cloneOutput(happyPathOutput());
  output.slashCommand = {
    ...output.slashCommand,
    content: output.slashCommand.content.replace(
      /^description:.*$/m,
      'description: ' + 'x'.repeat(81),
    ),
  };
  assert.throws(
    () => validateSlashDescription(output.slashCommand.content),
    /Invariant 4 \(slash description\): description is 81 chars \(max 80\)/,
  );
});

test('Invariant 4: slash description containing "TODO:" trips with "contains literal"', () => {
  const output = cloneOutput(happyPathOutput());
  output.slashCommand = {
    ...output.slashCommand,
    content: output.slashCommand.content.replace(
      /^description:.*$/m,
      'description: content-agent — TODO: fill in later',
    ),
  };
  assert.throws(
    () => validateSlashDescription(output.slashCommand.content),
    /Invariant 4 \(slash description\): description contains literal "TODO:"/,
  );
});

// Invariant 5 — no unfilled placeholders

test('Invariant 5: literal "<step>" in agent.md trips with "unfilled placeholder"', () => {
  const output = cloneOutput(happyPathOutput());
  let agentMdPath = '';
  let agentMdContent = '';
  for (const [path, content] of output.files) {
    if (path.endsWith('/agent.md')) {
      agentMdPath = path;
      agentMdContent = content;
      break;
    }
  }
  // Inject a stub-style placeholder. Reserved templates like <plan>/<project>
  // are allow-listed, so use a non-allowed token.
  const tampered = agentMdContent.replace(/## Purpose\n\n/, '## Purpose\n\n<step>\n\n');
  output.files.set(agentMdPath, tampered);
  assert.throws(
    () => validateNoPlaceholders(tampered),
    /Invariant 5 \(no placeholders\): agent\.md contains \d+ unfilled placeholder\(s\): <step>/,
  );
});

test('Invariant 5: bare "TODO:" without gap description trips with "bare \\"TODO:\\""', () => {
  const tampered = '# Agent\n\n## Purpose\n\nReal purpose. TODO:    \n\nMore text.';
  assert.throws(
    () => validateNoPlaceholders(tampered),
    /Invariant 5 \(no placeholders\): bare "TODO:" in agent\.md without a gap description/,
  );
});

test('Invariant 5: <placeholder> inside a ```yaml fenced block is ignored', () => {
  // Per pr-toolkit review: I3 owns the bindings yaml block; I5 should not
  // double-fire on tokens inside it. A future template adding `description:
  // "Optional binding for <provider>"` inside the fence must not trip I5.
  const md = '# Agent\n\n## Tools and bindings\n\n```yaml\nfoo:\n  description: "uses <provider> API"\n```\n';
  assert.doesNotThrow(() => validateNoPlaceholders(md));
});

test('Invariant 5: Markdown autolink <https://...> is ignored', () => {
  const md = '# Agent\n\n## Purpose\n\nSee <https://example.com/spec> for details.\n';
  assert.doesNotThrow(() => validateNoPlaceholders(md));
});

test('Invariant 5: aggregate validateInvariants trips on a placeholder in slash command body', () => {
  const output = cloneOutput(happyPathOutput());
  // Inject a stub-style placeholder into the slash command body. The
  // description line is left untouched so I4 still passes.
  output.slashCommand = {
    ...output.slashCommand,
    content: output.slashCommand.content.replace(
      /^## Usage$/m,
      '## Usage\n\nSee <unfilled-token> for help.',
    ),
  };
  assert.throws(
    () => validateInvariants(output),
    /Invariant 5 \(no placeholders\): slash command body contains 1 unfilled placeholder\(s\): <unfilled-token>/,
  );
});

// Tamper guard — proves validateInvariants is actually wired up

test('tamper: a single mutation that trips an invariant fails the aggregate', () => {
  const baseline = happyPathOutput();
  // Sanity: baseline passes aggregate.
  assert.doesNotThrow(() => validateInvariants(baseline));
  const broken = cloneOutput(baseline);
  // Drop a subagent file — invariant 1 should trip the aggregate.
  for (const path of broken.files.keys()) {
    if (path.endsWith('/subagents/critic.md')) {
      broken.files.delete(path);
      break;
    }
  }
  assert.throws(() => validateInvariants(broken), /Invariant 1/);
});
