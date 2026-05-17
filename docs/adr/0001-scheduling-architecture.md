# ADR-0001: Scheduling architecture for roster

**Status:** Proposed
**Date:** 2026-05-15
**Deciders:** Firat (project owner)
**Supersedes:** initial design sketches in `docs/ARCHITECTURE.md:141-200` referencing `claude -p` cron and a custom in-session scheduler daemon

## Context

Roster needs to run agents (SDR, design, Twitter manager, dreamer, etc.) on schedules. The user's deployment target is an always-running Mac mini. The system must support a daily/hourly cadence of agent runs that call external APIs (Apollo, Sonar, Twitter, Slack), drive headless browsers (Playwright/Chrome), and surface human-in-the-loop items back to the user.

### Hard requirements

1. **Subscription-only billing.** No Agent SDK credit consumption, no `claude -p` invocations, no API-keyed access. All model usage must draw from the user's interactive Claude Pro/Max and ChatGPT Plus/Pro plans. The Claude Agent SDK billing change (June 15, 2026) makes `claude -p` and programmatic SDK usage drain a separate credit pool — this is disallowed.
2. **Platform: macOS and Windows.** Both first-class. Linux is bonus, not required.
3. **Tools: Claude Code and Codex CLI.** Both first-class. User can switch between them with zero or minimal migration.
4. **Workspace portability.** Same project folder works for both tools (`cd ~/my-roster && claude` or `cd ~/my-roster && codex`).
5. **Compact and lightweight.** Avoid custom daemons, brokers, or orchestration frameworks. Prefer native tool primitives.
6. **Maintenance windows.** Occasionally the user will update Claude Code or Codex; the system must tolerate scheduler downtime and resume cleanly.
7. **Context management.** User must be able to `/clear` their own chat sessions freely. The system must do its own context management for any long-lived sessions.

### Forces at play

