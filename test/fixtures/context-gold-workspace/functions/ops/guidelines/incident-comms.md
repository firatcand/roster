---
schema_version: 2
id: incident-comms
kind: guideline
purpose: Define who says what to whom during an operations incident and in what order.
scope:
  function: ops
---

# Incident communications

During an incident, communication is part of the response, and it has an owner, an
order, and a register, so responders respond instead of narrating.

The order is fixed: affected internal teams first, with observed impact and the next
update time; the incident channel second, with the working timeline; leadership
third, on the escalation policy's triggers rather than on drama; and any external
communication last, only through the designated owner, only in approved words.
Skipping ahead in the order is how three versions of one incident end up circulating.

The communications owner is named at incident start and is not the technical lead:
a responder context-switching into announcements loses both threads. The owner
reads the ticket record and the incident channel, writes in the notice template's
structure, and never speculates about cause ahead of the timeline.

Update cadence is promised and kept: every notice names the time of the next notice,
and an update with nothing new still ships on time saying exactly that. A silent gap
where an update was promised reads as things getting worse, whatever the truth.

After resolution, the confirmation notice states what was fixed, how it was
verified, and what would indicate recurrence — the same structure the resolution
confirmation template defines — and the incident's communication trail is attached
to the follow-up record so the next incident inherits working examples instead of
blank templates.

## Severity language

Notices use the severity vocabulary the impact classes define and no other
adjectives: an incident is its class, not "minor", "small", or "nothing to worry
about". Reassuring adjectives age catastrophically when a timeline later shows the
notice-writer could not have known yet. The classes carry the reassurance the facts
support, and nothing more.

## Cross-team etiquette

Affected teams get facts before leadership gets summaries, always: a team that
learns of its own impact from a leadership deck stops trusting the notice channel.
When two teams are affected unequally, each notice states that team's own impact
first and the shared timeline second, so nobody has to parse someone else's notice
to find their answer.
