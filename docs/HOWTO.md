# How-to

Recipes for the 24 most common tasks. Each is short and self-contained. Examples use `_demo` (the included demo project) and `myproject` (a placeholder for your real project). For deeper rationale, see [ARCHITECTURE.md](ARCHITECTURE.md). For schemas and APIs, see [API.md](API.md).

---

## 1. Start a session

```bash
cd ~/repos/roster
claude
```

Claude Code walks up from your cwd and merges `.claude/` settings, MCPs, and slash commands. To work specifically on one agent in one project, cd into the instance:

```bash
cd ~/repos/roster/gtm/sdr/projects/_demo/
claude
```

This loads the merged context for that agent + project.

---

## 2. Create a new project

Use the chief-of-staff slash command:

```
/chief-of-staff create-project myproject
```

Without a list of agents, it prompts a multi-select of all globally-discovered agents. Pick zero or more. Pick "None" to leave the project bare; you can add agents later.

Or via script:

```bash
bash scripts/new-project.sh myproject
```

---

## 3. Create a new project with agents

Pass the agents inline to skip the prompt:

```
/chief-of-staff create-project myproject with gtm/sdr
```

For each agent, the underlying script prompts for tool bindings declared in the agent's `## Tools and bindings` section. Press Enter or type `skip` to leave any binding as `# TODO:`. Required bindings left as TODO will error on the agent's first run, prompting you to fill them then.

---

## 4. Add an agent to an existing project

```
/chief-of-staff add-agent-to-project myproject gtm sdr
```

This is additive; no confirmation gate. The script prompts for tool bindings.

---

## 5. Create a new global agent

```
/chief-of-staff create-agent gtm content-writer
```

Or:

```bash
bash scripts/new-agent.sh gtm content-writer
```

This scaffolds:
- `gtm/content-writer/agent.md` (template — fill in)
- `gtm/content-writer/subagents/` (template only)
- `gtm/content-writer/plans/` (empty — add at least one plan before using)
- `gtm/content-writer/projects/_template/` (instance template)
- `.claude/commands/content-writer.md` (slash command router)

It also runs an interactive tool-definition prompt. Press Enter to skip; you can add the `## Tools and bindings` section by hand later.

---

## 6. Create a new function

```
/chief-of-staff create-function research --description "User research, interviews, survey synthesis"
```

Functions are top-level domains (gtm, product, design, ops). Adding a new one updates `.config/functions.yaml` and scaffolds the folder, README, and optionally an EXPERT.md stub.

After creating: add the corresponding Slack channel `#research`, add `SLACK_HITL_CHANNEL_RESEARCH=#research` to `.env`.

---

## 7. Run an agent (interactive)

```
/sdr run cold-outreach for _demo
```

Or in natural language:

```
Run gtm/sdr on _demo using cold-outreach plan
```

The agent:
1. Loads the project context, instance config, and plan
2. Validates required tool bindings are filled
3. Executes each plan step
4. Surfaces HITL approval gates in-session
5. Logs the run to `gtm/sdr/projects/_demo/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`

---

## 8. Run an agent unattended (cron / /schedule)

Two options.

**Native /schedule** (recommended for interactive setup):

In Claude Code, run `/schedule` and configure a recurring task with the prompt:

```
/sdr run cold-outreach for _demo
```

at e.g. `0 9 * * 1-5`.

**Cron + claude -p** (recommended for headless / always-on setups):

Use `scripts/new-cron.sh` to scaffold a wrapper, then add the line to your crontab. See `scripts/cron/crontab` for the format.

For unattended runs, `approval_channel: auto` routes HITL to the function's Slack channel (`SLACK_HITL_CHANNEL_<FUNCTION>` from `.env`).

---

## 9. Use an expert to develop project guidelines

```
Use the GTM expert. Help me define ICPs for _demo.
```

The expert reads `projects/_demo/CLAUDE.md` and existing guidelines first, then identifies gaps and asks. Output writes to `projects/_demo/guidelines/icps/<persona>.md`.

