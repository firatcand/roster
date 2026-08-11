---
schema_version: 2
id: triage-prior
kind: lesson
purpose: Preserve an approved lesson about precedent search order during triage.
scope:
  function: ops
  agent: vendor-support
  plan: ticket-triage
---

# Search the failure signature before the vendor name

Precedent searches keyed on the failure signature find applicable fixes that vendor-name
searches miss, because the same underlying failure recurs across vendors more often than
it recurs within one vendor. Run the signature search first and the vendor search second,
and record both searched strings in the verdict. The weeks this order was followed, the
match step verified an accepted fix in minutes; the weeks it was skipped, diagnosis
started from scratch on failures the archive had already solved.
