import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from '../src/lib/context-args.ts';
import { detectAuthoredSecretMaterial } from '../src/lib/authored-secret-detector.ts';
import { writeLockfile } from '../src/lib/founder-skills/lockfile.ts';
import { PROJECT_SKILL_ROOTS } from '../src/lib/founder-skills/tool-targets.ts';
import {
  CLAUDE_PROJECT_INSTRUCTIONS_PATH,
  CODEX_PROJECT_INSTRUCTIONS_PATH,
  installV2ProjectActivation,
  renderRosterBootstrap,
} from '../src/lib/generated-artifacts.ts';
import {
  VENDOR_SKILL_MAP_PATH,
  hashProjectSkillForHost,
  type VendorSkillHost,
} from '../src/lib/vendor-skills/adapter-map.ts';
import { parseSkillRef } from '../src/lib/vendor-skills/skill-ref.ts';
import { isWorkspaceFailure } from '../src/lib/workspace-diagnostics.ts';
import {
  resolveWorkspaceContext,
  type WorkspaceContext,
} from '../src/lib/workspace-context.ts';
import {
  collectCompleteWorkspaceSnapshot,
  prepareVendorSkillMap,
  scaffoldWorkspace,
  validateWorkspace,
} from '../src/lib/workspace-registry.ts';
import {
  parseWorkspaceToolUseDefinition,
  resolveToolUse,
  type EffectiveWorkspaceToolUse,
} from '../src/lib/workspace-tool-use.ts';

const HOSTS = ['claude', 'codex'] as const;

type ProofRequest = Record<string, string>;

type ProofCase = {
  id: string;
  shape: 'cli-argv' | 'stdio-json-rpc';
  skill_ref: string;
  skill_dir: string;
  function: string;
  agent: string;
  plan: string;
  tool_use: string;
  purpose: string;
  when: string[];
  capabilities: string[];
  filters: string[];
  rules: string[];
  how: string[];
  output_required: string[];
  output_guidance: string[];
  effects: string[];
  evidence_required: string[];
  request: ProofRequest;
  excluded_request?: ProofRequest;
  expected_result_count: number;
};

const fixtureRoot = resolve('test/fixtures/host-tool-proof');
const PROOF_CASES = (JSON.parse(readFileSync(join(fixtureRoot, 'cases.json'), 'utf8')) as {
  cases: ProofCase[];
}).cases;

const MECHANICS_CONTENT_PATTERNS: readonly RegExp[] = [
  /\b(?:https?|wss?|ssh|ftp|sftp|grpc|stdio):\/\//i,
  /(?:^|\s)--[a-z0-9-]*(?:endpoint|url|host|port|token|key|auth|header|secret|credential|proxy)[a-z0-9-]*(?:=|\b)/i,
  /(?:^|\s)-H\s+/,
  /\bauthorization\s*:/i,
  /\bbearer\s+/i,
  /\boauth\b/i,
  /\b(?:curl|wget|npx|pipx)\s/i,
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|ai|app|cloud)\b/i,
  /\b(?:[a-z0-9-]+\.)+[a-z]{2,}:[0-9]{2,5}\b/i,
  /\blocalhost(?::[0-9]+)?\b/i,
  /\b[A-Z][A-Z0-9_]{2,}=\S/,
  /\b[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET)S?\b/,
  /\b(?:node|deno|bun)\s+\S+\.(?:mjs|cjs|js)\b/i,
  /\bauthorization\s+header\b/i,
];

type MechanicsFinding = { path: string; pattern: string };

function collectMechanicsFindings(value: unknown, path = '$'): MechanicsFinding[] {
  if (typeof value === 'string') {
    return MECHANICS_CONTENT_PATTERNS
      .filter((pattern) => pattern.test(value))
      .map((pattern) => ({ path, pattern: String(pattern) }));
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectMechanicsFindings(entry, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, entry]) => collectMechanicsFindings(entry, `${path}.${key}`));
}

const FORBIDDEN_RESOLVED_KEYS = new Set([
  'api_key',
  'apikey',
  'auth',
  'authorization',
  'base_url',
  'bearer',
  'command',
  'credential',
  'credentials',
  'endpoint',
  'endpoints',
  'password',
  'provider',
  'provider_route',
  'route',
  'secret',
  'secrets',
  'surface',
  'token',
  'transport',
  'url',
]);

function assertFailureCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => isWorkspaceFailure(error) && error.code === code);
}

