# Install roster

This file is written for an AI agent in Claude Code or Codex to install `@firatcand/roster` on the user's machine and scaffold their first subscription-safe operator-agent workspace.

The concrete target: help the user run role-based agents on the AI coding subscription they already pay for. A typical first workflow is `gtm/sdr`: scan X for market signals every morning, draft cold outbound, and park the messages for human approval before anything is sent.

For the longer human-facing pitch, see [README.md](README.md). For full usage docs, see [docs/HOWTO.md](docs/HOWTO.md).

## Prereqs

Node.js `^22.18.0 || >=24.0.0`. Verify before doing anything else:

```bash
node --version
```

If it's lower, stop and ask the user to install Node 22+ (e.g., `nvm install 22 && nvm use 22`). Don't try to upgrade Node yourself.

## Steps

Run these in order. Surface each step's output to the user before moving on.

### 1. Detect the host AI tool

This runbook is optimized for Claude Code and Codex. Check for these config dirs:

- `~/.claude/` → Claude Code
- `~/.codex/` → Codex CLI

Tell the user which you found. They need at least one. If neither is present, stop and ask the user to install Claude Code or Codex CLI first.

### 2. Scaffold the workspace FIRST

`roster install` now defaults to **workspace-local** install when run inside a roster workspace — so the order is scaffold-then-install, not install-then-scaffold. Ask the user where to scaffold. Reasonable defaults:

- `~/agent-team` — if they don't have a strong preference
- `~/repos/<their-product>-agents` — if they're an existing repos user

Then:

```bash
mkdir -p <target> && cd <target>
npx --yes @firatcand/roster init
```

This writes `CLAUDE.md`, `conventions.md`, `config/project.yaml`, `guidelines/`, function dirs (`gtm/`, `product/`, `design/`, `ops/`), the `chief-of-staff` and `dreamer` workspaces, supporting scripts, and `.claude/commands/` slash commands. Non-destructive — re-running merges new files without overwriting edits.

### 3. Install skills + agents (workspace-local)

From inside the directory you just scaffolded:

```bash
npx --yes @firatcand/roster install --yes --scope project
```

This copies the three framework skills (`chief-of-staff`, `dreamer`, `roster-orchestrator`) and the reinforcement agent (`lesson-drafter`) into `<workspace>/.claude/` and/or `<workspace>/.codex/` for every detected supported tool. Workspace-local — no cross-project pollution. Idempotent — safe to re-run.

If the user prefers user-scope install (visible to every Claude Code project on the machine), use `--scope user` instead. **Do not** use `--scope project` from a directory that doesn't contain `config/project.yaml` — `roster install` will refuse with exit code 2.

### 4. Verify the install

```bash
npx @firatcand/roster doctor
```

Exits 0 on a clean install, non-zero on drift. If it fails, surface the report verbatim to the user and stop. Don't silently re-run `install`.

### 5. (Optional) Wire SessionStart banners

```bash
npx @firatcand/roster hooks install --tool all
```

Installs hooks into `~/.claude/settings.json` and `~/.codex/hooks.json` so every future session in a roster workspace shows pending-HITL counts on start. Idempotent.

### 6. Tell the user what's next

Surface this to the user, verbatim:

> Your workspace is ready. Inside Claude Code or Codex, run:
>
> `/chief-of-staff create-agent <function> <agent-name>`
>
> For example: `/chief-of-staff create-agent gtm sdr`. Use this when the user wants an X market-watch / cold-outbound agent that drafts messages and queues them for approval. The five-phase guided dialogue will interview you for the specifics and write a populated `agent.md` plus default plans. Walk through [docs/HOWTO.md](docs/HOWTO.md) for the full worked example.

## Don't

- Don't pipe `curl ... | bash` — there's no such installer.
- Don't hand-edit installed skill dirs (`<workspace>/.claude/skills/chief-of-staff/`, `~/.claude/skills/chief-of-staff/`, etc.). They're managed by `roster install`.
- Don't run `roster init` outside the directory the user chose. Always `cd` into the target first.
- Don't recommend `claude -p` for scheduled agent fires — it bills the API, not the subscription. Roster's `schedule install` uses the host tool's native subagent primitive on purpose.

## If you hit errors

- **`EACCES` on install** — ask the user before suggesting `sudo`. Usually the right fix is to point npm's global prefix at a user-writable dir (`npm config set prefix ~/.npm-global` and add it to PATH).
- **`command not found: roster` after install** — the user's shell may not have the npm prefix on PATH. Keep using `npx @firatcand/roster <cmd>` while you sort it out.
- **`roster doctor` non-zero** — don't silently re-run `install`. Surface the report and discuss with the user.
- **macOS Gatekeeper warning on first `roster` run** — the binary is unsigned. The user can allow it under System Settings → Privacy & Security, or keep using `npx @firatcand/roster <cmd>`.
