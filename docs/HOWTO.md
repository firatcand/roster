# HOWTO — roster v0.1

Step-by-step guide for the two commands that ship in v0.1: `install` and `init`. The full agent-team workflow lights up in v0.2. This doc is honest about what works today.

---

## Install

```bash
npx @firatcand/roster install
```

**What it detects.** Roster looks for AI tool config dirs under your home directory:

| Tool | Config root detected |
|---|---|
| Claude Code | `~/.claude/` |
| Codex CLI | `~/.codex/` (Phase 2) |
| Gemini CLI | `~/.gemini/` (Phase 2) |

Detection is presence-only: if the config root directory exists, the tool is considered installed. Source: `src/lib/tools.ts:66-70`.

**What Phase 1 actually installs.** `install` only writes to Claude Code in v0.1 — Codex and Gemini support lands in Phase 2. For Claude Code it copies:

- `skills/chief-of-staff/` → `~/.claude/skills/chief-of-staff/`
- Any `.md` files under `agents/` → `~/.claude/agents/`

The copy is done with `fs-extra` `copy` (`overwrite: true`), so re-running is safe — existing files are updated in place. Source: `src/lib/install.ts:94-150`.

**If you have multiple tools installed.** When more than one config root is detected, roster shows a checkbox prompt with every tool pre-selected (`src/bin/roster.ts:88-117`). **In v0.1, deselect Codex and Gemini before confirming** — `installToTool` throws for any non-Claude tool (`src/lib/install.ts:95-99`). Leave only Claude Code checked. Phase 2 will turn the others into real targets.

**Symlink prompt.** If the target path is a symbolic link, roster asks before replacing it:

```
~/.claude/skills/chief-of-staff is a symbolic link. Replace it with the bundled skill?
```

Answer `n` to keep your symlink. Roster logs it as preserved and moves on.

**EACCES (permission denied).** If the write fails with a permissions error, roster surfaces:

```
Permission denied: ~/.claude/skills/chief-of-staff
  remedy: re-run with sudo, or run `sudo chown -R "$USER" ~/.claude/skills`
```

Re-run with `sudo npx @firatcand/roster install`, or fix directory ownership first.

---

## Init

```bash
mkdir my-team && cd my-team
npx @firatcand/roster init [name]
```

`name` defaults to the current directory's basename if omitted.

**What gets scaffolded.** v0.1 writes four things into the current directory:

1. `CLAUDE.md` — workspace-level context, generated from `templates/CLAUDE.project.template.md` with `{{PROJECT_NAME}}` substituted. Source: `src/commands/init.ts:57-60`.
2. `projects/_demo/README.md` — placeholder project directory copied from `templates/scaffold/`. Source: `src/commands/init.ts:131-135`.
3. `.env.example` — credential placeholder, written if no `.env.example` already exists. Source: `src/commands/init.ts:62-65`.
4. `.gitignore` — roster's default ignore patterns appended under a `# Roster defaults` marker. Idempotent: if the marker is already present, nothing is appended. Source: `src/commands/init.ts:68-82`.

**Idempotency.** If `CLAUDE.md` already exists, roster asks before overwriting:

```
CLAUDE.md already exists in this directory. Overwrite?
```

Answer `n` to cancel. Nothing is written.

**Git init prompt.** If the directory has no `.git/`, roster asks:

```
Initialize a git repo here?
```

Answer `n` to skip. This is the only prompt that has no destructive consequence either way.

**After init.** Your workspace has the minimal skeleton. The function dirs (`gtm/`, `product/`, `design/`, `ops/`), `conventions.md`, role-based agents, and scripts that power the full agent-team workflow are Phase 2 additions. The `CLAUDE.md` that roster writes tells you what's coming.

---

## First run — confirming chief-of-staff is loaded

After `roster install`, Claude Code can load the chief-of-staff skill from `~/.claude/skills/chief-of-staff/`. Slash command routing (`/chief-of-staff`) is not wired up yet — the `.claude/commands/` directory is not written by `install`. In v0.1 you invoke by natural language:

> Open Claude Code in any directory, then write:
>
> `What plans does the chief-of-staff skill support?`

