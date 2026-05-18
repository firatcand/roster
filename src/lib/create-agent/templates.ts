// Boilerplate constants + per-section builders for the guided agent-creation
// render. Files marked "byte-identical to stub mode" in skills/chief-of-staff/
// SKILL.md's Generated file contracts table source their content from this module.
//
// Single source of truth: when scripts/new-agent.sh ships (ROS-58), its
// stub-mode output for these files must equal what this module produces.
// A drift detector test there will enforce that contract.
//
// Multi-line interpolation rule: any fixture value that arrived from a YAML
// `|` block scalar may carry embedded newlines. Inline interpolation
// (`${value}` inside a template literal) only prefixes the FIRST line with
// surrounding whitespace; continuation lines land at column 0 — breaking
// both YAML block-scalar nesting and Markdown bullet continuation. Use
// indentBlockScalar / indentBulletContinuation for any field that may be
// multi-line.

import type { GuidedAgentFixture, GuidedSubagent, GuidedTool, GuidedPlan, GuidedStep } from './fixture-schema.ts';

// Stub date used in any boilerplate that needs a created/last_modified field.
// Hardcoded for host-independence — the harness asserts render() output is
// byte-identical across runs, so Date.now() at render time would flake CI.
const STUB_DATE = '2026-01-01';

// Indent every line of a multi-line value so it sits cleanly inside a YAML
// block-scalar (`description: |`) or any other context that needs a stable
// leading-whitespace prefix. Trailing whitespace is trimmed.
function indentBlockScalar(text: string, indent: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => indent + line)
    .join('\n');
}

// Indent continuation lines of a multi-line value so they sit under a
// Markdown bullet (`- ${first}\n  ${rest}`). Without this, Markdown treats
// the continuation as a sibling paragraph and breaks bullet grouping.
function indentBulletContinuation(text: string): string {
  return text.trimEnd().split('\n').join('\n  ');
}

// ─────────────────────────────────────────────────────────────────────────────
// File-level boilerplate
// ─────────────────────────────────────────────────────────────────────────────

export function renderReadme(fn: string, agent: string): string {
  return `# ${agent}

${fn} agent. See \`agent.md\` for the orchestrator contract.

## Files

- \`agent.md\` — orchestrator contract (purpose, inputs, steps, subagents, tools, outputs, approval, lessons, failure modes)
- \`subagents/\` — per-subagent contracts (one file per name listed in \`agent.md ## Subagents\`)
- \`plans/\` — workflow recipes (one yaml per plan)
- \`playbook/\` — global lessons (dreamer-promoted or hand-flagged)
- \`logs/\` — agent-level operational logs
- \`.claude/\` — agent-scoped skills and plugins
- \`.mcp.json\` — agent-scoped MCPs
- \`projects/\` — per-project instances (config, project-scoped lessons, run/feedback logs)

## Invocation

Use the \`/${agent}\` slash command, or invoke via natural language ("Run ${fn}/${agent} on <project> using <plan>").

## Outputs

Per run: \`projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md\`.
`;
}

export function renderMcpJson(agent: string, tools: GuidedTool[]): string {
  const mcpTools = tools.filter((t) => t.mcp_url);
  if (mcpTools.length === 0) {
    return `{
  "_comment": "Agent-scoped MCPs for ${agent}. Universal MCPs are inherited from the workspace .mcp.json.",
  "mcpServers": {}
}
`;
  }
  const sorted = [...mcpTools].sort((a, b) => a.name.localeCompare(b.name));
  const entries = sorted.map(
    (t) => `    "${t.name}": {
      "type": "http",
      "url": "${t.mcp_url}"
    }`,
  );
  return `{
  "_comment": "Agent-scoped MCPs for ${agent}. Universal MCPs are inherited from the workspace .mcp.json.",
  "mcpServers": {
${entries.join(',\n')}
  }
}
`;
}

export function renderClaudeSettings(agent: string): string {
  return `{
  "_comment": "Agent-scoped Claude Code settings for ${agent}. Inherits universal settings from the workspace .claude/settings.json."
}
`;
}

export function renderSubagentTemplate(): string {
  return `# <Subagent> Subagent

## Role

<One-sentence description of what this subagent does and what it returns.>

## Inputs

- <field> (type): <description>

## Output

<Schema or example of the subagent's return shape.>

## Tools

<List the tools/MCPs this subagent uses, or "None" for pure-reasoning subagents.>

## Boundaries

- <What this subagent must NOT do.>

## Quality bar

<Acceptance criteria — what makes a result good enough to ship.>
`;
}

