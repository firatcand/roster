import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import YAML from 'yaml';
import { renderRosterBootstrap } from '../src/lib/generated-artifacts.ts';
import {
  renderChildDefinition,
  renderMarkdownDefinition,
} from '../src/lib/workspace-record.ts';
import { validateStructuredPlans } from '../src/lib/workspace-plan.ts';
import { discoverWorkspace } from '../src/lib/workspace-registry.ts';

const FUNCTION_COUNT = 50;
const AGENTS_PER_FUNCTION = 10;
const WARM_READS = 50;
const P95_LIMIT_MS = 250;

test('seeded warm discovery and static plan-validation p95 stay below 250 ms without a cache', { timeout: 120_000 }, (context) => {
  const root = mkdtempSync(join(tmpdir(), 'roster-discovery-bench-'));
  try {
    const functions: Record<string, { path: string }> = {};
    for (let functionIndex = 0; functionIndex < FUNCTION_COUNT; functionIndex++) {
      const functionId = `function-${functionIndex}`;
      const functionRoot = `functions/${functionId}`;
      functions[functionId] = { path: functionRoot };
      const absoluteFunction = join(root, 'functions', functionId);
      mkdirSync(join(absoluteFunction, 'guidelines'), { recursive: true });
      const agents = Array.from({ length: AGENTS_PER_FUNCTION }, (_, index) => `agent-${index}`);
      writeFileSync(join(absoluteFunction, 'function.yaml'), YAML.stringify({
        schema_version: 2,
        id: functionId,
        purpose: `Purpose ${functionIndex}`,
        agents,
        guidelines: ['shared'],
      }));
      writeFileSync(
        join(absoluteFunction, 'guidelines', 'shared.md'),
        renderMarkdownDefinition('guideline', 'shared', '', { function: functionId }),
      );
      for (const [agentIndex, agentId] of agents.entries()) {
        const absoluteAgent = join(absoluteFunction, 'agents', agentId);
        for (const slot of ['plans', 'subagents', 'guidelines', 'tools', 'playbook']) {
          mkdirSync(join(absoluteAgent, slot), { recursive: true });
        }
        writeFileSync(join(absoluteAgent, 'agent.yaml'), YAML.stringify({
          schema_version: 2,
          id: agentId,
          function: functionId,
          purpose: '',
          plans: ['primary'],
          subagents: ['researcher'],
          guidelines: ['review'],
          default_guidelines: [],
          tool_uses: ['search'],
          lessons: ['lesson'],
        }));
        writeFileSync(
          join(absoluteAgent, 'plans', 'primary.yaml'),
          YAML.stringify({
            schema_version: 2,
            id: 'primary',
            agent: `${functionId}/${agentId}`,
            purpose: 'Run the primary workflow.',
            inputs: {},
            brain_selectors: {},
            guidelines: [],
            artifacts: {},
            caps: {},
            steps: agentIndex < AGENTS_PER_FUNCTION - 1
              ? [{
                  id: 'delegate',
                  kind: 'nested-plan',
                  instruction: 'Use the next specialist plan.',
                  plan: `${functionId}/agent-${agentIndex + 1}#primary`,
                }]
              : [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare the result.' }],
            completion: {
              artifacts: [],
              output_guidance: 'Return the completed result.',
              criteria: ['The result is complete.'],
            },
          }),
        );
        writeFileSync(
          join(absoluteAgent, 'subagents', 'researcher.yaml'),
          renderChildDefinition('subagent', functionId, agentId, 'researcher', ''),
        );
        writeFileSync(
          join(absoluteAgent, 'guidelines', 'review.md'),
          renderMarkdownDefinition('guideline', 'review', '', { function: functionId, agent: agentId }),
        );
        writeFileSync(
          join(absoluteAgent, 'tools', 'search.yaml'),
          renderChildDefinition('tool-use', functionId, agentId, 'search', '', { function: functionId, agent: agentId }),
        );
        writeFileSync(
          join(absoluteAgent, 'playbook', 'lesson.md'),
          renderMarkdownDefinition('lesson', 'lesson', '', { function: functionId, agent: agentId }),
        );
      }
    }
    writeFileSync(join(root, 'roster.yaml'), YAML.stringify({
      schema_version: 2,
      workspace_id: 'benchmark',
      functions,
      hosts: {},
    }));
    writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());

    const expectedRecords = FUNCTION_COUNT * (2 + AGENTS_PER_FUNCTION * 6);
    assert.equal(discoverWorkspace(root).records.length, expectedRecords);
    const durations: number[] = [];
    for (let iteration = 0; iteration < WARM_READS; iteration++) {
      const started = performance.now();
      assert.equal(discoverWorkspace(root).records.length, expectedRecords);
      durations.push(performance.now() - started);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
    context.diagnostic(`warm discovery p95 ${p95.toFixed(1)} ms`);
    assert.ok(p95 < P95_LIMIT_MS, `warm discovery p95 ${p95.toFixed(1)} ms exceeds ${P95_LIMIT_MS} ms`);

    const fullSnapshot = discoverWorkspace(root, { full: true }).records;
    assert.deepEqual(validateStructuredPlans(fullSnapshot).diagnostics, []);
    const validationDurations: number[] = [];
    for (let iteration = 0; iteration < WARM_READS; iteration++) {
      const started = performance.now();
      const validation = validateStructuredPlans(fullSnapshot);
      assert.deepEqual(validation.diagnostics, []);
      validationDurations.push(performance.now() - started);
    }
    validationDurations.sort((left, right) => left - right);
    const validationP95 = validationDurations[Math.ceil(validationDurations.length * 0.95) - 1]!;
    context.diagnostic(`warm static validation p95 ${validationP95.toFixed(1)} ms`);
    assert.ok(validationP95 < P95_LIMIT_MS, `warm static validation p95 ${validationP95.toFixed(1)} ms exceeds ${P95_LIMIT_MS} ms`);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
