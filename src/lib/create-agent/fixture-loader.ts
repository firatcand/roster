// Fixture loader for the guided agent-creation test harness. Lives in its own
// file so that fixture-schema.ts (a render-time dep transitively imported by
// render.ts) stays free of node:fs — the purity check in
// test/create-agent.guided.test.ts enforces this.

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import {
  FixtureValidationError,
  GuidedAgentFixtureSchema,
  type GuidedAgentFixture,
} from './fixture-schema.ts';

export function loadFixture(path: string): GuidedAgentFixture {
  const raw = readFileSync(path, 'utf8');
  const parsed: unknown = parseYaml(raw);
  const result = GuidedAgentFixtureSchema.safeParse(parsed);
  if (!result.success) {
    throw new FixtureValidationError(path, result.error.issues);
  }
  return result.data;
}
