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
