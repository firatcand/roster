# Probes

Dated outputs of repeating probes that detect upstream behaviour changes in tools Roster depends on. Each subdirectory is one probe; each file inside is one run, named `YYYY-MM-DD.md`. Diff across dates to see when (if ever) the picture changes.

| Probe | Script | Cadence | Why |
|---|---|---|---|
| `claude-url-scheme/` | `scripts/probe-claude-url-scheme.sh` | First Mon monthly + opportunistic per Claude Desktop release | Catch the day Anthropic ships a `claude://schedule/...` deep-link, so Roster can promote `roster schedule install --tool claude` from UI hand-off to programmatic install ahead of [anthropics/claude-code#41364](https://github.com/anthropics/claude-code/issues/41364). Tracked in [ROS-57](https://linear.app/firatdogan/issue/ROS-57). See [ADR-0001 Action Item #11](../adr/0001-scheduling-architecture.md) and [docs/SCHEDULING.md § Re-check protocol](../SCHEDULING.md#re-check-protocol-for-claude-url-scheme).
