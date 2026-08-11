---
schema_version: 2
id: spend-policy
kind: guideline
purpose: Define who may commit operational spend, at what thresholds, and with what record.
scope:
  function: ops
---

# Spend policy

Operational spend is committed by named owners inside named thresholds, and every
commitment leaves a record the next budget review can reconstruct without asking
anyone.

Working-level owners commit spend inside their standing threshold without approval,
and record the commitment with its reason on the originating ticket the same day.
The record states what was bought, what it resolved, and which alternative was
rejected on price or on capability.

Above the standing threshold, spend requires the function owner's approval before
commitment, requested through the escalation path with the same evidence bundle an
escalation carries: the decision requested, the options with costs, and the
recommendation. Retroactive approval exists only for genuine emergencies, and every
retroactive request is reviewed as a process failure as well as a spend decision.

Recurring spend — subscriptions, capacity reservations, support tiers — is reviewed
at renewal against measured usage, never rolled over by default. The renewal review
workflow owns assembling that evidence; this policy owns requiring it.

No spend commitment is made inside a vendor negotiation conversation. Negotiations
produce proposals; commitments happen afterward, on our side, with the record
written first.

## Visibility

All committed spend in the function is queryable from the tickets that carry it, and
the quarterly review reconciles ticket-recorded spend against the ledger. A gap in
either direction is investigated the week it is found: unrecorded spend means the
record discipline slipped, and unledgered records mean a commitment never landed.
