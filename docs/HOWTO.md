# HOWTO — Roster v1.0

End-to-end walkthrough: install the CLI, scaffold a workspace, fill its substrate, create your first agent, run it, audit the install, schedule it.

Order matters — each section assumes the previous one ran clean. For design rationale, see [ARCHITECTURE.md](ARCHITECTURE.md). For the public reference, see [API.md](API.md). For scheduling specifics, see [SCHEDULING.md](SCHEDULING.md).

---

## 1. Install

```bash
npx @firatcand/roster install
```

**What it detects.** Roster looks for AI tool config dirs under your home directory:

| Tool | Config root detected | Override env var |
|---|---|---|
| Claude Code | `~/.claude/` | `ROSTER_CLAUDE_HOME` |
| Codex CLI | `~/.codex/` | `ROSTER_CODEX_HOME` |
| Gemini CLI | `~/.gemini/` | `ROSTER_GEMINI_HOME` |

Detection is presence-only: if the config root directory exists, the tool is considered installed. With multiple tools detected, Roster shows a checkbox prompt with every tool pre-selected; uncheck any you don't want to write to.

**What gets installed.** For each selected tool, Roster copies:

- `skills/<skill>/` → `<tool-config-root>/skills/<skill>/`
- Any `.md` files under `agents/` → `<tool-config-root>/agents/` (Claude Code only)

The copy is idempotent — re-running updates existing files in place.

**Symlink prompt.** If a target path is a symbolic link, Roster asks before replacing it:

```
~/.claude/skills/chief-of-staff is a symbolic link. Replace it with the bundled skill?
```

Answer `n` to keep your symlink. Roster logs it as preserved and moves on.

**EACCES (permission denied).** If the write fails with a permissions error, Roster surfaces:

```
Permission denied: ~/.claude/skills/chief-of-staff
  remedy: re-run with sudo, or run `sudo chown -R "$USER" ~/.claude/skills`
```

Re-run with `sudo npx @firatcand/roster install`, or fix directory ownership first.

---

## 2. Scaffold a workspace

```bash
mkdir my-team && cd my-team
npx @firatcand/roster init my-team
```

`init` writes a v1.0 workspace tree into the current directory:

```
my-team/
├── CLAUDE.md                  # workspace-level context for AI tools
├── CONTEXT.md                 # synthesis read by every dispatched agent
├── conventions.md             # cross-agent conventions
├── .env                       # secrets — copy from templates/env.example, gitignored
├── .gitignore                 # roster defaults appended
├── config/
│   └── project.yaml           # workspace identity (filled in next section)
├── guidelines/
│   ├── voice.md               # brand voice
│   ├── messaging.md           # value props, positioning
│   ├── brand-book.md          # tone, palette, type, do/don't
│   ├── asset-links.md         # logo / image refs
│   └── icps/                  # one persona file per ICP
├── gtm/                       # function dir + EXPERT.md
├── product/
├── design/
├── ops/
├── chief-of-staff/            # bundled cross-cutting agent
├── dreamer/                   # bundled reinforcement agent
└── scripts/                   # helper scripts shipped with the scaffold
```

**Refusal on a v0.4 workspace.** If `init` sees a `projects/` directory (or any `<function>/<agent>/projects/`), it aborts with:

```
Detected v0.4 workspace. v1.0 is a breaking change with no automatic migration.
Re-scaffold in a fresh directory; see docs/CHANGELOG.md#v1.0.0.
```

There's no migration tool — manual re-scaffold is the documented path. Existing v0.4.0 workspaces stay on v0.4.0.

**Idempotency.** Re-running `init` on a populated v1 workspace skips files that already exist; it never overwrites your edits.

**Git init prompt.** If the directory has no `.git/`, Roster asks before running `git init`. Answer `n` to skip.

---

## 3. Fill `config/project.yaml`

This file is the workspace's identity. Every agent reads it.

