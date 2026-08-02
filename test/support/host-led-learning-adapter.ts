#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from '../../src/lib/context-args.ts';
import type { SeedBrainCandidate } from '../../src/lib/workspace-context.ts';
import {
  hashSeededLearningValue,
  materializeSeededLesson,
  openSeededLearningStore,
  renderSeededCandidateMeaning,
  type SeededCandidateMeaning,
  type SeededCompletedRun,
  type SeededFeedback,
  type SeededLessonCandidate,
} from './seeded-learning-store.ts';
import { resolveSeededWorkspaceContext } from './seeded-workspace-context.ts';

const RUN_ID = 'run-opportunity-discovery-001';
const FEEDBACK_ID = 'feedback-opportunity-discovery-001';
const CANDIDATE_ID = 'candidate-opportunity-discovery-001';
const FIXTURE_STARTED_AT = '2026-08-02T09:00:00.000Z';
const FIXTURE_COMPLETED_AT = '2026-08-02T09:01:00.000Z';
const MAX_ARGUMENT_BYTES = 8 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

type Turn = 'discover' | 'approve';

type AdapterDefinition = {
  command: string;
  log_category: string;
  allowed_turns: readonly Turn[];
  required_flags: readonly string[];
  repeatable_flags: readonly string[];
};

type Contract = {
  schema_version: 1;
  fixture_id: string;
  runtime: {
    state_path: string;
    adapter_log_path: string;
    adapter_directory: string;
  };
  roster: {
    target: string;
    allowed_model_invocations: readonly {
      verb: string;
      required_argv: readonly string[];
      log_category: string;
    }[];
  };
  adapters: readonly AdapterDefinition[];
};

type ParsedArguments = {
  ordered: readonly { flag: string; value: string }[];
  values: ReadonlyMap<string, readonly string[]>;
};

function fail(message: string): never {
  throw new Error(`Roster 350 fixture adapter rejected the call: ${message}`);
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
      .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_ARGUMENT_BYTES
    && !CONTROL_CHARACTERS.test(value);
}

function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/') && rel !== '';
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}

function workspacePath(options: {
  root: string;
  relativePath: string;
  label: string;
  leaf: 'regular-file' | 'regular-file-or-missing' | 'directory';
}): string {
  if (!boundedString(options.relativePath) || isAbsolute(options.relativePath)) {
    fail(`${options.label} is not a bounded workspace-relative path`);
  }
  const root = resolve(options.root);
  const resolved = resolve(root, options.relativePath);
  if (!inside(root, resolved)) fail(`${options.label} escaped the workspace`);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('workspace root must be a non-symlink directory');
  }
  const components = relative(root, resolved).split(sep);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT'
        && index === components.length - 1
        && options.leaf === 'regular-file-or-missing') {
        return resolved;
      }
      fail(`${options.label} has a missing or unreadable path component`);
    }
    if (stat.isSymbolicLink()) fail(`${options.label} contains a symbolic link`);
    if (index < components.length - 1 && !stat.isDirectory()) {
      fail(`${options.label} has a non-directory path component`);
    }
    if (index === components.length - 1) {
      if (options.leaf === 'directory' && !stat.isDirectory()) {
        fail(`${options.label} must be a directory`);
      }
      if (options.leaf !== 'directory' && !stat.isFile()) {
        fail(`${options.label} must be a regular file`);
      }
    }
  }
  return resolved;
}

