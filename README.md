![banner](https://raw.githubusercontent.com/firatcand/roster/7095215fd4224709f47d69270f35201b1c3206ce/roster-banner%402x.png)


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# Roster

> A CLI that installs and scaffolds an opinionated multi-agent workspace for Claude Code today, with Codex CLI and Gemini support landing in v0.2 — role-based agents for GTM, product, design, and ops, with a reinforcement loop that compounds learning.

## What is this?

`@firatcand/roster` is an npm CLI. You run it once and it does two things:

1. **`roster install`** — copies a curated set of skills and agent definitions into your AI coding tool's config dir. Today: `~/.claude/`. Coming in v0.2: `~/.codex/`, `~/.gemini/`.
2. **`roster init`** — scaffolds a structured agent-team workspace in any directory. v0.1 produces the minimal scaffold (`CLAUDE.md` + `projects/_demo/`); v0.2 adds the full tree (function dirs, role-based agents, maintenance agent, reinforcement agent).

The workspace it scaffolds separates **substrate** (strategic context: brand voice, ICPs, messaging) from **artifacts** (daily output: emails, posts, components), and runs work through named YAML **plans** that are deterministic, auditable, and schedule-friendly.

If you're a solo founder or ≤5-person team using Claude Code (or Codex / Gemini) and you need outbound, content, design, and ops work done without losing context between sessions — this might fit.

## Getting started

First-time install and first run — under 10 minutes on a Mac with Node ≥ 22.

```bash
# 1. Install skills + agents into your AI tool's config dir
npx @firatcand/roster install

# 2. Scaffold a workspace in a fresh directory
mkdir my-team && cd my-team
npx @firatcand/roster init

# 3. Open Claude Code in that directory
claude

# 4. Run the demo SDR plan
/sdr run cold-outreach for _demo

# 5. Read the run log and provide feedback — lessons surface
#    in dreamer/pending/ on the next nightly reinforcement pass.
```

> Until v0.1 is published to npm, install locally with `npm pack && npm install -g firatcand-roster-*.tgz` from a clone. See [docs/roadmap.md](docs/roadmap.md) for publish status.

[docs/HOWTO.md](docs/HOWTO.md) has the long-form step-by-step.

## Subcommands

| Command | What it does |
|---|---|
| `roster install` | Detect installed AI tools, prompt for selection, copy skills + agents into each tool's config dir. Idempotent. |
| `roster install --all` | Install to every detected tool, non-interactive (good for CI / scripted migration). |
| `roster install --tool <name>` | Install to a single named tool (`claude`, `codex`, or `gemini`), non-interactive. |
| `roster init [name]` | Scaffold the agent-team workspace into CWD. Substitutes `{{PROJECT_NAME}}`. |
| `roster doctor` | Audit installed skills/agents per AI tool; exits non-zero on drift. |
| `roster --help` / `--version` | Usage + version from `package.json`. |

## Tool support

| Tool | Status | Skills installed to | Agents installed to |
|---|---|---|---|
| Claude Code | Supported | `~/.claude/skills/<skill>/` (directory per skill) | `~/.claude/agents/<agent>.md` |
| Codex CLI | Supported | `~/.codex/prompts/<skill>.md` (flat file per skill) | `~/.codex/agents/<agent>.md` |
| Gemini CLI | Supported | `~/.gemini/extensions/<skill>/` (directory per skill) | `~/.gemini/agents/<agent>.md` |
| Cursor | **Out of scope** — see [docs/roadmap.md](docs/roadmap.md) | — | — |

Detection is presence-only: roster considers a tool installed if its config root exists. Override via `ROSTER_CLAUDE_HOME` / `ROSTER_CODEX_HOME` / `ROSTER_GEMINI_HOME` (used by the test suite).

## What `init` scaffolds

`roster init` is non-destructive — re-running merges new files in without overwriting your edits. The full scaffold:

```
my-team/                            ← full layout
├── CLAUDE.md, conventions.md       ← workspace-level context
├── gtm/, product/, design/, ops/   ← functions (top-level domains)
│   ├── EXPERT.md                   ← function-level expert (substrate-shaping)
│   └── <agent-role>/               ← role-based agents (sdr, ux-designer, ...)
│       ├── agent.md                ← contract: purpose, inputs, plans, outputs
│       ├── plans/*.yaml            ← named workflows the agent can run
│       ├── subagents/*.md          ← reusable building blocks
│       └── projects/<project>/     ← per-project instance with config + logs
├── projects/<project>/             ← project-level shared substrate
│   └── CLAUDE.md, guidelines/      ← voice, ICPs, messaging, brand-book
├── chief-of-staff/                 ← cross-cutting maintenance agent
├── dreamer/                        ← cross-cutting reinforcement agent
├── scripts/                        ← backing scripts (create/archive/audit/rename)
└── .claude/commands/               ← workspace-level slash commands
```

The two big ideas behind the layout:

1. **Substrate vs artifacts**: experts shape substrate (project guidelines), agents produce artifacts (specific outputs). Don't conflate them.
2. **Plans**: each agent has named plans (YAML workflow recipes). Cron-friendly. Auditable. Reusable.

## Migrating from agent-team

If you've been running the original `~/repos/agent-team` layout, here's the verbatim migration. Project substrate and `.env` carry over; the framework (skills, agents, scripts, conventions) comes from `roster init`.

```bash
# 1. Install roster (locally until v0.1 publishes; npx after)
npx @firatcand/roster install

# 2. Scaffold a fresh workspace
mkdir ~/repos/my-agent-team && cd ~/repos/my-agent-team
npx @firatcand/roster init

# 3. Copy project-level substrate (guidelines, ICPs, brand voice)
cp -r ~/repos/agent-team/projects/{athelea,firatdogan} projects/

# 4. Copy per-agent project instances (run logs, configs)
cp -r ~/repos/agent-team/gtm/sdr/projects/* gtm/sdr/projects/

# 5. Copy credentials
cp ~/repos/agent-team/.env .env

# 6. Archive the old repo
mv ~/repos/agent-team ~/repos/_archived/agent-team
```

Adjust the project names in step 3 to match what's actually under your `agent-team/projects/`, and extend step 4 for every function that has its own `projects/` dir (e.g. `gtm/content/projects/`, `product/pm/projects/`).

Audit after migration:

```bash
roster doctor          # confirms skills + agents are in place
```

## Documentation

- [docs/HOWTO.md](docs/HOWTO.md) — recipes for common tasks (install, init, create project, run agent, audit, etc.)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design rationale, the substrate-vs-artifacts model, lessons protocol, dreamer reinforcement loop
- [docs/API.md](docs/API.md) — every script, config schema, and convention
- [docs/roadmap.md](docs/roadmap.md) — what's shipped, what's next

## Opinions you can replace

The CLI ships a curated set of skills and agent definitions — these are starting points, not law.

- Function categories (`gtm/`, `product/`, `design/`, `ops/`) are defaults. Add your own with `/chief-of-staff create-function`.
- The example experts reflect one founder's judgment. Replace freely.
- The demo project (`projects/_demo/`) is safe to delete after init.

## What this is NOT

- Not a hosted SaaS — you run it locally against your own AI coding tool.
- Not a build/CI tool — for that, see [forge](https://github.com/firatcand/forge) (complementary, not bundled).
- Not a substitute for thinking — it's a structure for organizing your thinking.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributors working on the CLI itself should read [CLAUDE.md](CLAUDE.md) for build/test/layout conventions.

### CI / branch protection

PRs into `main` run [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — typecheck, test, build, `npm pack --dry-run`, `pnpm smoke`, `pnpm e2e`. Repo admins should enable branch protection on `main` (one-time manual step in **Settings → Branches → Branch protection rules → Add rule**):

- Require status checks to pass before merging: `CI / verify`
- Require branches to be up-to-date before merging
- (Optional) Require linear history

### Publishing / Releases

Releases are triggered by pushing a version tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The [publish workflow](.github/workflows/publish.yml) runs the full quality gate (`typecheck`, `test`, `build`), asserts the tag matches `package.json` version, publishes to npm with provenance, and creates a GitHub Release with auto-generated notes.

**One-time setup — `NPM_TOKEN` secret:**

1. Mint a Granular Access Token at [npmjs.com](https://www.npmjs.com/) → Account → Access Tokens → Generate New Token → Granular.
   - Permissions: **Read and write** scoped to `@firatcand/roster` (publish; deprecation is intentionally kept manual — see rollback note below).
   - Set an expiry (90–365 days recommended).
2. In this repo: **Settings → Secrets and variables → Actions → New repository secret**.
   - Name: `NPM_TOKEN`
   - Value: the token from step 1.

No additional setup is needed for provenance — the workflow's `id-token: write` permission handles OIDC attestation automatically.

**Pre-release tags** (e.g. `v0.1.0-rc.1`) are detected by suffix and automatically published to the `next` dist-tag on npm and marked as pre-release on GitHub. Stable tags publish to `latest`.

If a bad version ships, `npm deprecate @firatcand/roster@<version> "<reason>"` and publish a fix as the next patch — never reuse a version number.

## Acknowledgments

Built on top of [Claude Code](https://claude.com/code) and the broader AI-coding-tool ecosystem.
