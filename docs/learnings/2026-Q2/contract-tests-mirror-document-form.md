# Contract-validation tests must mirror how the contract is actually written

> 2026-05-13 · ROS-20 · tags: [foundation, testing, contracts]

## What we expected

The e2e script's cross-reference check would assert "every plan path mentioned in `gtm/sdr/agent.md` resolves on disk" with a literal-path regex: `gtm/sdr/plans/[a-z0-9_-]+\.yaml`. The brief literally said "agent.md references valid plan paths" — so an assertion that matched plan *paths* in agent.md felt obviously correct.

## What happened

First happy-path run failed the new assertion: zero plan paths found. `agent.md` does not write `gtm/sdr/plans/cold-outreach.yaml` anywhere — it documents plans as bullet items under `## Plans` (`` - `cold-outreach` — ... ``) and references them at runtime via `gtm/sdr/plans/<plan>.yaml` (a templated placeholder, not a real path). My regex matched neither. The "valid plan paths" check was asserting nothing in the form the document used.

## Why

I tested against my *mental model* of the contract (full paths), not the document's actual form (bullet slugs + a templated placeholder). When a test grep doesn't match what the source actually says, the assertion becomes a no-op: the build stays green even though the contract is being silently ignored. The bug was caught the first time the script ran, but in a less observable test the silent-pass version could easily ship.

## Next time

When writing a test that validates a Markdown / YAML / config-file contract:

1. Open the source document and read the *exact* shape of the references you're asserting on — bullet bullets, code-fence callouts, frontmatter keys, prose mentions.
2. Pattern-match that shape. Add a secondary pattern for plausible-but-not-yet-used alternative forms (e.g., bullet slugs *and* literal paths) so the assertion stays correct if someone rewrites the document in a different style.
3. Always have at least one positive assertion that fails loudly if the section the contract lives in is *missing or empty* — otherwise an empty match looks like a pass.
4. Sanity-check the assertion at least once against a deliberately-broken input (a tamper test) — the green run alone doesn't prove the regex matches anything; it just proves it didn't match anything that broke.
