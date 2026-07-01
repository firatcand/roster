import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition, CANONICAL_STATES, REQUIRED_STATES } from '../src/lib/tasks/machine.ts';
import type { CanonicalState, TaskEvent } from '../src/lib/tasks/machine.ts';

type Result = { next: CanonicalState; illegal?: boolean };

const ALL_EVENTS: readonly TaskEvent[] = [
  'claim',
  'start',
  'block',
  'unblock',
  'submit',
  'signoff',
  'revise',
  'cancel',
];

const EXPECTED: Record<CanonicalState, Record<TaskEvent, Result>> = {
  backlog: {
    claim: { next: 'backlog', illegal: true },
    start: { next: 'backlog', illegal: true },
    block: { next: 'backlog', illegal: true },
    unblock: { next: 'backlog', illegal: true },
    submit: { next: 'backlog', illegal: true },
    signoff: { next: 'backlog', illegal: true },
    revise: { next: 'backlog', illegal: true },
    cancel: { next: 'backlog', illegal: true },
  },
  ready: {
    claim: { next: 'claimed' },
    start: { next: 'ready', illegal: true },
    block: { next: 'ready', illegal: true },
    unblock: { next: 'ready', illegal: true },
    submit: { next: 'ready', illegal: true },
    signoff: { next: 'ready', illegal: true },
    revise: { next: 'ready', illegal: true },
    cancel: { next: 'ready', illegal: true },
  },
  claimed: {
    claim: { next: 'claimed' },
    start: { next: 'active' },
    block: { next: 'claimed', illegal: true },
    unblock: { next: 'claimed', illegal: true },
    submit: { next: 'claimed', illegal: true },
    signoff: { next: 'claimed', illegal: true },
    revise: { next: 'claimed', illegal: true },
    cancel: { next: 'cancelled' },
  },
  active: {
    claim: { next: 'active', illegal: true },
    start: { next: 'active' },
    block: { next: 'blocked' },
    unblock: { next: 'active' },
    submit: { next: 'review' },
    signoff: { next: 'active', illegal: true },
    revise: { next: 'active' },
    cancel: { next: 'cancelled' },
  },
  blocked: {
    claim: { next: 'blocked', illegal: true },
    start: { next: 'blocked', illegal: true },
    block: { next: 'blocked' },
    unblock: { next: 'active' },
    submit: { next: 'blocked', illegal: true },
    signoff: { next: 'blocked', illegal: true },
    revise: { next: 'blocked', illegal: true },
    cancel: { next: 'blocked', illegal: true },
  },
  review: {
    claim: { next: 'review', illegal: true },
    start: { next: 'review', illegal: true },
    block: { next: 'review', illegal: true },
    unblock: { next: 'review', illegal: true },
    submit: { next: 'review' },
    signoff: { next: 'done' },
    revise: { next: 'active' },
    cancel: { next: 'cancelled' },
  },
  done: {
    claim: { next: 'done', illegal: true },
    start: { next: 'done', illegal: true },
    block: { next: 'done', illegal: true },
    unblock: { next: 'done', illegal: true },
    submit: { next: 'done', illegal: true },
    signoff: { next: 'done' },
    revise: { next: 'done', illegal: true },
    cancel: { next: 'done', illegal: true },
  },
  cancelled: {
    claim: { next: 'cancelled', illegal: true },
    start: { next: 'cancelled', illegal: true },
    block: { next: 'cancelled', illegal: true },
    unblock: { next: 'cancelled', illegal: true },
    submit: { next: 'cancelled', illegal: true },
    signoff: { next: 'cancelled', illegal: true },
    revise: { next: 'cancelled', illegal: true },
    cancel: { next: 'cancelled' },
  },
};

test('full truth table: every (state × event) matches the independent spec', () => {
  const states = Object.keys(EXPECTED) as CanonicalState[];
  for (const state of states) {
    for (const event of ALL_EVENTS) {
      assert.deepStrictEqual(
        transition(state, event),
        EXPECTED[state][event],
        `transition(${state}, ${event})`,
      );
    }
  }
});

test('happy path: ready --claim--> claimed --start--> active --submit--> review --signoff--> done', () => {
  const a = transition('ready', 'claim');
  assert.deepStrictEqual(a, { next: 'claimed' });
  const b = transition(a.next, 'start');
  assert.deepStrictEqual(b, { next: 'active' });
  const c = transition(b.next, 'submit');
  assert.deepStrictEqual(c, { next: 'review' });
  const d = transition(c.next, 'signoff');
  assert.deepStrictEqual(d, { next: 'done' });
});

test('block/unblock: active --block--> blocked --unblock--> active', () => {
  const a = transition('active', 'block');
  assert.deepStrictEqual(a, { next: 'blocked' });
  const b = transition(a.next, 'unblock');
  assert.deepStrictEqual(b, { next: 'active' });
});

test('revise: review --revise--> active', () => {
  assert.deepStrictEqual(transition('review', 'revise'), { next: 'active' });
});

test('cancel from claimed, active, review → cancelled', () => {
  assert.deepStrictEqual(transition('claimed', 'cancel'), { next: 'cancelled' });
  assert.deepStrictEqual(transition('active', 'cancel'), { next: 'cancelled' });
  assert.deepStrictEqual(transition('review', 'cancel'), { next: 'cancelled' });
});

test('idempotent no-ops land on the current state without illegal', () => {
  assert.deepStrictEqual(transition('active', 'start'), { next: 'active' });
  assert.deepStrictEqual(transition('done', 'signoff'), { next: 'done' });
  assert.deepStrictEqual(transition('cancelled', 'cancel'), { next: 'cancelled' });
  assert.deepStrictEqual(transition('blocked', 'block'), { next: 'blocked' });
  assert.deepStrictEqual(transition('active', 'unblock'), { next: 'active' });
  assert.deepStrictEqual(transition('active', 'revise'), { next: 'active' });
});

test('illegal transitions return { next: current, illegal: true }', () => {
  assert.deepStrictEqual(transition('ready', 'signoff'), { next: 'ready', illegal: true });
  assert.deepStrictEqual(transition('active', 'claim'), { next: 'active', illegal: true });
  assert.deepStrictEqual(transition('backlog', 'start'), { next: 'backlog', illegal: true });
  assert.deepStrictEqual(transition('done', 'start'), { next: 'done', illegal: true });
});

test('CANONICAL_STATES has the 8 states in the canonical order', () => {
  assert.deepStrictEqual(
    [...CANONICAL_STATES],
    ['backlog', 'ready', 'claimed', 'active', 'blocked', 'review', 'done', 'cancelled'],
  );
});

test('REQUIRED_STATES ⊆ CANONICAL_STATES', () => {
  assert.deepStrictEqual([...REQUIRED_STATES], ['ready', 'active', 'done']);
  for (const state of REQUIRED_STATES) {
    assert.ok(CANONICAL_STATES.includes(state), `${state} is canonical`);
  }
});
