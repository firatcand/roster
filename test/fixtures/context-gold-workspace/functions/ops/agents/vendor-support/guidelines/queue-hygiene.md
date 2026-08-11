---
schema_version: 2
id: queue-hygiene
kind: guideline
purpose: Define the daily and weekly habits that keep the ticket queue an honest picture of reality.
scope:
  function: ops
  agent: vendor-support
---

# Queue hygiene

The queue is only useful while it tells the truth, and queue truth decays through
small daily accumulations: stale statuses, orphaned tickets, and optimistic
next-action dates nobody re-dated. Hygiene is the counter-habit.

Daily, the queue is walked top-down for status truth: every ticket in progress shows
its actual last action and its actual next one, and a ticket whose owner is waiting
on someone says so, with the someone named. The walk takes minutes when done daily
and hours when done monthly, which is the whole argument for daily.

Weekly, the audit sweeps for orphans — tickets whose owner changed teams, whose
vendor was renamed, or whose reporter no longer needs the outcome — and each orphan
is re-owned, re-linked, or closed with its reason. An orphan left in place teaches
the queue's readers that some tickets are decorative.

Next-action dates are commitments, not aspirations: a date that passes without its
action gets re-dated with a one-line reason, and three re-dates on one ticket
trigger the aging review regardless of impact class, because serial optimism is how
a stuck ticket hides in plain sight.

Closure discipline caps the hygiene: a ticket closes only with its resolution
recorded to the reusable-by-a-stranger standard, and bulk-closing stale tickets to
make the queue look healthy is falsifying the record — the one hygiene violation
treated as an integrity issue rather than a habit slip.

## Metrics honesty

Queue metrics inherit queue truth: aging numbers, resolution times, and volume
counts are only as honest as the statuses beneath them, which is why hygiene is a
prerequisite for every report that cites them. A metric computed over a dirty queue
is withdrawn rather than footnoted, because a footnoted wrong number still travels
without its footnote.