- Each tool has a different scheduling primitive set. Claude Code has Desktop Scheduled Tasks (local) and Cloud Routines (GitHub-connected cloud). Codex has app Automations and `codex exec` for cron.
- Both tools support subagents with isolated context. Claude via `Task` tool with `run_in_background` / `subagent_type`; Codex via TOML-defined agents at `~/.codex/agents/` and `.codex/agents/`. Both support nested subagents.
- Each tool reads a project context file: `CLAUDE.md` for Claude, `AGENTS.md` for Codex.
- Codex on Windows has a known subagent TOML config bug ([Issue #19399](https://github.com/openai/codex/issues/19399)); workaround is runtime persona injection.
- Anthropic has not yet shipped programmatic CLI install for Desktop Scheduled Tasks ([Issue #41364](https://github.com/anthropics/claude-code/issues/41364)). Codex `codex exec` cron supports programmatic install today.
- Codex has tighter rate limits than Claude Max; Plus users hit 5-hour and weekly ceilings on heavy workloads.

## Decision

**Use each tool's native local desktop scheduling primitive as the scheduler. Each fire spawns a fresh CLI session in the workspace. Within that session, the orchestrator skill dispatches subagents via native primitives (blocking, isolated context). HITL items flow through a shared filesystem queue. Chat sessions are entirely separate and observe pending HITL items.**

```
┌─ Mac mini, always-on ───────────────────────────────────────────────┐
│                                                                      │
│  Claude Desktop app                Codex app                         │
│  - holds Claude Scheduled Tasks    - holds Codex Automations         │
│  - fires fresh `claude` sessions   - fires fresh `codex` sessions    │
│                                                                      │
│  Each fire:                                                          │
│    ┌─ Fresh CLI session in ~/my-roster/ ─────────────────────────┐  │
│    │  Loads CONTEXT.md (via CLAUDE.md or AGENTS.md symlink)      │  │
│    │  Invokes roster-orchestrator skill                          │  │
│    │  Skill dispatches subagent (Task / subagent invocation)     │  │
│    │  Subagent runs in isolated context, calls APIs, etc.        │  │
│    │  Nested subagents allowed (e.g., SDR → critic → writer)     │  │
│    │  Writes run log + status to disk                            │  │
│    │  HITL items → roster/<function>/pending/                    │  │
│    │  Exits                                                       │  │
│    └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  Chat sessions (zero to many, parallel):                             │
│    - User opens claude or codex in ~/my-roster/ for ad-hoc work     │
│    - Observe pending/ on session start, surface HITL banners        │
│    - Never own scheduling                                            │
│    - User /clear-s freely; no impact on schedules                   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Options Considered

### Option A: Custom in-session scheduler daemon (rejected)

A long-lived `claude` or `codex` session opened by `launchd`/Task Scheduler, owning a heartbeat-based lock, sleeping on `ScheduleWakeup`, dispatching subagents on wake. Multiple chat sessions coordinate via filesystem locks.

| Dimension | Assessment |
|---|---|
| Complexity | High — heartbeat lock, takeover logic, context-management loop, daily restarts |
| Cost | Free; runs under subscription |
| Scalability | OK for one user; cross-tool needs duplicate orchestrator skills |
| Team familiarity | Custom design; no prior art in either tool's ecosystem |
| Robustness | Single point of failure; session death halts all schedules |
| Context bleed | Real risk; mitigated by periodic `/clear` |

**Pros:**
- Maximum control over scheduling logic
- Cross-platform via launchd/Task Scheduler templates

**Cons:**
- Reinvents what both tool vendors now ship natively
- Heavy code surface (heartbeat, takeover, context management)
- Fragile around tool updates and crashes
- No native UI to inspect/edit schedules

### Option B: Custom MCP server for detached subagent spawning (rejected)

A roster-owned MCP server that wraps `codex exec` and `claude -p` to spawn detached subagents in fresh processes, returning handles to the parent session.

| Dimension | Assessment |
|---|---|
| Complexity | Medium — small MCP server, but maintenance ongoing |
| Cost | **Violates subscription rule on Claude** — `claude -p` bills against Agent SDK credit |
| Scalability | OK |
| Team familiarity | Established MCP pattern but requires server build |

**Pros:**
- Cross-platform parent-non-blocking subagents on Codex
- Programmatic install

**Cons:**
- **Fundamentally unsafe on Claude.** Wrapping `claude -p` in MCP would drain Agent SDK credit, violating the hard subscription-only requirement.
- Adds a dependency we maintain forever
- Unnecessary once Option C is on the table

### Option C: Native desktop-app scheduling per tool (accepted)

Claude Desktop Scheduled Tasks for the Claude side. Codex app Automations for the Codex side. Each fires a fresh CLI session. Programmatic `codex exec` cron available as a Linux/power-user fallback for Codex.

| Dimension | Assessment |
|---|---|
| Complexity | Low — no custom scheduling infrastructure |
| Cost | Free; both fires draw from interactive subscription |
| Scalability | Per-tool app handles cron natively |
| Team familiarity | Native tool features, documented and supported |
| Robustness | Apps own restart/recovery; survives crashes |
| Context bleed | Impossible — every fire is a fresh session |
| Programmatic install | Hand-off via UI today on Claude; immediate on Codex via `codex exec` cron |

**Pros:**
- Uses each tool's officially supported, subscription-billed scheduling primitive
- Fresh context per fire by construction — no `/clear` cycles needed
- No long-lived scheduler session to babysit
- Survives tool updates: apps queue schedules until they're back
- Lightweight: no daemon, no MCP, no broker
- Workspace fully portable between tools

**Cons:**
- UI hand-off for Claude schedule install until [Issue #41364](https://github.com/anthropics/claude-code/issues/41364) ships
- Linux Claude not supported (no Desktop Scheduled Tasks on Linux); user falls back to Codex `exec` cron
- Codex Plus rate limits tighter than Claude Max; heavy workloads need Pro
- Codex Windows subagent TOML bug requires workaround

### Option D: Cloud Routines for Claude (rejected as default; available as opt-in)

Anthropic-hosted Cloud Routines, GitHub-connected workspace, runs even when machine is off.

| Dimension | Assessment |
|---|---|
| Complexity | Medium — requires GitHub-connected workspace and separate secret store |
| Cost | Subscription-billed |
| Scalability | Excellent — runs in Anthropic cloud |
| Team familiarity | Native Claude feature |
| Local file access | None — only sees cloned GitHub repo |

**Pros:**
- Runs when laptop is off
- Native subscription billing
- Programmatic install via `/schedule` (in CLI today)

**Cons:**
- **Workspace must be pushed to GitHub** — meaningful prerequisite
- **Local `.env` invisible** — secrets must be duplicated into Claude's web-UI secret store
- Run-log writes come back as GitHub commits
- Doesn't satisfy the "compact and lightweight" requirement when paired with secret syncing

**Verdict:** Available as opt-in via `roster schedule install --cloud-routine --github-repo <owner/repo>` for users who explicitly want machine-off resilience. Not the default.

## Trade-off Analysis

The decisive trade-off: **owning the scheduler logic vs. delegating to the tool vendors.**

Three years ago, neither Claude Code nor Codex had local scheduling primitives. A custom in-session scheduler (Option A) or an MCP-based orchestration shim (Option B) would have been necessary. As of Feb 2026 (Codex app launch) and the Claude Desktop redesign, both tools now ship local-first scheduling natively. Owning that layer ourselves is now strictly worse than delegating.

The cost of delegation is two compromises:
1. **Schedule install is UI-driven on Claude today.** This is temporary — Anthropic is tracking the CLI install gap. Roster mitigates by generating the spec and printing import instructions; once the gap closes, install becomes one command.
2. **Linux Claude users are unsupported.** Mac + Windows is the hard requirement, so this is acceptable scope. Linux users can still use Codex side-by-side.

The benefits of delegation are large and durable:
- Roster ships ~80% less code in the scheduling layer
- Every tool update gets us scheduler improvements for free
- Subscription billing is guaranteed by the tool vendors, not by our wrapper
- Users can inspect/edit schedules in familiar UIs
- Fresh-context-per-fire eliminates a whole class of context-bleed bugs

## Consequences

### What becomes easier

- **No scheduler daemon to maintain.** Roster has no long-lived process. The CLI is invoked per-fire by the tool's app.
- **No context management for the scheduler.** Each fire is a fresh session. Nothing accumulates.
- **No heartbeat / lock / takeover protocol.** Only one schedule fires at a time per spec; no coordination problem.
- **Workspace portability is automatic.** Same folder, same `schedules.yaml`, two desktop apps reading it. `cd` is the migration.
- **Tool maintenance windows are handled by the apps.** When Claude Code or Codex updates, the apps queue schedules and resume after restart.
- **Chat sessions are unconstrained.** Users `/clear` whenever; no scheduler state lives in their context.

### What becomes harder

- **Schedule install on Claude requires UI hand-off** until [Issue #41364](https://github.com/anthropics/claude-code/issues/41364) ships. Roster prints the import spec; user pastes into the Desktop app.
- **`roster schedule list` cannot fully introspect the Desktop app's registry today.** Roster maintains a mirror in `roster/<function>/schedules.yaml` for its own truth; users must keep them in sync. `roster doctor` flags drift on best-effort comparison.
- **Linux Claude users are second-class.** They must use Codex for scheduled work, or accept Cloud Routines with GitHub-connected workspace.
- **Codex Plus users may hit rate limits on heavy schedules.** Roster ships a `roster schedule estimate-usage` advisory.
- **Codex Windows requires the TOML subagent workaround** until [Issue #19399](https://github.com/openai/codex/issues/19399) is upstream-fixed. Runtime persona injection used as transitional path.

### What we'll need to revisit

- When Anthropic ships #41364: replace Claude UI hand-off with programmatic install.
- When OpenAI fixes #19399: drop the Codex Windows persona-injection workaround.
- If Codex Plus rate limits become a blocker: reconsider whether scheduled work should default to Claude side where Max gives more headroom.
- If users demand machine-off resilience: promote Option D (Cloud Routines) from opt-in to a first-class secondary path with secret-sync tooling.

## Implementation notes

### Workspace shape

```
~/my-roster/
  CONTEXT.md                           # canonical project context
  CLAUDE.md → CONTEXT.md               # symlink (mac/linux); dual-write on Windows
  AGENTS.md → CONTEXT.md               # symlink (mac/linux); dual-write on Windows
  .env                                 # local secrets, both tools read
  roster/
    <function>/                        # gtm, design, product, ops, marketing
      schedules.yaml                   # roster's mirror of the registered schedules
      pending/                         # HITL queue
      state.md                         # last-run, last-status per agent
  <function>/<agent>/                  # e.g., gtm/sdr/
    agent.md                           # contract (tool-agnostic)
    plans/<plan>.yaml                  # workflow recipes
    subagents/<name>.md                # critic, writer, prospector, etc.
    projects/<project>/
      config/default.yaml              # tool/API bindings
      guidelines/                      # substrate
      log/runs/<ts>.md                 # run logs
```

### Tool-specific installation (handled by `roster install`)

| Concern | Claude path | Codex path |
|---|---|---|
| Orchestrator skill | `~/.claude/skills/roster-orchestrator/` | `~/.codex/skills/roster-orchestrator/` |
| Subagent definitions (global) | `~/.claude/agents/*.md` | `~/.codex/agents/*.toml` |
| Subagent definitions (project) | `<workspace>/.claude/agents/*.md` | `<workspace>/.codex/agents/*.toml` |
| Session-start hook | `~/.claude/settings.json` `SessionStart` block | `~/.codex/config.toml` pre-session block |
| Project context file | reads `CLAUDE.md` (symlink to CONTEXT.md) | reads `AGENTS.md` (symlink to CONTEXT.md) |

### Schedule install flow

```bash
# Claude side (today: UI hand-off)
roster schedule install gtm/sdr cold-outreach --cron "0 9 * * MON-FRI" --tool claude
  → writes paste-ready fields document to .roster/schedule-specs/sdr-cold-outreach.claude.fields.md
    (markdown, not JSON — Claude Desktop has no JSON-import API; see Spike 2)
  → adds entry to roster/gtm/schedules.yaml (status=pending-ui-install)
  → prints: "Open Claude Desktop → Schedule sidebar → New local task → fill in fields from the document above"

# Codex side (default: UI hand-off via app Automations)
roster schedule install gtm/sdr cold-outreach --cron "0 9 * * MON-FRI" --tool codex
  → writes paste-ready fields document to .roster/schedule-specs/sdr-cold-outreach.codex.fields.md
    (markdown — Codex Automations are created from a Codex thread in natural language, not by TOML import)
  → adds entry to roster/gtm/schedules.yaml (status=pending-ui-install)
  → prints: "Open Codex app → start a new thread → paste the message from the fields document above"

# Codex side (power-user: programmatic via codex exec cron)
roster schedule install gtm/sdr cold-outreach --cron "0 9 * * MON-FRI" --tool codex --via cron
  → writes crontab line via crontab -l | { cat; echo "..."; } | crontab -
  → adds entry to roster/gtm/schedules.yaml
  → no UI hand-off

# Opt-in cloud (Claude only, requires GitHub-connected workspace)
roster schedule install gtm/sdr cold-outreach --cron "0 9 * * MON-FRI" --tool claude --cloud-routine --github-repo firatcand/my-roster
  → uses Claude /schedule CLI command to register a Cloud Routine
  → warns about local .env invisibility
```

### Per-fire execution

Each scheduled fire produces a fresh CLI session that:

1. Loads `CONTEXT.md` (via `CLAUDE.md` or `AGENTS.md` symlink) — system prompt includes the directive to invoke `roster-orchestrator` skill on every new conversation.
2. Orchestrator skill activates, reads the fire's prompt (e.g., `Run /sdr cold-outreach for _demo`).
3. Skill dispatches the named agent via the tool's native subagent primitive:
   - Claude: `Task(subagent_type="sdr", prompt="run plan cold-outreach for project _demo", run_in_background=false)`
   - Codex: natural-language invocation of the `sdr` subagent
4. Subagent runs in fresh, isolated context. May spawn nested subagents (prospector, writer, critic). Each nested subagent has its own isolated context.
5. Subagent writes run log to `<agent>/projects/<project>/log/runs/<ts>.md` and updates `roster/<function>/state.md`.
6. HITL items written to `roster/<function>/pending/<id>.md`.
7. Subagent returns a brief status summary (~30 tokens) to the orchestrator. Orchestrator logs completion. Session exits.

### HITL surface

Two channels, both source-of-truth on `roster/<function>/pending/<id>.md`:

- **In-chat banners.** Any open chat session in the workspace polls `pending/` on session start and on user message turns. Surfaces new items as banners.
- **Slack (opt-in).** Per-function routing via `SLACK_HITL_CHANNEL_<FUNCTION>` env vars. Same `pending/<id>.md` payload; slash-command callbacks update the file when the user replies in Slack.

### Cross-tool consistency checks (handled by `roster doctor`)

- CONTEXT.md present; CLAUDE.md and AGENTS.md correctly symlinked (or dual-write content equal on Windows)
- `roster/<function>/schedules.yaml` not empty if `.roster/schedule-specs/` has entries
- Codex Windows: `~/.codex/config.toml` has runtime persona injection workaround configured
- No duplicate schedule registrations across Claude and Codex for the same agent/plan (warns; doesn't fail)
- `.env` contains expected keys referenced by registered agents

### Context management policy

| Session type | Context management |
|---|---|
| Scheduled fire (fresh CLI session) | Disposed on exit; no management needed |
| Subagent (isolated context inside a fire) | Disposed on completion; no management needed |
| User's chat session | User clears with `/clear` whenever |
| Long-lived chat session | Orchestrator skill is stateless; rereads disk on bootstrap and after `/clear` |

No long-lived scheduler session exists in this architecture. The category of "system-managed context cleaning" disappears.

## Spike Findings (2026-05-15)

Three pre-decision spikes were run on a macOS dev box (`Darwin 25.3.0`, Mac mini deployment target).

### Spike 1 — Codex headless cron auth ✅ PASS

| Check | Result |
|---|---|
| Codex installed | `codex-cli 0.129.0` at `/opt/homebrew/bin/codex` |
| `~/.codex/auth.json` permissions | `-rw-------` (owner-only) |
| `auth_mode` | `"chatgpt"` — subscription mode |
| `OPENAI_API_KEY` field | `null` — no API key path active |
| OAuth token shape | `{access_token, refresh_token, id_token, account_id}` — refresh-capable |
| `codex --version` in minimal-env shell (`env -i HOME=... PATH=/opt/homebrew/bin:...`) | runs successfully |
| `codex login status` in minimal-env shell | `Logged in using ChatGPT` |

**Conclusion:** `codex exec` from cron will authenticate via the persisted OAuth token in `~/.codex/auth.json`, refresh automatically, and bill against the ChatGPT Plus/Pro Codex quota. No TTY, no inherited shell env beyond `HOME`/`PATH` required. Verified `codex exec` syntax: positional prompt, no `--skill` or `--prompt` flag (skill is invoked by referencing it in the natural-language prompt; Codex orchestrates). Sample working cron line:

```cron
# Roster: subscription-safe cron. Restrictive env to prevent CODEX_API_KEY / OPENAI_API_KEY leak.
0 9 * * MON-FRI /usr/bin/env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" CODEX_HOME="$HOME/.codex" /opt/homebrew/bin/codex exec -C "$HOME/my-roster" -c shell_environment_policy.inherit=core "Use the sdr skill to run plan cold-outreach for project _demo" >> "$HOME/my-roster/logs/cron/sdr-cold-outreach.log" 2>&1
```

The `env -i` clears the inherited environment, allowing only `HOME`/`PATH`/`CODEX_HOME` to pass through. This prevents accidental injection of `CODEX_API_KEY` or `OPENAI_API_KEY` from the user's shell environment that would silently switch billing from ChatGPT subscription to per-token API billing.

### Spike 2 — Claude Desktop Scheduled Task spec format ⚠️ PARTIAL

| Check | Result |
|---|---|
| Claude Desktop installed | Yes (`~/Library/Application Support/Claude/`) |
| Feature flags in `claude_desktop_config.json` | `coworkScheduledTasksEnabled: true`, `ccdScheduledTasksEnabled: true` — both task systems available |
| JSON spec files for scheduled tasks | **None found** — no `schedules.json`, no `tasks.json`, no equivalent directory |
| Storage backend | `Local Storage/leveldb/` (Chromium LevelDB) — binary, opaque |
| `strings` search of LevelDB for `schedule` | Only matches sidebar-UI state (`frame-sidebar-pinned schedule customiz`). Task definitions are binary-encoded or server-side. |
| Claude CLI schedule subcommand | None (`claude --help` has no `schedule` / `routine` / `loop` surface) — confirms [Issue #41364](https://github.com/anthropics/claude-code/issues/41364) gap is open |

**Conclusion:** There is no human-readable file roster can write to install a Claude Desktop Scheduled Task. Writing to LevelDB is brittle and disallowed (Path γ). The only safe v1 path is UI hand-off (Path α): roster generates the spec block, user pastes it into the Desktop app sidebar.

### Spike β — `claude://` URL scheme deep-link ❌ NEGATIVE

| Check | Result |
|---|---|
| URL scheme registered in `Info.plist` | Yes — `CFBundleURLSchemes: ["claude"]` |
| Asar grep for `claude://[a-zA-Z0-9_/-]+` literals | **Only `claude://cowork/shared-artifact`** found |
| Routes for schedule/routine/task | **None** |
| Probes (`open -g "claude://schedule"`, `claude://schedule/new`, `claude://routine`, `claude://task/new`, etc.) | No observable response — URLs unhandled by the app |

**Conclusion:** The `claude://` URL scheme is reserved for Cowork shared-artifact links. There is no schedule-creation deep-link route. Path β is dead; UI hand-off remains the only viable approach until [Issue #41364](https://github.com/anthropics/claude-code/issues/41364) is shipped.

## Codex review findings (2026-05-15)

A second-opinion review of this ADR + Phase 2.5 plan was run via `codex exec` (subscription-safe). Findings incorporated below; raw severity tags from Codex preserved.

### Corrections applied to this ADR

- **[BLOCKER] Cron syntax fixed.** Original sample used invented `--skill`/`--prompt` flags. Replaced with positional-prompt syntax verified against `codex exec --help`. `env -i` restrictive-env wrapper added to prevent API-key env-var leak (see below).
- **[BLOCKER] "JSON spec" language replaced.** Spike 2 confirmed Claude Desktop has no JSON-import format. Earlier passages still implied roster generates a "valid JSON spec" — corrected to "paste-ready prompt + cron + workspace fields" stored as `.fields.md`, not `.json`. Same fix applied to Phase 2.5 task acceptance criteria.
- **[BLOCKER] Codex subscription-safety hardened.** `codex exec` honors `CODEX_API_KEY`, `OPENAI_API_KEY`, `CODEX_HOME`, and `config.toml` `model_provider` overrides — any of which can silently route billing to per-token API. Roster doctor and the cron generator now enforce: (1) `env -i` wrapper for cron, (2) explicit blocklist of `CODEX_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY` in the cron env, (3) `CODEX_HOME` pinned to `$HOME/.codex`, (4) audit of `config.toml` for non-default `model_provider` blocks.
- **[BLOCKER] Codex Automation hand-off correction.** Codex Automations are created from a Codex thread via natural language, not by importing a TOML file. Earlier passages assumed TOML import; corrected throughout. The TOML path under `~/.codex/agents/` remains valid for **subagent** definitions; it does NOT define schedules.
- **[MAJOR] Codex subagent TOML schema.** Current schema uses `developer_instructions` and `model_reasoning_effort` (not older `instructions`/`reasoning_effort`). Roster's subagent generator must emit the current field names; schema-generation tests added to Phase 2.5.
- **[MAJOR] "Apps queue schedules" claim softened.** Behavior across Claude Desktop and Codex app updates is undocumented. Statements downgraded to "best-effort, not relied upon." Roster's missed-fire detection logic does not assume queueing — it explicitly handles missed windows.

### Skill install path note

Both `~/.codex/skills/` (Codex-native; verified present on dev machine) and `~/.agents/skills/` (cross-tool community path referenced in some Codex docs and used by gstack-style ecosystems) coexist. Roster installs the orchestrator skill to `~/.codex/skills/roster-orchestrator/` as the canonical Codex location, and `roster doctor` warns if the alternate `~/.agents/skills/roster-orchestrator/` exists and diverges.

### New requirements added to Phase 2.5

The following came from Codex's MAJOR/MINOR/NICE list and were promoted to first-class Phase 2.5 tasks rather than deferred:

- **Schema validation of `schedules.yaml`** — JSON Schema (or Zod), `roster schedule validate` command, rejection behavior on malformed entries.
- **Failure observability** — missed-fire detection (expected-vs-actual), nonzero-exit capture, `codex exec --json` event capture, stale `last_run` detection, error-class HITL items.
- **Secrets handling hardening** — `.env` permission check (require `0600`), log redaction policy, scan installed templates/skills for secret literals, env-var policy enforcement in cron generator.
- **`--dry-run` mode** — install/run/doctor commands accept `--dry-run` and print cron line, prompt, resolved auth mode, env redactions, next due, without invoking the model.
- **Migration from `agent-team`** — moved from P3-T08 to a P2.5 task because the scheduling design needs to inform the migration plan.
- **`roster schedule estimate-usage` command** — count message-equivalents per fire (including subagent fanout and retry assumptions), aggregate per day/week, compare against ChatGPT/Claude plan limits.

## Action Items

1. [x] **Validate Codex headless cron auth.** Done — Spike 1 above.
2. [x] **Confirm Claude Desktop Scheduled Task spec format.** Done — Spike 2 above. Format is opaque LevelDB; no JSON write-path. UI hand-off is the v1 mechanism.
3. [ ] Decide CONTEXT.md content structure: directive blocks for orchestrator invocation, link sections to per-function CONTEXT files, etc.
4. [ ] Sketch `roster schedule install` CLI: argument parsing, spec generation, UI hand-off messages (Claude) vs programmatic install (Codex `exec` cron or app Automation), registry write to `roster/<function>/schedules.yaml`.
5. [ ] Implement `roster-orchestrator` skill (one canonical body; per-tool installer renders the appropriate frontmatter and per-tool subagent invocation idioms).
6. [ ] Implement `roster doctor` checks listed in "Cross-tool consistency checks".
7. [ ] Document the Codex Windows TOML subagent workaround in `docs/SCHEDULING.md` ([Issue #19399](https://github.com/openai/codex/issues/19399)).
8. [ ] Document the Linux Claude gap and recommended fallback (use Codex) in `docs/SCHEDULING.md`.
9. [ ] Add a Phase 2.5 task block to `plans/phases.yaml` covering scheduling primitives, orchestrator skill, doctor checks, and schedule-management CLI.
10. [ ] Open follow-up ADR-0002 once Anthropic ships [Issue #41364](https://github.com/anthropics/claude-code/issues/41364) to capture the migration from UI hand-off to programmatic install on the Claude side.
11. [ ] Periodically re-check the `claude://` URL scheme route table on each Claude Desktop release — if a schedule-creation deep-link appears, promote it from "future investigation" to a first-class install path (lighter than UI hand-off, faster than waiting on #41364).

## References

- [Use the Claude Agent SDK with your Claude plan (billing change June 15, 2026)](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Automate work with routines — Claude Code Docs](https://code.claude.com/docs/en/routines)
- [Schedule tasks on the web — Claude Code Docs (Cloud Routines)](https://code.claude.com/docs/en/web-scheduled-tasks)
- [Automations — Codex app (OpenAI Developers)](https://developers.openai.com/codex/app/automations)
- [Non-interactive mode — Codex (codex exec)](https://developers.openai.com/codex/noninteractive)
- [Using Codex with your ChatGPT plan (OpenAI Help Center)](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [Subagents — Codex (OpenAI Developers)](https://developers.openai.com/codex/subagents)
- [The Codex CLI Customisation Stack](https://codex.danielvaughan.com/2026/04/12/codex-cli-customisation-stack-unified-system/)
- [Issue #41364 — Share scheduled tasks between CLI and Desktop](https://github.com/anthropics/claude-code/issues/41364)
- [Issue #19399 — Codex Windows subagent TOML config bug](https://github.com/openai/codex/issues/19399)
- [claude -p suggested to Max subscriber — caused unintended API billing](https://github.com/anthropics/claude-code/issues/37686)
- Roster files: `docs/ARCHITECTURE.md`, `spec/PRD.md`, `plans/phases.yaml`, `src/lib/tools.ts`
