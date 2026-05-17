// Pure render function for guided agent creation (ROS-54).
//
// Implements skills/chief-of-staff/SKILL.md § "Generated file contracts" against
// a post-dialogue resolved fixture. Maps RelPath -> content for every file the
// guided plan would write. No fs, no process, no LLM — deterministic over fixture data.
//
// The test harness asserts byte-identical match against test/golden/content-agent/.
// scripts/update-golden.ts regenerates the golden tree from this function.

import type { GuidedAgentFixture } from './fixture-schema.ts';
import { validateStepIdsMatch } from './fixture-schema.ts';
import { agentDirs, agentFiles, slashCommandPath } from './paths.ts';
import {
  renderAgentMd,
  renderAssetReferences,
  renderClaudeSettings,
  renderMcpJson,
  renderPlanYaml,
  renderProjectConfig,
  renderReadme,
  renderSlashCommand,
  renderSubagent,
  renderSubagentTemplate,
} from './templates.ts';

export interface RenderInput {
  fixture: GuidedAgentFixture;
  // expert is the contents of <fn>/EXPERT.md, or null if absent.
  // SKILL.md uses it for shape-suggestion seeding during Phase 3; for render
  // it is informational and does not change byte output. Kept in the signature
  // so future revisions (e.g., expert-derived defaults) can adopt it without
  // a signature break.
  expert: string | null;
}

export interface RenderOutput {
  // Ordered dirs (parent-before-child) — Step 4 of SKILL.md atomic write.
  dirs: string[];
  // RelPath -> content. Insertion order matches Step 5 (canonical write order).
  files: Map<string, string>;
  // Out-of-rollback root: the slash command at .claude/commands/<agent>.md.
  // Kept separate because Step 6 of SKILL.md is a separate post-tree write.
  slashCommand: { path: string; content: string };
}

export function render(input: RenderInput): RenderOutput {
  const { fixture } = input;
  validateStepIdsMatch(fixture);

  const { fn, agent } = fixture;
  const subagentNames = fixture.uncertain_answers.subagents.map((s) => s.name);
  const planNames = fixture.uncertain_answers.plans.map((p) => p.name);

  const dirs = agentDirs(fn, agent);
  const orderedPaths = agentFiles({ fn, agent, subagentNames, planNames });

  const files = new Map<string, string>();
  for (const path of orderedPaths) {
    files.set(path, renderFileAtPath(path, fixture));
  }

  return {
    dirs,
    files,
    slashCommand: {
      path: slashCommandPath(agent),
      content: renderSlashCommand(fn, agent, fixture.slash_command.description),
    },
  };
}

function renderFileAtPath(path: string, fixture: GuidedAgentFixture): string {
  const { fn, agent } = fixture;
  const root = `${fn}/${agent}`;

  if (path === `${root}/README.md`) return renderReadme(fn, agent);
  if (path === `${root}/.mcp.json`) return renderMcpJson(agent, fixture.uncertain_answers.tools);
  if (path === `${root}/.claude/settings.json`) return renderClaudeSettings(agent);
  if (path === `${root}/subagents/_template.md`) return renderSubagentTemplate();

  if (path.startsWith(`${root}/subagents/`) && path.endsWith('.md')) {
    const name = path.slice(`${root}/subagents/`.length, -3);
    const subagent = fixture.uncertain_answers.subagents.find((s) => s.name === name);
    if (!subagent) {
      throw new Error(`render: subagent file ${path} requested but no subagent named "${name}" in fixture`);
    }
    return renderSubagent(subagent);
  }

  if (path === `${root}/plans/.gitkeep`) return '';

  if (path.startsWith(`${root}/plans/`) && path.endsWith('.yaml')) {
    const name = path.slice(`${root}/plans/`.length, -5);
    const plan = fixture.uncertain_answers.plans.find((p) => p.name === name);
    if (!plan) {
      throw new Error(`render: plan file ${path} requested but no plan named "${name}" in fixture`);
    }
    return renderPlanYaml(plan);
  }

  if (path === `${root}/projects/_template/config/default.yaml`) return renderProjectConfig(agent);
  if (path === `${root}/projects/_template/asset-references.md`) return renderAssetReferences();
  if (path.endsWith('/.gitkeep')) return '';
  // agent.md is written LAST per SKILL.md Step 5 — canonical contract.
  if (path === `${root}/agent.md`) return renderAgentMd(fixture);

  throw new Error(`render: no template for path ${path}`);
}
