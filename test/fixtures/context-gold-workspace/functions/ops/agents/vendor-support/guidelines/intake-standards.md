---
schema_version: 2
id: intake-standards
kind: guideline
purpose: Define what a vendor ticket must contain at intake before triage will accept it.
scope:
  function: ops
  agent: vendor-support
---

# Intake standards

Triage quality is decided at intake: a ticket that arrives complete is triaged in
minutes, and a ticket that arrives as a vibe costs a round trip before work can
start. These standards define complete.

Every incoming vendor ticket states the observable symptom in one sentence — what
happened, where, and when first noticed — separate from any theory about the cause.
Theories are welcome and are labeled as theories; a ticket whose symptom section
contains a diagnosis has skipped the observation.

The ticket names the affected system and the affected vendor service by their
registry names, not by team nicknames, so the failure signature search has exact
strings to work with. Nicknames are translated at intake, once, and the translation
noted.

Evidence attaches at intake: the error text verbatim, the relevant log excerpt with
timestamps, and the monitoring link when one exists. "Logs available on request" is
an incomplete ticket; the request is this standard.

Impact is stated as observed, not as feared. "Two customer exports failed at 09:14"
is intake evidence; "this could affect all customers" is escalation speculation and
belongs in the impact assessment triage will perform, not in the intake record.

A ticket failing these standards is returned to its reporter with the missing items
named, immediately and without judgment; the standards exist so the return happens
once, at the cheapest moment, instead of during a live incident.

## Duplicate awareness

Intake checks the recent queue for the same symptom before creating a ticket, and a
match becomes a linked occurrence rather than a fresh ticket, so volume counts stay
honest and triage sees recurrence immediately. When in doubt, intake creates the
ticket and notes the possible duplicate — a false link is cheaper to cut than a
missed recurrence is to rediscover.