```yaml
# config/project.yaml
name: my-team                  # kebab-case slug, substituted by init
display_name: "My Team"        # human-readable name
stage: pre-launch              # one of: pre-launch | post-launch | scaling | mature
audience: ""                   # one-line description of who you sell to — fill this
motion: outbound               # one of: outbound | inbound | plg | hybrid
created: ""                    # yyyy-mm-dd — fill this
```

`name` and `display_name` are substituted from the `init` argument. The remaining four fields are blank or carry a sensible default — edit them before running any agent. Agents reference this file to ground their language ("you're writing for an SMB-owner audience post-launch").

---

## 4. Fill `guidelines/`

This is the substrate every agent reads. Spend an hour here before running anything; it pays back the first time `/sdr` writes copy in your voice.

- **`guidelines/voice.md`** — adjectives, tone, sentence length, vocabulary do/don't, channel notes. The shipped file is filled with example "Acme Corp" content so you see the expected shape; overwrite freely.
- **`guidelines/messaging.md`** — top value props, positioning lines, anti-positioning.
- **`guidelines/brand-book.md`** — tone, palette, type, layout rules, brand do/don't.
- **`guidelines/asset-links.md`** — pointers to logos, hero images, brand assets you host elsewhere.
- **`guidelines/icps/<persona>.md`** — one file per ideal customer profile. The shipped `_persona-template.md` is the scaffold.

You don't need every file complete on day one — most agents look up the fields they need and report what's missing. But `voice.md` and at least one ICP file should be real before you run an outbound agent.

**Adding your own guideline file:** create `guidelines/<name>.md` and reference it from each agent that needs it via `config.yaml` `guideline_refs:` — that's the whole project-local tier. To promote it to workspace-canonical (audited, and optionally a default ref for every future agent), follow the short checklist in your workspace's `conventions.md` § "Adding a new guideline file".

---

## 5. Workspace secrets — `/.env`

```bash
cp templates/env.example .env
chmod 600 .env
```

Open `.env` and fill the keys you'll use. The example file is grouped by purpose (Linear, Slack, LLM providers, per-agent tool keys). Uncomment what you need; leave the rest commented.

**Permissions.** Roster requires `0600` on `.env`. `roster doctor` check 11 warns at `0644` and errors if world-readable.

**What goes here:**

```dotenv
# Linear (for MCP-driven workflows)
LINEAR_API_KEY=lin_api_xxx
LINEAR_TEAM_ID=TEAM-xxx

# Slack HITL routing
SLACK_BOT_TOKEN=xoxb-xxx
SLACK_HITL_CHANNEL_GTM=gtm-hitl
SLACK_HITL_CHANNEL_ADMIN=admin-hitl

# LLM providers (for cron-driven flows outside the host CLI)
OPENAI_API_KEY=sk-xxx
ANTHROPIC_API_KEY=sk-ant-xxx

# Per-agent tool keys (declared by the agents that use them)
APOLLO_API_KEY=...
HEYREACH_API_KEY=...
```

