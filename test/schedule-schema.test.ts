import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULES_YAML_VERSION,
  scheduleFileSchema,
  scheduleEntrySchema,
  validateCronExpression,
  findDuplicateNames,
  flattenZodErrors,
} from '../src/lib/schedule-schema.ts';

const minimalEntry = {
  name: 'cold-outreach-daily',
  agent: 'sdr',
  plan: 'cold-outreach',
  cron: '0 9 * * 1-5',
  tool: 'codex',
  install_mode: 'via-cron',
  status: 'installed',
};

const fullEntry = {
  ...minimalEntry,
  timezone: 'America/New_York',
  max_duration_minutes: 30,
  hitl_routing: 'roster/gtm/pending/',
  retry_policy: { max_attempts: 2, backoff_seconds: 300 },
};

test('schedule schema — minimal entry validates', () => {
  const parsed = scheduleEntrySchema.safeParse(minimalEntry);
  assert.equal(parsed.success, true);
});

test('schedule schema — full entry with optionals validates', () => {
  const parsed = scheduleEntrySchema.safeParse(fullEntry);
  assert.equal(parsed.success, true);
});

test('schedule schema — version field at file root required', () => {
  const file = { schedules: [minimalEntry] };
  const parsed = scheduleFileSchema.safeParse(file);
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const errs = flattenZodErrors(parsed.error);
    assert.ok(errs.some((e) => e.path === 'version'), `expected version error, got ${JSON.stringify(errs)}`);
  }
});

test('schedule schema — wrong version number rejected', () => {
  const file = { version: 99, schedules: [minimalEntry] };
  const parsed = scheduleFileSchema.safeParse(file);
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const errs = flattenZodErrors(parsed.error);
    assert.ok(errs.some((e) => e.message.includes('unsupported schema version')));
  }
});

test('schedule schema — current version constant is 1', () => {
  assert.equal(SCHEDULES_YAML_VERSION, 1);
});

test('schedule schema — empty schedules array is OK', () => {
  const file = { version: 1, schedules: [] };
  const parsed = scheduleFileSchema.safeParse(file);
  assert.equal(parsed.success, true);
});

test('schedule schema — missing required field surfaces field-level error', () => {
  for (const field of ['name', 'agent', 'plan', 'cron', 'tool', 'install_mode', 'status'] as const) {
    const { [field]: _, ...rest } = minimalEntry;
    const parsed = scheduleEntrySchema.safeParse(rest);
    assert.equal(parsed.success, false, `expected ${field} to be required`);
    if (!parsed.success) {
      const errs = flattenZodErrors(parsed.error);
      assert.ok(errs.some((e) => e.path === field), `expected error path '${field}' in ${JSON.stringify(errs)}`);
    }
  }
});

test('schedule schema — status enum accepts pending-ui-install and installed', () => {
  for (const status of ['pending-ui-install', 'installed'] as const) {
    const parsed = scheduleEntrySchema.safeParse({ ...minimalEntry, status });
    assert.equal(parsed.success, true, `expected status='${status}' to be accepted`);
  }
});

test('schedule schema — cron leading/trailing whitespace is trimmed on parse', () => {
  const parsed = scheduleEntrySchema.safeParse({ ...minimalEntry, cron: '  0 9 * * 1-5  ' });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.cron, '0 9 * * 1-5', 'cron should be trimmed in output');
  }
});

test('schedule schema — status enum rejects invalid value', () => {
  const parsed = scheduleEntrySchema.safeParse({ ...minimalEntry, status: 'bogus' });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const errs = flattenZodErrors(parsed.error);
    assert.ok(errs.some((e) => e.message.includes("must be one of 'pending-ui-install' | 'installed'")));
  }
});

test('schedule schema — tool enum rejects invalid value', () => {
  const parsed = scheduleEntrySchema.safeParse({ ...minimalEntry, tool: 'gemini' });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const errs = flattenZodErrors(parsed.error);
    assert.ok(errs.some((e) => e.message.includes("must be one of 'claude' | 'codex'")));
  }
});

test('schedule schema — install_mode enum rejects invalid value', () => {
  const parsed = scheduleEntrySchema.safeParse({ ...minimalEntry, install_mode: 'magic' });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const errs = flattenZodErrors(parsed.error);
    assert.ok(errs.some((e) => e.message.includes('install_mode')));
  }
});

