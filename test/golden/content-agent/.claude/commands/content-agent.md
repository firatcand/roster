---
name: content-agent
description: "GTM content agent — drafts short-form posts in project voice"
---

# /content-agent

Routes to the `gtm/content-agent/` agent. Looks up the named plan in `gtm/content-agent/plans/` and invokes it with the supplied arguments.

## Usage

```
/content-agent run <plan> for <project>
/content-agent list-plans
/content-agent --help
```

## What this command does

1. Reads `gtm/content-agent/agent.md` to load the agent contract
2. Loads the plan yaml from `gtm/content-agent/plans/<plan>.yaml`
3. Loads project context from `projects/<project>/CLAUDE.md` and `projects/<project>/guidelines/`
4. Executes the plan steps, dispatching to subagents as declared
5. Writes the run log to `gtm/content-agent/projects/<project>/log/runs/`

See `gtm/content-agent/agent.md` for the full orchestrator contract.