function toolUseDocument(spec: ProofCase, extra: Record<string, unknown> = {}): string {
  return YAML.stringify({
    schema_version: 2,
    id: spec.tool_use,
    scope: { function: spec.function, agent: spec.agent },
    purpose: spec.purpose,
    skill_ref: spec.skill_ref,
    when: spec.when,
    capabilities: spec.capabilities,
    filters: spec.filters,
    rules: spec.rules,
    how: spec.how,
    output_expectations: { required: spec.output_required, guidance: spec.output_guidance },
    effects: { allowed: spec.effects },
    approval: { requirement: 'none', guidance: [] },
    evidence: { required: spec.evidence_required, guidance: [] },
    ...extra,
  });
}

function planDocument(spec: ProofCase): string {
  return YAML.stringify({
    schema_version: 2,
    id: spec.plan,
    agent: `${spec.function}/${spec.agent}`,
    purpose: spec.purpose,
    inputs: {},
    brain_selectors: {},
    guidelines: [],
    tool_uses: [],
    artifacts: {},
    caps: {},
    steps: [
      {
        id: 'derive',
        kind: 'reasoning',
        instruction: 'Derive request-specific tool input from the authored company guidance.',
      },
      {
        id: 'invoke',
        kind: 'tool',
        instruction: 'Invoke the referenced company tool guidance and keep only guided output fields.',
        tool_use: spec.tool_use,
      },
    ],
    completion: {
      artifacts: [],
      output_guidance: 'Return the guided result to the host.',
      criteria: ['The result carries every required output field.'],
    },
  });
}

function revisionFor(spec: ProofCase): string {
  return createHash('sha1').update(spec.skill_dir).digest('hex');
}

function at(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}

type BuildProofWorkspaceOptions = {
  materializeHosts?: boolean;
  toolUseExtras?: Record<string, Record<string, unknown>>;
};

