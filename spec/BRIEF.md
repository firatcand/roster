# Roster v2 — Brief

## Product

Roster is a thin, agent-facing framework around a working directory. It turns a folder or repository into a purpose-built agent system for Claude Code and Codex by maintaining the scaffolding, company context, and use-case-specific tool guidance that those hosts need.

The human works through Claude Code or Codex. The host calls Roster. Roster is not a second chat interface and it is not the workflow runtime.

The core dynamic is:

> scaffold → resolve context → host executes → record evidence → learn

Roster owns the durable structure and context-management parts of that loop. The host interprets the plan, reasons, invokes subagents and tools, obtains human decisions, carries outputs between steps, and decides what happens next.

## User & JTBD

The primary user is a person running company work through Claude Code or Codex in a folder on one or more machines.

When the user asks the host to perform a recurring or specialized job, they need the host to:

- find the correct agent, structured plan, guidelines, lessons, and tool-use definitions without eagerly loading the whole repository;
- retrieve the smallest relevant, cited slice of company knowledge from a shared Brain;
- use external tools according to the company's purpose, filters, business rules, and evidence policy;
- record portable outcomes and feedback; and
- improve later work through human-approved lessons.

The user should not need to learn or operate Roster commands directly during normal work.

## Three pillars

### Working Directory

The repository is the Git-canonical authoring surface for functions, role-based agents, structured plans, subagents, guidelines, playbooks, approved lessons, and workspace tool-use definitions.

The hierarchy remains useful for ownership and authoring, but activation is flat: the host discovers a target and asks for one bounded bundle instead of recursively loading many instruction files. Fresh workspaces are sparse. Optional structures are created only when the human asks the host to create them.

Plans are deterministic operating guides, not prompts and not programs. They define ordered work, expected inputs and outputs, decision points, tool-use references, and completion criteria. Claude Code or Codex interprets them.

### Brain

Brain is a Roster-owned, remote company knowledge system backed by Postgres and S3-compatible object storage. It is broader than Roster product data and can hold company facts, people, customers, prospects, examples, documents, content, ideas, tasks, decisions, events, relationships, run observations, and feedback.

Postgres owns identity, scope, metadata, provenance, structured knowledge, indexes, retrieval state, and learning state. S3 owns raw media and large immutable artifacts. OpenAI embeddings are optional indexing infrastructure, not the only retrieval mode.

Multiple explicitly bound workspaces and machines may share one company Brain. External systems such as Notion remain authoritative until selected information is explicitly ingested with provenance.

### Tools

Roster does not replace vendor skills or connect, route, health-check, or execute external providers.

A vendor skill owns installation, authentication, syntax, version compatibility, output parsing, and provider-specific best practices. A Roster workspace tool-use definition owns how that skill is applied here: why and when to use it, which capabilities matter, business filters, query strategy, expected result, approval guidance, and what to read from or save into Brain. A plan references the tool-use definition.

Brain's own Postgres, S3, extraction, embedding, and retrieval commands are the explicit built-in exception because Brain is a Roster subsystem.

## v1 scope

- Sparse workspace initialization and generated host activation.
- Hierarchical scaffolding for functions, agents, plans, subagents, guidelines, tool-use definitions, and lessons.
- Discovery, static schema validation, reference checking, and drift diagnostics.
- Bounded context assembly for a host-supplied task, agent, plan, and optional step hint.
- Company Brain ingestion, source versioning, indexing, retrieval, provenance, scopes, and graph-shaped knowledge.
- Portable run, artifact, feedback, and human-decision evidence in Brain.
- Dreamer readiness, evidence-backed lesson candidates, human promotion, rejection, retirement, and later lesson selection.
- Thin, host-neutral Claude Code and Codex activation instructions.
- One-way migration from the current scaffold, scheduling, and operations surfaces.

## Non-goals

- A Roster-owned plan compiler, reducer, current-step cursor, transition engine, retry engine, or output-binding runtime.
- Roster-owned scheduling, cron, daemons, wake/resume, polling, or session management.
- A generic task queue, lease system, outbox, inbox, operations platform, or Slack-specific control plane.
- Roster-owned approval authority. The host waits for and enforces human decisions; Roster may store action-bound decision evidence for portability.
- A generic provider connection, routing, fallback, secret-injection, or execution layer for external tools.
- A hosted Roster agent, chat UI, or requirement that humans call Roster CLI themselves.
- Automatic ingestion of everything from Notion, social networks, repositories, or other company systems.

## Product principles

1. **Host runtime, Roster context.** Claude Code or Codex executes; Roster makes the right structure and context available.
2. **Flat activation, structured authorship.** Preserve role and plan structure on disk, but return one bounded context bundle at runtime.
3. **Evidence before deletion.** Lack of observed use may indicate broken activation, deployment, or guidance. Capabilities are removed only when they fall outside the product boundary or measured value does not justify them.
4. **Remote knowledge, local policy.** Company knowledge and portable evidence live in Brain; authored operating policy lives in Git.
5. **Vendor skill plus company use.** External skills explain the tool; Roster explains this company's use of the tool.
6. **Human-approved learning.** Dreamer may create candidates automatically, but only a human-approved lesson becomes active policy.
7. **Sparse by default.** No empty capability forests, placeholder plans, schedule trees, or pre-created run-log directories.

## Definition of done

Roster v2 is complete when the Social Media Manager discovery plan in `my-roster` works through both Claude Code and Codex as follows:

1. The human asks the host to discover social opportunities.
2. The host discovers the relevant agent and reads its complete structured plan.
3. Roster returns a bounded, cited context bundle containing applicable guidelines, approved lessons, Brain examples and company facts, tool-use definitions, and vendor skill references.
4. The host derives the request-specific filters, invokes the appropriate vendor skill or CLI, interprets the result, and completes the plan without a Roster execution engine.
5. Roster records the completed-run summary, source and tool provenance, artifacts, outcome, feedback, and any human decision evidence in Brain.
6. Dreamer becomes due from durable evidence, the host invokes the Dreamer skill, and a cited candidate is stored.
7. After human approval, the lesson is materialized in the working directory and changes a later applicable context bundle.

The representative bundle must use at least 60 percent fewer tokens than the frozen eager-load baseline while meeting required-context recall, irrelevant-context exclusion, citation completeness, deterministic selection, secret-safety, and scope-isolation thresholds.

## Defaults and constraints

- `roster init` may succeed without Brain credentials. Brain-dependent operations fail clearly until a company Brain is bound.
- Neon/Postgres and S3 are remote so Brain and run evidence are portable across machines.
- Markdown run logs are optional projections; Brain is canonical for portable run and learning evidence.
- Operational evidence is stored separately from semantic company knowledge and is not embedded or retrieved as ordinary knowledge by default.
- External `skill_ref` values use a canonical package/name identity; generated host adapters may map that identity to host-specific installation paths.
- Plans and tool-use definitions may include approval guidance, but only the host can pause and enforce the decision.
- No backwards-compatibility shim is permanent. Migration is explicit, one-way, and rehearsed against `my-roster` and `roster-lobu`.

## Open product-boundary questions

None. Implementation details that do not change these ownership boundaries may be decided within the relevant GitHub issue.
