---
schema_version: 2
id: data-handling
kind: guideline
purpose: Define what vendor-related data may be shared with whom during support work.
scope:
  function: ops
  agent: vendor-support
---

# Data handling

Support work constantly touches data that belongs to someone else — vendor pricing,
contract terms, incident details, and occasionally customer information a vendor
ticket drags along. The rules below decide what moves where.

**Vendor pricing and contract terms** stay inside the operations function. They are
never pasted into cross-team channels, never quoted in tickets a vendor can read,
and never used in public comparison, however tempting a negotiation anecdote is.

**Incident details** are shared on a need-to-operate basis: the teams affected by an
incident see the incident, not the vendor's entire history. When an incident summary
leaves the function, vendor performance data from unrelated tickets is removed first.

**Customer information** inside a vendor ticket is an escalation trigger on its own.
It is redacted from the working record immediately, the redaction is noted, and the
ticket proceeds on the redacted record; the unredacted original lives only where
customer data is allowed to live.

**Vendor contacts** are people. Their direct remarks are paraphrased into tickets
rather than quoted verbatim, and internal frustration with a vendor never appears in
a record the escalation path might one day attach to an email.

When a sharing question is not covered above, the default is not to share and to ask
the function owner, with the question and answer recorded so the next occurrence is
covered.

## Retention

Working copies of vendor data made during a ticket — exports, spreadsheets, pasted
excerpts — are deleted when the ticket closes, with the ticket recording that the
cleanup happened. The archive keeps the evidence the resolution needs; scattered
working copies keep only risk. A working copy that must outlive its ticket gets an
explicit retention note naming its owner and its review date, so nothing survives by
being forgotten.
