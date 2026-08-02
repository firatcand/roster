import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  MAX_CONTEXT_BUDGET_TOKENS,
  MAX_CONTEXT_QUERY_BYTES,
  MAX_CONTEXT_STEP_BYTES,
  MIN_CONTEXT_BUDGET_TOKENS,
  parseContextArgs,
  type ParsedContextArgs,
} from '../src/lib/context-args.ts';

type ParsedOk = Extract<ParsedContextArgs, { kind: 'ok' }>;
type ParsedError = Extract<ParsedContextArgs, { kind: 'err' }>;

function parseOk(args: readonly string[]): ParsedOk {
  const parsed = parseContextArgs(args);
  assert.equal(parsed.kind, 'ok', parsed.kind === 'err' ? parsed.message : undefined);
  return parsed as ParsedOk;
}

function parseError(args: readonly string[]): ParsedError {
  const parsed = parseContextArgs(args);
  assert.equal(parsed.kind, 'err');
  return parsed as ParsedError;
}

test('context args parse exact agent and selected-plan targets with stable defaults', () => {
  assert.deepEqual(
    parseOk(['gtm/social-manager', '--query', 'Find relevant opportunities', '--json']),
    {
      kind: 'ok',
      target: 'gtm/social-manager',
      query: 'Find relevant opportunities',
      stepHint: null,
      budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
      explain: false,
      json: true,
    },
  );

  const selected = parseOk([
    '--json',
    '--explain',
    '--step',
    'research',
    '--budget',
    String(DEFAULT_CONTEXT_BUDGET_TOKENS),
    'gtm/social-manager#opportunity-discovery',
    '--query',
    'Find relevant opportunities',
  ]);
  assert.deepEqual(selected, {
    kind: 'ok',
    target: 'gtm/social-manager#opportunity-discovery',
    query: 'Find relevant opportunities',
    stepHint: 'research',
    budgetTokens: DEFAULT_CONTEXT_BUDGET_TOKENS,
    explain: true,
    json: true,
  });
});

test('context args reject malformed, path-like, fuzzy, and alternate-scope targets', () => {
  for (const target of [
    'GTM/social-manager',
    'gtm/Social-Manager',
    'gtm/social-manager/plan',
    'gtm/social-manager#Plan',
    'gtm/social-manager#one#two',
    '../gtm/social-manager',
    'gtm/*',
    '$TARGET/social-manager',
    'tools/social-manager',
  ]) {
    const parsed = parseError([target, '--query', 'task', '--json']);
    assert.match(parsed.message, /exact lowercase/);
    assert.equal(JSON.stringify(parsed).includes(target), false);
  }

  assert.match(
    parseError(['gtm/social-manager', '--query', 'task', '--cwd', '/tmp', '--json']).message,
    /unknown argument/,
  );
});

test('context args require one target, query, and JSON and reject duplicate or malformed argv', () => {
  const cases: ReadonlyArray<readonly string[]> = [
    ['--query', 'task', '--json'],
    ['gtm/social-manager', '--json'],
    ['gtm/social-manager', '--query', 'task'],
    ['gtm/social-manager', 'extra', '--query', 'task', '--json'],
    ['gtm/social-manager', '--query', '--json'],
    ['gtm/social-manager', '--step', '--json'],
    ['gtm/social-manager', '--budget', '--json'],
    ['gtm/social-manager', '--query', 'task', '--query', 'again', '--json'],
    ['gtm/social-manager', '--query', 'task', '--step', 'one', '--step', 'two', '--json'],
    ['gtm/social-manager', '--query', 'task', '--budget', '8000', '--budget', '9000', '--json'],
    ['gtm/social-manager', '--query', 'task', '--explain', '--explain', '--json'],
    ['gtm/social-manager', '--query', 'task', '--json', '--json'],
    ['gtm/social-manager', '--query=task', '--json'],
    ['gtm/social-manager', '--query', 'task', '--unknown', '--json'],
  ];
  for (const args of cases) assert.equal(parseContextArgs(args).kind, 'err', args.join(' '));
});

