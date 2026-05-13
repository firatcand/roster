# Non-interactive CLI flags need a full TTY audit, not just a happy-path test

> 2026-05-13 · ROS-16 · tags: [foundation, cli, ux, review-loop]

## What we expected

`roster install --all` and `--tool <name>` would be obviously non-interactive: no prompts to deselect, no checkbox to confirm. The acceptance criteria spoke to the menu path, the wiring skipped it, tests covered the parser + exit codes. Ship.

## What happened

`/codex review` flagged a P2 the brief had not anticipated: `installToTool` accepts an *optional* `ConfirmFn`, and when none is passed it falls back to a default that lazy-imports Inquirer and prompts on stdin. The "non-interactive" flags inherited that default. On a TTY-less CI runner the install would hang (or crash, depending on Inquirer's stdin behaviour) the moment it hit a pre-existing symlinked skill — silently invisible to anyone testing locally with a real terminal.

Fix was three lines: pass `confirm: async () => false` whenever `target.mode !== 'interactive'`, plus a regression test that pre-creates a symlink and asserts the subprocess exits 0 without hanging. Caught and fixed before opening the PR.

## Why

This is the second time in two PRs that `/codex review` caught a TTY/silent-failure trap the brief hadn't anticipated (the first was the SKILL.md skip in ROS-13/15). The shape is consistent: a helper accepts an optional callback, supplies a TTY-using default, and the caller — who is wiring up a flag explicitly marketed for CI — never thinks to override it because the default is already "reasonable" in interactive use. The trap is invisible until someone runs the binary headless.

## Next time

When adding any flag advertised as "non-interactive" or "for CI / scripted migration":

1. Trace **every** function the install path can call. Search for `await import('@inquirer/prompts')`, `readline`, `process.stdin.isTTY`, `prompt`, `question`, `confirm` — any lazy-imported prompt is a landmine.
2. For each one, either pass a deterministic callback or assert at runtime that we're not about to prompt.
3. Add at least one subprocess test that exercises the flag with a fixture *known to trigger* the helper's prompt branch (a pre-existing symlink, a duplicate file, an EACCES — whatever the helper would normally ask about). The test must run with no inherited TTY so a regression hangs the CI job instead of silently passing.

Treat this as part of the install/scaffold-path ship gate alongside `/codex review` itself.
