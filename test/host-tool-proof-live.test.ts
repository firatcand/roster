// Live-proof envelope contract: ROSTER_HOST_TOOL_PROOF_ENVELOPE_ACK=read-only-attested is the
// operator's own attestation that the residual envelope — host login, the explicitly selected
// public skill, and the host's native sandbox — enforces read-only execution. The harness passes
// the strictest native noninteractive flags each CLI offers, but it cannot prove the host honors
// them; without the attestation an enabled gate fails closed before any spawn.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from '../src/lib/context-args.ts';
import { getPackageVersion } from '../src/lib/paths.ts';
import {
  installV2ProjectActivation,
  renderRosterBootstrap,
} from '../src/lib/generated-artifacts.ts';
import { VENDOR_SKILL_MAP_PATH } from '../src/lib/vendor-skills/adapter-map.ts';
import { isCanonicalSkillRef } from '../src/lib/vendor-skills/skill-ref.ts';
import { resolveWorkspaceContext } from '../src/lib/workspace-context.ts';
import { prepareVendorSkillMap, scaffoldWorkspace } from '../src/lib/workspace-registry.ts';

type LiveHost = 'claude' | 'codex';

const HOST_GATES: Record<LiveHost, string> = {
  claude: 'ROSTER_CLAUDE_HOST_TOOL_PROOF',
  codex: 'ROSTER_CODEX_HOST_TOOL_PROOF',
};
const SKILL_REF_VARIABLE = 'ROSTER_HOST_TOOL_PROOF_SKILL_REF';
const ENVELOPE_ACK_VARIABLE = 'ROSTER_HOST_TOOL_PROOF_ENVELOPE_ACK';
const ENVELOPE_ACK_VALUE = 'read-only-attested';

const CHILD_ENV_ALLOWLIST: readonly string[] = [
  'HOME',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  HOST_GATES.claude,
  HOST_GATES.codex,
  SKILL_REF_VARIABLE,
  ENVELOPE_ACK_VARIABLE,
];

type LiveEnv = Record<string, string | undefined>;

type LiveBinding = {
  nonce: string;
  skill_ref: string;
  tool_use: string;
};

type LiveSpawnOptions = {
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxBuffer: number;
  binding: LiveBinding;
};

type LiveSpawnResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

type LiveSpawn = (command: string, args: readonly string[], options: LiveSpawnOptions) => LiveSpawnResult;

type LiveSummary = {
  guidance_resolved: boolean;
  skill_loaded: boolean;
  result_count: number;
};

type LiveOutcome =
  | { performed: false; reason: 'gate-disabled' }
  | ({ performed: true; host: LiveHost; roster_version: string } & LiveSummary);

const CLAUDE_TOOL_SET = 'Bash,Glob,Grep,Read,Skill';
const CLAUDE_ALLOWED_TOOLS = 'Read,Glob,Grep,Skill,Bash(roster discover:*),Bash(roster context:*)';

function envelopeNotEnforceable(host: LiveHost, missing: string): never {
  throw new Error(
    `The installed ${host} CLI does not offer the required read-only restriction surface (${missing}); `
    + 'the smoke stays not performed — envelope not enforceable with installed CLI version.',
  );
}