export function renderSubagent(s: GuidedSubagent): string {
  const toolsBlock = s.tools.length === 0 ? 'None.' : s.tools.map((t) => `- ${t}`).join('\n');
  return `# ${titleCase(s.name)} Subagent

## Role

${s.role.trimEnd()}

## Inputs

${s.inputs.trimEnd()}

## Output

${s.output.trimEnd()}

## Tools

${toolsBlock}

## Boundaries

${s.boundaries.trimEnd()}

## Quality bar

${s.quality_bar.trimEnd()}
`;
}

export function renderProjectConfig(agent: string): string {
  return `---
agent: ${agent}
project: <project-slug>
created: ${STUB_DATE}
last_modified: ${STUB_DATE}
---

# ${agent} config — <project-name>

# Fill in per-project values. Required tool bindings carry TODO placeholders
# that cause the agent to error at runtime until populated.

tools: {}
`;
}

export function renderAssetReferences(): string {
  return `# Asset references

List the project assets this agent reads at runtime. One bullet per asset.
Use relative paths from the project root (e.g., \`guidelines/voice.md\`).

- <relative-path>: <one-line description>
`;
}

export function renderPlanYaml(plan: GuidedPlan): string {
  const stepLines = plan.steps.map((s) => `  - id: ${s.id}\n    title: ${s.title}`).join('\n');
  return `plan: ${plan.name}
description: |
${indentBlockScalar(plan.description, '  ')}

# Inputs schema — fill in per-invocation arguments here.
inputs: {}

# Outputs schema — what this plan returns to the caller.
outputs: {}

steps:
${stepLines}
`;
}

export function renderSlashCommand(fn: string, agent: string, description: string): string {
  // ROS-62: quote via JSON.stringify so YAML-special characters (`:`, `#`,
  // `{`, `[`, `&`, `*`, etc.) in the description don't trip the I4 YAML
  // parser. JSON.stringify produces a valid YAML double-quoted scalar.
  return `---
name: ${agent}
description: ${JSON.stringify(description)}
---

# /${agent}

Routes to the \`${fn}/${agent}/\` agent. Looks up the named plan in \`${fn}/${agent}/plans/\` and invokes it with the supplied arguments.

## Usage

\`\`\`
/${agent} run <plan> for <project>
/${agent} list-plans
/${agent} --help
\`\`\`

## What this command does

1. Reads \`${fn}/${agent}/agent.md\` to load the agent contract
2. Loads the plan yaml from \`${fn}/${agent}/plans/<plan>.yaml\`
3. Loads project context from \`projects/<project>/CLAUDE.md\` and \`projects/<project>/guidelines/\`
4. Executes the plan steps, dispatching to subagents as declared
5. Writes the run log to \`${fn}/${agent}/projects/<project>/log/runs/\`

See \`${fn}/${agent}/agent.md\` for the full orchestrator contract.
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// agent.md per-section builders
// ─────────────────────────────────────────────────────────────────────────────

export function renderAgentMd(fixture: GuidedAgentFixture): string {
  const { fn, agent, grounded, uncertain_answers } = fixture;
  return [
    `# ${titleCase(agent)} Agent\n`,
    sectionPurpose(grounded.purpose),
    sectionInputs(fn, agent, grounded.orchestrator_inputs),
    sectionSteps(grounded.steps),
    sectionSubagents(uncertain_answers.subagents),
    sectionTools(uncertain_answers.tools),
    sectionToolsAndBindings(uncertain_answers.tools),
    sectionOutputs(fn, agent, grounded.outputs_description),
    sectionApproval(),
    sectionLessonsProtocol(),
    sectionFailureModes(uncertain_answers.failure_modes),
  ].join('\n');
}

function sectionPurpose(purpose: string): string {
  return `## Purpose

${purpose.trimEnd()}
`;
}

