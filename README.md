![banner](https://raw.githubusercontent.com/firatcand/roster/7095215fd4224709f47d69270f35201b1c3206ce/roster-banner%402x.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@firatcand/roster.svg)](https://www.npmjs.com/package/@firatcand/roster)

# Roster

Roster is a thin, agent-facing CLI and context framework around a working
directory. It turns a folder into a purpose-built agent system for Claude Code
or Codex without becoming a second agent runtime.

The human works through Claude Code or Codex. The host calls Roster to find
authored policy and company context, interprets the complete plan, invokes its
own tools and subagents, waits for human decisions in its native interface, and
records completed evidence. Roster owns the durable structure around that work.

```text
scaffold → resolve context → host executes → record evidence → learn
```

## Product boundary

Roster has three pillars:

| Pillar | Roster owns |
|---|---|
| Working directory | Sparse functions, role agents, structured plans, subagents, guidelines, tool-use definitions, approved lessons, discovery, and static validation |
| Company Brain | Remote Postgres/S3 knowledge, source versions, indexes, graph-shaped facts, retrieval, citations, portable evidence, and learning state |
| Tool guidance | Company-specific why/when/how guidance and vendor-skill references; the host still loads and executes the vendor tool |

Claude Code or Codex remains responsible for reasoning, interpreting plans,
carrying outputs between steps, invoking subagents and external tools, retries,
conditions, human approvals, scheduling sessions, and rendering results.

Roster deliberately does not own a plan reducer or current-step cursor, a
provider router/executor, a scheduler, a general operations queue, or approval
authority.

## Current v2 foundation

The v2 roadmap is being delivered in dependency order. The current foundation
provides:

- exact sparse initialization;
- deterministic on-demand scaffolding;
- a hierarchical canonical registry with flat JSON discovery;
- structural path, ownership, and generated-drift validation;
- bounded regular-file reads, component-wise symlink refusal, and atomic writes;
- minimal generated Claude Code and Codex activation that mentions only commands
  available today; and
- the existing opt-in company Brain while its v2 identity/source lifecycle is
  upgraded.

Full structured-plan validation, scoped tool-use precedence, bounded context,
portable evidence, and activated Dreamer learning are subsequent roadmap tasks.
Legacy scheduling and general-operations commands remain temporarily for
migration safety; they are not part of the v2 product contract and are removed
by the breaking-simplification phase.

## Requirements

- Node.js `^22.18.0 || >=24.0.0`
- Claude Code or Codex for the host-led workflow
- Optional: Neon/Postgres and S3-compatible storage for company Brain
- Secrets supplied by Infisical or another ambient host mechanism; Roster does
  not create `.env` files or store resolved secret values

## Quick start

Run these commands through Claude Code or Codex, or directly while developing a
workspace:

```bash
mkdir my-roster && cd my-roster
npx --yes @firatcand/roster init my-roster
npx --yes @firatcand/roster install --tool claude --scope project --yes
```

A fresh `roster init` creates exactly:

```text
roster.yaml
ROSTER.md
```

No function, agent, plan, guideline, tool, lesson, host, log, schedule, pending,
`.roster`, `.env`, `.gitignore`, or placeholder directory exists until a command
actually needs it.

Create only the requested authored records:

```bash
roster scaffold function gtm --purpose "Go-to-market policy and roles"
roster scaffold agent social-manager \
  --scope function:gtm \
  --purpose "Manage evidence-based social discovery"
roster scaffold plan opportunity-discovery \
  --scope agent:gtm/social-manager \
  --purpose "Produce a reviewed list of relevant reply opportunities"
roster scaffold guideline brand-voice \
  --scope agent:gtm/social-manager
roster scaffold tool-use social-opportunity-search \
  --scope plan:gtm/social-manager#opportunity-discovery
```

Then discover the compact records an agent can use:

```bash
roster discover --json
roster discover social-manager --kind agent --json
roster discover gtm/social-manager#opportunity-discovery --exact --json
roster validate --json
```

Names are qualified by ownership. `gtm/social-manager` and
`product/social-manager` are different agents and never collide.

## Workspace model

Authorship stays hierarchical so ownership remains legible:

```text
roster.yaml
ROSTER.md
functions/<function>/
  function.yaml
  guidelines/<guideline>.md
  agents/<agent>/
    agent.yaml
    guidelines/<guideline>.md
    plans/<plan>.yaml
    subagents/<subagent>.yaml
    tools/<tool-use>.yaml
    playbook/<lesson>.md
```

Only `roster.yaml` registers function roots. Each `function.yaml` registers its
agents and guidelines; each `agent.yaml` registers its owned records. Discovery
follows those declarations and returns one flat, stable list. It never treats an
arbitrary directory scan as authority.

Optional directories appear on first use. Scaffolding one agent does not create
empty plan, playbook, tool, log, pending, or host trees.

## Generated host activation

Project install writes reproducible, self-identifying activation files without
overwriting authored host instructions.

- Claude Code uses a project instruction file, with an isolated rule fallback
  when an authored instruction already exists.
- Codex uses create-only root `AGENTS.md` when safe and a project Roster skill as
  the non-destructive fallback.
- Install and doctor report activation assurance as `auto-loaded`,
  `advisory-manual`, or `missing`; they never claim parity without a supported
  host-version attestation.
- `.roster/generated-manifest.json` is deterministic and Git-portable.
  `.roster/state/` is ignored locally and holds temporary locks only.

Auto-load assurance is deliberately narrow and fixture-backed. The checked-in
fixtures currently prove only these exact patch versions:

| Host | Generated path | Proven version | Fixture |
|---|---|---:|---|
| Claude Code | `.claude/CLAUDE.md` | `2.1.220` | `test/fixtures/host-activation/claude-project/.claude/CLAUDE.md` |
| Claude Code | `.claude/rules/roster.md` | `2.1.220` | `test/fixtures/host-activation/claude-rule/.claude/rules/roster.md` |
| Codex CLI | `AGENTS.md` | `0.144.1` | `test/fixtures/host-activation/codex-project/AGENTS.md` |

The Codex skill fallback is discoverable but is not attested as automatic
project activation. Missing binaries, different host patches, and authored
Codex root instructions therefore remain `advisory-manual`.

`roster update` on a v2 workspace synchronizes only unedited generated bootstrap
files. An edited generated file is preserved and reported per path. Authored
registry, policy, plan, and lesson files are never silently overwritten.

## Common v2 commands

| Command | Purpose |
|---|---|
| `roster init [workspace-id]` | Create only `roster.yaml` and `ROSTER.md` |
| `roster scaffold <kind> <id>` | Create one registered authored record |
| `roster discover [query] --json` | Return compact qualified records and diagnostics |
| `roster validate [target] --json` | Check registry, identity, paths, ownership, and generated drift |
| `roster install --tool claude\|codex --scope project` | Generate the selected host bootstrap |
| `roster update` | Safely synchronize enabled generated bootstrap files |
| `roster doctor --json` | Report workspace health, generated drift, safety, secrets, and activation assurance |
| `roster brain <verb>` | Use the opt-in company knowledge Brain |
| `roster skills sync` | Explicitly install a declared external skill manifest; never run implicitly by v2 update |

Commands return human text by default and stable JSON envelopes with `--json`.
Machine failures include a code, message, remedy, and JSON-safe details.

## Company Brain

Brain is broader than Roster product state: it is the company knowledge system
used to run the work. It can store structured entities and facts, source
documents, examples, content, ideas, analytics, relationships, completed-work
evidence, feedback, and human decisions with provenance.

The local repository holds authored operating policy. Remote Postgres/S3 holds
portable company knowledge and evidence so the same workspace can be used from
multiple machines. Missing Brain credentials never block local init, scaffold,
discover, or structural validation.

The existing Brain CLI is opt-in:

```bash
roster brain init
roster brain doctor
roster brain save --help
roster brain query --help
roster brain fs --help
```

Use Infisical to inject database, S3, and embedding credentials per command.
Roster configuration stores references and non-secret metadata only.

## Tool-use definitions

Vendor skills remain authoritative for installation, authentication, syntax,
parsing, compatibility, and generic best practices. A Roster tool-use definition
adds only the company-specific application:

- why and when this workspace uses the tool;
- the relevant subset of capabilities;
- company filters and safety rules;
- expected results;
- Brain reads/writes and evidence requirements; and
- the canonical external `skill_ref`.

The host derives request-specific filters and executes the tool. Roster does not
spawn a provider command, inject the provider secret, choose fallbacks, or judge
provider output as a workflow transition.

## Safety and ownership

- Authored files are changed only by an explicit scaffold/edit/migration action.
- Generated files have versioned ownership metadata and content hashes.
- Every default read and write is bounded to the resolved workspace.
- Every component below the workspace root is checked without following
  symlinks, including links whose target stays inside the workspace.
- New authored files use create-only atomic publication; registry membership is
  committed last.
- Raw secrets never enter authored files, generated output, JSON diagnostics,
  manifests, or issue bodies.
- No telemetry, install scripts, hosted Roster agent, or proprietary workflow
  runtime is required.

## Legacy workspaces

Roster recognizes v0.4/v1 and mixed workspaces but does not silently overlay v2
files or reinterpret their directories as a v2 registry. Their bytes remain
unchanged until the one-way v2 migrator can fingerprint, dry-run, back up, apply,
and recheck the conversion.

The legacy templates remain in the npm package temporarily as frozen migration
input. New v2 commands never read or emit them.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm test:scaffold-scripts
pnpm smoke
```

The full phase gate is:

```bash
pnpm typecheck && pnpm build && pnpm test && pnpm test:scaffold-scripts && pnpm smoke
```

See [spec/CONTEXT.md](spec/CONTEXT.md) for the current product contract,
[docs/roadmap.md](docs/roadmap.md) for the dependency-ordered refactor, and
[CONTRIBUTING.md](CONTRIBUTING.md) for repository workflow.

## License

[MIT](LICENSE)
