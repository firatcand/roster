# Dreaming Agent

Reinforcement and consolidation. Reads the durable evidence of finished work, drafts cited lesson candidates, presents them, and writes approved lessons into the right playbook.

## Why this is one agent

Cross-domain pattern detection matters. A lesson observed in Twitter automation might inform outreach. One dreamer reads everything; per-domain dreamers would miss connections.

## Files

- `agent.md` — orchestrator contract
- `subagents/` — pattern-detector, lesson-drafter
- `playbook/` — the dreamer's own lessons (lessons about how to learn)
- `logs/` — its own runs

## How it activates

There is no timer and no queue. Completed runs and feedback are recorded into the workspace Brain with `roster brain record run` and `roster brain record feedback`. `roster dream status` reads that evidence and answers `due` or `not_due` with the `readiness_key` of the occasion — a bounded read that writes nothing and stays durable, so a check that never happened is simply recovered by the next one.

Your host agent checks that status right after recording and again at the start of the next session in this workspace. While it is `due`, the host reads the occasion with `roster dream candidates list --readiness-key <key> --json` and invokes the `dreamer` skill only when nothing has been drafted for it yet.

On-demand still works: "Run the dreamer over last week's outreach work."

## Output

A cited lesson candidate in the Brain, presented in the session for you to decide. The human's answer is recorded with `roster brain record decision` and applied with `roster dream candidates promote`, `reject`, or `retire`. Promotion is what writes the playbook file.

The skill contract lives in `skills/dreamer/SKILL.md`.

## Critical rule

The dreamer is the only agent that writes to `playbook/` files. Other agents surface candidate observations in their own output; the dreamer evaluates and drafts, and only a human decision promotes. You may also write playbook lessons by hand with `source: human`.