function buildProofWorkspace(options: BuildProofWorkspaceOptions = {}): { root: string; cleanup: () => void } {
  const materializeHosts = options.materializeHosts ?? true;
  const root = mkdtempSync(join(tmpdir(), 'roster-host-tool-proof-'));
  try {
    writeFileSync(join(root, 'roster.yaml'), [
      'schema_version: 2',
      'workspace_id: host-tool-proof',
      'tool_uses: []',
      'functions: {}',
      'hosts: {}',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
    for (const spec of PROOF_CASES) {
      scaffoldWorkspace(root, { kind: 'function', id: spec.function });
      scaffoldWorkspace(root, { kind: 'agent', id: spec.agent, scope: `function:${spec.function}` });
      scaffoldWorkspace(root, {
        kind: 'plan',
        id: spec.plan,
        scope: `agent:${spec.function}/${spec.agent}`,
        purpose: spec.purpose,
      });
      const scaffolded = scaffoldWorkspace(root, {
        kind: 'tool-use',
        id: spec.tool_use,
        scope: `agent:${spec.function}/${spec.agent}`,
        purpose: spec.purpose,
      });
      writeFileSync(at(root, scaffolded.record.path), toolUseDocument(spec, options.toolUseExtras?.[spec.id] ?? {}));
      writeFileSync(
        at(root, `functions/${spec.function}/agents/${spec.agent}/plans/${spec.plan}.yaml`),
        planDocument(spec),
      );
      if (!materializeHosts) continue;
      for (const host of HOSTS) {
        cpSync(
          join(fixtureRoot, 'skills', spec.skill_dir),
          at(root, `${PROJECT_SKILL_ROOTS[host]}/${spec.skill_dir}`),
          { recursive: true },
        );
      }
    }
    if (materializeHosts) {
      const source = 'github:fixture-vendors/fixture-skills';
      writeFileSync(join(root, 'founder-skills.yaml'), YAML.stringify({
        source,
        skills: PROOF_CASES.map((spec) => ({
          name: spec.skill_dir,
          ref: revisionFor(spec),
          skill_ref: spec.skill_ref,
        })),
      }));
      writeLockfile(root, {
        version: 1,
        source,
        skills: PROOF_CASES.map((spec) => {
          const contentHashes = {
            claude: hashProjectSkillForHost({ workspaceRoot: root, host: 'claude', skillName: spec.skill_dir }).contentHash,
            codex: hashProjectSkillForHost({ workspaceRoot: root, host: 'codex', skillName: spec.skill_dir }).contentHash,
          };
          return {
            name: spec.skill_dir,
            ref: revisionFor(spec),
            contentHash: contentHashes.claude,
            contentHashes,
            tools: [...HOSTS],
            skill_ref: parseSkillRef(spec.skill_ref),
          };
        }),
      });
      for (const host of HOSTS) {
        const installed = installV2ProjectActivation({ root, host });
        assert.equal(installed.ok, true, JSON.stringify(installed.diagnostics));
      }
      const prepared = prepareVendorSkillMap(root);
      const mapPath = at(root, VENDOR_SKILL_MAP_PATH);
      mkdirSync(dirname(mapPath), { recursive: true });
      writeFileSync(mapPath, prepared.content);
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function contextRequestFor(root: string, spec: ProofCase) {
  return {
    root,
    target: `${spec.function}/${spec.agent}#${spec.plan}`,
    query: spec.request['objective']!,
    stepHint: 'The host is preparing one tool invocation.',
    budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
    explain: true,
  } as const;
}

function requiredGuidance(entries: readonly string[], pattern: RegExp): RegExpExecArray {
  for (const entry of entries) {
    const match = pattern.exec(entry);
    if (match !== null) return match;
  }
  assert.fail(`no resolved guidance entry matches ${String(pattern)}`);
}

function deriveInput(
  spec: ProofCase,
  request: ProofRequest,
  effective: EffectiveWorkspaceToolUse,
): Record<string, unknown> {
  if (spec.shape === 'cli-argv') {
    const ledger = requiredGuidance(effective.filters, /^restrict lookups to the ([a-z0-9-]+) ledger$/)[1]!;
    const excludedFlag = requiredGuidance(effective.filters, /^exclude accounts flagged ([a-z0-9-]+)$/)[1]!;
    requiredGuidance(effective.rules, /^never mutate ledger entries$/);
    requiredGuidance(effective.how, /^report balances in minor units$/);
    return {
      account_code: request['account_code'],
      ledger,
      exclude_flags: [excludedFlag],
      fields: [...effective.output_expectations.required],
    };
  }
  const collection = requiredGuidance(effective.filters, /^only include documents from the ([a-z0-9-]+) collection$/)[1]!;
  const excludedStatus = requiredGuidance(effective.filters, /^exclude ([a-z0-9-]+) documents$/)[1]!;
  const maxResults = Number(requiredGuidance(effective.how, /^return at most ([0-9]+) matches$/)[1]);
  requiredGuidance(effective.rules, /^cite every match by document identifier$/);
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'search',
    params: {
      query: request['topic'],
      collection,
      exclude_status: [excludedStatus],
      max_results: maxResults,
      fields: [...effective.output_expectations.required],
    },
  };
}

type SanitizedProvenance = {
  host: VendorSkillHost;
  skill_ref: string;
  tool_use: string;
  locator_assurance: string;
  result_count: number;
};

type DriverOutcome = {
  semantic: unknown;
  executedPath: string;
  provenance: SanitizedProvenance;
};

function runReferenceHostDriver(options: {
  root: string;
  host: VendorSkillHost;
  bundle: WorkspaceContext;
  spec: ProofCase;
  request?: ProofRequest;
}): DriverOutcome {
  const { root, host, bundle, spec } = options;
  const skillEntry = bundle.skill_refs.find((entry) => entry.content.skill_ref === spec.skill_ref);
  assert.notEqual(skillEntry, undefined);
  const locator = skillEntry!.content.hosts[host];
  assert.equal(locator?.kind, 'workspace-relative');
  if (locator?.kind !== 'workspace-relative') assert.fail('unreachable');
  assert.equal(locator.assurance, 'verified');
  const toolFragment = bundle.tool_uses.find(
    (entry) => entry.content.effective.skill_ref === spec.skill_ref,
  );
  assert.notEqual(toolFragment, undefined);
  const effective = toolFragment!.content.effective;
  const skillDirectory = at(root, locator.path);
  assert.match(readFileSync(join(skillDirectory, 'SKILL.md'), 'utf8'), /invoke\.mjs/);
  const input = deriveInput(spec, options.request ?? spec.request, effective);
  const executedPath = join(skillDirectory, 'invoke.mjs');
  const invocation = spec.shape === 'cli-argv'
    ? spawnSync(process.execPath, [executedPath, JSON.stringify(input)], {
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
    : spawnSync(process.execPath, [executedPath], {
        input: JSON.stringify(input),
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
  assert.equal(invocation.status, 0, invocation.stderr);
  const payload = JSON.parse(invocation.stdout) as Record<string, unknown>;
  let semantic: unknown;
  let resultCount: number;
  if (spec.shape === 'cli-argv') {
    const results = payload['results'];
    assert.ok(Array.isArray(results));
    semantic = payload;
    resultCount = results.length;
  } else {
    assert.equal(payload['jsonrpc'], '2.0');
    assert.equal(payload['id'], 1);
    const result = payload['result'] as { matches?: unknown } | undefined;
    assert.ok(Array.isArray(result?.matches));
    semantic = result;
    resultCount = result!.matches!.length;
  }
  return {
    semantic,
    executedPath,
    provenance: {
      host,
      skill_ref: effective.skill_ref,
      tool_use: toolFragment!.fragment_id,
      locator_assurance: locator.assurance,
      result_count: resultCount,
    },
  };
}

function semanticStrings(value: unknown, sink: string[]): string[] {
  if (typeof value === 'string' && value.length >= 3) sink.push(value);
  if (typeof value === 'number') sink.push(String(value));
  if (Array.isArray(value)) for (const entry of value) semanticStrings(entry, sink);
  else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) semanticStrings(entry, sink);
  }
  return sink;
}

function assertSanitizedProvenance(outcome: DriverOutcome, spec: ProofCase, root: string): void {
  assert.deepEqual(
    Object.keys(outcome.provenance).sort(),
    ['host', 'locator_assurance', 'result_count', 'skill_ref', 'tool_use'],
  );
  const rendered = JSON.stringify(outcome.provenance);
  const forbidden = [
    ...Object.values(spec.request),
    ...spec.filters,
    ...spec.rules,
    ...spec.how,
    ...semanticStrings(outcome.semantic, []).filter((value) => value !== String(outcome.provenance.result_count)),
    'invoke.mjs',
    process.execPath,
    '.claude/',
    '.agents/',
    root,
  ];
  for (const value of forbidden) {
    assert.equal(rendered.includes(value), false, `provenance leaks ${JSON.stringify(value)}`);
  }
  assert.deepEqual(detectAuthoredSecretMaterial(rendered), []);
}

function assertNoForbiddenKeys(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assert.equal(
      FORBIDDEN_RESOLVED_KEYS.has(key.toLowerCase()),
      false,
      `forbidden key '${key}' at ${path}`,
    );
    assertNoForbiddenKeys(entry, `${path}.${key}`);
  }
}

function filesUnder(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) files.push(...filesUnder(path));
    else files.push(path);
  }
  return files;
}

test('two fictional skills drive both host projections from one host-neutral bundle to one semantic result', () => {
  const ws = buildProofWorkspace();
  try {
    const validation = validateWorkspace(ws.root);
    assert.equal(validation.ok, true, JSON.stringify(validation.diagnostics));
    for (const path of [CLAUDE_PROJECT_INSTRUCTIONS_PATH, CODEX_PROJECT_INSTRUCTIONS_PATH]) {
      assert.equal(existsSync(at(ws.root, path)), true, path);
    }
    const snapshot = collectCompleteWorkspaceSnapshot(ws.root);
    assert.equal(PROOF_CASES.length >= 2, true);
    assert.equal(new Set(PROOF_CASES.map((spec) => spec.shape)).size >= 2, true);
    assert.equal(PROOF_CASES.some((spec) => spec.shape === 'cli-argv'), true);
    for (const spec of PROOF_CASES) {
      const resolution = resolveToolUse(
        snapshot,
        { function: spec.function, agent: spec.agent, plan: spec.plan },
        spec.tool_use,
      );
      assert.equal(resolution.effective.skill_ref, spec.skill_ref);
      assert.deepEqual(resolution.effective.filters, spec.filters);
      assert.deepEqual(resolution.effective.rules, spec.rules);
      assert.deepEqual(resolution.effective.output_expectations.required, spec.output_required);

      const request = contextRequestFor(ws.root, spec);
      const bundle = resolveWorkspaceContext(request);
      assert.deepEqual(resolveWorkspaceContext(request), bundle);

      const entry = bundle.skill_refs.find((candidate) => candidate.content.skill_ref === spec.skill_ref);
      assert.notEqual(entry, undefined);
      const claudeLocator = entry!.content.hosts.claude;
      const codexLocator = entry!.content.hosts.codex;
      assert.equal(claudeLocator?.kind, 'workspace-relative');
      assert.equal(codexLocator?.kind, 'workspace-relative');
      if (claudeLocator?.kind !== 'workspace-relative' || codexLocator?.kind !== 'workspace-relative') {
        assert.fail('unreachable');
      }
      assert.equal(claudeLocator.path, `.claude/skills/${spec.skill_dir}`);
      assert.equal(codexLocator.path, `.agents/skills/${spec.skill_dir}`);
      assert.equal(claudeLocator.assurance, 'verified');
      assert.equal(codexLocator.assurance, 'verified');
      assert.equal(claudeLocator.content_hash, codexLocator.content_hash);
      assert.equal(claudeLocator.revision_immutable, true);

      const outcomes = HOSTS.map((host) => runReferenceHostDriver({ root: ws.root, host, bundle, spec }));
      assert.deepEqual(outcomes[0]!.semantic, outcomes[1]!.semantic);
      for (const [index, host] of HOSTS.entries()) {
        const outcome = outcomes[index]!;
        assert.equal(
          outcome.executedPath,
          join(ws.root, ...PROJECT_SKILL_ROOTS[host].split('/'), spec.skill_dir, 'invoke.mjs'),
        );
        assert.equal(outcome.provenance.host, host);
        assert.equal(outcome.provenance.skill_ref, spec.skill_ref);
        assert.equal(outcome.provenance.locator_assurance, 'verified');
        assert.equal(outcome.provenance.result_count, spec.expected_result_count);
        assert.equal(outcome.provenance.tool_use.startsWith(`tool-use:${spec.tool_use}:`), true);
        assertSanitizedProvenance(outcome, spec, ws.root);
      }

      if (spec.shape === 'cli-argv') {
        assert.deepEqual(outcomes[0]!.semantic, {
          results: [{
            account_code: 'op-4210',
            balance_minor_units: 482155,
            currency: 'EUR',
            snapshot_id: 'fixture-snapshot-0007',
          }],
        });
      } else {
        const matches = (outcomes[0]!.semantic as { matches: Record<string, unknown>[] }).matches;
        assert.deepEqual(matches.map((match) => match['doc_id']), ['handbook-setup-01', 'handbook-setup-02']);
        for (const match of matches) {
          assert.deepEqual(Object.keys(match).sort(), [...spec.output_required].sort());
        }
      }

      if (spec.excluded_request !== undefined) {
        const excluded = runReferenceHostDriver({
          root: ws.root,
          host: 'claude',
          bundle,
          spec,
          request: spec.excluded_request,
        });
        assert.equal(excluded.provenance.result_count, 0);
      }

      const renderedBundle = JSON.stringify(bundle).toLowerCase();
      for (const marker of ['invoke.mjs', 'jsonrpc', 'json-rpc', 'stdio', 'cli-argv']) {
        assert.equal(renderedBundle.includes(marker), false, marker);
      }
    }
  } finally {
    ws.cleanup();
  }
});

test('the closed tool-use schema refuses provider, surface, endpoint, command, and credential fields', () => {
  const spec = PROOF_CASES[0]!;
  assert.equal(typeof parseWorkspaceToolUseDefinition(toolUseDocument(spec), 'tool.yaml').skill_ref, 'string');
  const rejectedExtensions: Record<string, unknown>[] = [
    { provider: 'fixture-vendor' },
    { surface: 'stdio-json-rpc' },
    { endpoint: 'https://api.example.com/v1/lookup' },
    { command: 'npx fixture-ledger lookup' },
    { credential: 'ledger-api-key-name' },
    { credentials: { reference: 'ambient' } },
    { api_key: 'from-environment' },
    { transport: 'stdio' },
    { base_url: 'https://api.example.com' },
    { auth: { mode: 'ambient' } },
    { scope: { function: spec.function, agent: spec.agent, provider: 'fixture-vendor' } },
    { effects: { allowed: spec.effects, endpoint: 'https://api.example.com' } },
    { approval: { requirement: 'none', credential: 'ledger-api-key-name' } },
    { output_expectations: { required: spec.output_required, command: 'render' } },
    { brain: { read: [], surface: 'mcp' } },
    { evidence: { required: [], token: 'name-only' } },
  ];
  for (const extra of rejectedExtensions) {
    assertFailureCode(
      () => parseWorkspaceToolUseDefinition(toolUseDocument(spec, extra), 'tool.yaml'),
      'UNKNOWN_FIELD',
    );
  }
  for (const value of [
    'https://api.example.com/v1',
    'stdio://fixture-docs/search',
    'npx -y fixture-docs',
    'fixture-ledger lookup --endpoint=https://api.example.com',
  ]) {
    assertFailureCode(
      () => parseWorkspaceToolUseDefinition(toolUseDocument(spec, { skill_ref: value }), 'tool.yaml'),
      'SKILL_REF_INVALID',
    );
  }
  const bearer = `Bearer ${'A1b2C3d4'.repeat(4)}`;
  assertFailureCode(
    () => parseWorkspaceToolUseDefinition(
      toolUseDocument(spec, { rules: [`send ${bearer} with every call`] }),
      'tool.yaml',
    ),
    'SECRET_MATERIAL_FORBIDDEN',
  );
});

test('resolved objects, fixture trees, and the authored workspace stay free of transport and credential material', () => {
  const ws = buildProofWorkspace();
  try {
    const snapshot = collectCompleteWorkspaceSnapshot(ws.root);
    for (const spec of PROOF_CASES) {
      const authored = parseWorkspaceToolUseDefinition(toolUseDocument(spec), 'tool.yaml');
      assert.deepEqual(collectMechanicsFindings(authored), []);
      const resolution = resolveToolUse(
        snapshot,
        { function: spec.function, agent: spec.agent, plan: spec.plan },
        spec.tool_use,
      );
      assertNoForbiddenKeys(resolution);
      assert.deepEqual(collectMechanicsFindings(resolution.effective), []);
      const bundle = resolveWorkspaceContext(contextRequestFor(ws.root, spec));
      assertNoForbiddenKeys(bundle);
      assert.deepEqual(collectMechanicsFindings(bundle.tool_uses.map((entry) => entry.content)), []);
      assert.deepEqual(collectMechanicsFindings(bundle.skill_refs.map((entry) => entry.content)), []);
      assert.deepEqual(detectAuthoredSecretMaterial(JSON.stringify(bundle)), []);
    }
    for (const file of [...filesUnder(fixtureRoot), ...filesUnder(ws.root)]) {
      assert.deepEqual(detectAuthoredSecretMaterial(readFileSync(file)), [], file);
    }
  } finally {
    ws.cleanup();
  }
});

test('the mechanics-content scan catches transport and credential vocabulary the closed schema cannot see', () => {
  const spec = PROOF_CASES[0]!;
  const poison = {
    when: [...spec.when, 'read the FIXTURE_LEDGER_KEY from the environment'],
    how: [...spec.how, 'run npx fixture-cli --endpoint https://api.example.com using ambient oauth credentials'],
    rules: [...spec.rules, 'set the authorization header before every call'],
    output_expectations: {
      required: spec.output_required,
      guidance: [...spec.output_guidance, 'export FIXTURE_API_TOKEN=value before invoking'],
    },
  };
  const poisonedDocument = toolUseDocument(spec, poison);
  const parsed = parseWorkspaceToolUseDefinition(poisonedDocument, 'tool.yaml');
  assert.equal(parsed.skill_ref, spec.skill_ref);
  const authoredFindings = collectMechanicsFindings(parsed);
  assert.equal(authoredFindings.length >= 4, true, JSON.stringify(authoredFindings));

  const ws = buildProofWorkspace({
    materializeHosts: false,
    toolUseExtras: { [spec.id]: poison },
  });
  try {
    const snapshot = collectCompleteWorkspaceSnapshot(ws.root);
    const resolution = resolveToolUse(
      snapshot,
      { function: spec.function, agent: spec.agent, plan: spec.plan },
      spec.tool_use,
    );
    const findings = collectMechanicsFindings(resolution.effective);
    assert.equal(findings.length >= 4, true, JSON.stringify(findings));
    for (const field of ['when', 'how', 'rules', 'output_expectations']) {
      assert.equal(
        findings.some((finding) => finding.path.includes(field)),
        true,
        `no finding under '${field}': ${JSON.stringify(findings)}`,
      );
    }
    const cleanSibling = PROOF_CASES[1]!;
    const cleanResolution = resolveToolUse(
      snapshot,
      { function: cleanSibling.function, agent: cleanSibling.agent, plan: cleanSibling.plan },
      cleanSibling.tool_use,
    );
    assert.deepEqual(collectMechanicsFindings(cleanResolution.effective), []);
  } finally {
    ws.cleanup();
  }
});
