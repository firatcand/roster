![banner](https://raw.githubusercontent.com/firatcand/roster/7095215fd4224709f47d69270f35201b1c3206ce/roster-banner%402x.png)


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

# Roster

> A CLI that installs and scaffolds an opinionated multi-agent workspace for Claude Code today, with Codex CLI and Gemini support landing in v0.2 — role-based agents for GTM, product, design, and ops, with a reinforcement loop that compounds learning.

## What is this?

`@firatcand/roster` is an npm CLI. You run it once and it does two things:

1. **`roster install`** — copies a curated set of skills and agent definitions into your AI coding tool's config dir. Detects and installs to `~/.claude/`, `~/.codex/`, and `~/.gemini/`.
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

### What `roster install` looks like

```
$ npx --yes @firatcand/roster install --all

roster v0.1.0
Multi-agent workspace scaffolder for Claude Code, Codex CLI, and Gemini.

✓ Claude Code — 3 skills → ~/.claude/skills, 7 agents → ~/.claude/agents
✓ Codex CLI — 3 skills → ~/.codex/prompts, 7 agents → ~/.codex/agents
✓ Gemini CLI — 3 skills → ~/.gemini/extensions, 7 agents → ~/.gemini/agents

Next: roster init to scaffold a workspace.
```

Without `--all`, you'll get an interactive checkbox to pick which tools to receive the skills + agents. Exit codes: 0 success, 1 error, 2 cancelled, 3 no tools detected.

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

## What roster installs

`roster install` copies three skills and seven agents into each detected tool's config dir. Skills are the entry points (one per agent function); agents are the building blocks the skills call.

**Skills**

| Skill | Purpose |
|---|---|
| `chief-of-staff` | Repo maintenance for roster workspaces — create, archive, rename, and audit projects, agents, and functions. Wraps `scripts/` with confirmation gates for destructive operations. |
| `dreamer` | Off-hours reflection. Reads recent runs + feedback, detects recurring patterns, drafts lesson candidates, and writes approved lessons to the right playbook scope. The only agent that writes to playbook files. |
| `sdr` | Cold outreach for a project — find prospects matching an ICP, enrich, draft personalized first-touch messages in the project's voice, and route through HITL approval. |

**Agents** (called by skills, not invoked directly)

| Agent | Owner skill | Purpose |
|---|---|---|
| `critic` | `sdr` | Reviews drafts for tone, brand fit, risk, compliance. Returns pass/fail with specific feedback. Does not rewrite. |
| `enricher` | `sdr` | Fills missing fields on prospects (recent posts, company news) via Apollo, HeyReach, web search. Does not score or contact. |
| `prospector` | `sdr` | Finds prospects matching ICP criteria. Read-only — no enrichment beyond search, no contact, no CRM writes. |
| `writer` | `sdr` | Drafts a single first-touch message for a single prospect using enrichment context and lessons. Does not send. |
| `lesson-drafter` | `dreamer` | Takes a candidate pattern and drafts a lesson file in the schema defined by `conventions.md`. One lesson per invocation. |
| `pattern-detector` | `dreamer` | Reads runs + matched feedback, returns raw candidate patterns with cited evidence. Returns everything that recurs. |
| `promotion-arbiter` | `dreamer` | Decides whether a project-validated lesson should be promoted to global, kept project-specific, or marked as conflicting. Decisions only. |

Every skill and agent ships with version `0.1.0` (frontmatter pin). `roster doctor` will surface drift between installed and shipped versions in v0.2.

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

## Security

Three guarantees about what `npm install -g @firatcand/roster` and `npx @firatcand/roster` do — and don't — do on your machine.

- **No `preinstall` / `install` / `postinstall` scripts.** The CLI runs only when you invoke it. `npm install -g @firatcand/roster` writes files to your global prefix and stops there. Asserted in `test/security.test.ts` ("no npm install lifecycle hooks in package.json").
- **No telemetry.** v0.1 collects nothing — no analytics, no error reporting, no usage pings. If telemetry is ever added it will be opt-in, gated behind a `--no-telemetry` flag, and disclosed here before the release that introduces it.
- **npm provenance.** Releases are signed via `npm publish --provenance` from GitHub Actions on `v*` tag push. Verify the signature with `npm info @firatcand/roster dist.integrity` or the provenance badge on the npm page.

Path-traversal guards on `install` / `init` were audited under ROS-30 — see `test/security.test.ts` for the regression suite.

## v0.2 roadmap

Items the SPEC deferred from v0.1, in roughly the order they're likely to land. Open to feedback on priority.

- **Companion-skill installers.** Install GTM / product / design domain expertise alongside the framework, similar to forge's `companions`. Will point at `firatcand/founder-skills`.
- **Per-skill versioning gate in `doctor`.** Skills already ship with `version:` in frontmatter; `roster doctor` will surface drift between installed and shipped versions, mirroring how npm handles outdated globals.
- **`roster sync`.** Pull the latest skills from the installed roster package into existing tool config dirs without re-running the full `install` flow.
- **`roster migrate <path>`.** Replace the manual `cp`-based migration documented in [Migrating from agent-team](#migrating-from-agent-team) with a single command that copies project substrate + `.env` and runs `roster init`.
- **Cursor support.** Promoted from "out of scope" once the Cursor skill API stabilizes — the layout maps cleanly to `~/.cursor/`.

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

**One-time setup — `production` environment (manual `workflow_dispatch` approval gate):**

The publish workflow's `workflow_dispatch` trigger lets a maintainer manually run a publish against an existing tag (used for partial-publish recovery). To prevent anyone with `Actions: write` from triggering an unreviewed publish, manual dispatches are gated behind a GitHub environment named `production` that requires maintainer approval. Tag-push releases (the canonical `git tag vX.Y.Z && git push --tags` path) are **not** gated — they run immediately.

1. GitHub repo → **Settings → Environments → New environment**, name: `production`.
2. **Required reviewers:** add the maintainer (Firat). **Do NOT enable "Prevent self-review"** — this is a solo-maintainer project and enabling it would leave every dispatch permanently stuck.
3. **Wait timer:** 0.
4. **Deployment branches and tags:** leave on the default "All branches and tags." A `v*` tag rule sounds appealing as belt-and-suspenders but actually blocks `workflow_dispatch` — on dispatch, `github.ref` is the default branch, not the tag (which is supplied separately via the `tag` input and checked out later in the job).

Because self-approval is allowed, the maintainer account becomes the only barrier between an `Actions: write` actor and an npm publish. **Enable TOTP-based 2FA on the GitHub account** (and on the npm account that owns `NPM_TOKEN`) as the compensating control.

After this, any manual `workflow_dispatch` of the publish workflow will pause in "Waiting for review" state until approved in the Actions UI.

**Pre-release tags** (e.g. `v0.1.0-rc.1`) are detected by suffix and automatically published to the `next` dist-tag on npm and marked as pre-release on GitHub. Stable tags publish to `latest`.

If a bad version ships, `npm deprecate @firatcand/roster@<version> "<reason>"` and publish a fix as the next patch — never reuse a version number.

## Acknowledgments

Built on top of [Claude Code](https://claude.com/code) and the broader AI-coding-tool ecosystem.