test('schedule schema — name must be kebab-case', () => {
  const parsed = scheduleEntrySchema.safeParse({ ...minimalEntry, name: 'Foo_Bar' });
  assert.equal(parsed.success, false);
  if (!parsed.success) {
    const errs = flattenZodErrors(parsed.error);
    assert.ok(errs.some((e) => e.path === 'name' && e.message.includes('kebab-case')));
  }
});

test('schedule schema — invalid IANA timezone rejected', () => {
  const parsed = scheduleEntrySchema.safeParse({ ...fullEntry, timezone: 'Foo/Bar' });
  assert.equal(parsed.success, false);
});

test('schedule schema — max_duration_minutes out of range', () => {
  for (const bad of [0, -1, 1441]) {
    const parsed = scheduleEntrySchema.safeParse({ ...fullEntry, max_duration_minutes: bad });
    assert.equal(parsed.success, false, `expected ${bad} to be rejected`);
  }
});

test('schedule schema — hitl_routing must start with roster/', () => {
  const parsed = scheduleEntrySchema.safeParse({ ...fullEntry, hitl_routing: 'pending/' });
  assert.equal(parsed.success, false);
});

test('schedule schema — retry_policy bounds enforced', () => {
  for (const bad of [
    { max_attempts: 0, backoff_seconds: 0 },
    { max_attempts: 6, backoff_seconds: 0 },
    { max_attempts: 1, backoff_seconds: -1 },
    { max_attempts: 1, backoff_seconds: 3601 },
  ]) {
    const parsed = scheduleEntrySchema.safeParse({ ...fullEntry, retry_policy: bad });
    assert.equal(parsed.success, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('schedule schema — unknown fields rejected (strict)', () => {
  const parsed = scheduleEntrySchema.safeParse({ ...minimalEntry, extra_field: 'nope' });
  assert.equal(parsed.success, false);
});

test('cron validator — accepts valid 5-field expressions', () => {
  const valid = [
    '* * * * *',
    '0 0 * * *',
    '0 9 * * 1-5',
    '*/5 * * * *',
    '0 */2 * * *',
    '15,30,45 * * * *',
    '0 0 1 1 *',
    '0 0 * * 0',
    '0 0 * * 7',
    '30 8 1-15 * 1-5',
    '0 0 1,15 * *',
    '0 0/4 * * *',
  ];
  for (const expr of valid) {
    const r = validateCronExpression(expr);
    assert.equal(r.ok, true, `expected '${expr}' to be valid: ${!r.ok ? r.reason : ''}`);
  }
});

test('cron validator — accepts standard aliases', () => {
  for (const alias of ['@hourly', '@daily', '@weekly', '@monthly', '@yearly', '@annually']) {
    const r = validateCronExpression(alias);
    assert.equal(r.ok, true, `expected ${alias} to be valid`);
  }
});

test('cron validator — rejects invalid expressions', () => {
  const invalid = [
    '@reboot',
    '0 9 * * 8 *',     // 6 fields
    '0 9 * *',         // 4 fields
    '60 0 * * *',      // minute out of range
    '0 24 * * *',      // hour out of range
    '0 0 0 1 *',       // day-of-month out of range
    '0 0 32 1 *',      // day-of-month out of range
    '0 0 1 13 *',      // month out of range
    '0 0 * * 9',       // weekday out of range
    'garbage',
    '',
    '*/0 * * * *',     // step 0
    '5-2 * * * *',     // reverse range
    '*/5/2 * * * *',   // multiple slash separators
    '*/5/* * * * *',   // multiple slashes
    '-5 * * * *',      // empty range start (NaN→0 footgun)
    '5- * * * *',      // empty range end
    '- * * * *',       // bare dash
    '/5 * * * *',      // empty step base
    '5/ * * * *',      // empty step value
    '5- 9 * * *',      // empty range end with trailing field
  ];
  for (const expr of invalid) {
    const r = validateCronExpression(expr);
    assert.equal(r.ok, false, `expected '${expr}' to be invalid`);
  }
});

test('findDuplicateNames — flags duplicate names', () => {
  const dupes = findDuplicateNames([
    { name: 'foo' },
    { name: 'bar' },
    { name: 'foo' },
    { name: 'baz' },
    { name: 'foo' },
  ]);
  assert.equal(dupes.length, 2);
  assert.equal(dupes[0]!.path, 'schedules.2.name');
  assert.equal(dupes[1]!.path, 'schedules.4.name');
});

test('findDuplicateNames — empty/unique inputs return []', () => {
  assert.equal(findDuplicateNames([]).length, 0);
  assert.equal(findDuplicateNames([{ name: 'a' }, { name: 'b' }]).length, 0);
});
