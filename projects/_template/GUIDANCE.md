# Setup guidance for <Project Name>

This file walks you (or a contractor, or an AI agent) through what to fill in for a new project, in what order. Delete sections as you complete them. Remove the file when fully set up — your call.

## Order of operations

### 1. Identify the project (5 min)
Edit `CLAUDE.md`:
- Project name
- What it is (product, brand, personal — and one sentence)
- Audience
- Primary agents (you can add later, but make a first pass)

### 2. Required guidelines (60-90 min for first project)

Fill these in `guidelines/`. They're required because every agent that works on this project reads them:

- **`voice.md`** — how this project sounds. Tone, vocabulary, sentence length, energy. Include 3-5 example sentences and 2-3 anti-examples.
- **`icps/<persona-slug>.md`** — at least one persona file. One file per persona/ICP. Include who they are, role, pains, goals, buying signals, disqualifiers.
- **`design.md`** — design principles for the project (visual approach, what's on/off-brand visually).
- **`design-tokens.md`** — concrete tokens: colors, fonts, spacing.
- **`brand-book.md`** — visual identity overview, logo usage rules, or pointer to design tool.
- **`messaging.md`** — top 3 value props, headlines, taglines, anti-claims.
- **`asset-links.md`** — paths and URLs to brand assets (logos, fonts, mood boards, etc.).

If something isn't fully developed yet, write what you know and mark TBDs explicitly. Agents respect TBD and will ask rather than fabricate.

### 3. Optional guidelines (fill when needed)

These start as stubs. Populate when relevant:

- **`do-and-dont.md`** — explicit project-specific rules ("never mention competitor by name", "always cc editor on outreach > $50k ACV", "never auto-send Twitter posts above 200 chars")
- **`compliance.md`** — legal/regulatory constraints (GDPR for EU prospects, CAN-SPAM, platform ToS)
- **`competitors.md`** — who they are, how to position against them, what to avoid claiming

Empty stubs are fine for these — agents will note "no compliance constraints specified" and proceed.

### 4. Add agent instances (varies)

For each agent this project will use:

```bash
# From repo root:
bash scripts/new-agent-instance.sh <project-slug> <function> <agent-name>
```

This creates the instance under the agent: `<function>/<agent>/projects/<project-slug>/{config,playbook,log,asset-references.md}`

Then fill in the instance's `config/default.yaml` for that agent. See `<function>/<agent>/agent.md` § "Inputs" for required fields.

### 5. First test run (30 min)

Start a Claude Code session in an agent's project instance:

```bash
cd <function>/<agent>/projects/<your-project>/
claude
```

Invoke the agent with a small input ("run sdr on these 3 prospects"). Inspect output. Annotate `log/feedback/<YYYY-MM>/<run-filename>.md` with what worked.

### 6. Add to schedule (if applicable, 15 min)

```bash
bash scripts/new-cron.sh <project>-<agent>-<frequency>
```

Then `bash scripts/cron/install.sh` to register.

### 7. Operating

- One Claude Code session per agent-project combo, started from inside the agent's project instance directory
- Use `/clear` for hygiene, then `/save-state` (or "save state and clear")
- Annotate runs in `log/feedback/` so the dreamer can learn
- The dreamer runs nightly and proposes lessons via Slack

## What goes where (cheat sheet)

| Thing | Lives in |
|---|---|
| How an agent works | `<function>/<agent>/agent.md` (don't touch from a project) |
| Agent's tools (MCPs, skills, plugins) | `<function>/<agent>/.claude/`, `<function>/<agent>/.mcp.json` |
| Agent's global lessons | `<function>/<agent>/playbook/` (one file per lesson) |
| Project's config for an agent | `<function>/<agent>/projects/<project>/config/default.yaml` |
| Project-scoped lessons | `<function>/<agent>/projects/<project>/playbook/` |
| Run outputs | `<function>/<agent>/projects/<project>/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md` |
| Feedback on a run | `<function>/<agent>/projects/<project>/log/feedback/<YYYY-MM>/<same-filename>.md` |
| Project guidelines (voice, icps, etc.) | `projects/<project>/guidelines/` |
| Brand assets (or links to them) | `projects/<project>/assets/` and `projects/<project>/guidelines/asset-links.md` |
| Where you left off | `projects/<project>/state.md` |
| Project-level session rules | `projects/<project>/CLAUDE.md` |

## Common questions

**Q: Should I commit `state.md`?** Yes, it's small and useful history.

**Q: Can I edit lesson files myself?** Yes, but mark them `source: human` in frontmatter. The dreamer respects human-written lessons and won't override without HITL approval.

**Q: An agent did something wrong — what do I do?** Annotate the matching feedback file. The dreamer picks it up. Don't fix the agent's logic from inside a project — that's a `<function>/<agent>/agent.md` change.

**Q: I want to use an agent that doesn't exist.** Run `bash scripts/new-agent.sh <function> <name>` from repo root. Then add an instance: `bash scripts/new-agent-instance.sh <project> <function> <name>`.

**Q: Where does the agent find this project's voice?** The agent reads `projects/<project>/guidelines/voice.md` directly. Path resolution happens in agent.md and the instance config.
