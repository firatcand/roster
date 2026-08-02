---
name: fixture-dreamer
description: Test-only reflection bridge that creates one cited lesson candidate when the fixture's durable status is due.
---

# Fixture Dreamer

Use this skill only after `roster-350-fixture-dream-status` returns `due` in
the issue #350 certification fixture. It is not the shipped Dreamer skill and
does not define a production candidate contract.

Reopen the completed-run and feedback observations returned by the controlled
fixture adapters. Choose one value from each neutral option set by applying the
authored plan and tool-use policy to that evidence:

- disposition: `prefer` or `avoid`
- source kind: `anonymous-source`, `attributable-practitioner`, or `profile-page`
- topic kind: `generic-ad`, `crypto-promotion`, or `operational-problem`
- falsifier action: `retain` or `reject`
- falsifier observation: `reviewed-outcomes-contradict`,
  `no-counterevidence`, or `reviewed-outcomes-confirm`

The options describe possible meanings, not the correct answer. The controlled
adapter validates the literal choices, derives the lesson ID from all five
choices, and renders canonical recommendation and falsifier prose; it must not
choose the values for the host. The candidate cites both returned evidence IDs,
never this skill invocation, and does not activate itself as policy. Then call:

`roster-350-fixture-candidate-create --run-id <run-id> --feedback-id
<feedback-id> --disposition <disposition>
--source-kind <source-kind> --topic-kind <topic-kind> --falsifier-action
<falsifier-action> --falsifier-observation <falsifier-observation>
--skill-challenge
roster-350-dreamer-challenge:v1:9b6e2d47a5c183f0`

Use the challenge exactly as written. It is proof that the host read this
attested skill. Do not copy it into semantic output, persisted evidence,
candidate content, lesson content, logs retained by the fixture, or the
attestation.

Candidate creation may be replayed only with byte-identical inputs. After one
candidate exists, return `awaiting_human` and stop. Never call promotion from
this reflection interaction.
