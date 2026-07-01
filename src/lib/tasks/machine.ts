export type CanonicalState =
  | 'backlog'
  | 'ready'
  | 'claimed'
  | 'active'
  | 'blocked'
  | 'review'
  | 'done'
  | 'cancelled';

export type TaskEvent =
  | 'claim'
  | 'start'
  | 'block'
  | 'unblock'
  | 'submit'
  | 'signoff'
  | 'revise'
  | 'cancel';

export const CANONICAL_STATES: readonly CanonicalState[] = [
  'backlog',
  'ready',
  'claimed',
  'active',
  'blocked',
  'review',
  'done',
  'cancelled',
];

export const REQUIRED_STATES: readonly CanonicalState[] = ['ready', 'active', 'done'];

const TABLE: Partial<Record<CanonicalState, Partial<Record<TaskEvent, CanonicalState>>>> = {
  ready: { claim: 'claimed' },
  claimed: { start: 'active', cancel: 'cancelled' },
  active: { block: 'blocked', submit: 'review', cancel: 'cancelled' },
  blocked: { unblock: 'active' },
  review: { signoff: 'done', revise: 'active', cancel: 'cancelled' },
};

export function transition(
  current: CanonicalState,
  event: TaskEvent,
): { next: CanonicalState; illegal?: boolean } {
  const target = TABLE[current]?.[event];
  if (target) {
    return { next: target };
  }
  for (const source of CANONICAL_STATES) {
    if (TABLE[source]?.[event] === current) {
      return { next: current };
    }
  }
  return { next: current, illegal: true };
}
