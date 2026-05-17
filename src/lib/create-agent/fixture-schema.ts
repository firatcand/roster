// Fixture schema for the guided agent-creation test harness (ROS-54).
//
// The fixture supplies the POST-DIALOGUE RESOLVED STATE — Phase 1 prose plus
// the result of Phase 2 classification and Phase 3 Q&A. The render function
// composes the on-disk file tree from this resolved state without invoking
// an LLM. Phase 2 classification itself is LLM-driven and out of scope for
// deterministic testing.
//
// Schema is the contract between fixture authors and render(). Any change to
// agent.md / subagent / plan / mcp shape goes through this file first.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const SLUG = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lowercase-kebab-case');
const NON_EMPTY = z.string().min(1);

const SlashCommandSchema = z.object({
  // Invariant 4: <= 80 chars, no '<', no 'TODO:' substring.
  description: z
    .string()
    .min(1)
    .max(80, 'slash command description must be <= 80 chars (invariant 4)')
    .refine((s) => !s.includes('<'), 'slash command description must not contain "<" (invariant 4)')
    .refine((s) => !/TODO:/.test(s), 'slash command description must not contain "TODO:" (invariant 4)'),
});

const StepSchema = z.object({
  id: SLUG,
  title: NON_EMPTY,
  description: NON_EMPTY,
});

const PlanStepSchema = z.object({
  id: SLUG,
  title: NON_EMPTY,
});

const PlanSchema = z.object({
  name: SLUG,
  description: NON_EMPTY,
  steps: z.array(PlanStepSchema).min(1),
});

const SubagentSchema = z.object({
  name: SLUG,
  role: NON_EMPTY,
  inputs: NON_EMPTY,
  output: NON_EMPTY,
  tools: z.array(NON_EMPTY),
  boundaries: NON_EMPTY,
  quality_bar: NON_EMPTY,
});

const ToolSchema = z.object({
  name: SLUG,
  required: z.boolean(),
  description: NON_EMPTY,
  mcp_url: z.string().url().optional(),
});

const GroundedSchema = z.object({
  purpose: NON_EMPTY,
  orchestrator_inputs: z.array(NON_EMPTY).min(1),
  steps: z.array(StepSchema).min(1),
  outputs_description: NON_EMPTY,
});

const UncertainAnswersSchema = z.object({
  subagents: z.array(SubagentSchema),
  tools: z.array(ToolSchema),
  plans: z.array(PlanSchema),
  failure_modes: z.array(NON_EMPTY),
});

export const GuidedAgentFixtureSchema = z.object({
  fn: SLUG,
  agent: SLUG,
  prose: NON_EMPTY,
  grounded: GroundedSchema,
  uncertain_answers: UncertainAnswersSchema,
  slash_command: SlashCommandSchema,
});

export type GuidedAgentFixture = z.infer<typeof GuidedAgentFixtureSchema>;
export type GuidedSubagent = z.infer<typeof SubagentSchema>;
export type GuidedTool = z.infer<typeof ToolSchema>;
export type GuidedPlan = z.infer<typeof PlanSchema>;
export type GuidedStep = z.infer<typeof StepSchema>;

export class FixtureValidationError extends Error {
  readonly path: string;
  readonly issues: z.ZodIssue[];
  constructor(path: string, issues: z.ZodIssue[]) {
    const summary = issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    super(`Fixture at ${path} failed validation:\n${summary}`);
    this.name = 'FixtureValidationError';
    this.path = path;
    this.issues = issues;
  }
}

export function loadFixture(path: string): GuidedAgentFixture {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = parseYaml(raw);
  const result = GuidedAgentFixtureSchema.safeParse(parsed);
  if (!result.success) {
    throw new FixtureValidationError(path, result.error.issues);
  }
  return result.data;
}

// Cross-fixture invariant: every plan step id must appear in grounded.steps.
// Enforced here (not in zod) because zod cross-field refinements get awkward.
// SKILL.md invariant 2: step ids match between agent.md and the starter plan.
export function validateStepIdsMatch(fixture: GuidedAgentFixture): void {
  const agentStepIds = new Set(fixture.grounded.steps.map((s) => s.id));
  for (const plan of fixture.uncertain_answers.plans) {
    for (const step of plan.steps) {
      if (!agentStepIds.has(step.id)) {
        throw new Error(
          `Invariant 2 (step ids match): plan "${plan.name}" references step id "${step.id}" not in grounded.steps`,
        );
      }
    }
  }
}
