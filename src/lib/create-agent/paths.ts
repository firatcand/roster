// Path layout helpers for the guided agent-creation render.
// Lists mirror the canonical order from skills/chief-of-staff/SKILL.md
// (Phase 5 Step 4 for dirs, Step 5 for files). Order matters: rollback walks
// rely on parent-before-child for dirs and creation-order for files.

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateSlug(value: string, fieldName: string): void {
  if (!SLUG_RE.test(value)) {
    throw new Error(`${fieldName} must be lowercase-kebab-case, got: ${JSON.stringify(value)}`);
  }
}

function agentRoot(fn: string, agent: string): string {
  validateSlug(fn, 'fn');
  validateSlug(agent, 'agent');
  return `${fn}/${agent}`;
}

// Ordered parent-before-child. Step 4 of SKILL.md atomic write contract.
// Does NOT include the parent <fn>/ — that must pre-exist (per SKILL.md
// invariant). The agent root <fn>/<agent>/ IS included as the first entry.
export function agentDirs(fn: string, agent: string): string[] {
  const root = agentRoot(fn, agent);
  return [
    `${root}`,
    `${root}/subagents`,
    `${root}/playbook`,
    `${root}/pending`,
    `${root}/plans`,
    `${root}/logs`,
    `${root}/logs/runs`,
    `${root}/logs/feedback`,
    `${root}/.claude`,
    `${root}/.claude/skills`,
    `${root}/.claude/plugins`,
  ];
}

// Files in canonical write order. Step 5 of SKILL.md atomic write contract.
// agent.md is LAST so any process keyed off its existence sees no agent
// or a complete one — never a half-written one.
//
// subagentNames and planNames expand to one entry each in their slots.
export interface FileOrderInput {
  fn: string;
  agent: string;
  subagentNames: string[];
  planNames: string[];
}

export function agentFiles(input: FileOrderInput): string[] {
  const { fn, agent, subagentNames, planNames } = input;
  const root = agentRoot(fn, agent);
  for (const name of subagentNames) validateSlug(name, 'subagent name');
  for (const name of planNames) validateSlug(name, 'plan name');
  return [
    `${root}/README.md`,
    `${root}/.mcp.json`,
    `${root}/.claude/settings.json`,
    `${root}/config.yaml`,
    `${root}/asset-references.md`,
    `${root}/subagents/_template.md`,
    ...subagentNames.map((name) => `${root}/subagents/${name}.md`),
    `${root}/plans/.gitkeep`,
    ...planNames.map((name) => `${root}/plans/${name}.yaml`),
    `${root}/playbook/.gitkeep`,
    `${root}/pending/.gitkeep`,
    `${root}/logs/runs/.gitkeep`,
    `${root}/logs/feedback/.gitkeep`,
    `${root}/.claude/skills/.gitkeep`,
    `${root}/.claude/plugins/.gitkeep`,
    `${root}/agent.md`,
  ];
}

// Slash command lives at repo-root, OUTSIDE the agent rollback root.
// Step 6 of SKILL.md atomic write — separately recoverable via --slash-only.
export function slashCommandPath(agent: string): string {
  validateSlug(agent, 'agent');
  return `.claude/commands/${agent}.md`;
}
