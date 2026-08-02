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
import {
  collectCompleteWorkspaceSnapshot,
  discoverWorkspace,
  validateWorkspace,
} from '../src/lib/workspace-registry.ts';
import { resolveToolUse } from '../src/lib/workspace-tool-use.ts';

const FUNCTION_COUNT = 50;
const AGENTS_PER_FUNCTION = 10;
const OVERLAID_FUNCTION_COUNT = 5;
const WARM_READS = 50;
const P95_LIMIT_MS = 250;
const COMPLETE_VALIDATION_LIMIT_MS = 1_500;

type ToolUseScope = {
  function?: string;
  agent?: string;
  plan?: string;
};

function renderToolUseDefinition(scope: ToolUseScope, purpose: string): string {
  return YAML.stringify({
    schema_version: 2,
    id: 'search',
    scope,
    purpose,
    skill_ref: 'exa:search',
  });
}

test('seeded discovery, static plans, and complete lattice validation stay within bounded latency', { timeout: 120_000 }, (context) => {
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
      const hasFunctionOverlay = functionIndex < OVERLAID_FUNCTION_COUNT;
      writeFileSync(join(absoluteFunction, 'function.yaml'), YAML.stringify({
        schema_version: 2,
        id: functionId,
        purpose: `Purpose ${functionIndex}`,
        agents,
        guidelines: ['shared'],
        tool_uses: hasFunctionOverlay ? ['search'] : [],
      }));
      writeFileSync(
        join(absoluteFunction, 'guidelines', 'shared.md'),
        renderMarkdownDefinition('guideline', 'shared', '', { function: functionId }),
      );
      if (hasFunctionOverlay) {
        mkdirSync(join(absoluteFunction, 'tools'), { recursive: true });
        writeFileSync(
          join(absoluteFunction, 'tools', 'search.yaml'),
          renderToolUseDefinition({ function: functionId }, `Constrain search for ${functionId}.`),
        );
      }
      for (const [agentIndex, agentId] of agents.entries()) {
        const absoluteAgent = join(absoluteFunction, 'agents', agentId);
        const hasPlanOverlay = hasFunctionOverlay && agentIndex === 0;
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
            tool_uses: hasPlanOverlay ? ['search'] : [],
            artifacts: {},
            caps: {},
            steps: [{
              id: 'search',
              kind: 'tool',
              instruction: 'Use the applicable search guidance.',
              tool_use: 'search',
            }, ...(agentIndex < AGENTS_PER_FUNCTION - 1
              ? [{
                  id: 'delegate',
                  kind: 'nested-plan',
                  instruction: 'Use the next specialist plan.',
                  plan: `${functionId}/agent-${agentIndex + 1}#primary`,
                }]
              : [{ id: 'prepare', kind: 'reasoning', instruction: 'Prepare the result.' }])],
            completion: {
              artifacts: [],
              output_guidance: 'Return the completed result.',
              criteria: ['The result is complete.'],
            },
          }),
        );
        if (hasPlanOverlay) {
          mkdirSync(join(absoluteAgent, 'plans', 'primary', 'tools'), { recursive: true });
          writeFileSync(
            join(absoluteAgent, 'plans', 'primary', 'tools', 'search.yaml'),
            renderToolUseDefinition(
              { function: functionId, agent: agentId, plan: 'primary' },
              `Narrow search for ${functionId}/${agentId}#primary.`,
            ),
          );
        }
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
          renderToolUseDefinition(
            { function: functionId, agent: agentId },
            `Search for ${functionId}/${agentId}.`,
          ),
        );
        writeFileSync(
          join(absoluteAgent, 'playbook', 'lesson.md'),
          renderMarkdownDefinition('lesson', 'lesson', '', { function: functionId, agent: agentId }),
        );
      }
    }
    mkdirSync(join(root, 'tools'), { recursive: true });
    writeFileSync(join(root, 'tools', 'search.yaml'), renderToolUseDefinition({}, 'Search public sources.'));
    writeFileSync(join(root, 'roster.yaml'), YAML.stringify({
      schema_version: 2,
      workspace_id: 'benchmark',
      functions,
      hosts: {},
      tool_uses: ['search'],
    }));
    writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());

    const expectedRecords = 3_111;
    assert.equal(FUNCTION_COUNT * (2 + AGENTS_PER_FUNCTION * 6), 3_100);
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

    const fullSnapshot = collectCompleteWorkspaceSnapshot(root);
    assert.deepEqual(validateStructuredPlans(fullSnapshot.records, undefined, fullSnapshot).diagnostics, []);
    const validationDurations: number[] = [];
    for (let iteration = 0; iteration < WARM_READS; iteration++) {
      const started = performance.now();
      const validation = validateStructuredPlans(fullSnapshot.records, undefined, fullSnapshot);
      assert.deepEqual(validation.diagnostics, []);
      validationDurations.push(performance.now() - started);
    }
    validationDurations.sort((left, right) => left - right);
    const validationP95 = validationDurations[Math.ceil(validationDurations.length * 0.95) - 1]!;
    context.diagnostic(`warm static validation p95 ${validationP95.toFixed(1)} ms`);

    const workspaceValidationStarted = performance.now();
    const workspaceValidation = validateWorkspace(root, { skipVendorSkillMap: true });
    const workspaceValidationMs = performance.now() - workspaceValidationStarted;
    context.diagnostic(`complete workspace validation ${workspaceValidationMs.toFixed(1)} ms`);
    assert.equal(workspaceValidation.ok, true, JSON.stringify(workspaceValidation.diagnostics));
    assert.equal(workspaceValidation.checks.find((check) => check.name === 'tool-use-lattice')?.status, 'pass');

    const resolverContext = { function: 'function-0', agent: 'agent-0', plan: 'primary' } as const;
    const firstResolution = resolveToolUse(fullSnapshot, resolverContext, 'search');
    assert.equal(firstResolution.effective.skill_ref, 'exa:search');
    assert.equal(firstResolution.contributors.length, 4);
    assert.deepEqual(
      firstResolution.contributors.map((entry) => entry.qualified_id),
      [
        'tools/search',
        'function-0/tools/search',
        'function-0/agent-0/tools/search',
        'function-0/agent-0#primary/tools/search',
      ],
    );
    const resolutionDurations: number[] = [];
    for (let iteration = 0; iteration < WARM_READS; iteration++) {
      const started = performance.now();
      const resolution = resolveToolUse(fullSnapshot, resolverContext, 'search');
      assert.equal(resolution.semantic_hash, firstResolution.semantic_hash);
      resolutionDurations.push(performance.now() - started);
    }
    resolutionDurations.sort((left, right) => left - right);
    const resolutionP95 = resolutionDurations[Math.ceil(resolutionDurations.length * 0.95) - 1]!;
    context.diagnostic(`dense four-level in-memory resolution p95 ${resolutionP95.toFixed(1)} ms`);
    assert.ok(p95 < P95_LIMIT_MS, `warm discovery p95 ${p95.toFixed(1)} ms exceeds ${P95_LIMIT_MS} ms`);
    assert.ok(validationP95 < P95_LIMIT_MS, `warm static validation p95 ${validationP95.toFixed(1)} ms exceeds ${P95_LIMIT_MS} ms`);
    assert.ok(
      workspaceValidationMs < COMPLETE_VALIDATION_LIMIT_MS,
      `complete workspace validation ${workspaceValidationMs.toFixed(1)} ms exceeds ${COMPLETE_VALIDATION_LIMIT_MS} ms`,
    );
    assert.ok(resolutionP95 < P95_LIMIT_MS, `dense four-level in-memory resolution p95 ${resolutionP95.toFixed(1)} ms exceeds ${P95_LIMIT_MS} ms`);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
