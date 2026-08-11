---
schema_version: 2
id: source-quality
kind: guideline
purpose: Define the source-quality ladder discovery uses when judging where a conversation lives.
scope:
  function: gtm
  agent: social-manager
---

# Source quality

Not all public conversation venues carry equal evidentiary weight, and discovery
judges the venue as part of judging the candidate.

First-party practitioner writing — a named person describing work they personally
did, on a venue they control or a forum with stable identity — sits at the top of
the ladder. Threads there reward substantive replies and preserve attribution
indefinitely.

Community forums with persistent identity come next: the author is pseudonymous but
consistent, the thread history is stable, and the community's own norms filter low
signal. Discovery treats these as full candidates with the venue noted.

High-velocity feeds sit lower: identity is thin, threads decay quickly, and context
collapses as posts travel. A feed conversation qualifies only when the author's
identity and the claim's substance both survive scrutiny, and the observed timestamp
matters doubly because decay is fast.

Aggregators and reposts sit at the bottom: they are pointers, not venues. Discovery
follows a repost to its origin and evaluates the origin; a candidate whose only
existence is an aggregator entry has no origin to evaluate and is dropped.

Anonymous boards are read for weather, never for candidates: they can signal that a
topic is heating, but a conversation without any stable identity cannot anchor a
company reply, whatever its content.

## Venue drift

Venues move on the ladder over time: a forum that loses its identity norms drops a
rung, and a feed that gains durable threading climbs one. The ladder is reviewed
when the listening report notes a venue behaving unlike its rung, and changes are
dated here so older shortlists are read against the ladder that judged them.
