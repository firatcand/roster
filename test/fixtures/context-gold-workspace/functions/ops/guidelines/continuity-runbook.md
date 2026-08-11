---
schema_version: 2
id: continuity-runbook
kind: guideline
purpose: Define how operations work continues when a key person, vendor, or system is suddenly unavailable.
scope:
  function: ops
---

# Continuity runbook

Continuity is a property maintained in advance: when a person, a vendor, or a system
disappears on a Tuesday morning, the work continues from records, not from memory.

Every recurring responsibility in the function names a primary and an alternate, and
the alternate exercises the responsibility at least once per quarter for real —
observation is not coverage. A responsibility whose alternate has never run it alone
is marked uncovered in the quarterly review until they have.

Vendor unavailability follows the incident path with one addition: the vendor
directory's commitment summary states the fallback posture per service — degrade,
switch, or wait — decided at onboarding when heads were cool, so an outage inherits
a decision instead of demanding one.

System unavailability leans on the rule that the ticket archive is the system of
record: any tool between people and the archive may fail without losing decisions,
because decisions land in the archive the same day they are made. During an archive
outage itself, decisions are logged in the standing fallback document and
transcribed back the day the archive returns.

The runbook is rehearsed twice a year against a scenario the function owner picks,
and every gap the rehearsal finds becomes a ticket with an owner, because a
continuity gap discovered in rehearsal costs an afternoon and the same gap
discovered in an incident costs the incident twice.

## Scope honesty

The runbook covers the function's own operations and says so: company-wide disaster
recovery is owned elsewhere, and this runbook links to it rather than paraphrasing
it, because a paraphrase of someone else's recovery plan is wrong within a quarter.