function claudeEnvelopeArgs(helpText: string): string[] {
  if (!/--tools <tools\.\.\.>/.test(helpText)) envelopeNotEnforceable('claude', '--tools');
  if (!helpText.includes('--strict-mcp-config')) envelopeNotEnforceable('claude', '--strict-mcp-config');
  if (!helpText.includes('--allowed-tools')) envelopeNotEnforceable('claude', '--allowed-tools');
  const choicesMatch = /--permission-mode <mode>[\s\S]{0,400}?\(choices:([\s\S]*?)\)/.exec(helpText);
  const choices = (choicesMatch?.[1] ?? '')
    .split(',')
    .map((choice) => choice.replace(/["\s]/g, ''));
  return [
    '-p',
    '--model',
    'haiku',
    '--output-format',
    'text',
    ...(choices.includes('manual') ? ['--permission-mode', 'manual'] : []),
    '--strict-mcp-config',
    '--tools',
    CLAUDE_TOOL_SET,
    '--allowed-tools',
    CLAUDE_ALLOWED_TOOLS,
  ];
}

function codexEnvelopeArgs(helpText: string): string[] {
  if (!helpText.includes('--sandbox')) envelopeNotEnforceable('codex', '--sandbox read-only');
  if (!helpText.includes('--skip-git-repo-check')) envelopeNotEnforceable('codex', '--skip-git-repo-check');
  if (!helpText.includes('--output-last-message')) envelopeNotEnforceable('codex', '--output-last-message');
  return [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '-c',
    'mcp_servers={}',
    ...(helpText.includes('--ignore-user-config') ? ['--ignore-user-config'] : []),
    ...(helpText.includes('--ignore-rules') ? ['--ignore-rules'] : []),
    '--color',
    'never',
  ];
}

const realSpawn: LiveSpawn = (command, args, options) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};

function buildChildEnv(parent: LiveEnv): Record<string, string> {
  const child: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = parent[key];
    if (typeof value === 'string') child[key] = value;
  }
  return child;
}

function at(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'));
}

function boundedExcerpt(text: string): string {
  return text.slice(0, 400).replace(/\s+/g, ' ').trim();
}

function assertWorktreeRosterBinary(): string {
  const rosterBin = resolve('bin/roster.js');
  if (!existsSync(rosterBin)) {
    throw new Error('The live proof exercises this worktree build; run pnpm build before enabling the gates.');
  }
  const version = spawnSync(process.execPath, [rosterBin, '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 64 * 1024,
  });
  if (version.status !== 0 || version.stdout.trim() !== getPackageVersion()) {
    throw new Error(
      'bin/roster.js does not report this worktree package.json version; rebuild with pnpm build before enabling the gates.',
    );
  }
  return rosterBin;
}

function buildLiveWorkspace(parent: string, skillRef: string): string {
  const root = join(parent, 'workspace');
  mkdirSync(root);
  writeFileSync(join(root, 'roster.yaml'), [
    'schema_version: 2',
    'workspace_id: host-tool-proof-live',
    'tool_uses: []',
    'functions: {}',
    'hosts: {}',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'ROSTER.md'), renderRosterBootstrap());
  scaffoldWorkspace(root, { kind: 'function', id: 'proof' });
  scaffoldWorkspace(root, { kind: 'agent', id: 'operator', scope: 'function:proof' });
  scaffoldWorkspace(root, {
    kind: 'plan',
    id: 'public-read',
    scope: 'agent:proof/operator',
    purpose: 'Prove one harmless host-executed public read through authored tool guidance.',
  });
  const scaffolded = scaffoldWorkspace(root, {
    kind: 'tool-use',
    id: 'public-lookup',
    scope: 'agent:proof/operator',
    purpose: 'Perform one harmless, public, read-only lookup through the selected skill.',
  });
  writeFileSync(at(root, scaffolded.record.path), YAML.stringify({
    schema_version: 2,
    id: 'public-lookup',
    scope: { function: 'proof', agent: 'operator' },
    purpose: 'Perform one harmless, public, read-only lookup through the selected skill.',
    skill_ref: skillRef,
    when: ['proving provider-neutral host tool use'],
    rules: ['use only harmless public input', 'never perform any write or mutation'],
    how: ['perform exactly one read-only request', 'reply with a bounded JSON summary only'],
    effects: { allowed: ['external-read'] },
    approval: { requirement: 'none', guidance: [] },
  }));
  writeFileSync(at(root, 'functions/proof/agents/operator/plans/public-read.yaml'), YAML.stringify({
    schema_version: 2,
    id: 'public-read',
    agent: 'proof/operator',
    purpose: 'Prove one harmless host-executed public read through authored tool guidance.',
    inputs: {},
    brain_selectors: {},
    guidelines: [],
    tool_uses: [],
    artifacts: {},
    caps: {},
    steps: [{
      id: 'invoke',
      kind: 'tool',
      instruction: 'Perform one harmless read-only request through the referenced tool guidance.',
      tool_use: 'public-lookup',
    }],
    completion: {
      artifacts: [],
      output_guidance: 'Reply with the bounded JSON proof summary only.',
      criteria: ['Exactly one read-only request was performed.'],
    },
  }));
  return root;
}

function parseFinalJsonSummary(output: string, binding: LiveBinding): LiveSummary {
  if (output.length > 65_536) {
    throw new Error('The live proof produced more output than its bound; nothing was parsed.');
  }
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    throw new Error('The live proof produced no output; expected one bounded JSON summary line.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    throw new Error('The live proof must end with the single bounded JSON summary line and no trailing output.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The live proof summary is not a JSON object.');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'guidance_resolved,nonce,result_count,skill_loaded,skill_ref,tool_use') {
    throw new Error('The live proof summary must carry exactly guidance_resolved, skill_loaded, result_count, nonce, skill_ref, and tool_use.');
  }
  if (typeof record['guidance_resolved'] !== 'boolean' || typeof record['skill_loaded'] !== 'boolean') {
    throw new Error('The live proof summary flags must be booleans.');
  }
  if (!Number.isSafeInteger(record['result_count']) || (record['result_count'] as number) < 1) {
    throw new Error('The live proof summary must report the exact positive result count of its single read.');
  }
  if (record['nonce'] !== binding.nonce) {
    throw new Error('The live proof summary did not echo this run\'s proof nonce.');
  }
  if (record['skill_ref'] !== binding.skill_ref || record['tool_use'] !== binding.tool_use) {
    throw new Error('The live proof summary identity does not match the workspace-recomputed skill_ref and tool-use fragment identity.');
  }
  return {
    guidance_resolved: record['guidance_resolved'],
    skill_loaded: record['skill_loaded'],
    result_count: record['result_count'] as number,
  };
}

function runLiveHostToolProof(options: { host: LiveHost; env: LiveEnv; spawn: LiveSpawn }): LiveOutcome {
  const { host, env, spawn } = options;
  if (env[HOST_GATES[host]] !== '1') return { performed: false, reason: 'gate-disabled' };
  if (env[ENVELOPE_ACK_VARIABLE] !== ENVELOPE_ACK_VALUE) {
    throw new Error(
      `${HOST_GATES[host]}=1 also requires ${ENVELOPE_ACK_VARIABLE}=${ENVELOPE_ACK_VALUE}: the operator must `
      + 'themselves attest that host login, the selected public skill, and the native sandbox enforce '
      + 'read-only execution. Without that attestation the smoke stays not performed and nothing is spawned.',
    );
  }
  const skillRef = env[SKILL_REF_VARIABLE];
  if (!isCanonicalSkillRef(skillRef)) {
    throw new Error(
      `${HOST_GATES[host]}=1 requires ${SKILL_REF_VARIABLE} to name one explicitly selected public skill `
      + 'as a canonical package:skill identity before any workspace bytes are written or a host is launched.',
    );
  }
  const rosterBin = assertWorktreeRosterBinary();
  const temporary = mkdtempSync(join(tmpdir(), `roster-host-tool-proof-live-${host}-`));
  try {
    const root = buildLiveWorkspace(temporary, skillRef);
    const installed = installV2ProjectActivation({ root, host });
    if (!installed.ok) {
      throw new Error(`Generating the ${host} activation for the live proof workspace failed; run roster doctor there.`);
    }
    const prepared = prepareVendorSkillMap(root);
    const mapPath = at(root, VENDOR_SKILL_MAP_PATH);
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, prepared.content);
    const bundle = resolveWorkspaceContext({
      root,
      target: 'proof/operator#public-read',
      query: 'perform one harmless public read-only proof lookup',
      stepHint: null,
      budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
      explain: false,
    });
    const toolFragment = bundle.tool_uses.find((entry) => entry.content.effective.id === 'public-lookup');
    const skillEntry = bundle.skill_refs.find((entry) => entry.content.skill_ref === skillRef);
    if (toolFragment === undefined || skillEntry === undefined) {
      throw new Error('The live proof workspace did not resolve its own tool guidance; nothing was launched.');
    }
    const binding: LiveBinding = {
      nonce: randomBytes(16).toString('hex'),
      skill_ref: skillRef,
      tool_use: toolFragment.fragment_id,
    };
    const shimDirectory = join(temporary, 'bin');
    mkdirSync(shimDirectory);
    writeFileSync(
      join(shimDirectory, 'roster'),
      `#!/bin/sh\nexec "${process.execPath}" "${rosterBin}" "$@"\n`,
      { mode: 0o755 },
    );
    const childEnv = buildChildEnv(env);
    childEnv['PATH'] = childEnv['PATH'] === undefined
      ? shimDirectory
      : `${shimDirectory}${delimiter}${childEnv['PATH']}`;
    const prompt = [
      'This workspace uses Roster; the roster CLI is on PATH. Follow the Roster activation and ROSTER.md lifecycle:',
      'resolve the context bundle for proof/operator#public-read with roster context and a harmless public query,',
      'load the referenced public skill through your own native skill support,',
      'and perform exactly one harmless, public, read-only request derived from the authored tool guidance.',
      'Perform no write, no mutation, and no private access.',
      `Proof nonce: ${binding.nonce}.`,
      'Then reply with only one single-line JSON object of exactly',
      '{"guidance_resolved":<boolean>,"skill_loaded":<boolean>,"result_count":<integer>,"nonce":<the proof nonce>,',
      '"skill_ref":<the skill_refs entry skill_ref from the roster context JSON>,',
      '"tool_use":<the tool-use fragment_id from the roster context JSON>}',
      'and no other text before or after it.',
    ].join(' ');
    const spawnOptions: LiveSpawnOptions = {
      cwd: root,
      env: childEnv,
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
      binding,
    };
    const help = spawn(host, host === 'claude' ? ['--help'] : ['exec', '--help'], {
      ...spawnOptions,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
    if (help.status !== 0) {
      throw new Error(
        `The installed ${host} CLI could not report its capabilities; verify the logged-in CLI, then rerun once. `
        + `stderr: ${boundedExcerpt(help.stderr)}`,
      );
    }
    let summarySource: string;
    if (host === 'claude') {
      const result = spawn('claude', [...claudeEnvelopeArgs(help.stdout), prompt], spawnOptions);
      if (result.status !== 0) {
        throw new Error(
          'The enabled Claude live proof could not run; verify the logged-in claude CLI and the selected skill, '
          + `then rerun once. stderr: ${boundedExcerpt(result.stderr)}`,
        );
      }
      summarySource = result.stdout;
    } else {
      const outputPath = join(temporary, 'last-message.txt');
      const result = spawn(
        'codex',
        [...codexEnvelopeArgs(help.stdout), '-o', outputPath, prompt],
        spawnOptions,
      );
      if (result.status !== 0) {
        throw new Error(
          'The enabled Codex live proof could not run; verify the logged-in codex CLI and the selected skill, '
          + `then rerun once. stderr: ${boundedExcerpt(result.stderr)}`,
        );
      }
      summarySource = readFileSync(outputPath, 'utf8');
    }
    return {
      performed: true,
      host,
      roster_version: getPackageVersion(),
      ...parseFinalJsonSummary(summarySource, binding),
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function summaryLineFor(binding: LiveBinding, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    guidance_resolved: true,
    skill_loaded: true,
    result_count: 1,
    nonce: binding.nonce,
    skill_ref: binding.skill_ref,
    tool_use: binding.tool_use,
    ...overrides,
  })}\n`;
}

const CLAUDE_HELP_FIXTURE = [
  '  --allowedTools, --allowed-tools <tools...>',
  '  --permission-mode <mode>              Permission mode to use for the session',
  '                                        (choices: "acceptEdits", "auto",',
  '                                        "bypassPermissions", "manual",',
  '                                        "dontAsk", "plan")',
  '  --strict-mcp-config                   Only use MCP servers from --mcp-config,',
  '  --tools <tools...>                    Specify the list of available tools from',
  '                                        the built-in set.',
].join('\n');

const CODEX_HELP_FIXTURE = [
  '  -c, --config <key=value>',
  '  -s, --sandbox <SANDBOX_MODE>',
  '          [possible values: read-only, workspace-write, danger-full-access]',
  '      --dangerously-bypass-approvals-and-sandbox',
  '      --skip-git-repo-check',
  '      --ignore-user-config',
  '      --ignore-rules',
  '      --color <COLOR>',
  '  -o, --output-last-message <FILE>',
].join('\n');

const EXPECTED_CLAUDE_ENVELOPE = [
  '-p',
  '--model',
  'haiku',
  '--output-format',
  'text',
  '--permission-mode',
  'manual',
  '--strict-mcp-config',
  '--tools',
  CLAUDE_TOOL_SET,
  '--allowed-tools',
  CLAUDE_ALLOWED_TOOLS,
];

const EXPECTED_CODEX_ENVELOPE = [
  'exec',
  '--skip-git-repo-check',
  '--sandbox',
  'read-only',
  '-c',
  'mcp_servers={}',
  '--ignore-user-config',
  '--ignore-rules',
  '--color',
  'never',
];

type RecordedCall = { command: string; args: readonly string[]; options: LiveSpawnOptions };

function hostStub(
  host: LiveHost,
  calls: RecordedCall[],
  respond: (options: LiveSpawnOptions, args: readonly string[]) => LiveSpawnResult,
  helpText?: string,
): LiveSpawn {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('--help')) {
      return {
        status: 0,
        stdout: helpText ?? (host === 'claude' ? CLAUDE_HELP_FIXTURE : CODEX_HELP_FIXTURE),
        stderr: '',
      };
    }
    return respond(options, args);
  };
}

function assertSafeEnvelope(args: readonly string[]): void {
  args.forEach((token, index) => {
    if (index === args.length - 1) return;
    assert.doesNotMatch(token, /danger/i, token);
    assert.doesNotMatch(token, /bypass/i, token);
    if (token === '-c' || token === '--config') assert.equal(args[index + 1], 'mcp_servers={}');
    if (token === '--sandbox' || token === '-s') assert.equal(args[index + 1], 'read-only');
    if (token === '--permission-mode') assert.equal(args[index + 1], 'manual');
  });
}

test('default environment stops both live proofs before any spawn', () => {
  for (const host of ['claude', 'codex'] as const) {
    const calls: string[] = [];
    const outcome = runLiveHostToolProof({
      host,
      env: {},
      spawn: (command) => {
        calls.push(command);
        throw new Error('spawn must never be reached');
      },
    });
    assert.deepEqual(outcome, { performed: false, reason: 'gate-disabled' });
    assert.deepEqual(calls, []);
  }
});

test('an enabled gate without the read-only envelope attestation fails once before any spawn', () => {
  for (const host of ['claude', 'codex'] as const) {
    for (const env of [
      { [HOST_GATES[host]]: '1' },
      { [HOST_GATES[host]]: '1', [ENVELOPE_ACK_VARIABLE]: 'yes' },
      { [HOST_GATES[host]]: '1', [ENVELOPE_ACK_VARIABLE]: ENVELOPE_ACK_VALUE.toUpperCase() },
    ]) {
      const calls: string[] = [];
      assert.throws(
        () => runLiveHostToolProof({
          host,
          env,
          spawn: (command) => {
            calls.push(command);
            throw new Error('spawn must never be reached');
          },
        }),
        new RegExp(ENVELOPE_ACK_VARIABLE),
      );
      assert.deepEqual(calls, []);
    }
  }
});

test('an enabled attested gate without a valid public skill identity fails once before any spawn', () => {
  for (const host of ['claude', 'codex'] as const) {
    for (const env of [
      { [HOST_GATES[host]]: '1', [ENVELOPE_ACK_VARIABLE]: ENVELOPE_ACK_VALUE },
      {
        [HOST_GATES[host]]: '1',
        [ENVELOPE_ACK_VARIABLE]: ENVELOPE_ACK_VALUE,
        [SKILL_REF_VARIABLE]: 'https://api.example.com/v1',
      },
      {
        [HOST_GATES[host]]: '1',
        [ENVELOPE_ACK_VARIABLE]: ENVELOPE_ACK_VALUE,
        [SKILL_REF_VARIABLE]: 'roster:brain',
      },
    ]) {
      const calls: string[] = [];
      assert.throws(
        () => runLiveHostToolProof({
          host,
          env,
          spawn: (command) => {
            calls.push(command);
            throw new Error('spawn must never be reached');
          },
        }),
        new RegExp(SKILL_REF_VARIABLE),
      );
      assert.deepEqual(calls, []);
    }
  }
});

test('canary secrets seeded in the parent environment never reach either spawned host', () => {
  const canaries = [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'ROSTER_OPS_URL',
    'ROSTER_OPS_ADMIN_URL',
    'ROSTER_BRAIN_URL',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'GITHUB_TOKEN',
    'SLACK_BOT_TOKEN',
    'EXA_API_KEY',
    'CONTEXT_DEV_API_KEY',
    'DATABASE_URL',
    'INFISICAL_TOKEN',
  ];
  const parent: LiveEnv = {
    HOME: join(tmpdir(), 'host-tool-proof-home'),
    PATH: '/usr/bin',
    [HOST_GATES.claude]: '1',
    [HOST_GATES.codex]: '1',
    [ENVELOPE_ACK_VARIABLE]: ENVELOPE_ACK_VALUE,
    [SKILL_REF_VARIABLE]: 'fixture-public:read',
    ...Object.fromEntries(canaries.map((key) => [key, `canary-${key.toLowerCase()}`])),
  };

  const child = buildChildEnv(parent);
  assert.equal(child['HOME'], parent['HOME']);
  assert.equal(child['PATH'], parent['PATH']);
  assert.equal(child[SKILL_REF_VARIABLE], 'fixture-public:read');
  assert.equal(child[ENVELOPE_ACK_VARIABLE], ENVELOPE_ACK_VALUE);
  for (const key of Object.keys(child)) {
    assert.equal(CHILD_ENV_ALLOWLIST.includes(key), true, key);
  }
  for (const canary of canaries) assert.equal(canary in child, false, canary);

  const assertSpawnedEnv = (env: Record<string, string>): void => {
    assert.deepEqual({ ...env, PATH: parent['PATH'] }, child);
    assert.equal(env['PATH']!.endsWith(`${delimiter}${parent['PATH']}`), true);
    assert.equal(env['PATH']!.split(delimiter)[0]!.endsWith(join('', 'bin')), true);
    for (const canary of canaries) {
      assert.equal(canary in env, false, canary);
      assert.equal(JSON.stringify(env).includes(`canary-${canary.toLowerCase()}`), false, canary);
    }
  };

  const claudeCalls: RecordedCall[] = [];
  const claudeOutcome = runLiveHostToolProof({
    host: 'claude',
    env: parent,
    spawn: hostStub('claude', claudeCalls, (options) => (
      { status: 0, stdout: summaryLineFor(options.binding), stderr: '' }
    )),
  });
  assert.equal(claudeOutcome.performed, true);
  if (!claudeOutcome.performed) assert.fail('unreachable');
  assert.equal(claudeOutcome.guidance_resolved, true);
  assert.equal(claudeOutcome.skill_loaded, true);
  assert.equal(claudeOutcome.result_count, 1);
  assert.equal(claudeOutcome.roster_version, getPackageVersion());
  assert.equal(claudeCalls.length, 2);
  assert.equal(claudeCalls[0]!.command, 'claude');
  assert.deepEqual(claudeCalls[0]!.args, ['--help']);
  const claudeProof = claudeCalls[1]!;
  assert.equal(claudeProof.command, 'claude');
  assert.deepEqual(claudeProof.args.slice(0, -1), EXPECTED_CLAUDE_ENVELOPE);
  assert.equal(
    claudeProof.args.at(-1)!.includes(`Proof nonce: ${claudeProof.options.binding.nonce}`),
    true,
  );
  assertSafeEnvelope(claudeProof.args);
  assertSpawnedEnv(claudeProof.options.env);
  assertSpawnedEnv(claudeCalls[0]!.options.env);

  const codexCalls: RecordedCall[] = [];
  const codexOutcome = runLiveHostToolProof({
    host: 'codex',
    env: parent,
    spawn: hostStub('codex', codexCalls, (options, args) => {
      writeFileSync(args[args.indexOf('-o') + 1]!, summaryLineFor(options.binding));
      return { status: 0, stdout: '', stderr: '' };
    }),
  });
  assert.equal(codexOutcome.performed, true);
  if (!codexOutcome.performed) assert.fail('unreachable');
  assert.equal(codexOutcome.result_count, 1);
  assert.equal(codexCalls.length, 2);
  assert.equal(codexCalls[0]!.command, 'codex');
  assert.deepEqual(codexCalls[0]!.args, ['exec', '--help']);
  const codexProof = codexCalls[1]!;
  assert.equal(codexProof.command, 'codex');
  assert.deepEqual(codexProof.args.slice(0, -3), EXPECTED_CODEX_ENVELOPE);
  assert.equal(codexProof.args.at(-3), '-o');
  assert.equal(codexProof.args.at(-2)!.endsWith('last-message.txt'), true);
  assert.equal(
    codexProof.args.at(-1)!.includes(`Proof nonce: ${codexProof.options.binding.nonce}`),
    true,
  );
  assertSafeEnvelope(codexProof.args);
  assertSpawnedEnv(codexProof.options.env);
});

test('a host CLI without the required restriction surface fails the enabled proof before the host launches', () => {
  const parent: LiveEnv = {
    HOME: join(tmpdir(), 'host-tool-proof-home'),
    PATH: '/usr/bin',
    [HOST_GATES.claude]: '1',
    [HOST_GATES.codex]: '1',
    [ENVELOPE_ACK_VARIABLE]: ENVELOPE_ACK_VALUE,
    [SKILL_REF_VARIABLE]: 'fixture-public:read',
  };
  const withoutRestriction: Record<LiveHost, string> = {
    claude: CLAUDE_HELP_FIXTURE.split('\n')
      .filter((line) => !line.includes('--tools <tools...>'))
      .join('\n'),
    codex: CODEX_HELP_FIXTURE.split('\n')
      .filter((line) => !line.includes('--sandbox'))
      .join('\n'),
  };
  for (const host of ['claude', 'codex'] as const) {
    const calls: RecordedCall[] = [];
    assert.throws(
      () => runLiveHostToolProof({
        host,
        env: parent,
        spawn: hostStub(host, calls, () => {
          throw new Error('the proof spawn must never be reached');
        }, withoutRestriction[host]),
      }),
      /envelope not enforceable with installed CLI version/,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, host === 'claude' ? ['--help'] : ['exec', '--help']);
  }
});

test('a host summary that breaks nonce or identity binding, or trails extra output, fails the proof', () => {
  const parent: LiveEnv = {
    HOME: join(tmpdir(), 'host-tool-proof-home'),
    PATH: '/usr/bin',
    [HOST_GATES.claude]: '1',
    [ENVELOPE_ACK_VARIABLE]: ENVELOPE_ACK_VALUE,
    [SKILL_REF_VARIABLE]: 'fixture-public:read',
  };
  const spoiled: Array<{ pattern: RegExp; stdout: (binding: LiveBinding) => string }> = [
    {
      pattern: /nonce/,
      stdout: (binding) => summaryLineFor({ ...binding, nonce: binding.nonce.split('').reverse().join('') }),
    },
    {
      pattern: /identity/,
      stdout: (binding) => summaryLineFor({ ...binding, tool_use: 'tool-use:public-lookup:sha256:0' }),
    },
    {
      pattern: /result count/,
      stdout: (binding) => summaryLineFor(binding, { result_count: 0 }),
    },
    {
      pattern: /summary/,
      stdout: (binding) => `${summaryLineFor(binding)}trailing narration after the summary\n`,
    },
  ];
  for (const variant of spoiled) {
    const calls: RecordedCall[] = [];
    assert.throws(
      () => runLiveHostToolProof({
        host: 'claude',
        env: parent,
        spawn: hostStub('claude', calls, (options) => (
          { status: 0, stdout: variant.stdout(options.binding), stderr: '' }
        )),
      }),
      variant.pattern,
    );
    assert.equal(calls.length, 2);
  }
});

// Operator attestation: the gated tests below run only when the operator sets the host gate,
// ROSTER_HOST_TOOL_PROOF_ENVELOPE_ACK=read-only-attested (their assertion that the residual
// envelope enforces read-only execution), and the selected public skill identity.
// Scope of the proof: the nonce/identity binding proves host-side context consumption and the
// launch envelope, not external execution itself — an accepted residual for an opt-in, non-CI
// smoke backed by the hermetic proof in test/host-tool-proof.test.ts.
test('LIVE: Claude Code consumes Roster tool guidance and invokes one explicitly selected public skill', {
  skip: process.env[HOST_GATES.claude] !== '1',
}, () => {
  const outcome = runLiveHostToolProof({ host: 'claude', env: process.env, spawn: realSpawn });
  assert.equal(outcome.performed, true);
  if (!outcome.performed) assert.fail('unreachable');
  assert.equal(outcome.guidance_resolved, true);
  assert.equal(outcome.skill_loaded, true);
  assert.equal(outcome.result_count >= 1, true);
  assert.equal(outcome.roster_version, getPackageVersion());
});

test('LIVE: Codex consumes Roster tool guidance and invokes one explicitly selected public skill', {
  skip: process.env[HOST_GATES.codex] !== '1',
}, () => {
  const outcome = runLiveHostToolProof({ host: 'codex', env: process.env, spawn: realSpawn });
  assert.equal(outcome.performed, true);
  if (!outcome.performed) assert.fail('unreachable');
  assert.equal(outcome.guidance_resolved, true);
  assert.equal(outcome.skill_loaded, true);
  assert.equal(outcome.result_count >= 1, true);
  assert.equal(outcome.roster_version, getPackageVersion());
});
