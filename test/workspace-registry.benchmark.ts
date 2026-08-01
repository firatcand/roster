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
import { discoverWorkspace } from '../src/lib/workspace-registry.ts';

const FUNCTION_COUNT = 50;
const AGENTS_PER_FUNCTION = 10;
const WARM_READS = 50;
const P95_LIMIT_MS = 250;

test('seeded warm discovery p95 stays below 250 ms without a cache', { timeout: 120_000 }, (context) => {
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
      for (const agentId of agents) {
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
          renderChildDefinition('plan', functionId, agentId, 'primary', ''),
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
