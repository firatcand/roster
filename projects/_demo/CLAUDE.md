---
project: _demo
type: example
created: 2026-05-03
---

# Acme Corp — Demo Project

This is a sample project demonstrating how `roster` organizes work. Acme Corp is a fictional B2B SaaS company that helps small businesses automate their accounting workflows.

This demo is **safe to delete**. It exists to show the structure of a populated project. Real projects go in `projects/<your-project-name>/`.

## Identity

- Product: Acme Books — accounting automation for SMBs
- Stage: early-stage SaaS, post-launch
- Audience: SMB owners and bookkeepers
- Primary motion: outbound to bookkeeping firms and SMB owners

## Active agent instances

- `gtm/sdr/projects/_demo/` — outbound prospecting and cold outreach

## Files in this project

- `CLAUDE.md` — this file
- `state.md` — session continuity (auto-updated)
- `guidelines/` — substrate (voice, ICPs, messaging, brand-book, etc.)

## How to use as a learning example

1. Browse `projects/_demo/guidelines/` to see what filled-in substrate looks like
2. Browse `gtm/sdr/projects/_demo/config/default.yaml` to see how an agent instance is configured
3. Try running the agent against this demo: `/sdr run cold-outreach for _demo` (will prompt for filled bindings — feel free to use placeholder values for the test)
4. Delete this entire `_demo/` directory and its instance(s) when you're ready to start fresh
