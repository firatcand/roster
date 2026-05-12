# .dogfood/ — agent-team workspace (dogfood instance)

This is the dogfood instance of the agent-team pattern that `@firatcand/roster` scaffolds. It exists so we eat our own cooking — the same conventions the CLI ships are exercised here against real projects.

**If you're working on the CLI itself, you don't need this directory.** See `../CLAUDE.md` (repo root) for CLI development.

## Layout

Matches the scaffold that `roster init` produces in a fresh workspace:

```
.dogfood/
├── CLAUDE.md            ← workspace-level operating rules for Claude Code sessions
├── conventions.md       ← canonical schema reference (file naming, lesson schema, ...)
├── .claude/commands/    ← workspace-level slash commands (/sdr, /chief-of-staff, /dreamer)
├── .config/             ← functions registry
├── .env.example         ← Slack HITL channels + tool credentials
├── gtm/, product/, design/, ops/   ← function dirs with EXPERT.md + role-based agents
├── chief-of-staff/      ← repo maintenance agent
├── dreamer/             ← reinforcement / lesson-promotion agent
├── projects/            ← project-level shared substrate
└── scripts/             ← shell helpers (create-function, new-project, audit-repo, ...)
```

## Usage

`cd .dogfood/` and open Claude Code. The `.claude/commands/` directory there activates `/sdr`, `/chief-of-staff`, and `/dreamer`. Slash-command and HITL routing follow the rules in `CLAUDE.md` and `conventions.md`.

## Why dogfood instead of an example

The `examples/` directory implies stable, documented sample output. Dogfood is operational state — it has live projects, run logs, and lessons. Keeping it here lets the CLI maintainer exercise every code path that a fresh `roster init` workspace will hit.