Per-agent overrides come later (see [§7](#7-agent-env-overrides)).

---

## 6. Create your first agent

```bash
claude                                            # or `codex`, or open Cursor
/chief-of-staff create-agent gtm sdr
```

This scaffolds an SDR agent under `gtm/sdr/`. The skill runs in one of two modes:

| Mode | When it fires | What it produces |
|---|---|---|
| **guided** | TTY context, no `AGENT_TEAM_NO_CONFIRM` env var | A short interview, then a fully populated `agent.md`, real subagent files, a starter plan if you named one, and a ≤ 80-char slash-command description. |
| **stub** | non-TTY context, `AGENT_TEAM_NO_CONFIRM=1`, or `mode=stub` inline | `agent.md` with `<placeholder>` strings throughout; a TODO slash-command description; empty `plans/`. You fill it in by hand. |

Mode selection priority: inline `mode=` argument → `AGENT_TEAM_NO_CONFIRM=1` env → TTY detection.

The same slash command works identically across Claude Code, Codex CLI, and Gemini — the dialogue rendering may differ slightly but the five-phase contract and the on-disk output are identical.

### Guided mode — worked example

**Phase 1 — Prose intake.** The skill opens with a single question:

> Describe what this agent does in 1–3 sentences. What does one run produce, on what input, for whom?

A realistic answer:

> Drafts cold outreach to founders at SMB SaaS companies that just raised a seed round. Reads our voice, messaging, and ICP. Outputs 3–5 personalized first-touch emails for HITL review. Runs Monday mornings.

**Phase 2 — Classify.** The skill silently partitions every required `agent.md` field into boilerplate / grounded / uncertain. You don't see this step — it just shapes Phase 3.

**Phase 3 — Targeted follow-ups.** One question per gap. Realistic sequence:

> Q1: Your prose mentions HITL on the drafts. Does this agent have a separate critic pass, or does the writer go straight to HITL?
>
> *— Add a critic subagent that scores tone and brand fit before HITL.*
>
> Q2: Which LLM should the writer use? Any MCP or web search?
>
> *— Claude Sonnet 4.6 for both writer and critic. No web search.*
>
> Q3: You said "runs Monday mornings." Want a starter plan file? What should it be named?
>
> *— Yes, `cold-outreach`.*
>
> Q4: What should happen if the prospect list is empty when the plan fires?
>
> *— Skip the run, log a warning. Don't draft on nothing.*
>
> Q5: Outputs — one `.md` per email, or one `.md` per batch?
>
> *— One per batch. Easier to scan in HITL.*

Five focused questions, one fact each — no bundling, no leading defaults. The skill never invents content; if something's missing, it asks.

**Phase 4 — Consolidated preview.** You see every file path that will be written, the full `agent.md`, the slash-command description, the `subagents/critic.md` body, and the `plans/cold-outreach.yaml` skeleton:

```
Will write:
  gtm/sdr/agent.md                                (3.2 KB, populated)
  gtm/sdr/config.yaml                             (canonical, tool bindings)
  gtm/sdr/subagents/critic.md                     (1.1 KB, 6 sections filled)
  gtm/sdr/subagents/_template.md                  (canonical)
  gtm/sdr/plans/cold-outreach.yaml                (4 steps, matches agent.md)
  gtm/sdr/plans/.gitkeep                          (canonical)
  gtm/sdr/README.md                               (canonical)
  gtm/sdr/.mcp.json                               (canonical)
  gtm/sdr/.claude/settings.json                   (canonical)
  .claude/commands/sdr.md                         (slash command, 68 chars)

Slash command description (≤ 80 chars):
  "gtm sdr — draft cold outreach for SMB SaaS founders in our voice for HITL"

[y / revise <section> / cancel]
```

`revise plans` re-enters Phase 3 for just that section, then re-renders the full preview. Loop until you type `y` or `cancel`.

**Phase 5 — Atomic write.** Final confirm, then the skill creates directories parent-before-child, writes files in deterministic order with `agent.md` last (canonical-contract guarantee), and finally writes the slash command outside the rollback root. Post-write summary:

```
Wrote gtm/sdr/ (9 files, 4 directories).
Wrote .claude/commands/sdr.md.
Logged to chief-of-staff/logs/operations-2026-05-22.md (outcome: success).
```

If anything fails between directory creation and the last byte of `agent.md`, the skill rolls back the entire agent tree in reverse order and leaves the workspace clean. The slash command write is treated separately — if it fails after the agent tree is canonical, you get a `--slash-only` retry message instead of a rollback.

### Stub mode (CI / headless)

```bash
AGENT_TEAM_NO_CONFIRM=1 /chief-of-staff create-agent gtm content
```

Writes the canonical tree under `gtm/content/` with placeholder strings, prints the list of paths created, and exits. No prompts. The output is byte-identical to invoking `bash scripts/new-agent.sh gtm content` directly. Use this when you're scripting workspace setup or you already know what you want and just need the scaffold.

If a non-interactive run partially fails (rare — usually a permission error on `.claude/commands/`), the agent tree is canonical but the slash command may not exist. Recover with:

```bash
bash scripts/new-agent.sh --slash-only gtm content
```

`--slash-only` writes only `.claude/commands/<agent>.md`; it refuses to clobber an existing file (delete it first if you need to retry).

### When to pick which mode

- **Use guided** the first time you create an agent of a given role. The follow-up questions catch gaps you wouldn't think to fill in a stub.
- **Use stub** when you're cloning an existing agent's shape, scripting setup in CI, or you just want the directory tree to land so you can edit `agent.md` in your editor.

---

## 7. Agent `.env` overrides

An agent can override (or explicitly opt out of) workspace `.env` keys with its own `.env` at `<function>/<agent>/.env`:

```dotenv
# gtm/sdr/.env
OPENAI_API_KEY=sk-sdr-quota-xxx     # override workspace value
APOLLO_API_KEY=                     # explicit opt-out: don't inherit from workspace
# SLACK_BOT_TOKEN not declared      # inherits from /.env
```

Resolution is **per-key**: keys present here win, keys defined as empty here are explicit-unset, keys absent here inherit from `/.env`. See [ARCHITECTURE.md §Env resolution](ARCHITECTURE.md#env-resolution) for the model.

**Permissions.** Agent `.env` files require `0600`. `roster doctor` check 13 warns at `0644` and errors if world-readable.

**Common pattern.** Use agent `.env` to:
- Bind a per-agent rate-limited key (separate Apollo seat for the SDR vs Product)
- Opt out of a workspace key the agent shouldn't touch (set the key to empty)
- Stage a new key per-agent before rolling it to the workspace

Most agents don't need a `.env` — only create one when an override matters.

---

## 8. Run a plan

```bash
/sdr run cold-outreach
```

The slash command is a thin router. It:

1. Reads `gtm/sdr/plans/cold-outreach.yaml`.
2. Calls `resolveAgentEnv(cwd, "gtm/sdr")` → merged env dict.
3. Reads `gtm/sdr/config.yaml` → resolves `guideline_refs`.
4. Reads `gtm/sdr/agent.md` → behavioral prompt.
5. Dispatches to the host's subagent primitive (Claude `Task` tool / Codex agent / Gemini equivalent) with the merged env in scope.

No project resolution. No "which project" prompt.

**Common failures** (the router handles each with a clear message):

| Failure | Message you'll see |
|---|---|
| Plan file missing | Lists plans under `gtm/sdr/plans/` |
| Agent directory missing | "Suggest: `/chief-of-staff create-agent gtm sdr`" |
| Required tool env unset | Names the missing key and the file you should set it in |
| Workspace-root path in `config.yaml` references a missing file | Names the broken `guideline_refs:` entry |

**Listing plans.** `/sdr` (with no args) lists every plan under `gtm/sdr/plans/` and prompts you to pick one.

**Output.** Run output lands at `gtm/sdr/logs/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`. HITL items land in `gtm/sdr/pending/`.

---

## 9. Audit — `roster doctor`

```bash
roster doctor
roster doctor --fix      # interactive fix mode for checks 11, 13, 15
roster doctor --json     # machine-readable output
```

Runs 15 checks against the workspace. Categories:

- **Install integrity** (1–10) — bundled skills/agents are present, schema versions match, no orphans.
- **Secrets hygiene** (11) — workspace `/.env` permissions `0600`.
- **Schedule drift** (12) — every entry in `roster/<function>/schedules.yaml` resolves to a real (agent, plan) pair.
- **Agent env hygiene** (13–15):
  - **Check 13** — every `<agent>/.env` is `0600`. Warns at `0644`, errors world-readable.
  - **Check 14** — agent `.env` keys that duplicate the workspace `.env` value (redundant — inherits anyway). Warns and offers `--fix` to delete.
  - **Check 15** — every `env_var:` referenced by a `<agent>/config.yaml` resolves to a value in the merged env. Errors with the offending agent path, missing key, and the file to fix.

`roster doctor` exits non-zero on any error. Wire it into CI to catch drift before it ships.

---

## 10. Scheduling

```bash
roster schedule install --tool claude --plan cold-outreach --agent gtm/sdr --cron "0 9 * * MON"
roster schedule validate
```

Schedules fire from each host's native scheduler — Claude Desktop Scheduled Tasks, Codex Automations, or a hardened crontab line (`--tool codex --via cron`). All model usage bills against your interactive Claude Pro/Max or ChatGPT Plus/Pro plan; `claude -p` and the Anthropic Agent SDK are banned and enforced by `roster doctor`.

Schedule entries are 2-tuples (`agent`, `plan`) — there's no `project` field in v1.0. Passing `--project` prints a removal hint and exits.

Platform × tool matrix, UI hand-off flow, Codex `--via cron` envscubbing, and the subscription-billing guarantees live in [SCHEDULING.md](SCHEDULING.md). Architectural rationale in [ADR-0001](adr/0001-scheduling-architecture.md).

---

## 11. Set up the brain

The **brain** is a workspace-scoped, append-only Postgres store the agent team reads and writes instead of scattering knowledge across markdown. It's bring-your-own — point it at a Neon (or any Postgres) database. Optional: a scaffolded workspace works fine without one.

```bash
# 1. Put the admin connection string in Infisical (never .env), e.g. under /<repo>:
#      ROSTER_BRAIN_ADMIN_URL = postgresql://<user>:<pw>@<host>/<db>?sslmode=require
#    (Neon: copy the connection string from the project dashboard.)

# 2. Provision schema + a restricted, append-only runtime role. Prints a runtime
#    connection string ONCE — store it back in Infisical as ROSTER_BRAIN_URL.
infisical run --env dev --path /<repo> -- roster brain init

# 3. Verify append-only safety + that migrations are current.
infisical run --env dev --path /<repo> -- roster brain doctor
```

The **runtime** role (`ROSTER_BRAIN_URL`) is what agents use day-to-day — it can only SELECT and INSERT, never UPDATE/DELETE/DROP, so the brain is append-only at the database level. `roster brain init` uses the **admin** role (`ROSTER_BRAIN_ADMIN_URL`); keep that one for setup, migrations, and backups only.

**Semantic search** is off by default — keyword + graph search work with no API key, no paid calls. To enable vector search:

```bash
infisical run --env dev --path /<repo> -- roster brain config set embeddings.enabled true
# requires OPENAI_API_KEY in the injected environment (text-embedding-3-small)
```

Day-to-day use is the `/brain` skill and the `roster brain` verbs (full reference in [API.md](API.md) §Brain). Where each piece of knowledge goes is governed by `brain/RESOLVER.md` in your workspace.

The brain is append-only, so replaced fact versions and re-mounted file chunks accumulate. `roster brain gc` (admin URL, like `init`) prunes superseded **versions** once both the version and its replacement are older than the retention window — 2 years by default (`--older-than 18mo` per run, or persist with `roster brain config set gc.retention 18mo`). The current version of everything always survives, whatever its age, and events/edges (visible history) are never touched. It previews counts and only deletes with `--yes` — append-only enforcement for agents is unaffected; gc is the one sanctioned deleter and never runs as the runtime role.

---

## 12. Back up the brain

The Postgres brain (`roster brain`) is durable team memory. If the Neon project is lost, there's no recovery path unless you keep portable backups.

```bash
# Dump every brain table (core + agent-created) to a portable directory.
# Reads brain_meta, so it needs the admin URL (the same one `roster brain init` uses).
infisical run --env dev --path /<repo> -- roster brain export --out ./backups/brain-$(date +%F)

# JSONL data files (one per table + manifest.json) are always written — they are
# what `roster brain import` restores from. --format sql ADDITIONALLY drops a
# standalone dump.sql you can replay with psql (see below):
roster brain export --out ./backups/brain-sql --format sql
```

Restore into a **fresh, empty brain** (import preserves row ids, so it refuses a brain that already holds data):

```bash
roster brain init                       # provision schema + runtime role on the target
roster brain import ./backups/brain-2026-06-26
```

Import runs the schema migrations, recreates agent-created tables through the brain's table broker, reloads every row with its original id (in one transaction, verified against the manifest's row counts + content checksums), and resets the identity sequences. The backup's schema version must match the installed `roster` exactly — restore with the same roster version that produced the dump.

A `--format sql` backup also contains a standalone `dump.sql`. `roster brain import` never executes it (it always restores from the verified JSONL); to replay it directly instead, run it against a freshly `roster brain init`-ed brain atomically:

```bash
psql "$ROSTER_BRAIN_ADMIN_URL" --single-transaction -f ./backups/brain-sql/dump.sql
```

### Periodic backups (cron)

```cron
# Daily 03:00 brain backup, keeping one directory per day. env -i scrubs the
# environment; Infisical injects ROSTER_BRAIN_ADMIN_URL (never a .env file).
0 3 * * *  cd /path/to/workspace && infisical run --env dev --path /<repo> -- \
  roster brain export --out "backups/brain-$(date +\%F)" >> logs/brain-backup.log 2>&1
```

Or hand the same command to a managed schedule via `roster schedule` so failures surface in the HITL inbox.

---

## 13. Drive tasks on your tracker

Roster can drive discrete tasks (claim → start → submit → done) on **your own issue
board** — Notion in v1. The CLI owns the state machine; the `/tasks` skill is the chat
front door. Every claim is human-initiated: there is no autonomous pickup.

### Connect Notion

1. Create an [internal Notion integration](https://www.notion.so/my-integrations) and
   copy its secret.
2. Share your task board (the database) with that integration (`•••` → Connections).
3. Make the secret available as `NOTION_TOKEN` **in the process environment** where you
   run `roster` — `roster task` reads `process.env.NOTION_TOKEN` and does not load
   `/.env` files itself. Export it in your shell profile, or wrap each call with your
   secret manager's runner (e.g. `infisical run -- roster task list`). Never commit it.

Your Notion identity is derived from the token at runtime (`fetch self`) — it is never
stored on disk.

### Map the board

```bash
roster task setup --data-source <collection://…|uuid>
```

The wizard introspects the board's status property and suggests a mapping from your
status names onto roster's canonical lifecycle
(`ready → claimed → active → review → done`, with `blocked`/`cancelled` branches).
Adjust with `--map ready=To do,active=Doing,done=Done`, then re-run with `--yes` to
write `roster/tracker.yaml`. Only `ready`, `active`, and `done` are required — unmapped
optional stages collapse (e.g. with no review status, `done` completes directly from
active, and `submit` becomes a guided no-op).

Multiple projects on one board? Set the optional project filter in `tracker.yaml` so
list/status only see your rows.

### Work the lifecycle

```bash
roster task list              # claimable pool + your in-flight tasks
roster task status            # stage digest + ⚠ needs-your-attention
roster task claim TASK-12     # self-assign (+ status, if claimed is mapped)
roster task start TASK-12     # → active
roster task block TASK-12 --reason "waiting on legal"   # comment first, then status
roster task unblock TASK-12
roster task submit TASK-12    # → review
roster task done TASK-12      # → done
```

Selectors accept the board's unique id (`TASK-12`), a raw page id, or part of the
title (fuzzy; ambiguity lists candidates instead of guessing). All commands take
`--json` and `--cwd`.

From chat, `/tasks` translates plain language ("what's ready?", "work on the landing
page", "I'm blocked on copy", "send it for review", "status update") into these verbs —
it never writes the board directly.

### Multi-user boards

One shared board, many rosters: each teammate runs roster with their **own**
`NOTION_TOKEN`, so assigned-to-me and the claimable pool are scoped per person.
Unassigned Ready tasks are the shared pool; `claim` self-assigns. A Ready task already
assigned to you counts as yours (it shows under Claimed / assigned, not the pool).

Caveats: `block` posts the reason as a board comment before any status write, so the
reason survives even if the status change fails; on boards with **no Blocked status
mapped**, the task stays Active after `block` — check board comments for context.

---

## 14. Get a second opinion

`roster second-opinion` sends any artifact to a **different** AI CLI and returns a structured verdict. Use it when you want an independent read on a diff, a draft, or a set of files — without context from the model that produced the original.

### When to use it

- **Before merging**: `roster second-opinion --diff HEAD~1` routes everything changed since the previous commit to Codex (default host) for a fresh read.
- **On a prose or messaging draft**: `roster second-opinion guidelines/messaging.md --message "Is the positioning sharp?"` gets structured critique you can triage.
- **Piped from another tool**: `cat spec.md | roster second-opinion --stdin --host gemini`.

### What the verdict looks like

```json
{
  "summary": "The diff is sound but one naming inconsistency will confuse downstream agents.",
  "findings": [
    { "severity": "minor", "message": "...", "location": "src/lib/foo.ts:12", "confidence": 8 }
  ],
  "host": "codex",
  "structured": true
}
```

Omit `--json` to get a plain-text summary. Severity levels: `major`, `minor`, `nit`, `praise`. Pass `--message "<focus>"` to narrow the reviewer's attention (e.g., `"focus on subscription-safety"`).

### `HOST_NOT_SUBSCRIPTION`

If the target CLI would bill per-token — an API key in the environment, `apiKeyHelper` configured, or Bedrock/Vertex detected — `roster second-opinion` exits with `HOST_NOT_SUBSCRIPTION` **before spawning anything**. Options:

- Switch host: `--host gemini` or `--host codex` (whichever authenticates via subscription OAuth on this machine).
- Log in via the target CLI's subscription auth and retry.
- Do not export `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` to work around this — that defeats the subscription-safe guarantee and the preflight will still refuse.

The `/second-opinion` skill is the chat front door (Claude Code / Codex / Gemini); every dispatch routes through the CLI and hits the same preflight.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Permission denied` on install | Re-run with `sudo`, or `sudo chown -R "$USER" ~/.claude/skills` |
| Symlink prompt during install | Answer `y` to replace, `n` to keep your symlink |
| No AI tool detected (install exits with no targets) | Install Claude Code, Codex CLI, or Gemini first — Roster looks for their config dirs |
| `Detected v0.4 workspace` on `init` | v1.0 has no migration tool. Re-scaffold in a fresh directory; see CHANGELOG#v1.0.0 |
| Skills not picked up by host CLI after install | Restart the host CLI so it re-reads its config dir |
| `roster doctor` check 13 errors on a fresh agent | Run `chmod 600 <function>/<agent>/.env`, or `roster doctor --fix` |
| `roster doctor` check 15 errors with a missing key | Add the key to `/.env` (workspace default) or to `<agent>/.env` (agent override) |
| Agent reads the workspace value when I set the agent value to empty | That's the explicit-unset behavior — empty in agent `.env` means "don't inherit". Add the value back if you wanted to inherit. |
| `--project removed in v1.0 — see CHANGELOG` from `roster schedule install` | Drop the `--project` flag. v1.0 schedules are 2-tuples (`agent`, `plan`). |
| `/<agent>` slash command not found after `create-agent` | Check `.claude/commands/<agent>.md` exists; if not, `bash scripts/new-agent.sh --slash-only <fn> <agent>` |
| `another roster migrate is writing this workspace's migration manifest` | A concurrent `roster migrate` holds the manifest lock (the error names its pid and age) — wait for it to finish, then retry. |
| `stale migration-manifest lock — the run that created it likely crashed` | The lock is over 15 minutes old. Locks are never broken automatically: verify no `roster migrate` is running, then delete the `.roster/migration-manifests/*.json.lock` file named in the error and retry. |
