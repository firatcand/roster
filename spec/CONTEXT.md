# Roster v2 — Project Context

Generated from `spec/BRIEF.md`, `spec/PRD.md`, and `spec/SPEC.md` after the host-ownership, provider-neutral tool-use, and native Brain decisions.

## Product

Roster is a thin CLI and framework around a working directory. Claude Code or Codex uses it to turn a folder into a purpose-built agent system with structured operating policy, bounded company context, use-case-specific tool guidance, portable evidence, and human-approved learning.

The human normally never calls Roster directly. The host is the runtime.

```text
scaffold → resolve context → host executes → record evidence → learn
```

## Architectural rule

Claude Code or Codex interprets plans, reasons, delegates, invokes external APIs, CLIs, MCP servers, browsers, and connectors, carries outputs, handles retries/conditions, obtains human decisions, schedules work, and renders results.

Roster scaffolds, discovers, statically validates, resolves bounded context, directly manages company Brain storage and retrieval, stores evidence, computes Dreamer readiness, manages candidates/lessons, and generates thin host activation instructions.

Direct provider access is confined to Roster-owned Brain PostgreSQL, S3-compatible storage, and optional embedding operations. Roster never owns a plan compiler/reducer, current-step cursor, workflow transition engine, external-tool executor/router, scheduler, general operations platform, or approval authority.

## Three pillars

### Working Directory

- Git-canonical functions, role agents, plans, subagents, guidelines, tool-use definitions, playbooks, and approved lessons.
- Sparse initialization: `roster.yaml` and short `ROSTER.md`; optional structures appear only on request.
- Hierarchical authorship with qualified identities; flat runtime activation through one context bundle.
- Structured plans are host-interpreted step-by-step operating guides, not prompts and not executable Roster DSLs.
- Deterministic scaffold/discover/validate/update/migrate commands with explicit authored/generated ownership.

### Brain

- Brain is optional during initialization and local work but indivisible when active.
- Every Brain-backed operation requires complete compatible PostgreSQL and S3-compatible configuration; neither store alone enables degraded behavior.
- Roster directly owns Brain initialization, identity checks, migrations, ingestion, retrieval, evidence, repair, and learning-state operations.
- Tracked `roster.yaml` stores the stable `workspace_id`, a generic secret reference, and non-secret storage organization; credentials remain ambient.
- Protected database metadata stores the same workspace and namespace identity. Brain initialization and doctor validate both services; individual commands perform only the I/O they need.
- Workspace/function/agent/plan scopes are typed retrieval labels for selection, ranking, explanation, and exclusion—not credentials or RLS principals.
- PostgreSQL owns identity, provenance, structured knowledge, indexes, evidence, and learning state. S3-compatible storage owns immutable raw media and large artifacts.
- Supports people, organizations, prospects, customers, content, ideas, tasks, examples, documents, facts, events, edges, decisions, runs, feedback, and lesson candidates.
- Lexical and structured retrieval work without embeddings; embedding and graph enhancements are provider-neutral, privacy-aware, optional, and evidence-gated.
- Clones and machines of the same logical workspace may share its Brain through authorized ambient credentials. A different `workspace_id` uses a different database and namespace.
- External systems remain authoritative until selected data is explicitly ingested with provenance.

### Tools

- External or workspace skill owns installation, authentication, provider syntax, capabilities, parsing, compatibility, and generic best practices.
- Workspace tool-use definition owns why/when/how that skill is used for this company/function/agent/plan, relevant capabilities, business filters, expected output, approval guidance, and Brain reads/writes.
- Plan references the workspace tool-use definition.
- The host derives request-specific filters and invokes the actual API, CLI, MCP server, browser, or connector.
- Roster validates and returns guidance; it does not connect, route, health-check, fall back, or execute external business providers.
- Roster's direct PostgreSQL, S3-compatible storage, and optional embedding operations are confined to Brain and are the sole provider-execution exception.

## Canonical authorities

| Data | Authority |
|---|---|
| Agents, plans, guidelines, tool-use definitions | Working-directory Git |
| Approved active lessons | Working-directory playbooks in Git |
| Company knowledge and source provenance | Brain/Postgres |
| Raw media and large artifacts | Brain/S3 |
| Runs, feedback, human-decision evidence, Dreamer candidates/history | Separate Brain evidence/learning schemas |
| Conversation, schedule, pending UI, approval enforcement | Claude Code or Codex |
| Markdown run logs | Optional projections only |

Operational evidence is not embedded or returned as ordinary semantic company knowledge by default. Explicit promotion preserves lineage.

## Structured plans

Plans declare purpose, inputs, ordered steps, expected artifacts/output guidance, completion criteria, Brain context selectors, subagent/nested/cross-agent references, tool-use references, and optional condition/retry/approval guidance.