Claude Code will read `~/.claude/skills/chief-of-staff/SKILL.md` and list the plans (`create-project`, `audit-repo`, `archive-project`, etc.). That confirms install succeeded.

**Don't try `audit-repo` against a v0.1 `init` workspace yet.** The skill aborts unless the cwd contains `conventions.md`, `gtm/`, and `projects/` (`skills/chief-of-staff/SKILL.md` — "Common preamble"). v0.1 `init` only writes `CLAUDE.md` + `projects/_demo/`; the rest of the scaffold lands in v0.2. Running an audit before then will exit with `Run chief-of-staff from your roster workspace root.`

---

## Creating an agent

> Available from v0.4.0. Earlier versions ship the stub-only behavior described below; the guided dialogue is the v0.4.0 addition.

`/chief-of-staff create-agent <function> <agent>` scaffolds a new role-based agent under one of your function dirs (`gtm/`, `product/`, `design/`, `ops/`, or anything you registered with `create-function`). It runs in one of two modes:

| Mode | When it fires | What it produces |
|---|---|---|
| **stub** | non-TTY context, `AGENT_TEAM_NO_CONFIRM=1`, or `mode=stub` inline | `agent.md` with `<placeholder>` strings throughout; a TODO slash-command description; empty `plans/`. You fill it in by hand. |
| **guided** | TTY context, no `AGENT_TEAM_NO_CONFIRM` env var | A short interview, then a fully populated `agent.md`, real subagent files, a starter plan if you named one, and a ≤ 80-char slash-command description. |

Mode selection priority (first match wins): inline `mode=` argument → `AGENT_TEAM_NO_CONFIRM=1` env → TTY detection.

The same slash command works identically across Claude Code, Codex CLI, and Gemini — the dialogue rendering may differ slightly (Claude Code shows it inline; Codex/Gemini show it in their respective chat surfaces) but the five-phase contract and the on-disk output are identical.

### Stub mode (CI / headless / "I'll fill it in later")

```bash
AGENT_TEAM_NO_CONFIRM=1 /chief-of-staff create-agent gtm content-agent
```

The skill writes the canonical tree under `gtm/content-agent/` with placeholder strings, prints the list of paths created, and exits. No prompts. The output is byte-identical to invoking `bash scripts/new-agent.sh gtm content-agent` directly. Use this when you're scripting workspace setup or you already know what you want and just need the scaffold.

If a non-interactive run partially fails (rare — usually a permission error on `.claude/commands/`), the agent tree is canonical but the slash command may not exist. Recover with:

```bash
bash scripts/new-agent.sh --slash-only gtm content-agent
```

`--slash-only` writes only `.claude/commands/<agent>.md`; it refuses to clobber an existing file (delete it first if you need to retry).

### Guided mode — worked example

Invoke without `AGENT_TEAM_NO_CONFIRM` in a real terminal:

```bash
/chief-of-staff create-agent gtm content-agent
```

**Phase 1 — Prose intake.** The skill opens with a single question:

> Describe what this agent does in 1–3 sentences. What does one run produce, on what input, for whom?

A realistic answer:

> Drafts long-form Substack posts on B2B SaaS positioning. Reads our brand voice, recent posts, and a one-line topic brief. Outputs a draft post in markdown ready for human review through HITL. Runs weekly on Sundays.

**Phase 2 — Classify.** The skill silently partitions every required `agent.md` field into boilerplate / grounded / uncertain. You don't see this step — it just shapes Phase 3.

**Phase 3 — Targeted follow-ups.** One question per gap. Realistic sequence:

> Q1: Your prose mentions HITL for the draft review. Does this agent have any subagents (e.g. a separate critic pass), or is the agent itself the only mover before HITL?
>
> *— Add a critic subagent that reviews tone and brand fit before HITL.*
>
> Q2: Which LLM should the writer use — Claude, GPT, something else? And does it need web search or any MCP?
>
> *— Claude Sonnet 4.6 for the writer, no web search needed. The critic runs on the same model.*
>
> Q3: You said "runs weekly." Should I create a starter plan file for that, and what should the plan be named?
>
> *— Yes, name it `weekly-draft`.*
>
> Q4: What should happen if the topic brief is empty or missing when the plan fires?
>
> *— Abort with a stderr message and skip the run; don't draft on nothing.*
>
> Q5: Outputs — single `.md` per run, or `.md` plus a metadata sidecar (frontmatter, run ID, topic)?
>
> *— Single `.md`. The HITL log already captures the metadata.*

