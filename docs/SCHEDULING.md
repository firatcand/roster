# Scheduling

Roster runs agents on a schedule by **delegating to each AI tool's native local scheduler** — never via custom daemons, never via `claude -p`, never via Agent SDK. Every fire opens a fresh CLI session that loads `CONTEXT.md`, invokes the `roster-orchestrator` skill, and dispatches subagents in isolated context. All model usage bills against your interactive Claude Pro/Max or ChatGPT Plus/Pro plan.

Architecture rationale: [ADR-0001](adr/0001-scheduling-architecture.md).

---

## Platform × tool matrix

Six cells, one row per supported tool. Cell content = the supported install path on that platform.

| Tool ↓ / Platform → | macOS | Windows | Linux |
|---|---|---|---|
| **Claude Code** | Claude Desktop Scheduled Tasks (UI hand-off via `roster schedule install --tool claude`) | Claude Desktop Scheduled Tasks (UI hand-off via `roster schedule install --tool claude`) | **Unsupported.** Fall back to Codex `--via cron`, or opt in to Claude Cloud Routines via `--cloud-routine` (requires GitHub-connected workspace). |
| **Codex CLI** | Codex app Automations (UI hand-off) **or** `roster schedule install --tool codex --via cron` for programmatic install. Codex `auth_mode=chatgpt` bills against ChatGPT subscription. | Codex app Automations (UI hand-off). `--via cron` works under Task Scheduler with the `env -i` wrapper. **Subagent TOML bug applies — see [Windows caveat](#codex-windows-toml-subagent-workaround).** | `roster schedule install --tool codex --via cron`. UI Automations require the Codex desktop app — use cron on headless Linux. |

> Reading the matrix: pick your row first (which CLI you're using for this agent), then your column (which OS the Mac mini / workstation is on). The cell tells you the install path Roster supports today.
>
> **Note on app restarts.** Whether a tool's desktop app re-queues missed fires after a restart or update is undocumented by both vendors and **not relied on by Roster** ([ADR-0001 § Codex review findings](adr/0001-scheduling-architecture.md#codex-review-findings-2026-05-15)). Missed fires surface as gaps in `roster schedule status` and `roster doctor`; see [Doctor checks](#doctor-checks-for-scheduling) and the [Disruption checks](#disruption-checks-optional-but-recommended) section below.

---

## Subscription-billing guarantees

Roster's hard rule: **all scheduled model usage must draw from your interactive subscription.** Never the Anthropic Agent SDK pool, never per-token API billing.

### What's banned

| Pattern | Why banned |
|---|---|
| **`claude -p "<prompt>"`** in cron / launchd / Task Scheduler | After the Claude Agent SDK billing change (June 15, 2026), `claude -p` invocations consume Agent SDK credit, not your Claude Pro/Max subscription quota. See [anthropics/claude-code#37686](https://github.com/anthropics/claude-code/issues/37686) for a Max subscriber's billing incident. **`roster doctor` greps installed skills and templates for `claude -p` and fails on match.** |
| Anthropic SDK / API key environment variables (`ANTHROPIC_API_KEY`) reachable by the scheduled job | Same outcome — switches billing to the API tier silently. |
| `OPENAI_API_KEY` or `CODEX_API_KEY` reachable by Codex `--via cron` | Codex `exec` honors these and would route billing per-token instead of via your ChatGPT plan's Codex quota. |
| Custom MCP servers that wrap `claude -p` or the Agent SDK | Same root cause; fundamentally unsafe even when convenient. |

### What's enforced

Roster ships these guardrails:

1. **Codex `--via cron` env scrubbing.** Generated crontab lines wrap the call in `/usr/bin/env -i` and explicitly pass only `HOME`, `PATH`, `CODEX_HOME`. Verified subscription-mode in Spike 1 of [ADR-0001](adr/0001-scheduling-architecture.md#spike-1--codex-headless-cron-auth--pass):

   ```cron
   # roster-generated; do not edit by hand
   0 9 * * MON-FRI /usr/bin/env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" CODEX_HOME="$HOME/.codex" /opt/homebrew/bin/codex exec -C "$HOME/my-roster" -c shell_environment_policy.inherit=core "Use the roster-orchestrator skill to run plan cold-outreach for agent sdr" >> "$HOME/my-roster/logs/cron/sdr-cold-outreach.log" 2>&1
   ```

2. **`roster doctor` checks** — see [doctor checks](#doctor-checks-for-scheduling) below. Static greps for the banned strings; env-blocklist enforcement; `~/.codex/auth.json` `auth_mode` verification; `config.toml` audit for non-default `model_provider` blocks.

3. **No `claude -p` in any shipped script.** Roster's installed skills and templates are scanned at publish time and on `roster doctor`.

### What's allowed

- Claude Desktop Scheduled Tasks fire **interactive** `claude` sessions — these bill against your Claude Pro/Max plan.
- Codex app Automations fire **interactive** `codex` sessions — these bill against your ChatGPT plan's Codex quota.
- Codex `exec` cron with `auth_mode=chatgpt` and a clean env — bills against the same ChatGPT quota as the app.
- Claude Cloud Routines (opt-in, `--cloud-routine`) — Anthropic-hosted, bills against your Claude subscription. See [Cloud Routines opt-in](#cloud-routines-opt-in).

---

## Claude Desktop Scheduled Tasks — UI hand-off flow

Anthropic has not yet shipped a programmatic CLI install for Desktop Scheduled Tasks ([anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364)). Spike 2 of [ADR-0001](adr/0001-scheduling-architecture.md#spike-2--claude-desktop-scheduled-task-spec-format--partial) confirmed there's no JSON import file and no `claude://` deep-link route (Spike β). The supported v1 path is **paste-ready field hand-off** into the Claude Desktop sidebar.

### Step-by-step

```bash
# 1. Generate the fields document + register in roster's mirror
roster schedule install gtm/sdr cold-outreach \
  --cron "0 9 * * MON-FRI" \
  --tool claude

# Roster writes:
#   .roster/schedule-specs/sdr-cold-outreach.claude.fields.md   (paste source)
#   roster/gtm/schedules.yaml                                   (mirror entry, status=pending-ui-install)
# Roster prints:
#   "Open Claude Desktop → click the Schedule icon in the sidebar →
#    'New local task' → fill in the fields below from sdr-cold-outreach.claude.fields.md"
```

The generated `.fields.md` document contains the six fields the Claude Desktop dialog expects, one per labelled section, in copy-paste order:

| Field in dialog | Source in fields document |
|---|---|
| Task name | `## Task name` |
| Prompt | `## Prompt` (the natural-language instruction that triggers `roster-orchestrator`) |
| Workspace path | `## Workspace path` (absolute path to your roster root) |
| Cron expression | `## Cron expression` |
| Allowed tools | `## Allowed tools` (read/write/edit/bash with project scope) |
| MCP servers | `## MCP servers` (filtered allowlist) |

Once you've pasted the fields and saved the task in the Desktop app, run `roster schedule status <name>` to flip the mirror entry from `pending-ui-install` to `active`. (The status update is manual today because Roster has no way to introspect Claude's LevelDB-backed task registry.)

### Why a `.fields.md` and not a `.json`

Claude Desktop stores scheduled tasks in `~/Library/Application Support/Claude/Local Storage/leveldb/` — Chromium binary LevelDB. There is no JSON import API. Roster historically called this a "JSON spec" in early drafts; that was incorrect and is now corrected throughout (`fields.md`, not `.json`). Writing directly to LevelDB is brittle and disallowed.

### What gets fixed when #41364 lands

When Anthropic ships [#41364](https://github.com/anthropics/claude-code/issues/41364), the install becomes one command: `roster schedule install --tool claude` will register the task programmatically without a UI step. The same `schedules.yaml` mirror entry will be reused. Tracked in [ADR-0002 (future)](adr/0001-scheduling-architecture.md#what-well-need-to-revisit) for the migration plan.

### Re-check protocol for `claude://` URL scheme

Spike β (2026-05-15) found `claude://` routed only `cowork/shared-artifact`; the latest probe (2026-07-02, Claude Desktop 1.15962.1) adds two non-schedule literals (`claude://claude.ai/mcp-auth-callback/sdk`, `claude://resume`) — still **no schedule-creation deep-link**, which is the only criterion that matters here: non-schedule routes get recorded in the probe artifact without follow-up. If Anthropic adds `claude://schedule/...` (or `claude://routine/...`, `claude://task/...`), Roster should promote it from "future investigation" to a first-class install path: lighter than UI hand-off, faster than waiting on [#41364](https://github.com/anthropics/claude-code/issues/41364).

**Probe script:** `scripts/probe-claude-url-scheme.sh` (macOS-only; not shipped in the npm tarball — maintainer tool).

**Cadence:** **first Monday of each month**, plus opportunistically any time Claude Desktop ships an update. The monthly anchor ensures the probe runs even if no one notices a release; the opportunistic trigger means we don't sit on a freshly-shipped route for up to 30 days.

**How to run:**

```bash
pnpm probe:claude-url
# or directly:
bash scripts/probe-claude-url-scheme.sh
```

The script performs three checks (Info.plist `CFBundleURLSchemes`, asar grep for `claude://[a-zA-Z0-9_/.-]+` literals, behaviour probes via `open -g`), prints a paste-ready Markdown report to stdout, and writes a dated artifact under `docs/probes/claude-url-scheme/<YYYY-MM-DD>.md`. Exit codes: `0` no schedule-creation routes (new non-schedule literals are recorded in the artifact, not flagged), `1` schedule-creation route detected — a literal starting `claude://schedule|routine|task` (the script prints a loud banner — see below), `2` environment problem.

**When the script exits 1** (schedule-creation route detected):

1. File a follow-up Linear ticket under Phase 2.5 to promote the route to a first-class install path in `roster schedule install --tool claude`.
2. Link the follow-up from [ROS-57](https://linear.app/firatdogan/issue/ROS-57) and update [ADR-0001 Action Item #11](adr/0001-scheduling-architecture.md#action-items).
3. Close ROS-57 referencing the follow-up.

**When the script exits 0**: paste the Markdown report into the latest comment on [ROS-57](https://linear.app/firatdogan/issue/ROS-57) with `Next probe due: <first Mon of next month>`. ROS-57 stays open — it *is* the recurring tracker.

Probe history lives in [`docs/probes/claude-url-scheme/`](probes/claude-url-scheme/).

---

## Codex Automations — UI hand-off flow

Codex Automations are created **from a Codex thread, in natural language** — there is no TOML import API for Automations. (The TOML files under `~/.codex/agents/` define **subagents**, not schedules. Don't conflate.)

### Step-by-step

```bash
roster schedule install gtm/sdr cold-outreach \
  --cron "0 9 * * MON-FRI" \
  --tool codex

# Roster writes:
#   .roster/schedule-specs/sdr-cold-outreach.codex.fields.md
#   roster/gtm/schedules.yaml                  (status=pending-ui-install)
# Roster prints:
#   "Open the Codex app → start a new thread → paste the entire message
#    from the fields document above. Codex will create the Automation."
```

The generated `.fields.md` is shorter than the Claude variant — three blocks (prompt, cron, workspace path) joined into a single paste-ready message.

### When to prefer `--via cron` instead

If any of these apply, use the programmatic `--via cron` path instead of the Automation UI:

- **Headless Linux.** No Codex app GUI to drive.
- **You want the schedule defined in version control.** A crontab line is easier to inspect and diff than an opaque Automation entry.
- **You want `roster schedule list` to see this schedule.** Today only the cron path is fully introspectable; Automations are best-effort.
- **You're scripting a fleet of schedules** for a CI environment or a paved-road platform install.

---

## Codex `--via cron` — programmatic install

```bash
roster schedule install gtm/sdr cold-outreach \
  --cron "0 9 * * MON-FRI" \
  --tool codex \
  --via cron

# Roster:
#   1. Pre-flight: confirms `~/.codex/auth.json` `auth_mode == "chatgpt"`.
#   2. Pre-flight: confirms no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CODEX_API_KEY` in the
#      current shell env (would leak into cron unless `env -i` strips them — which we do, but
#      we warn anyway in case the user is debugging).
#   3. Appends the env-scrubbed crontab line via `crontab -l | { cat; echo "<line>"; } | crontab -`.
#   4. Adds entry to roster/gtm/schedules.yaml (status=active).
#   5. Prints the exact line installed + the log file path.
```

The installed crontab line uses `/usr/bin/env -i` to wipe the inherited environment — only `HOME`, `PATH`, and `CODEX_HOME` are forwarded. This is the only way to guarantee `OPENAI_API_KEY` or `CODEX_API_KEY` from the user's shell can't silently switch Codex to per-token API billing.

### What `roster schedule estimate-usage` will tell you

Before you install a fleet of cron schedules on Codex Plus, run:

```bash
roster schedule estimate-usage
```

This walks every registered schedule, reads each agent's plan for declared subagent fanout + retry policy, multiplies by cron frequency, and reports expected messages per day/week against your plan's published limits. See [ROS-44](https://linear.app/firatdogan/issue/ROS-44) for the implementation. Recipe:

1. **Audit current schedules:** `roster schedule list --json | jq '.[] | {name, cron, agent, plan}'`
2. **Estimate:** `roster schedule estimate-usage --plan codex-plus` → outputs a daily/weekly message-equivalent table per schedule, plus aggregate.
3. **Compare against ChatGPT Plus ceiling** (5-hour and weekly rolling). If aggregate > 70% of weekly, either reduce cron frequency, drop subagent fanout, or upgrade to Pro.

---

## Codex Windows TOML subagent workaround

Codex on Windows has a known bug — subagent TOML files under `~/.codex/agents/` and `.codex/agents/` are not loaded correctly ([openai/codex#19399](https://github.com/openai/codex/issues/19399)). This breaks the `roster-orchestrator → subagent` dispatch flow on Windows installs.

### Workaround: runtime persona injection

Until [#19399](https://github.com/openai/codex/issues/19399) is fixed upstream, Roster on Windows uses **runtime persona injection** — the subagent's persona body is concatenated into the orchestrator's invocation prompt at fire time, rather than relying on Codex to resolve the TOML file.

Roster handles this automatically when `roster schedule install --tool codex` detects `process.platform === 'win32'`. The generated prompt looks like:

```
You are now acting as the <subagent-name> subagent. Your persona is:

<verbatim contents of the subagent's persona body>

Your task: <the original subagent invocation prompt>
```

The user does not configure this. The orchestrator skill on Windows reads the TOML files itself and inlines the persona; on macOS/Linux it falls back to the native subagent primitive.

### Doctor surface

`roster doctor` on Windows checks:

- `~/.codex/config.toml` either contains the persona-injection workaround block (Roster's preferred placement) or your shipped orchestrator skill version is recent enough to inline at fire time.
- No subagent TOML file under `.codex/agents/` is being silently ignored without the injection fallback registered.

When #19399 lands upstream, Roster will drop the workaround and `roster doctor --fix` will offer to remove the injection block.

---

## Linux Claude gap — fallback recommendations

Claude Desktop is not available on Linux. There is no `claude://schedule/...` deep-link, no Linux Scheduled Tasks UI, no analog. **Roster's `roster schedule install --tool claude` refuses to run on Linux** unless `--cloud-routine` is also passed.

Two supported paths if you're on Linux:

### Path A (recommended): use Codex for scheduled work

```bash
roster schedule install gtm/sdr cold-outreach \
  --cron "0 9 * * MON-FRI" \
  --tool codex \
  --via cron
```

Why this is the recommended fallback: a Mac mini deployment target was the primary spec assumption for Roster, but a Linux box with `cron` + Codex CLI + `auth_mode=chatgpt` covers the same surface area — and `--via cron` is more introspectable than either app's UI. You lose Claude Code-specific features (e.g., the Anthropic-managed subagent model) but you keep subscription billing, fresh-context-per-fire, and HITL queue semantics.

### Path B (opt-in): Cloud Routines with GitHub-connected workspace

```bash
roster schedule install gtm/sdr cold-outreach \
  --cron "0 9 * * MON-FRI" \
  --tool claude \
  --cloud-routine \
  --github-repo firatcand/my-roster
```

Trade-offs ([ADR-0001 Option D](adr/0001-scheduling-architecture.md#option-d-cloud-routines-for-claude-rejected-as-default-available-as-opt-in)):

- **Pro:** runs when machine is off; native subscription billing; immediate programmatic install via Claude's `/schedule` CLI surface.
- **Con:** workspace must be pushed to GitHub; local `.env` is invisible — secrets must be duplicated into Claude's web-UI secret store; run-log writes come back as GitHub commits.

Choose Path A unless machine-off resilience is a hard requirement.

---

## Cloud Routines (opt-in)

Available on Claude side via `--cloud-routine --github-repo <owner/repo>`. Not the default. Use when:

- You need scheduled fires while your machine is off / on the road / between updates.
- You're willing to push the workspace to GitHub.
- You're willing to duplicate `.env` keys into Claude's web-UI secret store.

Not currently supported for Codex (no Codex cloud routine primitive at parity yet).

---

## Doctor checks for scheduling

`roster doctor` ([ROS-38](https://linear.app/firatdogan/issue/ROS-38)) extends the base doctor with these scheduling-specific checks:

1. **Symlink/dual-write integrity.** `CONTEXT.md` exists and `CLAUDE.md` / `AGENTS.md` resolve to it (symlink on mac/linux; dual-write content-equal on Windows).
2. **`schedules.yaml` parse + schema.** All `roster/<function>/schedules.yaml` files match the schema and reference valid agents/plans.
3. **Cron drift detection.** Every Codex `--via cron` entry in `schedules.yaml` is cross-referenced against the live crontab. Surfaces three failure modes: a registered entry with no crontab marker block, a crontab line that differs from what `renderCronLine` would emit today, and an unreadable crontab (permissions). Implemented in [ROS-38](https://linear.app/firatdogan/issue/ROS-38); see `src/lib/doctor-scheduling-drift.ts`.
4. **Codex auth pre-flight.** `~/.codex/auth.json` `auth_mode == "chatgpt"`; no API-key field; `~/.codex/config.toml` has no non-default `model_provider` override.
5. **Banned-string scan.** Grep installed skills/templates for `claude -p`, `ANTHROPIC_API_KEY`, Agent SDK imports. Fail on match.
6. **Env-var blocklist.** Verify generated crontab lines wrap with `env -i` and don't leak `OPENAI_API_KEY` / `CODEX_API_KEY` / `ANTHROPIC_API_KEY`.
7. **Codex Windows persona-injection workaround.** Configured if platform is Windows.
8. **`.env` permissions.** Require `0600` on POSIX systems; warn otherwise.
9. **Stale `last_run`.** Per-schedule, compare `last_run` against expected `next_fire`; surface missed-fire candidates ([ROS-42](https://linear.app/firatdogan/issue/ROS-42)).
10. **Duplicate registration.** Warn if the same `<agent>/<plan>` is registered on both Claude and Codex sides simultaneously.

Most checks support `--fix`: e.g., re-create the missing `CLAUDE.md` symlink, chmod `.env` to `0600`, append a missing persona-injection block.

---

## Manual macOS Mac mini end-to-end verification

Before you trust a schedule for unattended production runs, walk through this once on the actual Mac mini. Browser-based UI hand-offs can't be CI'd; missed-fire detection in CI is intentionally muted ([ROS-40](https://linear.app/firatdogan/issue/ROS-40)).

### CI coverage vs. manual gate

Most of the install-path machinery is exercised in CI by `test/e2e-schedule.sh` (`pnpm e2e:schedule`) — it packs and globally installs the tarball, stubs `crontab` on `PATH`, installs one Codex `--via cron` schedule, asserts the generated cron line contains `env -i` + `shell_environment_policy.inherit=core`, then removes it. **No real cron entry is ever written, no scheduled session ever fires in CI** — this is intentional to avoid subscription-quota consumption from automated runs.

That leaves three things this manual gate must verify that CI cannot:

1. **Claude Desktop / Codex app UI hand-off actually flows.** The `.fields.md` artifacts paste cleanly into the dialogs and the resulting schedule fires.
2. **An interactive fire actually bills against your subscription**, not API credit (verify in the relevant usage dashboard).
3. **Real cron entries survive a reboot** and unattended app restarts.

### Pre-flight (~10 min)

1. `roster doctor` exits 0 on the workspace.
2. Claude Desktop is open and signed in to the same account holding your Pro/Max subscription.
3. Codex app is open and signed in; `codex login status` reports `Logged in using ChatGPT`.
4. `.env` is `0600` and contains the keys referenced by the agent you're about to schedule.

### Install one no-op schedule per tool

```bash
# Claude side
roster schedule install ops/heartbeat noop \
  --cron "*/5 * * * *" \
  --tool claude
# follow the UI hand-off — paste the six fields into Claude Desktop's "New local task" dialog
# expect: roster/ops/schedules.yaml entry with status=pending-ui-install
# after pasting: run `roster schedule status ops/heartbeat-noop` to flip to active

# Codex side
roster schedule install ops/heartbeat noop \
  --cron "*/5 * * * *" \
  --tool codex \
  --via cron
# expect: crontab line installed; schedules.yaml entry status=active
```

(`ops/heartbeat noop` should be a one-line plan that writes `pong` to `logs/heartbeat.log` and exits. Roster's demo workspace ships one for this purpose.)

### Observe two fires per side

Wait 10 minutes. Then:

```bash
roster schedule status ops/heartbeat-noop
# expect: last_run within the last 5 min, last_status=ok, two entries in state.md history

tail -n 20 logs/heartbeat.log
# expect: two timestamped `pong` lines

tail -n 20 logs/cron/heartbeat-noop.log   # Codex --via cron only
# expect: two `codex exec` invocations, exit code 0
```

### Verify subscription billing (cannot be automated)

The single thing the e2e shell test fundamentally cannot verify is that the fired session bills against your interactive subscription instead of API credit. After the two fires above:

- **Claude side:** Open the Claude usage page (or Settings → Plan & billing). Confirm the two fires show under your Claude Pro/Max usage counter, **not** under Agent SDK / API spend.
- **Codex side:** Open the ChatGPT usage dashboard (Settings → Plan → Usage). Confirm the two fires count toward your Codex (ChatGPT Plus/Pro) limit, **not** the API tokens dashboard at `platform.openai.com/usage`.

If either fire shows up under API spend, **stop**: `roster doctor` missed something. File against [ROS-38](https://linear.app/firatdogan/issue/ROS-38) with the exact crontab line / Scheduled Task contents.

### Disruption checks (optional but recommended)

- **Quit + relaunch Claude Desktop.** The app should resume firing the schedule on the next due window. Behavior is best-effort per [ADR-0001](adr/0001-scheduling-architecture.md#codex-review-findings-2026-05-15) — Roster's missed-fire detection explicitly does **not** rely on "apps queue schedules", so a dropped fire should surface in `roster schedule status` as a gap.
- **Reboot the Mac mini.** Same expectation. Verify `crontab -l` survives reboot (it does; cron is launchd-managed).
- **Quit Codex app.** Cron-installed schedules continue firing — they don't depend on the app being open. UI-installed Automations pause until the app is back.

### Tear down

```bash
roster schedule remove ops/heartbeat-noop --tool claude   # prints UI removal hand-off
roster schedule remove ops/heartbeat-noop --tool codex    # removes crontab line
```

If everything above behaves as documented, the platform is ready for a real schedule. If anything surprises you, file it against the relevant Phase 2.5 Linear issue ([ROS-34](https://linear.app/firatdogan/issue/ROS-34), [ROS-35](https://linear.app/firatdogan/issue/ROS-35), [ROS-38](https://linear.app/firatdogan/issue/ROS-38), [ROS-42](https://linear.app/firatdogan/issue/ROS-42)).

---

## References

- [ADR-0001 — Scheduling architecture for roster](adr/0001-scheduling-architecture.md) — full rationale, options considered, spike findings, Codex review corrections.
- [Use the Claude Agent SDK with your Claude plan (billing change June 15, 2026)](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Automate work with routines — Claude Code Docs](https://code.claude.com/docs/en/routines)
- [Schedule tasks on the web — Claude Code Docs (Cloud Routines)](https://code.claude.com/docs/en/web-scheduled-tasks)
- [Automations — Codex app (OpenAI Developers)](https://developers.openai.com/codex/app/automations)
- [Non-interactive mode — Codex (`codex exec`)](https://developers.openai.com/codex/noninteractive)
- [Using Codex with your ChatGPT plan (OpenAI Help Center)](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [anthropics/claude-code#41364 — Share scheduled tasks between CLI and Desktop](https://github.com/anthropics/claude-code/issues/41364) — when this ships, Claude UI hand-off becomes programmatic install.
- [openai/codex#19399 — Codex Windows subagent TOML config bug](https://github.com/openai/codex/issues/19399) — when this ships, Roster drops the Windows persona-injection workaround.
- [anthropics/claude-code#37686 — `claude -p` suggested to Max subscriber caused unintended API billing](https://github.com/anthropics/claude-code/issues/37686) — the incident behind the `claude -p` ban.
