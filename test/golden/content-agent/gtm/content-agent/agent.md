# Content-Agent Agent

## Purpose

Creates short-form GTM content drafts in a project's voice. One run takes
a topic brief plus the project's ICPs and produces 2-3 candidate posts
that have been critiqued for voice fit, brand safety, and ICP relevance.

## Inputs

The orchestrator (slash command or natural-language invocation) expects:

- plan: name of a plan in plans/ (e.g., draft-post)
- project: project slug (must match a folder in projects/)
- topic: short brief of what to write about (1-2 sentences)

Read at runtime:

- `agent.md` (this file)
- `gtm/content-agent/plans/<plan>.yaml` — workflow recipe
- `gtm/content-agent/config.yaml` — guideline refs + tool bindings (workspace-root paths)
- Workspace guidelines referenced under `config.yaml` `guideline_refs:` (e.g., `/guidelines/voice.md`, `/guidelines/icps/`, `/guidelines/messaging.md`)
- `gtm/content-agent/asset-references.md` — which workspace assets this agent uses
- `gtm/content-agent/playbook/*.md` — validated lessons (single playbook per agent)
- Recent ~10 runs in `gtm/content-agent/logs/runs/`

Env resolution: `gtm/content-agent/.env` overrides workspace `/.env`. Required tool env vars validated before the plan runs.

## Subagents

- `critic.md` — Reviews each candidate draft for voice fit, ICP relevance, brand safety,
  and do-and-don't compliance. Returns pass/fail with specific feedback.

## Tools

- `drive` — Read project voice.md and brand-book.md from Google Drive (required)
- `linear` — Optionally link drafts to a Linear ticket for tracking (optional)

## Tools and bindings

Tool bindings expected by this agent. Values land in this agent's `config.yaml` under a `tools:` key.

`required: true` means the agent errors at runtime if the binding is unfilled. `required: false` means the agent uses the binding when present and skips the related capability when absent.

```yaml
drive:
  required: true
  description: "Read project voice.md and brand-book.md from Google Drive"
linear:
  required: false
  description: "Optionally link drafts to a Linear ticket for tracking"
```

## Outputs

Run file at `gtm/content-agent/logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`. Per-plan output schemas are declared in each plan's `outputs:` block.

Approved post drafts written to the run log, one entry per candidate with
its critic score and any revision history. Drafts not surfaced to external
systems by this agent — copy/posting is a separate user action.

## Approval

`approval_channel: auto` — in-session if interactive caller, Slack `#hitl` (or the project's configured channel) if cron-triggered. TTL: 24h. After TTL, pending items are marked expired and not actioned.

Per-run config can override:
- `approval_channel: slack` — always async
- `approval_channel: session` — always sync (fails if no session)

## Lessons protocol

Log observations to the run's `## Candidate lessons` section. The dreamer reads these on its next reflection pass and promotes patterns into `playbook/`. Do NOT write to `playbook/` directly during a run — that is the dreamer's job. Hand-flagged lessons may be written outside of runs with `source: human` in frontmatter.

## Failure modes

- **Cwd not project root**: abort with the standard message
- **Required guideline missing or empty**: abort, request setup
- **Config invalid or required tool binding is TODO**: abort with schema error
- **Tool unavailable**: abort, surface which tool and that it should be in this agent's `.mcp.json`
- **HITL TTL expired with pending items**: log expired, do not action, surface in next session

Project-specific:

- No matching ICP found in project guidelines — abort with a list of available ICPs
- Voice file missing or empty — abort with link to onboarding guide
