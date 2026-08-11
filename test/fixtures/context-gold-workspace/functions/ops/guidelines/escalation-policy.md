---
schema_version: 2
id: escalation-policy
kind: guideline
purpose: Define when an internal operations issue escalates, to whom, and with what evidence attached.
scope:
  function: ops
---

# Escalation policy

Escalation exists to move a decision to the person who can actually make it, with the
evidence already assembled. An escalation without evidence is a forwarded worry; the
policy below exists to prevent those.

## When to escalate

Escalate immediately when any of these holds: a customer-visible service is degraded, a
vendor has missed a committed response window twice on one ticket, a spend threshold
would be exceeded without an existing approval, or two teams disagree about ownership
of a live issue. Everything else stays at the working level until the normal cadence
review.

## What every escalation carries

- The one-sentence statement of the decision being requested, never just a description
  of the situation.
- The timeline of what was tried, with timestamps, in order.
- The evidence bundle: the ticket history, the vendor's own words, and any measurement
  that shows impact.
- The recommended option with its cost, and at least one alternative with its cost.

## What escalation is not

Escalation is not blame assignment, and the write-up must read that way: systems and
sequences, not personalities. It is also not a way to skip the queue for convenience;
an escalation that arrives without the required evidence is returned to sender with
this policy attached.

## After the decision

The decision, its reasoning, and its date are recorded back onto the originating
ticket so the next similar issue starts from precedent rather than from scratch.

## Cadence reviews

Issues that never trip an escalation trigger still surface on a cadence: the weekly
audit reviews the working-level queue for tickets aging past their expected
resolution class, and a ticket aging twice past its class becomes an escalation
candidate regardless of impact, because silent aging is how small issues compound
into large ones.

## Recording the path not taken

When a working-level owner considers escalation and decides against it, the
consideration is recorded on the ticket in one sentence with the reason. The record
costs a minute and buys two things: the next reviewer knows the option was weighed,
and the pattern of near-escalations becomes visible data for the cadence review.
