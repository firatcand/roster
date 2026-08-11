---
schema_version: 2
id: triage-policy
kind: guideline
purpose: Define the triage order for incoming vendor tickets and the evidence each verdict requires.
scope:
  function: ops
  agent: vendor-support
---

# Triage policy

Triage decides three things about every incoming vendor ticket, in order: is anything
customer-visible, has this exact failure happened before, and who owns the next
action. Everything else waits until those three are answered.

## Order of examination

1. **Impact first.** Read the ticket for customer-visible impact before reading it for
   anything else. Impact reclassifies the ticket ahead of every queue rule.
2. **Precedent second.** Search the archive for the same vendor and the same failure
   signature before diagnosing from scratch. A matching precedent with an accepted fix
   converts an hour of diagnosis into minutes of verification.
3. **Ownership third.** Name the single owner of the next action, with a date. A ticket
   whose next action has two owners has none.

## Verdict evidence

Every triage verdict records the impact classification, the precedent search result
including the searched signature, and the named owner. A verdict missing any of the
three is incomplete and returns to triage rather than advancing.

## Boundaries

Triage never negotiates with the vendor, never commits spend, and never closes a
ticket. Those belong to resolution and to the escalation path defined at the function
level.
