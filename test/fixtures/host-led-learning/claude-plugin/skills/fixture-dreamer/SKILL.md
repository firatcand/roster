---
name: fixture-dreamer
description: Test-only reflection bridge that creates one cited lesson candidate when the fixture's durable status is due.
---

# Fixture Dreamer

Use this skill only after `roster-350-fixture-dream-status` returns `due` in
the issue #350 certification fixture. It is not the shipped Dreamer skill and
does not define a production candidate contract.

Reopen the completed-run and feedback observations returned by the controlled
fixture adapters. Draft one concise, falsifiable recommendation scoped to the
selected Roster plan. The recommendation must cite both returned evidence IDs,
must not use this skill invocation as evidence, and must not activate itself as
policy.

Choose a concise kebab-case proposed lesson ID from the evidence. Write one
bounded recommendation and one bounded observation that would falsify it. Pass
those host-authored values as literal arguments; the adapter must not invent
candidate semantics. Then call:

`roster-350-fixture-candidate-create --run-id <run-id> --feedback-id
<feedback-id> --lesson-id <proposed-lesson-id> --recommendation
<recommendation> --falsifiable-by <falsification-condition> --skill-challenge
roster-350-dreamer-challenge:v1:9b6e2d47a5c183f0`

Use the challenge exactly as written. It is proof that the host read this
attested skill. Do not copy it into semantic output, persisted evidence,
candidate content, lesson content, logs retained by the fixture, or the
attestation.

Candidate creation may be replayed only with byte-identical inputs. After one
candidate exists, return `awaiting_human` and stop. Never call promotion from
this reflection interaction.
