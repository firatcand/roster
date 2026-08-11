---
schema_version: 2
id: tooling-access
kind: guideline
purpose: Define which support tooling this agent operates with and the access discipline around it.
scope:
  function: ops
  agent: vendor-support
---

# Tooling access

Support work runs on a small set of tools, each with a defined access posture, and
the posture is part of the work rather than an IT afterthought.

The ticket archive is the system of record. Everything triage, resolution, and audit
produce lands there, under the originating ticket, the same day it is produced. Side
documents, chat threads, and personal notes are drafting surfaces; a decision that
lives only in one of them does not exist for the next reader.

Archive search access is read-only by design in this agent's workflows, and stays
that way: search never modifies, closes, or reassigns what it finds, however obvious
the cleanup looks in passing. Observed hygiene problems become their own tickets.

Vendor portals are logged into with the function's service identity, never personal
accounts, so portal history survives personnel changes. Credentials live in the
company secret manager under the references the onboarding record names; no
credential value is ever written into a ticket, a runbook, or this guideline.

Monitoring dashboards are consulted at triage and at audit, and every dashboard
reading that supports a verdict is captured as a dated link or export attached to
the ticket, because a dashboard's live view weeks later will not show what the
verdict saw.

New tooling enters this list through the function owner, with its access posture
defined before first use, not after the first surprise.

## Break-glass

A break-glass path exists for archive and portal access when the normal grant chain
is unavailable during an incident, and every break-glass use is logged, reviewed at
the next weekly audit, and closed with either a process fix or a confirmation that
the use was proper. Unreviewed break-glass use is treated as a security finding.
