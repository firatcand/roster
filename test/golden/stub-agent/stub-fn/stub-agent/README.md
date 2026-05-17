# stub-agent

<One-line description.>

## Files

- `agent.md` — orchestrator contract
- `subagents/` — specialized roles
- `playbook/` — global lessons (one file per lesson)
- `logs/` — agent-level operational logs
- `.claude/` — agent-scoped skills, plugins
- `.mcp.json` — agent-scoped MCPs (CREATE THIS — see template comment)
- `projects/` — per-project instances

## Invocation

From a project instance session:

```bash
cd stub-fn/stub-agent/projects/<project>/
claude
"Run stub-agent on <inputs>"
```

From cron: see ROS-39 (Phase 2.5 scheduling primitives — wrapper layout + install script land then).

## Configuration

Per-project: `projects/<proj>/stub-fn/stub-agent/config/default.yaml` (created by `new-agent-instance.sh`).

## Outputs

`projects/<proj>/stub-fn/stub-agent/log/runs/<YYYY-MM>/<YYYY-MM-DD-HHMM>.md`
