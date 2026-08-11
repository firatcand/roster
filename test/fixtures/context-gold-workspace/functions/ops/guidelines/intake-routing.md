---
schema_version: 2
id: intake-routing
kind: guideline
purpose: Define how work arriving at the operations function is routed to the right queue on first touch.
scope:
  function: ops
---

# Intake routing

Everything arriving at the operations function gets routed on first touch, because
mis-routed work ages invisibly in the wrong queue while its requester believes it is
being handled.

Vendor-related issues route to the vendor-support intake under its intake standards.
Access requests route to the access-review owner with the requesting workflow named.
Spend questions route by threshold under the spend policy. Continuity concerns route
to the runbook owner. Anything customer-visible routes to the incident path first
and gets its bookkeeping later; routing ceremony never delays impact response.

Ambiguous arrivals are routed provisionally within the day, with the provisional
label visible, rather than parked for clarification. The receiving queue owns
re-routing if the guess was wrong, and the re-route is recorded so recurring
ambiguity becomes a routing-rule fix here instead of a permanent judgment call.

Work that belongs to no queue is the routing rule's failure, not the requester's:
it is accepted, owned by the function owner by default, and the gap becomes a
routing amendment the same week. "Not ours" is never the first answer to a
first-touch arrival.

The routing table is reviewed quarterly against where re-routes actually happened,
because the org chart changes quietly and the table's job is to describe the
organization that exists, not the one the last review remembered.