Roster performs bounded parsing, schema validation, reference resolution, cycle detection, and linting. It returns the complete plan. The host interprets all runtime semantics.

The plan schema must not grow an arbitrary code, shell, expression, goto, worker, queue, or hidden transition language.

## Context contract

The host supplies:

- target function/agent and optional selected plan;
- human request/task query;
- optional host-selected step hint; and
- token budget.

Roster returns:

- target metadata, agent definition, and complete plan;
- applicable guidelines and approved lessons;
- cited Brain facts, structured records, and extracts;
- applicable workspace tool-use definitions and canonical vendor skill refs;
- trust classes, workspace and narrower scope labels, versions/hashes, immutable workspace/source/version/object/extractor citations, inclusion reasons, and budget accounting; and
- deterministic exclusions and diagnostics.

Roster does not return or persist a selected current step, next action, prior-output binding, transition, provider route, or approval receipt.

Brain evidence is considered only after complete PostgreSQL and S3-compatible configuration is established. With no Brain configuration, context returns the complete local bundle, empty Brain evidence, and one `BRAIN_NOT_CONFIGURED` warning. Partial configuration makes `roster context` return no bundle, a fatal `BRAIN_CONFIGURATION_INCOMPLETE` diagnostic, and a nonzero exit without contacting either store. With complete configuration, an identity or namespace mismatch stops before company-content reads, object access, or mutation.

## Minimal CLI

```text
roster init|install|update|doctor|migrate
roster scaffold function|agent|plan|subagent|guideline|tool-use|lesson
roster discover
roster validate
roster context
roster brain init|doctor|ingest|save|get|query|event|link|merge|fs
roster brain record run|feedback|artifact|decision
roster dream status
roster dream candidates list|create|promote|reject|retire
```

Remove schedule, pending, general ops, runtime next/submit/approve, plan compile, and external tool route/health/execute surfaces.

Dreamer reflection is a host skill, not a scheduled CLI model invocation.

## Portable evidence and human decisions

A completed-run record contains the request summary/hash, host and Roster versions, agent/plan identity, timing, outcome, source/tool summaries, artifacts, provenance, and optional feedback links. It does not drive execution.

Human decisions may be stored with an exact normalized action digest, answer, actor assurance, timestamp, and host provenance. The record is portable evidence, never execution authority. The host presents, waits, enforces native safety, and decides whether to proceed.

Equivalent writes are idempotent; conflicting replay fails without mutation.

## Dreamer

Dreamer is retained and rebuilt because its low use is explained by broken activation:

- no durable eligibility/observation accumulator;
- session bootstrap checks only already-pending files;
- triggers are manual or Roster-scheduled;
- nightly plan looks at `log/...` while agent scaffold uses `logs/...`;
- no candidate lifecycle engine; and
- promotion is coupled to Slack/local queue behavior.

Replacement flow:

```text
completed runs + feedback in Brain
→ roster dream status computes durable due/not_due watermark
→ host checks after recording and on next Roster interaction
→ host invokes Dreamer skill when due
→ skill drafts cited candidates in Brain
→ host waits for human promote/revise/reject/retire
→ approved lesson is written to Git playbook
→ later context selects the lesson
```

Candidate creation may be automatic through the host. Policy activation remains human-confirmed by default. Dreamer output cannot support itself as independent evidence.

## Survivorship-corrected dispositions

### Keep and make central

- functions, role agents, subagents, structured plans, guidelines, playbooks, lessons;
- sparse scaffolding and qualified discovery;
- Brain structured knowledge, graph/provenance, S3, retrieval, backup/GC/reindex primitives;
- Dreamer concept and human-approved learning;
- generated/authored ownership, safe paths, bounded reads, atomic writes, hashes, locks, and drift handling;
- vendor skill pinning/provenance generalized from founder skills; and
- a small portable evidence layer extracted from existing persistence work.

### Delete after extraction

- Roster scheduling/cron/fire/state and schedule-derived pending;
- general operations queues, leases, outbox, overlay, sealed ledger, inbox, wake/resume, capability negotiation, and setup journals;
- general HITL state machine, Slack approval coupling, and execution receipts;
- proposed Roster plan compiler/reducer/current-step protocol; and
- generic external provider routing/health/fallback/execution.

### Quarantine or measure

- external task-system workflows through ordinary skill/tool-use definitions;
- second opinion as repository-development tooling;
- tripwire as optional report-only defense;
- additional host adapters pending measured demand; and
- trigram aliases, default embeddings, multi-hop graph, automatic edges, and hosted reranking pending representative quality and demand evidence.

## Security invariants

