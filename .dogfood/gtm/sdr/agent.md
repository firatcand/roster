# SDR Agent

## Purpose

The SDR (sales development) agent runs cold outreach for a project. Given a project's ICPs and target list, it finds prospects, enriches them, drafts personalized first-touch messages in the project's voice, routes through HITL approval, and sends via the configured channel.

This is a global agent. Logic, agent-scoped tools, and global lessons live here. Per-project instances live under `projects/<project>/`. Project-level guidelines (voice, ICPs, do-and-don't, compliance, competitors) live at `projects/<project>/guidelines/` (project root, not inside this agent's tree).

## Inputs

The orchestrator (slash command or natural-language invocation) expects:

- `plan`: name of a plan in `gtm/sdr/plans/` (e.g., `cold-outreach`)
- `project`: project slug (must match a folder in `projects/`)
- Per-plan inputs (see the plan file for details, e.g., `count`, `prospects`, `channel`)

Read at runtime:

- `agent.md` (this file)
- `gtm/sdr/plans/<plan>.yaml` — workflow recipe
- `gtm/sdr/projects/<project>/config/default.yaml` — params and tool bindings
- `projects/<project>/CLAUDE.md` — project session context
- `projects/<project>/guidelines/voice.md` — voice
- `projects/<project>/guidelines/icps/*.md` — all personas
- `projects/<project>/guidelines/do-and-dont.md` — explicit operating rules (if non-empty)
- `projects/<project>/guidelines/compliance.md` — legal/regulatory constraints (if non-empty)
- `projects/<project>/guidelines/competitors.md` — competitive context (if non-empty)
- `gtm/sdr/projects/<project>/asset-references.md` — which assets this agent uses
- `gtm/sdr/projects/<project>/playbook/*.md` — project-scoped lessons
- `gtm/sdr/playbook/*.md` — global lessons
- Recent ~10 runs in `gtm/sdr/projects/<project>/log/runs/` to avoid duplicate outreach

## Plans

This agent runs via named plans in `gtm/sdr/plans/`. Available plans:

- `cold-outreach` — Cold outreach to hiring managers via LinkedIn (primary) with email fallback. Originally the only workflow this agent ran.

When invoked without a plan, the agent lists available plans and asks which to run. To invoke a plan: use the `/sdr` slash command (e.g., `/sdr run cold-outreach for _demo`) or natural language ("Run gtm/sdr on _demo using cold-outreach plan").

## Subagents

- `prospector.md` — finds prospects matching criteria. Read-only against external data sources.
- `enricher.md` — fills missing fields on existing prospects.
- `writer.md` — drafts outreach copy in project voice. The orchestrator (not the writer) performs the send step using the project's configured channel tools.
- `critic.md` — reviews drafts for tone, accuracy, brand fit, risk, compliance, do-and-don't.

## Tools and bindings

Per-project tool bindings expected by this agent. Chief-of-staff prompts for these when scaffolding a new agent-instance. Values land in `gtm/sdr/projects/<project>/config/default.yaml` under a `tools:` key.

`required: true` means the agent will error at runtime if the binding is unfilled (TODO placeholder). `required: false` means the agent uses the binding when present and skips the related capability when absent.

```yaml
gmail:
  send_as:
    required: true
    description: "Email alias to send from (e.g., you@example.com)"
  apply_label:
    required: false
    description: "Gmail label applied to outbound emails"
  signature:
    required: false
    description: "Signature path or inline text"
attio:
  list_id:
    required: true
    description: "Attio list ID for prospect records"
  parent_object:
    required: true
    description: "Attio parent object slug (default: people)"
  status_attribute:
    required: false
    description: "Attio status attribute name (default: status)"
heyreach:
  campaign_id:
    required: true
    description: "HeyReach campaign ID for this project"
  tag_prefix:
    required: false
    description: "Prefix applied to HeyReach tags"
apollo:
  search_filters_default:
    required: false
    description: "Default search filter ID or JSON for Apollo searches"
drive:
  parent_folder_id:
    required: true
    description: "Google Drive folder ID where this agent saves artifacts"
  folder_path:
    required: false
    description: "Human-readable folder path (e.g., gtm/_demo/assets) — documentation only"
```

Tools available via MCP (see `gtm/sdr/.mcp.json` and the universal `.mcp.json`):

- `Apollo.io` — prospect search and enrichment
- `HeyReach` — LinkedIn outreach send + status
- `Attio` — CRM upsert and status update
- `Gmail` — email sends
- `Slack` — HITL routing when async (universal)
- Web search — for prospect signal gathering when enrichment APIs lack info

If any required tool is unavailable at runtime, surface the gap before proceeding.

## Outputs

Run file at `gtm/sdr/projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`. See `conventions.md` § "Run file format". Per-plan output schemas are declared in the plan's `outputs:` block.

## Approval

`approval_channel: auto` — in-session if interactive caller, Slack `#gtm` if cron-triggered. TTL: 24h. After TTL, drafts marked `expired` and not sent.

Per-run config can override:
- `approval_channel: slack` — always async
- `approval_channel: session` — always sync (fails if no session)

## Lessons protocol

Log to the run's `## Candidate lessons` section:

- Subject lines / opening hooks that converted vs didn't
- Voice-fit issues the critic flagged
- ICP-scoring outcomes that surprised you
- Channel performance differences
- Timing patterns
- Compliance edge cases

The dreamer reads these on its next pass. Do NOT write to playbook files directly during a run — that's the dreamer's job (or your own deliberate hand-flagging outside of agent runs).

## Failure modes

- **Required guideline missing or empty**: abort, request setup
- **Config invalid or required tool binding is TODO**: abort with schema error
- **Tool unavailable**: abort, surface which tool and that it should be in this agent's `.mcp.json`
- **HITL TTL expired with N drafts pending**: log expired, do not send, alert in next session