function sectionInputs(fn: string, agent: string, orchestratorInputs: string[]): string {
  const orchestratorLines = orchestratorInputs.map((line) => `- ${indentBulletContinuation(line)}`).join('\n');
  return `## Inputs

The orchestrator (slash command or natural-language invocation) expects:

${orchestratorLines}

Read at runtime:

- \`agent.md\` (this file)
- \`${fn}/${agent}/plans/<plan>.yaml\` — workflow recipe
- \`${fn}/${agent}/projects/<project>/config/default.yaml\` — params and tool bindings
- \`projects/<project>/CLAUDE.md\` — project session context
- \`projects/<project>/guidelines/*.md\` — project substrate (voice, ICPs, do-and-don't, compliance, competitors)
- \`${fn}/${agent}/projects/<project>/asset-references.md\` — which assets this agent uses
- \`${fn}/${agent}/projects/<project>/playbook/*.md\` — project-scoped lessons
- \`${fn}/${agent}/playbook/*.md\` — global lessons
- Recent ~10 runs in \`${fn}/${agent}/projects/<project>/log/runs/\`
`;
}

function sectionSteps(steps: GuidedStep[]): string {
  const stepLines = steps
    .map((s) => `- \`${s.id}\` — **${s.title}.** ${indentBulletContinuation(s.description)}`)
    .join('\n');
  return `## Steps

${stepLines}
`;
}

function sectionSubagents(subagents: GuidedSubagent[]): string {
  if (subagents.length === 0) {
    return `## Subagents

None. This agent runs all logic inline without delegating to subagents.
`;
  }
  const lines = subagents.map((s) => `- \`${s.name}.md\` — ${indentBulletContinuation(s.role)}`).join('\n');
  return `## Subagents

${lines}
`;
}

function sectionTools(tools: GuidedTool[]): string {
  if (tools.length === 0) {
    return `## Tools

None. This agent operates without external tool bindings.
`;
  }
  const lines = tools
    .map((t) => `- \`${t.name}\` — ${indentBulletContinuation(t.description)}${t.required ? ' (required)' : ' (optional)'}`)
    .join('\n');
  return `## Tools

${lines}
`;
}

function sectionToolsAndBindings(tools: GuidedTool[]): string {
  if (tools.length === 0) {
    return `## Tools and bindings

No external tools required. This section is intentionally empty.
`;
  }
  // Invariant 3: every tool listed in ## Tools has a corresponding entry here
  // with a non-TODO required flag and a non-empty description.
  const blocks = tools.map(
    (t) => `${t.name}:
  required: ${t.required}
  description: "${t.description.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
  );
  return `## Tools and bindings

Per-project tool bindings expected by this agent. Values land in \`projects/<project>/config/default.yaml\` under a \`tools:\` key.

\`required: true\` means the agent errors at runtime if the binding is unfilled. \`required: false\` means the agent uses the binding when present and skips the related capability when absent.

\`\`\`yaml
${blocks.join('\n')}
\`\`\`
`;
}

function sectionOutputs(fn: string, agent: string, outputsDescription: string): string {
  return `## Outputs

Run file at \`${fn}/${agent}/projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md\`. Per-plan output schemas are declared in each plan's \`outputs:\` block.

${outputsDescription.trimEnd()}
`;
}

function sectionApproval(): string {
  return `## Approval

\`approval_channel: auto\` — in-session if interactive caller, Slack \`#hitl\` (or the project's configured channel) if cron-triggered. TTL: 24h. After TTL, pending items are marked expired and not actioned.

Per-run config can override:
- \`approval_channel: slack\` — always async
- \`approval_channel: session\` — always sync (fails if no session)
`;
}

function sectionLessonsProtocol(): string {
  return `## Lessons protocol

Log observations to the run's \`## Candidate lessons\` section. The dreamer reads these on its next reflection pass and promotes patterns into \`playbook/\`. Do NOT write to \`playbook/\` directly during a run — that is the dreamer's job. Hand-flagged lessons may be written outside of runs with \`source: human\` in frontmatter.
`;
}

function sectionFailureModes(projectSpecific: string[]): string {
  const standard = [
    '**Cwd not project root**: abort with the standard message',
    '**Required guideline missing or empty**: abort, request setup',
    '**Config invalid or required tool binding is TODO**: abort with schema error',
    '**Tool unavailable**: abort, surface which tool and that it should be in this agent\'s `.mcp.json`',
    '**HITL TTL expired with pending items**: log expired, do not action, surface in next session',
  ];
  const specific = projectSpecific.map((line) => `- ${indentBulletContinuation(line)}`);
  return `## Failure modes

${standard.map((line) => `- ${line}`).join('\n')}
${specific.length > 0 ? '\nProject-specific:\n\n' + specific.join('\n') + '\n' : ''}`;
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('-');
}