Experts are different from agents — see [ARCHITECTURE.md § Substrate vs artifacts](ARCHITECTURE.md#substrate-vs-artifacts).

---

## 10. Audit a project

```
/chief-of-staff audit-project _demo
```

Checks required guideline files exist and aren't template content, instance configs are valid, runs aren't stale, etc. Reports issues with suggested fixes. Never auto-fixes.

Full report: `chief-of-staff/logs/<YYYY-MM>/audit-_demo-<timestamp>.md`.

---

## 11. Audit an agent

```
/chief-of-staff audit-agent gtm sdr
```

Validates agent.md required sections, plans/, slash command, README, .mcp.json, subagents, projects/_template/, and per-instance config consistency.

---

## 12. Audit the whole repo

```
/chief-of-staff audit-repo
```

Aggregates project audits and agent audits into one report. Also checks universal `.mcp.json`, root `CLAUDE.md`, `conventions.md`, `README.md`, and orphaned instances.

---

## 13. Archive a project

```
/chief-of-staff archive-project oldproject reason="MVP shelved"
```

Moves the project root and all instance folders to `_archive/projects/<slug>-<date>/`. Always confirms before moving. Preserves run history and project-scoped lessons.

To restore: `unarchive-project <slug>`.

---

## 14. Rename a project

```
/chief-of-staff rename-project oldname newname
```

Renames folders everywhere AND replaces the slug in `CLAUDE.md`, `GUIDANCE.md`, instance configs (`project: <new>`), and asset-references. Does NOT auto-update lesson, run, or feedback bodies — those are historical evidence reviewed manually.

Always confirms before executing. Surfaces unauto-updated mentions in the report.

---

## 15. Remove an agent from a project

```
/chief-of-staff remove-agent-from-project _demo gtm sdr
```

Archives the instance to `_archive/<function>/<agent>/projects/<project>-<date>/`. Always preserves run history; does not hard-delete (you can `rm -rf` the archived copy manually if certain).

---

## 16. Edit tool bindings later

Open the instance config:

```bash
$EDITOR gtm/sdr/projects/_demo/config/default.yaml
```

Edit values under `tools:`. Save. The agent reads them on the next run. No restart needed.

To see what bindings the agent expects, look at the agent's `## Tools and bindings` section in `gtm/sdr/agent.md`.

---

## 17. Look at lessons (playbook)

Project-scoped lessons:

```bash
ls gtm/sdr/projects/_demo/playbook/
cat gtm/sdr/projects/_demo/playbook/L-2026-01-15-001.md
```

Global lessons (apply across all projects for that agent):

```bash
ls gtm/sdr/playbook/
```

Lessons follow a fixed schema; see [API.md § Lesson schema](API.md#lesson-schema).

---

## 18. Write a lesson by hand

Create a file at `<function>/<agent>/playbook/L-YYYY-MM-DD-NNN.md` (global) or `<function>/<agent>/projects/<project>/playbook/L-YYYY-MM-DD-NNN.md` (project-scoped).

Use frontmatter `source: human` so the dreamer respects it (won't modify or supersede without explicit HITL approval).

Schema:

```markdown
---
id: L-2026-05-03-001
source: human
scope: global
project: —
agent: sdr
created: 2026-05-03
last_observed: 2026-05-03
status: validated
---

## Pattern observed
<short description>

## Recommendation
<what the agent should do next time>

## Why this might be project-specific
<when does this generalize, when not>

## Retirement criteria
<what evidence would invalidate this>
```

---

## 19. Look at recent runs

```bash
ls gtm/sdr/projects/_demo/log/runs/
ls gtm/sdr/projects/_demo/log/runs/2026-05/
cat gtm/sdr/projects/_demo/log/runs/2026-05/2026-05-03-0930.md
```

Each run pairs with an optional feedback file at `log/feedback/<same-filename>.md`.

---

## 20. Commit changes to git

The repo is git-tracked. Roster's chief-of-staff and agents NEVER auto-commit. You commit manually:

```bash
git status
git diff
git add -A
git commit -m "Your message"
git push  # only if you've configured a remote
```

Suggested cadence: commit after each meaningful chunk of work (not every file change, not weekly). The git log becomes a readable timeline of decisions.

---

## 21. Connect remotely

If you want to run roster on a different machine (a server, a Mac mini, anything always-on), the setup is:

1. Install Claude Code on the target machine
2. Clone the repo there
3. Configure `.env` with the same credentials
4. Use SSH or remote desktop to interact with Claude Code on that machine

Typical patterns:
- Run cron jobs on the always-on machine, push results back via git
- Run interactive sessions remotely via tmux or screen
- For multi-machine setups: pick one machine as the source of truth, sync via git

There's no built-in multi-machine sync. The repo IS the sync mechanism.

---

## 22. When something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Agent errors "required tool binding is TODO" | Instance config has unfilled bindings | Edit `<fn>/<agent>/projects/<project>/config/default.yaml` and fill the `# TODO:` lines |
| Slash command not recognized | Slash command file missing | Check `.claude/commands/<agent>.md` exists; if not, run `bash scripts/new-agent.sh <fn> <agent>` and copy the generated file |
| `audit-repo` reports orphaned instance | Agent was deleted but instance folder remains | Move instance to `_archive/` or recreate the agent |
| Cron job doesn't fire | Wrapper script missing or path wrong | Check `scripts/cron/wrappers/` for the wrapper; verify the cron line uses absolute paths |
| Slack approvals never arrive | Bot token missing or channel name wrong | Verify `SLACK_BOT_TOKEN` and `SLACK_HITL_CHANNEL_<FUNCTION>` in `.env` |
| Plan YAML parse error | Indentation or quote issue | `python3 -c "import yaml; yaml.safe_load(open('<path>'))"` to find the line |
| Dreamer never picks up lessons | State cutoff is in the future, or no new material since last run | Edit `dreamer/state.md`'s `last_processed_through` to an earlier date |

For audit issues with suggested fixes, run `/chief-of-staff audit-repo` and follow the suggestions.

---

## 23. Routine cadence

Suggested rhythm for solo / small-team use:

- **Daily**: run agent plans as needed. Commit at end of day.
- **Weekly**: run `/chief-of-staff audit-repo`. Review playbook additions from the dreamer. Commit lessons.
- **Monthly**: review which functions/agents are stagnant; archive unused ones. Update guidelines that have drifted.
- **Per project**: `/chief-of-staff audit-project <project>` after major substrate changes.

The dreamer runs nightly via /schedule (configure once); approvals come through Slack `#admin`.

---

## 24. Where things live (cheat sheet)

```
roster/
├── CLAUDE.md, conventions.md, README.md  ← read once, refer back
├── .env, .env.example                    ← credentials (only .example committed)
├── .claude/commands/                     ← slash command routers
├── .config/functions.yaml                ← registered functions
├── docs/                                 ← you are here
├── scripts/                              ← every backing script
├── projects/<project>/
│   ├── CLAUDE.md, state.md               ← session context
│   └── guidelines/                       ← substrate (voice, ICPs, messaging, …)
├── <function>/
│   ├── EXPERT.md                         ← function-level expert
│   └── <agent>/
│       ├── agent.md                      ← contract
│       ├── plans/<plan>.yaml             ← workflow recipes
│       ├── subagents/                    ← reusable building blocks
│       ├── playbook/                     ← global lessons (dreamer + human)
│       └── projects/<project>/
│           ├── config/default.yaml       ← per-project params + tool bindings
│           ├── asset-references.md
│           ├── log/runs/                 ← run output
│           ├── log/feedback/             ← HITL feedback
│           └── playbook/                 ← project-scoped lessons
├── chief-of-staff/                       ← repo-maintenance agent
├── dreamer/                              ← reinforcement agent
└── _archive/                             ← archived projects and instances
```

When in doubt, search the file tree (`find . -type f -name "<pattern>"`) — the structure is grep-friendly.