Five focused questions, one fact each — no bundling, no leading defaults. The skill never invents content; if something's missing, it asks.

**Phase 4 — Consolidated preview.** You see every file path that will be written, the full `agent.md`, the slash-command description, the `subagents/critic.md` body, and the `plans/weekly-draft.yaml` skeleton:

```
Will write:
  gtm/content-agent/agent.md                              (3.2 KB, populated)
  gtm/content-agent/subagents/critic.md                   (1.1 KB, 6 sections filled)
  gtm/content-agent/subagents/_template.md                (canonical)
  gtm/content-agent/plans/weekly-draft.yaml               (4 steps, matches agent.md)
  gtm/content-agent/plans/.gitkeep                        (canonical)
  gtm/content-agent/README.md                             (canonical)
  gtm/content-agent/.mcp.json                             (canonical)
  gtm/content-agent/.claude/settings.json                 (canonical)
  gtm/content-agent/projects/_template/**                 (canonical, 7 files)
  .claude/commands/content-agent.md                       (slash command, 64 chars)

Slash command description (≤ 80 chars):
  "gtm content-agent — draft weekly Substack posts in our voice for HITL review"

[y / revise <section> / cancel]
```

`revise plans` re-enters Phase 3 for just that section, then re-renders the full preview. Loop until you type `y` or `cancel`.

**Phase 5 — Atomic write.** Final confirm (`Write this? (y/revise/cancel)`), then the skill creates directories parent-before-child, writes files in deterministic order with `agent.md` last (canonical-contract guarantee), and finally writes the slash command outside the rollback root. Post-write summary:

```
Wrote gtm/content-agent/ (15 files, 17 directories).
Wrote .claude/commands/content-agent.md.
Logged to chief-of-staff/logs/2026-05/operations-2026-05-17.md (outcome: success).
```

If anything fails between directory creation and the last byte of `agent.md`, the skill rolls back the entire agent tree in reverse order, leaves the workspace clean, and prints the residual paths (if any) for manual cleanup. The slash command write is treated separately — if it fails after the agent tree is canonical, you get a `--slash-only` retry message instead of a rollback.

### When to pick which mode

- **Use guided** the first time you create an agent of a given role. The follow-up questions catch gaps you wouldn't think to fill in a stub.
- **Use stub** when you're cloning an existing agent's shape, scripting setup in CI, or you just want the directory tree to land so you can edit `agent.md` in your editor.
- The two outputs are byte-identical for every file *except* `agent.md`, the slash command description, named subagent files, and starter plan files. Everything else (README, settings, MCP config, projects/_template) is canonical regardless of mode.

---

## Doctor

Coming in v0.2. Will audit installed skills and agents for drift and report missing or stale components. Source: `src/lib/tools.ts:86-88`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Permission denied` on install | Re-run with `sudo`, or `sudo chown -R "$USER" ~/.claude/skills` |
| Symlink prompt during install | Answer `y` to replace, `n` to keep your symlink |
| No AI tool detected (install exits with no targets) | Install Claude Code first — roster looks for `~/.claude/` |
| `CLAUDE.md already exists` prompt | Answer `y` to overwrite, `n` to cancel |
| Skills not picked up by Claude Code after install | Restart Claude Code so it re-reads `~/.claude/skills/` |
| `roster install` crashes with `installToTool: codex not implemented` or `gemini not implemented` | The multi-select pre-checks every detected tool. Deselect Codex/Gemini and leave only Claude Code. Phase 2 will make the others real targets. |
| `Run chief-of-staff from your roster workspace root.` | The skill needs `conventions.md` + `gtm/` + `projects/`. v0.1 `init` doesn't create those yet — it's a v0.2 scaffold. |
