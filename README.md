![banner](https://raw.githubusercontent.com/firatcand/roster/7095215fd4224709f47d69270f35201b1c3206ce/roster-banner%402x.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@firatcand/roster.svg)](https://www.npmjs.com/package/@firatcand/roster)

# Roster

Roster is a thin, agent-facing CLI and context framework around a working
directory. It turns a folder into a purpose-built agent system for Claude Code
or Codex without becoming a second agent runtime.

The human works through Claude Code or Codex. The host calls Roster to find
authored policy and company context, interprets the complete plan, invokes its
own tools and subagents, and waits for human decisions in its native interface.
When the corresponding capability exists, the host also asks Roster to record
completed evidence and activate learning. Roster owns the durable structure
around that work.

```text
scaffold → resolve context → host executes → [when available: record evidence → learn]
```

## Product boundary

Roster has three pillars:

| Pillar | Roster owns |
|---|---|
| Working directory | Sparse functions, role agents, structured plans, subagents, guidelines, tool-use definitions, approved lessons, discovery, and static validation |
| Company Brain | Remote Postgres/S3 knowledge, source versions, indexes, graph-shaped facts, retrieval, citations, portable evidence, and learning state |
| Tool guidance | Company-specific purpose/when/how guidance and canonical vendor-skill references; the host still loads and executes the vendor tool |

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
- strict structured-plan schema, reference, scope, and cycle validation alongside
  structural path, ownership, and generated-drift checks;
- deterministic bounded task-context assembly with complete selected-plan
  closure, trust-separated fragments, provenance, and exact budget accounting;
- scope-owned workspace, function, agent, and plan tool-use guidance that resolves
  to one flat, provenance-carrying policy without executing a provider;
- bounded regular-file reads, component-wise symlink refusal, and atomic writes;
- one generated host-neutral lifecycle shared by thin Claude Code and Codex
  activation wrappers, with unavailable future stages marked explicitly; and
- the existing opt-in company Brain while its v2 identity/source lifecycle is
  upgraded.

Portable evidence and activated Dreamer learning are subsequent roadmap tasks.
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
roster scaffold tool-use social-opportunity-research \
  --scope agent:gtm/social-manager
roster scaffold tool-use social-opportunity-research \
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

A scaffolded plan is an editable draft. It is discoverable immediately, but
`roster validate` rejects it until an expert authors at least one ordered step
and actionable completion guidance. Roster validates and returns the complete
guide; Claude Code or Codex interprets it and performs the work.

A scaffolded tool-use definition is also a discoverable draft. It contains an
explicit empty `skill_ref` until the host-guided expert chooses the canonical
vendor skill and authors the company policy; update and validation fail closed
while that draft remains incomplete.

```yaml
schema_version: 2
id: opportunity-discovery
agent: gtm/social-manager
purpose: Produce a reviewed shortlist of relevant reply opportunities.
inputs:
  request:
    description: The human's current discovery request.
    required: true
brain_selectors:
  successful-replies:
    description: Examples of successful prior replies.
    required: false
guidelines: []
tool_uses:
  - social-opportunity-research
artifacts:
  shortlist:
    description: The human-reviewed opportunity shortlist.
caps:
  candidates:
    maximum: 25
    guidance: Keep only opportunities that match the current request.
steps:
  - id: prepare
    kind: reasoning
    instruction: Derive request-specific filters before choosing a tool query.
  - id: search
    kind: tool
    instruction: Use the company-defined social search use case.
    tool_use: social-opportunity-research
  - id: approve
    kind: approval
    instruction: Present the shortlist and pause.
    approval_guidance: Wait for the human in the host interface.
completion:
  artifacts:
    - shortlist
  output_guidance: Return the approved shortlist with relevance rationale.
  criteria:
    - Every opportunity is supported by evidence.
```

Plans contain inert guidance, not commands or an expression language. Array
position is the only step order, and references use local IDs only for
same-agent records. Cross-agent and nested-plan targets remain fully qualified.

## Bounded task context

The host requests one exact agent target, an optional explicitly selected plan,
and the current task:

```bash
roster context gtm/social-manager#opportunity-discovery \
  --query "Find reply opportunities from the last 24 hours" \
  --step research \
  --budget 12000 \
  --explain \
  --json
```

`--query` and `--json` are required. An omitted `#plan` returns agent-only
context; Roster never infers a plan from the request or step hint. The response
is one JSON document with `schema_version`, `workspace`, `target`, `request`,
`agent`, `plan`, `guidelines`, `lessons`, `brain_evidence`, `tool_uses`,
`skill_refs`, `provenance`, `budget`, and `diagnostics` sections. It deliberately
has no success `ok` field.

The selected root plan and its complete statically referenced nested-plan
closure are mandatory and never truncated. Applicable approved lessons and
cited Brain evidence are optional and ranked under the token budget. If the
workspace has no Brain binding, context resolution still succeeds with the
complete local bundle, empty `brain_evidence`, and a `BRAIN_NOT_BOUND` warning.

Claude Code or Codex interprets and executes the returned definitions. Roster
does not choose a current step, invoke a vendor tool, carry runtime outputs,
enforce approval, or decide what happens next.

## Workspace model

Authorship stays hierarchical so ownership remains legible:

```text
roster.yaml
ROSTER.md
tools/<tool-use>.yaml
functions/<function>/
  function.yaml
  guidelines/<guideline>.md
  tools/<tool-use>.yaml
  agents/<agent>/
    agent.yaml
    guidelines/<guideline>.md
    plans/<plan>.yaml
    plans/<plan>/tools/<tool-use>.yaml
    subagents/<subagent>.yaml
    tools/<tool-use>.yaml
    playbook/<lesson>.md
```

Only `roster.yaml` registers function roots. The workspace, function, agent,
and plan registries each declare the tool-use records they own. Discovery
follows those declarations and returns one flat, stable list. It never treats
an arbitrary directory scan as authority.

Tool-use identities remain unambiguous even when the same local use-case ID is
specialized at every scope:

| Owner | Qualified identity |
|---|---|
| Workspace | `tools/<id>` |
| Function | `<function>/tools/<id>` |
| Agent | `<function>/<agent>/tools/<id>` |
| Plan | `<function>/<agent>#<plan>/tools/<id>` |

Optional directories appear on first use. Scaffolding one agent does not create
empty plan, playbook, tool, log, pending, or host trees.

## Generated host activation

Project install writes reproducible, self-identifying activation files without
overwriting authored host instructions.

- `ROSTER.md` is the single generated lifecycle contract. Claude Code and Codex
  wrappers only activate that file; they do not duplicate commands, trust
  rules, or business workflow.
- Claude Code uses a project instruction file, with an isolated rule fallback
  when an authored instruction already exists.
- Codex uses create-only root `AGENTS.md` when safe and a project Roster skill as
  the non-destructive fallback.
- Install and doctor report activation assurance as `auto-loaded`,
  `advisory-manual`, or `missing`; they never claim parity without a supported
  host-version attestation.
- `.roster/generated-manifest.json` is deterministic and Git-portable.
  `.roster/state/` is ignored locally and holds temporary locks only.

The shared lifecycle and each enabled host use four capability states:

| State | Meaning |
|---|---|
| `supported` | Present and sufficiently proven for the caller to rely on |
| `advisory` | Useful guidance or activation exists, but the host must perform or manually activate it |
| `missing` | The capability or enabled activation is absent |
| `drifted` | Generated bytes or metadata no longer prove the canonical contract |

`roster doctor --json` emits the host-neutral lifecycle once at
`generated.lifecycle_capabilities` and only the host-specific
`activation_capability` under each enabled host. Doctor is an on-demand
diagnostic, not a per-task handshake or capability-negotiation protocol.

Discovery and bounded context are currently `supported`. Whole-plan
interpretation, vendor-skill loading, execution, and human presentation are
`advisory` because the host owns them. Portable evidence recording, Dreamer
readiness, and the Dreamer candidate lifecycle are currently `missing`; the
generated contract tells the host to finish the work and report that durable
recording/learning is unavailable rather than substituting legacy run,
scheduling, pending, ops, generic Brain writes, or Markdown logs.

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

Activation `supported` proves that the generated pointer auto-loaded and the
shared lifecycle was reachable on the exact fixture patch. It does not prove a
model followed an entire business workflow; host-led golden-flow coverage is a
separate integration concern.

`roster update` on a v2 workspace first preflights the complete authored
tool-use catalog and vendor-skill provenance. If any definition is an unfinished
draft or the portable map cannot be derived safely, it writes nothing. A valid
update synchronizes only unedited generated bootstrap files and atomically
regenerates `.roster/vendor-skill-map.json`. Authored registry, policy, plan,
and lesson files are never silently overwritten.

When Roster ships a revised generated lifecycle, existing self-identifying
generated bodies are replaced by `roster update`. Until that explicit update,
doctor reports canonical-renderer drift; it never reclassifies old generated
bytes as authored policy or overwrites a genuinely authored instruction file.

## Common v2 commands

| Command | Purpose |
|---|---|
| `roster init [workspace-id]` | Create only `roster.yaml` and `ROSTER.md` |
| `roster scaffold <kind> <id>` | Create one registered authored record |
| `roster discover [query] --json` | Return compact qualified records and diagnostics |
| `roster validate [target] --json` | Check registry, identity, paths, ownership, and generated drift |
| `roster context <function>/<agent>[#plan] --query <retrieval-query> --json` | Return one bounded, cited, trust-separated task bundle from a short, non-secret host-derived query |
| `roster install --tool claude\|codex --scope project` | Generate the selected host bootstrap |
| `roster update` | Preflight tool guidance, then synchronize bootstrap files and the portable vendor-skill map |
| `roster doctor --json` | Report workspace health, generated drift, safety, secrets, and activation assurance |
| `roster brain <verb>` | Use the opt-in company knowledge Brain |
| `roster skills sync` | Explicitly install a declared external skill manifest; never run implicitly by v2 update |

Commands return human text by default and stable JSON envelopes with `--json`;
`roster context` is agent-facing and requires JSON. Machine failures include a
code, message, remedy, and JSON-safe details.

## Company Brain

Brain is broader than Roster product state: it is the company knowledge system
used to run the work. It can store structured entities and facts, source
documents, examples, content, ideas, analytics, relationships, completed-work
evidence, feedback, and human decisions with provenance.

The local repository holds authored operating policy. Remote Postgres/S3 holds
portable company knowledge and evidence so the same workspace can be used from
multiple machines. Missing Brain credentials never block local init, scaffold,
discover, structural validation, or the mandatory local portion of task
context.

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

- the purpose and situations in which this workspace uses the tool;
- the relevant subset of capabilities;
- company filters and safety rules;
- expected-output guidance;
- Brain reads/writes and evidence requirements; and
- a canonical external `skill_ref` in `<package>:<skill>` form.

Definitions may be owned by the workspace, function, agent, or plan. Roster
resolves only the exact ancestry for the requested context. `purpose` is
replaced by the most specific definition; applicability, procedure, filters,
rules, output expectations, evidence, and approval guidance accumulate in
broad-to-narrow order. Effects may only narrow, approval may only become more
strict, Brain intent is append-only, and every layer must retain the same
`skill_ref`. The result is one flat effective definition with field-level
provenance and a deterministic semantic hash. A narrower layer can never relax
broader safety. Brain read/write entries are requested intent, never grants;
the independently loaded Brain binding and scope still authorize access.

For example, Social Manager can own the reusable Exa ceiling in
`functions/gtm/agents/social-manager/tools/social-opportunity-research.yaml`:

```yaml
schema_version: 2
id: social-opportunity-research
scope: { function: gtm, agent: social-manager }
purpose: Find timely public posts matching company positioning.
skill_ref: exa:search
filters:
  - exclude previously presented canonical URLs
  - exclude cryptocurrency topics
rules:
  - require canonical URLs and attributable provenance
brain:
  read: [previously-presented-opportunities]
effects:
  allowed: [external-read, brain-read, brain-write]
```

Its `opportunity-discovery` plan can then own a same-ID overlay beneath
`plans/opportunity-discovery/tools/`:

```yaml
schema_version: 2
id: social-opportunity-research
scope: { function: gtm, agent: social-manager, plan: opportunity-discovery }
purpose: Rank timely LinkedIn and public-web opportunities for this request.
skill_ref: exa:search
how:
  - start with a 24-hour lookback and expand only as far as 72 hours
  - rank candidates by ICP relevance
filters:
  - reject profile and company-homepage URLs as candidate post URLs
output_expectations:
  required: [canonical_url, author, published_at, relevance_reason]
brain:
  write: [discovered-opportunity, retrieval-provenance]
effects:
  allowed: [external-read, brain-read, brain-write]
```

`.roster/vendor-skill-map.json` maps each canonical ref for the workspace's
committed hosts. Each entry also carries sorted `authored_paths`: secret-free,
workspace-relative tool-use paths used only to prove which generated-map drift
belongs to an explicitly ignored unrelated draft during targeted validation.
They are validation provenance, not locators, policy, or semantic authority. A
`host-native` locator is advisory: Claude Code, Codex, or its
plugin manager decides whether that identity is installed and resolves it.
Only an explicitly project-materialized, workspace-confined locator is marked
`verified` by Roster. Roster neither scans global host caches nor installs a
global plugin.

Project-relative verification requires a canonical per-host content hash in
`founder-skills.lock`. Legacy aggregate-only lock entries fail closed even when
their bytes appear unchanged; run `roster skills sync` to rewrite reviewed lock
metadata with the bounded, symlink-safe hash format before updating the map.

The host derives request-specific filters and executes the tool. Roster does not
spawn a provider command, inject the provider secret, choose fallbacks, or judge
provider output as a workflow transition. Expected output remains guidance for
the host, never a Roster-owned provider result gate.

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