test('context budget accepts only canonical base-10 safe integers inside the closed range', () => {
  assert.equal(DEFAULT_CONTEXT_BUDGET_TOKENS >= MIN_CONTEXT_BUDGET_TOKENS, true);
  assert.equal(DEFAULT_CONTEXT_BUDGET_TOKENS <= MAX_CONTEXT_BUDGET_TOKENS, true);
  for (const budget of [MIN_CONTEXT_BUDGET_TOKENS, DEFAULT_CONTEXT_BUDGET_TOKENS, MAX_CONTEXT_BUDGET_TOKENS]) {
    assert.equal(
      parseOk(['gtm/social-manager', '--query', 'task', '--budget', String(budget), '--json']).budgetTokens,
      budget,
    );
  }

  for (const budget of [
    '0',
    '-1',
    '+1',
    '1.5',
    '1e3',
    '01',
    '9007199254740992',
    String(MIN_CONTEXT_BUDGET_TOKENS - 1),
    String(MAX_CONTEXT_BUDGET_TOKENS + 1),
  ]) {
    assert.equal(
      parseContextArgs(['gtm/social-manager', '--query', 'task', '--budget', budget, '--json']).kind,
      'err',
      budget,
    );
  }
});

test('context query and step bounds use UTF-8 bytes and reject controls without echoing values', () => {
  const queryAtLimit = 'é'.repeat(MAX_CONTEXT_QUERY_BYTES / 2);
  const stepAtLimit = 'é'.repeat(MAX_CONTEXT_STEP_BYTES / 2);
  const accepted = parseOk([
    'gtm/social-manager',
    '--query',
    queryAtLimit,
    '--step',
    stepAtLimit,
    '--json',
  ]);
  assert.equal(Buffer.byteLength(accepted.query, 'utf8'), MAX_CONTEXT_QUERY_BYTES);
  assert.equal(Buffer.byteLength(accepted.stepHint!, 'utf8'), MAX_CONTEXT_STEP_BYTES);

  const queryTooLong = `secret-canary-${'x'.repeat(MAX_CONTEXT_QUERY_BYTES)}`;
  const queryError = parseError(['gtm/social-manager', '--query', queryTooLong, '--json']);
  assert.deepEqual(queryError.details, {
    field: 'query',
    observed_bytes: Buffer.byteLength(queryTooLong, 'utf8'),
    limit_bytes: MAX_CONTEXT_QUERY_BYTES,
  });
  assert.equal(JSON.stringify(queryError).includes('secret-canary'), false);

  const queryWithControl = parseError(['gtm/social-manager', '--query', 'task\u007fnext', '--json']);
  assert.deepEqual(queryWithControl.details, { field: 'query', byte_offset: 4 });

  const stepWithControl = 'secret-canary\nnext';
  const stepError = parseError([
    'gtm/social-manager',
    '--query',
    'task',
    '--step',
    stepWithControl,
    '--json',
  ]);
  assert.deepEqual(stepError.details, { field: 'step', byte_offset: 13 });
  assert.equal(JSON.stringify(stepError).includes('secret-canary'), false);
  const stepTooLong = parseError([
    'gtm/social-manager',
    '--query',
    'task',
    '--step',
    'x'.repeat(MAX_CONTEXT_STEP_BYTES + 1),
    '--json',
  ]);
  assert.deepEqual(stepTooLong.details, {
    field: 'step',
    observed_bytes: MAX_CONTEXT_STEP_BYTES + 1,
    limit_bytes: MAX_CONTEXT_STEP_BYTES,
  });
  assert.equal(parseContextArgs(['gtm/social-manager', '--query', '', '--json']).kind, 'err');
  assert.equal(parseContextArgs(['gtm/social-manager', '--query', 'task', '--step', '', '--json']).kind, 'err');
});

test('every raw invalid-argument surface is sanitized', () => {
  const canary = `sk-${'Ab9_'.repeat(8)}`;
  const failures = [
    parseError([`gtm/${canary}`, '--query', 'task', '--json']),
    parseError(['gtm/social-manager', canary, '--query', 'task', '--json']),
    parseError(['gtm/social-manager', '--query', 'task', `--${canary}`, '--json']),
    parseError(['gtm/social-manager', '--query', 'task', '--budget', canary, '--json']),
    parseError(['gtm/social-manager', '--query', `${canary}${'x'.repeat(MAX_CONTEXT_QUERY_BYTES)}`, '--json']),
    parseError(['gtm/social-manager', '--query', 'task', '--step', `${canary}\u0000`, '--json']),
  ];
  for (const failure of failures) {
    const serialized = JSON.stringify(failure);
    assert.equal(serialized.includes(canary), false);
    assert.equal(serialized.includes('Ab9_'), false);
  }
});
