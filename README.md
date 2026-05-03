# Roster

> A scaffold for building durable, multi-agent systems on top of Claude Code.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## What is this?

Roster is an opinionated scaffold for organizing AI agents around real-world functions (GTM, product, design, ops) — the way humans organize work. It separates **substrate** (the strategic context: brand voice, ICPs, messaging) from **artifacts** (the daily output: emails, posts, components), and provides a reinforcement loop that improves agents over time.

If you're a solo founder or small team building automation that needs to:
- Scale across multiple projects without losing context
- Hand off to contractors without rebuilding
- Maintain quality through structured human review
- Improve automatically from feedback

…this might fit.

## Quick start

(See [docs/HOWTO.md](docs/HOWTO.md) for the full guide. This is the 5-minute version.)

```bash
# Clone
git clone <your-fork-of-roster>.git agent-team
cd agent-team

# Configure
cp .env.example .env
# Edit .env with your credentials (Slack, Anthropic, any tool APIs)

# Install Claude Code if you haven't
# https://claude.com/code

# Initialize git
git init && git add -A && git commit -m "Initial setup"

# Open Claude Code
claude
```

In Claude:

```
/chief-of-staff create-project myproject
/chief-of-staff create-agent gtm myagent
```

## Architecture in 30 seconds

```
roster/
├── gtm/, product/, design/, ops/    ← functions (top-level domains)
│   ├── EXPERT.md                    ← function-level expert (substrate-shaping)
│   └── <agent-role>/                ← role-based agents (sdr, ux-designer, etc.)
│       ├── agent.md                 ← contract: purpose, inputs, plans, outputs
│       ├── plans/*.yaml             ← named workflows the agent can run
│       ├── subagents/*.md           ← reusable building blocks
│       └── projects/<project>/      ← per-project instance with config + logs
├── projects/<project>/              ← project-level shared substrate
│   ├── CLAUDE.md, guidelines/       ← voice, ICPs, messaging, brand-book
├── chief-of-staff/                  ← cross-cutting maintenance agent
├── dreamer/                         ← cross-cutting reinforcement agent
├── scripts/                         ← all backing scripts
└── .claude/commands/                ← project-level slash commands
```

The two big ideas:

1. **Substrate vs artifacts**: experts shape substrate (project guidelines), agents produce artifacts (specific outputs). Don't conflate them.
2. **Plans**: each agent has named plans (YAML workflow recipes). Cron-friendly. Auditable. Reusable.

## What's included

- **3 example experts** for GTM, product, design (opinionated — replace freely)
- **1 example agent** (`gtm/sdr`) with subagents and plans
- **2 cross-cutting agents** (`chief-of-staff`, `dreamer`) with their plans
- **1 demo project** (`projects/_demo/` — a fictional Acme Corp) showing what populated content looks like
- **All backing scripts** for create/archive/audit/rename
- **Slash commands** for natural invocation (`/sdr`, `/chief-of-staff`, `/dreamer`)

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design rationale, the substrate-vs-artifacts model, lessons protocol, dreamer reinforcement loop
- [docs/HOWTO.md](docs/HOWTO.md) — recipes for common tasks (create project, run agent, audit, etc.)
- [docs/API.md](docs/API.md) — every script, config schema, and convention
- [conventions.md](conventions.md) — the canonical schema for the repo

## Opinions you can replace

- The 3 example experts (`gtm/EXPERT.md`, `product/EXPERT.md`, `design/EXPERT.md`) reflect one founder's judgment. Replace freely.
- The function categories (gtm/product/design/ops) are starting points. Add your own via `/chief-of-staff create-function`.
- The demo project (`projects/_demo/`) is safe to delete.

## What this is NOT

- Not a hosted SaaS — you run it locally, connected to your own Claude Code
- Not Claude Code-agnostic — it depends on Claude Code's slash commands, scheduled tasks, and `claude -p` headless mode
- Not a substitute for thinking — it's a structure for organizing your thinking

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome but not promised — this is casually maintained.

## Acknowledgments

Built on top of [Claude Code](https://claude.com/code). Thanks to Anthropic for the underlying primitives.
