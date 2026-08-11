---
schema_version: 2
id: access-reviews
kind: guideline
purpose: Define the quarterly access review that keeps operations tooling permissions honest.
scope:
  function: ops
---

# Access reviews

Access accumulates silently and is removed deliberately; the quarterly review is the
deliberate part, and it reviews every access the function's work touches.

The review walks the inventory the onboarding records and tooling guidelines
maintain: who holds each vendor portal identity, each archive role, each monitoring
grant, and each secret-manager reference. Every entry is confirmed by its named
holder, reassigned with a dated handover, or revoked the same week — carried
"pending" entries are the failure mode the review exists to prevent.

Service identities are reviewed against their consumers: an identity no current
workflow uses is revoked, and an identity two workflows share is split before the
sharing becomes load-bearing. Personal-account usage found anywhere in vendor
tooling is migrated to the service identity immediately and noted as a finding.

Departures trigger an out-of-cycle mini-review within the week, scoped to the
departing person's holdings, because the quarterly cadence is a floor for hygiene
and never a ceiling for risk.

Findings are tickets: every revocation, migration, and split leaves the review as a
ticket with an owner and a date, and the next review opens by verifying the last
review's tickets closed.

## Evidence of review

The review itself leaves evidence: the confirmed inventory snapshot, dated and
owner-signed, attached to the review ticket. An access decision made outside a
review cites the review it will be verified in, so between-cycle changes cannot
drift outside the evidence trail.