- All default paths are workspace-confined, regular-file-only, bounded, and component-wise symlink safe.
- External paths require an exact host-obtained human grant.
- Brain activates only with complete compatible PostgreSQL and S3-compatible storage; partial configuration contacts neither store.
- The database is the cross-workspace boundary; one logical workspace cannot activate another workspace's database or S3 namespace.
- Scope labels cannot widen retrieval and are never treated as credentials; v2 has no shared-Brain tenancy, per-scope logins, or cross-workspace/cross-scope RLS.
- Runtime roles cannot mutate schema, protected workspace identity/provenance, or create arbitrary tables.
- HTTPS and explicit endpoint trust protect S3 configuration.
- Privacy class governs storage, extraction, embedding, retrieval, and export; secret-class content is never embedded.
- Authored policy, vendor instruction, Brain evidence, and tool output remain structurally separated by trust class.
- Vendor skills prefer immutable pins and record source/revision/hash/review provenance.
- Raw secrets never enter authored files, generated output, context, logs, migrations, or issue bodies. Any secret manager, workload identity, environment injector, or provider credential mechanism may supply ambient credentials; none is required by Roster.
- Legacy logs, actors, approvals, and candidates import as `legacy-unverified`, never accepted authority.

## Migration

One-way, dry-run-first migration upgrades each existing Brain in its current PostgreSQL database and S3-compatible namespace. Both stores must be completely configured before Brain migration begins. Migration creates or validates tracked non-secret provider-neutral configuration and protected workspace identity; preserves authored structures, structured knowledge, and graph/source/object history; converts tool intent into tool-use definitions; replaces absolute paths with stable source identity while retaining them as legacy locators; imports legacy evidence as unverified; records generic ambient credential references without resolving values; removes exact Roster-managed schedule blocks with consent; and archives or deletes general operations state after extracting minimal evidence.

At least two frozen synthetic fixtures representing distinct workflow domains are required. No shared tenancy wrapper, permanent dual-write, or compatibility shim is created.

## Golden proof

The golden proof is a synthetic, non-normative specialized-workflow fixture:

1. Human asks Claude Code or Codex.
2. Host discovers the agent and complete structured plan.
3. Roster returns bounded local policy, optional cited Brain evidence, tool-use guidance, external skill references, and citations.
4. Host derives filters and invokes the external skill through its available API, CLI, MCP, browser, or connector surface.
5. With both Brain stores active, Roster records portable completed-run/artifact/feedback evidence.
6. Dreamer becomes due and the host invokes it without a Roster schedule.
7. Human approves a cited candidate.
8. The approved lesson changes a later context bundle.

A second synthetic workflow from a distinct domain proves the model is not tied to one role or use case. Multiple hermetic provider/surface fixtures prove the host-execution boundary. One explicitly configured live-provider smoke per host is optional. No fixture or live provider is normative.

## Release gates

- Local initialization, scaffolding, discovery, validation, and local context pass with no infrastructure.
- Brain activation tests cover neither store, PostgreSQL only, object storage only, both valid, and complete-but-mismatched/unavailable states.
- Both host adapters complete synthetic golden flows without a Roster executor.
- Brain workspace/source/version/object/extractor citations, protected identity, namespace confinement, scope-selection correctness, recovery, privacy, and embedding-optional behavior pass.
- Multiple hermetic fixtures cover materially different external-tool surfaces and provider contracts; one configured live-provider smoke per host is optional and non-gating.
- Dreamer readiness and promotion work after evidence recording and next-session recovery.
- Context quality passes required recall, exclusion, citation, determinism, and at least 60 percent token reduction.
- Scheduler and general ops/HITL code and tests are absent after migration.
- Security, migration, doctor, drift, representative rehearsal, full tests, smoke, secret scan, and second opinion pass.

## Default implementation decisions

- Initialization and local scaffolding/discovery/validation require no Brain infrastructure or credentials.
- Brain activates only when both compatible PostgreSQL and S3-compatible storage are configured and validated. No configuration leaves Brain inactive while local context returns with `BRAIN_NOT_CONFIGURED`; partial configuration makes context and Brain commands return nonzero with `BRAIN_CONFIGURATION_INCOMPLETE`, emits no context bundle, and contacts neither store.
- Roster directly owns Brain database, object-storage, migration, ingestion, retrieval, evidence, and repair operations.
- Any compatible PostgreSQL, S3-compatible storage, optional embedding provider, and ambient credential mechanism may be used.
- Embeddings are optional; lexical and structured retrieval are required baseline modes.
- External tools remain host-executed through API, CLI, MCP, browser, or connector surfaces.
- `skill_ref` has one canonical external identity with host-specific generated aliases.
- Git is canonical for operating policy; Brain is canonical for portable evidence and company knowledge; S3-compatible storage is canonical for large bytes.
- Provider, workspace, role, and workflow examples are non-normative.
- No product-boundary question remains open. Tasks may decide implementation details only within this contract.