function readWorkspaceFile(root: string, relativePath: string, label: string): Buffer {
  const path = workspacePath({ root, relativePath, label, leaf: 'regular-file' });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch {
    fail(`${label} could not be opened without following symbolic links`);
  }
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) fail(`${label} must be a regular file`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const current = lstatSync(workspacePath({ root, relativePath, label, leaf: 'regular-file' }));
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.dev !== current.dev || before.ino !== current.ino) {
      fail(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function readContract(workspace: string): Contract {
  const value = JSON.parse(readWorkspaceFile(
    workspace,
    '.fixture/runtime/host-launch-contract.json',
    'contract path',
  ).toString('utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('contract is not an object');
  const record = value as Record<string, unknown>;
  if (record['schema_version'] !== 1 || typeof record['fixture_id'] !== 'string') fail('contract identity is invalid');
  if (record['runtime'] === null || typeof record['runtime'] !== 'object' || Array.isArray(record['runtime'])) {
    fail('contract runtime is invalid');
  }
  if (record['roster'] === null || typeof record['roster'] !== 'object' || Array.isArray(record['roster'])) {
    fail('contract roster is invalid');
  }
  if (!Array.isArray(record['adapters'])) fail('contract adapters are invalid');
  const contract = value as Contract;
  if (!boundedString(contract.runtime.state_path)
    || !boundedString(contract.runtime.adapter_log_path)
    || !boundedString(contract.runtime.adapter_directory)
    || !boundedString(contract.roster.target)
    || !Array.isArray(contract.roster.allowed_model_invocations)) {
    fail('contract runtime or Roster data is invalid');
  }
  const rosterVerbs = new Set<string>();
  for (const invocation of contract.roster.allowed_model_invocations) {
    if (!boundedString(invocation.verb) || !boundedString(invocation.log_category)
      || !Array.isArray(invocation.required_argv)
      || invocation.required_argv.length > 16
      || !invocation.required_argv.every(boundedString)
      || rosterVerbs.has(invocation.verb)) {
      fail('contract Roster invocation data is invalid');
    }
    rosterVerbs.add(invocation.verb);
  }
  const adapterCommands = new Set<string>();
  for (const adapter of contract.adapters) {
    if (!boundedString(adapter.command) || !boundedString(adapter.log_category)
      || !Array.isArray(adapter.allowed_turns)
      || adapter.allowed_turns.some((turn) => turn !== 'discover' && turn !== 'approve')
      || !Array.isArray(adapter.required_flags) || !adapter.required_flags.every(boundedString)
      || !Array.isArray(adapter.repeatable_flags) || !adapter.repeatable_flags.every(boundedString)
      || adapterCommands.has(adapter.command)) {
      fail('contract adapter data is invalid');
    }
    adapterCommands.add(adapter.command);
  }
  workspacePath({
    root: workspace,
    relativePath: contract.runtime.adapter_directory,
    label: 'adapter directory',
    leaf: 'directory',
  });
  return contract;
}

function parseArguments(argv: readonly string[], definition: AdapterDefinition): ParsedArguments {
  const allowed = new Set([...definition.required_flags, ...definition.repeatable_flags]);
  const values = new Map<string, string[]>();
  const ordered: { flag: string; value: string }[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || value === undefined || !allowed.has(flag) || !boundedString(value)) {
      fail(`invalid literal argv for ${definition.command}`);
    }
    const existing = values.get(flag) ?? [];
    if (existing.length > 0 && !definition.repeatable_flags.includes(flag)) {
      fail(`non-repeatable flag ${flag} was repeated`);
    }
    existing.push(value);
    values.set(flag, existing);
    ordered.push({ flag, value });
  }
  for (const flag of definition.required_flags) {
    if (!values.has(flag)) fail(`required flag ${flag} is missing`);
  }
  return { ordered, values };
}

function one(arguments_: ParsedArguments, flag: string): string {
  const values = arguments_.values.get(flag);
  if (values === undefined || values.length !== 1) fail(`${flag} must occur exactly once`);
  return values[0]!;
}

function queryProof(query: string, requestHash: string): Record<string, unknown> {
  const bytes = Buffer.byteLength(query, 'utf8');
  if (bytes === 0 || bytes > 240 || /^-/u.test(query) || CONTROL_CHARACTERS.test(query)) {
    fail('derived query is not a bounded literal');
  }
  const queryHash = sha256(query);
  if (queryHash === requestHash) fail('derived query must differ from the natural request');
  return {
    bytes,
    differs_from_request: true,
    leading_option: false,
    control_characters: false,
    query,
    query_sha256: queryHash,
  };
}

function appendLog(options: {
  workspace: string;
  contract: Contract;
  turn: Turn;
  command: string;
  category: string;
  flags: readonly string[];
  output: unknown;
  query?: Record<string, unknown>;
  challengeHash?: string;
  rosterProof?: Readonly<{
    argvHash: string;
    contractArgvHash: string;
    bundleHash: string;
  }>;
}): void {
  if (options.rosterProof !== undefined
    && (!SHA256.test(options.rosterProof.argvHash)
      || options.rosterProof.argvHash !== options.rosterProof.contractArgvHash
      || !SHA256.test(options.rosterProof.bundleHash))) {
    fail('Roster invocation proof is invalid');
  }
  const relativePath = options.contract.runtime.adapter_log_path;
  const lockRelativePath = `${relativePath}.lock`;
  const lockPath = workspacePath({
    root: options.workspace,
    relativePath: lockRelativePath,
    label: 'adapter log lock',
    leaf: 'regular-file-or-missing',
  });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let lockDescriptor: number;
  try {
    lockDescriptor = openSync(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
  } catch {
    fail('adapter log already has an active or stale writer lock');
  }
  try {
    const lockStat = fstatSync(lockDescriptor);
    if (!lockStat.isFile()) fail('adapter log lock is not a regular file');
    const path = workspacePath({
      root: options.workspace,
      relativePath,
      label: 'adapter log',
      leaf: 'regular-file-or-missing',
    });
    const lines = existsSync(path)
      ? readWorkspaceFile(options.workspace, relativePath, 'adapter log')
        .toString('utf8').split(/\r?\n/u).filter((line) => line.length > 0)
      : [];
    for (const [index, line] of lines.entries()) {
      let previous: unknown;
      try {
        previous = JSON.parse(line) as unknown;
      } catch {
        fail('adapter log contains invalid JSON');
      }
      if (previous === null || typeof previous !== 'object' || Array.isArray(previous)
        || (previous as Record<string, unknown>)['sequence'] !== index + 1) {
        fail('adapter log sequence is invalid');
      }
    }
    const record = {
      schema_version: 1,
      sequence: lines.length + 1,
      turn: options.turn,
      command: options.command,
      log_category: options.category,
      flags: [...options.flags].sort(),
      output_sha256: sha256(canonicalJson(options.output)),
      ...(options.query === undefined ? {} : { query_proof: options.query }),
      ...(options.challengeHash === undefined ? {} : { skill_challenge_sha256: options.challengeHash }),
      ...(options.rosterProof === undefined ? {} : {
        roster_invocation_status: 'prepared-bundle-success',
        roster_argv_exact: true,
        roster_argv_sha256: options.rosterProof.argvHash,
        roster_contract_argv_sha256: options.rosterProof.contractArgvHash,
        roster_bundle_sha256: options.rosterProof.bundleHash,
      }),
    };
    let logDescriptor: number;
    try {
      logDescriptor = openSync(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
        0o600,
      );
    } catch {
      fail('adapter log could not be opened without following symbolic links');
    }
    try {
      if (!fstatSync(logDescriptor).isFile()) fail('adapter log must be a regular file');
      writeFileSync(logDescriptor, `${canonicalJson(record)}\n`, { encoding: 'utf8' });
      fsyncSync(logDescriptor);
    } finally {
      closeSync(logDescriptor);
    }
    workspacePath({
      root: options.workspace,
      relativePath,
      label: 'adapter log',
      leaf: 'regular-file',
    });
  } finally {
    closeSync(lockDescriptor);
    const currentLockPath = workspacePath({
      root: options.workspace,
      relativePath: lockRelativePath,
      label: 'adapter log lock',
      leaf: 'regular-file',
    });
    const lockStat = lstatSync(currentLockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
      fail('adapter log lock changed while held');
    }
    unlinkSync(currentLockPath);
  }
}

function emit(value: unknown): never {
  writeFileSync(1, `${canonicalJson(value)}\n`, { encoding: 'utf8' });
  process.exit(0);
}

function readJson(workspace: string, relativePath: string, label: string): unknown {
  return JSON.parse(readWorkspaceFile(workspace, relativePath, label).toString('utf8')) as unknown;
}

function contextCandidates(workspace: string): readonly SeedBrainCandidate[] {
  const value = readJson(workspace, '.fixture/input/brain-evidence.json', 'Brain input');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Brain input is invalid');
  const candidates = (value as Record<string, unknown>)['candidates'];
  if (!Array.isArray(candidates)) fail('Brain candidates are invalid');
  return structuredClone(candidates) as SeedBrainCandidate[];
}

function expandedRosterArgv(
  invocation: Contract['roster']['allowed_model_invocations'][number],
  target: string,
  argv: readonly string[],
): Readonly<{ expected: readonly string[]; derivedQuery?: string }> {
  const queryIndexes = invocation.required_argv
    .map((entry, index) => entry === '$DERIVED_QUERY' ? index : -1)
    .filter((index) => index >= 0);
  if (queryIndexes.length > 1) fail('Roster contract has multiple derived-query placeholders');
  const derivedQuery = queryIndexes.length === 1 ? argv[queryIndexes[0]!] : undefined;
  if (queryIndexes.length === 1 && derivedQuery === undefined) {
    fail('Roster argv is missing its contracted derived query');
  }
  const expected = invocation.required_argv.map((entry) => {
    if (entry === '$TARGET') return target;
    if (entry === '$DERIVED_QUERY') return derivedQuery!;
    if (/^\$[A-Z][A-Z0-9_]*$/u.test(entry)) fail(`Roster contract has unsupported placeholder ${entry}`);
    return entry;
  });
  return derivedQuery === undefined ? { expected } : { expected, derivedQuery };
}

function requireContractedRosterArgv(
  invocation: Contract['roster']['allowed_model_invocations'][number],
  target: string,
  argv: readonly string[],
): Readonly<{ expected: readonly string[]; derivedQuery?: string }> {
  const contracted = expandedRosterArgv(invocation, target, argv);
  if (canonicalJson(argv) !== canonicalJson(contracted.expected)) {
    fail(`Roster ${invocation.verb} argv does not exactly match required_argv`);
  }
  return contracted;
}

export const hostLedLearningAdapterTestApi = Object.freeze({
  workspacePath,
  expandedRosterArgv,
  requireContractedRosterArgv,
  parseArguments,
  appendLog,
});

function invokePreparedRoster(options: {
  workspace: string;
  argv: readonly string[];
  verb: string;
}): Readonly<{ output: unknown; bundleHash: string }> {
  const bundleRelativePath = '.fixture/runtime/roster.js';
  const before = readWorkspaceFile(options.workspace, bundleRelativePath, 'Roster bundle');
  const bundle = workspacePath({
    root: options.workspace,
    relativePath: bundleRelativePath,
    label: 'Roster bundle',
    leaf: 'regular-file',
  });
  const result = spawnSync(process.execPath, [bundle, options.verb, ...options.argv], {
    cwd: options.workspace,
    env: {
      HOME: process.env['HOME']!,
      PATH: process.env['PATH']!,
      TMPDIR: process.env['TMPDIR']!,
      LANG: process.env['LANG']!,
      LC_ALL: process.env['LC_ALL']!,
      NO_COLOR: '1',
      CI: '1',
    },
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const after = readWorkspaceFile(options.workspace, bundleRelativePath, 'Roster bundle');
  if (sha256(before) !== sha256(after)) fail('Roster bundle changed during invocation');
  if (result.status !== 0) fail(`Roster ${options.verb} failed (${sha256(result.stderr ?? '')})`);
  try {
    return {
      output: JSON.parse(result.stdout) as unknown,
      bundleHash: sha256(after),
    };
  } catch {
    fail(`Roster ${options.verb} returned invalid JSON`);
  }
}

function localContextProjection(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('Roster context output is not an object');
  }
  const record = value as Record<string, unknown>;
  return {
    schema_version: record['schema_version'],
    workspace: record['workspace'],
    target: record['target'],
    request: record['request'],
    agent: record['agent'],
    plan: record['plan'],
    guidelines: record['guidelines'],
    lessons: record['lessons'],
    tool_uses: record['tool_uses'],
    skill_refs: record['skill_refs'],
  };
}

function runRoster(options: {
  workspace: string;
  contract: Contract;
  turn: Turn;
  argv: readonly string[];
  requestHash: string;
}): never {
  const verb = options.argv[0];
  const invocation = options.contract.roster.allowed_model_invocations.find((entry) => entry.verb === verb);
  if (invocation === undefined) fail('Roster verb is outside the launch contract');
  const contracted = requireContractedRosterArgv(
    invocation,
    options.contract.roster.target,
    options.argv.slice(1),
  );
  let output: unknown;
  let query: Record<string, unknown> | undefined;
  let rosterBundleHash: string;
  if (verb === 'discover') {
    if (contracted.derivedQuery !== undefined) fail('Roster discover contract cannot derive a query');
    const result = invokePreparedRoster({
      workspace: options.workspace,
      verb,
      argv: contracted.expected,
    });
    output = result.output;
    rosterBundleHash = result.bundleHash;
  } else if (verb === 'context') {
    const derivedQuery = contracted.derivedQuery;
    if (derivedQuery === undefined) fail('Roster context contract must contain one derived query');
    query = queryProof(derivedQuery, options.requestHash);
    const result = invokePreparedRoster({
      workspace: options.workspace,
      verb,
      argv: contracted.expected,
    });
    const realOutput = result.output;
    rosterBundleHash = result.bundleHash;
    const seededOutput = resolveSeededWorkspaceContext({
      root: options.workspace,
      request: {
        target: options.contract.roster.target,
        query: derivedQuery,
        stepHint: null,
        budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
        explain: false,
      },
      candidates: contextCandidates(options.workspace),
    });
    if (canonicalJson(localContextProjection(realOutput))
      !== canonicalJson(localContextProjection(seededOutput))) {
      fail('prepared Roster context diverged from the seeded local-policy projection');
    }
    output = seededOutput;
  } else {
    fail('Roster invocation has no fixture implementation');
  }
  appendLog({
    workspace: options.workspace,
    contract: options.contract,
    turn: options.turn,
    command: 'roster',
    category: invocation.log_category,
    flags: options.argv.filter((entry) => entry.startsWith('--')),
    output,
    query,
    rosterProof: {
      argvHash: sha256(canonicalJson(options.argv)),
      contractArgvHash: sha256(canonicalJson([invocation.verb, ...contracted.expected])),
      bundleHash: rosterBundleHash,
    },
  });
  emit(output);
}

function runAdapter(options: {
  workspace: string;
  contract: Contract;
  turn: Turn;
  command: string;
  argv: readonly string[];
  requestHash: string;
  challengeHash: string;
  host: string;
  rosterVersion: string;
}): never {
  const definition = options.contract.adapters.find((entry) => entry.command === options.command);
  if (definition === undefined || !definition.allowed_turns.includes(options.turn)) {
    fail('command is not allowed in this turn');
  }
  const parsed = parseArguments(options.argv, definition);
  const storePath = workspacePath({
    root: options.workspace,
    relativePath: options.contract.runtime.state_path,
    label: 'learning state',
    leaf: 'regular-file-or-missing',
  });
  const store = openSeededLearningStore(storePath);
  let output: unknown;
  let query: Record<string, unknown> | undefined;
  let challengeHash: string | undefined;
  switch (options.command) {
    case 'roster-350-fixture-search': {
      const derivedQuery = one(parsed, '--query');
      query = queryProof(derivedQuery, options.requestHash);
      const toolData = readJson(options.workspace, '.fixture/input/fake-search-results.json', 'tool input');
      if (toolData === null || typeof toolData !== 'object' || Array.isArray(toolData)) fail('tool input is invalid');
      output = { ...toolData, request_hash: options.requestHash };
      break;
    }
    case 'roster-350-fixture-run-record': {
      const selectedResult = one(parsed, '--selected-result');
      const toolData = readJson(options.workspace, '.fixture/input/fake-search-results.json', 'tool input');
      const results = toolData !== null && typeof toolData === 'object' && !Array.isArray(toolData)
        ? (toolData as Record<string, unknown>)['results']
        : null;
      if (toolData === null || typeof toolData !== 'object' || Array.isArray(toolData)
        || !Array.isArray(results)
        || !results.some((entry: unknown) => (
          entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          && (entry as Record<string, unknown>)['result_id'] === selectedResult
        ))) fail('selected result does not exist in the controlled corpus');
      const requestHash = one(parsed, '--request-hash');
      if (!SHA256.test(requestHash) || requestHash !== options.requestHash) fail('request hash is invalid');
      const citations = parsed.values.get('--brain-citation') ?? [];
      const record: SeededCompletedRun = {
        id: RUN_ID,
        target: options.contract.roster.target,
        request_hash: requestHash,
        host: options.host,
        roster_version: options.rosterVersion,
        started_at: FIXTURE_STARTED_AT,
        completed_at: FIXTURE_COMPLETED_AT,
        outcome: 'completed',
        selected_result_id: selectedResult,
        tool_ids: ['social-search'],
        source_ids: [...citations],
        artifact_ids: ['artifact-opportunity-shortlist-001'],
      };
      output = store.recordCompletedRun(record);
      break;
    }
    case 'roster-350-fixture-feedback-record': {
      if (one(parsed, '--run-id') !== RUN_ID || one(parsed, '--signal') !== 'useful') {
        fail('feedback must cite the controlled run with the useful signal');
      }
      const summary = 'The completed observation was marked useful for the requested workflow.';
      const record: SeededFeedback = {
        id: FEEDBACK_ID,
        run_id: RUN_ID,
        signal: 'positive',
        summary,
        summary_hash: hashSeededLearningValue(summary),
      };
      output = store.recordFeedback(record);
      break;
    }
    case 'roster-350-fixture-dream-status':
      output = store.status();
      break;
    case 'roster-350-fixture-candidate-create': {
      if (one(parsed, '--run-id') !== RUN_ID || one(parsed, '--feedback-id') !== FEEDBACK_ID) {
        fail('candidate citations do not match the controlled evidence');
      }
      const skillChallenge = one(parsed, '--skill-challenge');
      challengeHash = sha256(skillChallenge);
      if (challengeHash !== options.challengeHash) fail('Dreamer challenge does not match the attested skill');
      const status = store.status();
      if (status.status !== 'due' || status.watermark === null) fail('candidate creation is not due');
      const meaning = {
        disposition: one(parsed, '--disposition'),
        source_kind: one(parsed, '--source-kind'),
        topic_kind: one(parsed, '--topic-kind'),
        falsifier_action: one(parsed, '--falsifier-action'),
        falsifier_observation: one(parsed, '--falsifier-observation'),
      } as SeededCandidateMeaning;
      const rendered = renderSeededCandidateMeaning(meaning);
      const candidate: SeededLessonCandidate = {
        id: CANDIDATE_ID,
        lesson_id: one(parsed, '--lesson-id'),
        watermark: status.watermark,
        target: options.contract.roster.target,
        meaning,
        recommendation: rendered.recommendation,
        falsifiable_by: rendered.falsifiable_by,
        citations: { run_ids: [RUN_ID], feedback_ids: [FEEDBACK_ID] },
      };
      output = store.createCandidate(candidate);
      break;
    }
    case 'roster-350-fixture-state-show':
      output = { status: store.status(), state: store.snapshot() };
      break;
    case 'roster-350-fixture-candidate-promote': {
      const candidateId = one(parsed, '--candidate-id');
      const candidate = store.candidate(candidateId);
      if (candidate === null) fail('candidate does not exist');
      const lessonRelativePath = `functions/gtm/agents/social-manager/playbook/${candidate.record.lesson_id}.md`;
      workspacePath({
        root: options.workspace,
        relativePath: lessonRelativePath,
        label: 'lesson path',
        leaf: 'regular-file-or-missing',
      });
      const materialized = materializeSeededLesson({
        store,
        workspaceRoot: options.workspace,
        candidateId,
        expectedCandidateHash: candidate.content_hash,
        lesson: {
          id: candidate.record.lesson_id,
          purpose: 'Preserve an approved discovery qualification lesson.',
          scope: { function: 'gtm', agent: 'social-manager', plan: 'opportunity-discovery' },
          body: [
            candidate.record.recommendation,
            '',
            `Evidence: ${RUN_ID} and ${FEEDBACK_ID}.`,
            '',
            candidate.record.falsifiable_by,
          ].join('\n'),
        },
      });
      if (materialized.path !== lessonRelativePath) fail('materialized lesson path is outside its contracted scope');
      workspacePath({
        root: options.workspace,
        relativePath: materialized.path,
        label: 'materialized lesson path',
        leaf: 'regular-file',
      });
      output = materialized;
      break;
    }
    default:
      fail('adapter command has no fixture implementation');
  }
  workspacePath({
    root: options.workspace,
    relativePath: options.contract.runtime.state_path,
    label: 'learning state',
    leaf: 'regular-file-or-missing',
  });
  appendLog({
    workspace: options.workspace,
    contract: options.contract,
    turn: options.turn,
    command: options.command,
    category: definition.log_category,
    flags: parsed.ordered.map((entry) => entry.flag),
    output,
    query,
    challengeHash,
  });
  emit(output);
}

function main(): never {
  const workspace = realpathSync(process.cwd());
  const contract = readContract(workspace);
  const adapterDirectory = workspacePath({
    root: workspace,
    relativePath: contract.runtime.adapter_directory,
    label: 'adapter directory',
    leaf: 'directory',
  });
  const invokedPath = realpathSync(resolve(process.argv[1] ?? ''));
  if (!inside(adapterDirectory, invokedPath)) fail('invoked adapter escaped the adapter directory');
  workspacePath({
    root: workspace,
    relativePath: relative(workspace, invokedPath),
    label: 'invoked adapter',
    leaf: 'regular-file',
  });
  const invokedName = basename(process.argv[1] ?? '');
  const command = invokedName === 'host-led-learning-adapter.js'
    ? process.argv[2] ?? ''
    : invokedName;
  const argv = invokedName === 'host-led-learning-adapter.js' ? process.argv.slice(3) : process.argv.slice(2);
  const turn = process.env['ROSTER_350_TURN'];
  const host = process.env['ROSTER_350_HOST'];
  const requestHash = process.env['ROSTER_350_REQUEST_SHA256'];
  const challengeHash = process.env['ROSTER_350_DREAMER_CHALLENGE_SHA256'];
  const rosterVersion = process.env['ROSTER_350_ROSTER_VERSION'];
  if ((turn !== 'discover' && turn !== 'approve') || !boundedString(host)
    || !SHA256.test(requestHash ?? '') || !SHA256.test(challengeHash ?? '')
    || !boundedString(rosterVersion)) fail('controlled runtime environment is incomplete');
  if (command === 'roster') {
    return runRoster({ workspace, contract, turn, argv, requestHash: requestHash! });
  }
  return runAdapter({
    workspace,
    contract,
    turn,
    command,
    argv,
    requestHash: requestHash!,
    challengeHash: challengeHash!,
    host: host!,
    rosterVersion: rosterVersion!,
  });
}

if (process.env['ROSTER_350_TURN'] !== undefined
  || (process.argv[1] !== undefined
    && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]))) {
  try {
    main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown adapter failure';
    process.stderr.write(`${detail}\n`);
    process.exit(1);
  }
}
