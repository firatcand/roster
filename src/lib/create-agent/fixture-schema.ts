// Fixture schema for the guided agent-creation test harness (ROS-54).
//
// The fixture supplies the POST-DIALOGUE RESOLVED STATE — Phase 1 prose plus
// the result of Phase 2 classification and Phase 3 Q&A. The render function
// composes the on-disk file tree from this resolved state without invoking
// an LLM. Phase 2 classification itself is LLM-driven and out of scope for
// deterministic testing.
//
// Schema-only — no fs, no yaml parsing. The loader lives in fixture-loader.ts
// so this file remains pure (importable by render.ts without dragging in I/O).

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

function uniqueBy<T>(arr: T[], key: (item: T) => string): boolean {
  const seen = new Set<string>();
  for (const item of arr) {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

const UncertainAnswersSchema = z.object({
  subagents: z
    .array(SubagentSchema)
    .refine((arr) => uniqueBy(arr, (s) => s.name), 'subagent names must be unique'),
  tools: z
    .array(ToolSchema)
    .refine((arr) => uniqueBy(arr, (t) => t.name), 'tool names must be unique'),
  plans: z
    .array(PlanSchema)
    .refine((arr) => uniqueBy(arr, (p) => p.name), 'plan names must be unique'),
  failure_modes: z.array(NON_EMPTY),
});

export const GuidedAgentFixtureSchema = z.object({
  fn: SLUG,
  agent: SLUG,
  prose: NON_EMPTY,
  grounded: GroundedSchema.refine(
    (g) => uniqueBy(g.steps, (s) => s.id),
    'grounded.steps must have unique ids',
  ),
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

