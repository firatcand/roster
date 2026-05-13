# Verbatim content ports carry source bugs forward
> 2026-05-13 · ROS-9 · tags: [content, review-loop, porting]

## What we expected
ROS-9 was framed as a "pure content port" — wrap eight `.dogfood/` markdown files in frontmatter, run the gates, ship. Acceptance criteria were structural (frontmatter parses, subagents exist in package, tarball includes the files). No code paths changed, so `/codex review` felt like a courtesy step on top of the same ship discipline used for code.

## What happened
Codex caught two P2 contract drifts inside `skills/sdr/SKILL.md`: (1) the body listed `writer.md` as "also performs the send step using channel tools" but `agents/writer.md` declared `Tools: None` and `Does not send` — a 10-line gap inside the same file the author had just written; (2) two sections of the same file disagreed on where tool bindings live (`gtm/sdr/projects/<project>/...` vs `projects/<project>/...`). Both drifts pre-existed in the `.dogfood/` source and propagated verbatim into `skills/`, `templates/scaffold/` (already shipped by ROS-17), and `.dogfood/` at once. Fixed all three in this PR.

## Why
"It's just markdown" framing skips the review gate that would have caught the contradiction. Human authors read documents top-to-bottom and don't easily notice that line 56 contradicts line 45 of the same file. A second model reading the diff cold has no such bias — and a canonical source treated as ground truth can hide the same bug across every downstream port.

## Next time
Run `/codex review` on content-only diffs too — especially verbatim ports from a "canonical" source. The cost is one minute; the upside is catching internal contract drift before it ships to every supported AI tool and every `roster init` workspace simultaneously. Extends the ROS-13/15 ship-gate rule from "install/scaffold paths" to "any user-facing contract document, code or not."
