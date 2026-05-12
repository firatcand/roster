# Codex review catches what briefs miss
> 2026-05-12 · ROS-13 + ROS-15 · tags: [foundation, testing, review-loop]

## What we expected
Bundling two co-touching tasks (Codex + Gemini install targets) would be straightforward — brief was tight, acceptance criteria explicit, ~24 tests targeted. Run the gates, ship.

## What happened
Implementation matched the brief in one pass: 28 tests green, build clean, no surprises. Then the optional `/codex review` step surfaced a real HIGH the brief had not anticipated — silent skip of skill directories missing `SKILL.md` in the Codex flat-file layout. Hides malformed source packs and makes partial installs look successful. Codex also flagged a few cheap test-coverage gaps (per-target EACCES wrapping, mid-process env re-read, sibling-`.md` exclusion). All fixed in-flight before opening the PR.

## Why
Briefs encode the *happy path* and known edge cases. A second-model review pressure-tests assumptions the brief author already internalised. The HIGH here was not in the acceptance checklist because "skip dirs without SKILL.md" felt obviously correct — it took an outside reader to point out a CLI installer that silently hides malformed input is failing its operator.

## Next time
Treat `/codex review` as a default ship gate for any new install/scaffold path, not an optional last step. Cost ~30 lines of code/test for a non-trivial behavioural improvement and one new contract test — high ROI versus shipping and learning from a user report.
