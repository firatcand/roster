# Roster v2 — Project Context

Generated from `spec/BRIEF.md`, `spec/PRD.md`, and `spec/SPEC.md` after the host-ownership decision.

## Product

Roster is a thin CLI and framework around a working directory. Claude Code or Codex uses it to turn a folder into a purpose-built agent system with structured operating policy, bounded company context, use-case-specific tool guidance, portable evidence, and human-approved learning.

The human normally never calls Roster directly. The host is the runtime.

```text
scaffold → resolve context → host executes → record evidence → learn
```

## Architectural rule

Claude Code or Codex interprets plans, reasons, delegates, invokes external tools, carries outputs, handles retries/conditions, obtains human decisions, schedules work, and renders results.

Roster scaffolds, discovers, statically validates, resolves bounded context, manages company Brain, stores evidence, computes Dreamer readiness, manages candidates/lessons, and generates thin host activation instructions.

Roster never owns a plan compiler/reducer, current-step cursor, workflow transition engine, provider router, scheduler, general operations platform, or approval authority.

## Three pillars

### Working Directory

- Git-canonical functions, role agents, plans, subagents, guidelines, tool-use definitions, playbooks, and approved lessons.
- Sparse initialization: `roster.yaml` and short `ROSTER.md`; optional structures appear only on request.
- Hierarchical authorship with qualified identities; flat runtime activation through one context bundle.
- Structured plans are host-interpreted step-by-step operating guides, not prompts and not executable Roster DSLs.
- Deterministic scaffold/discover/validate/update/migrate commands with explicit authored/generated ownership.

### Brain

- Roster-owned remote company Brain, broader than Roster product data.
- Neon/Postgres owns Brain identity, workspace bindings, scopes, provenance, structured knowledge, indexes, evidence, and learning state.
- S3-compatible storage owns immutable raw media and large artifacts.
- Supports people, organizations, prospects, customers, content, ideas, tasks, examples, documents, facts, events, edges, decisions, runs, feedback, and lesson candidates.
- Lexical and structured retrieval work without embeddings; OpenAI embeddings and graph enhancements are privacy-aware, optional, and evidence-gated.
- Multiple authorized machines/workspaces may share a company Brain.
- External systems remain authoritative until selected data is explicitly ingested with provenance.

### Tools

- Vendor skill owns installation, authentication, provider syntax, capabilities, parsing, compatibility, and generic best practices.
- Workspace tool-use definition owns why/when/how that skill is used for this company/function/agent/plan, relevant capabilities, business filters, expected output, approval guidance, and Brain reads/writes.
- Plan references the workspace tool-use definition.
- The host derives request-specific filters and invokes the real CLI/MCP/API/browser/connector.
- Roster validates and returns guidance; it does not connect, route, health-check, fallback, or execute external providers.
- Brain Postgres/S3/extraction/embedding/retrieval commands are the built-in exception.

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
- trust classes, scope, versions/hashes, provenance, inclusion reasons, and budget accounting; and
- deterministic exclusions and diagnostics.

Roster does not return or persist a selected current step, next action, prior-output binding, transition, provider route, or approval receipt.

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

- Notion task state machine as optional external tool integration;
- second opinion as repository-development tooling;
- tripwire as optional report-only defense;
- Gemini adapter pending measured demand; and
- trigram aliases, default embeddings, multi-hop graph, automatic edges, and hosted reranking pending adopter quality evidence.

## Security invariants

- All default paths are workspace-confined, regular-file-only, bounded, and component-wise symlink safe.
- External paths require an exact host-obtained human grant.
- Every Brain row is isolated by `brain_space_id` and authorized scope using RLS/least-privilege roles.
- Runtime roles cannot mutate schema or create arbitrary tables.
- HTTPS and explicit endpoint trust protect S3 configuration.
- Privacy class governs storage, extraction, embedding, retrieval, and export; secret-class content is never embedded.
- Authored policy, vendor instruction, Brain evidence, and tool output remain structurally separated by trust class.
- Vendor skills prefer immutable pins and record source/revision/hash/review provenance.
- Raw secrets never enter authored files, generated output, context, logs, migrations, or issue bodies; Infisical supplies them per command.
- Legacy logs, actors, approvals, and candidates import as `legacy-unverified`, never accepted authority.

## Migration

One-way, dry-run-first migration preserves authored useful structures and Brain history, converts tool intent into tool-use definitions, replaces absolute Brain source identity, imports legacy evidence as unverified, maps only secret key names to Infisical references, removes exact Roster-managed cron blocks with consent, and archives/deletes general operations state after extracting minimal evidence.

Frozen `my-roster` and `roster-lobu` snapshots are required fixtures. No permanent compatibility shim.

## Golden proof

The first real proof is `my-roster` Social Media Manager discovery:

1. Human asks Claude Code or Codex.
2. Host discovers the agent and complete structured plan.
3. Roster returns bounded guidelines, lessons, company Brain examples/facts, tool-use guidance, vendor skill refs, and citations.
4. Host derives filters and invokes the vendor skill.
5. Host records portable completed-run/artifact/feedback evidence.
6. Dreamer becomes due and the host invokes it without a Roster schedule.
7. Human approves a cited candidate.
8. The approved lesson changes a later context bundle.

The same model must work for a distinct `roster-lobu` workflow.

## Release gates

- Static plan and reference validation passes.
- Both host adapters complete the seeded and real golden flows without a Roster executor.
- Brain source/version/retrieval citations, scope isolation, recovery, and privacy pass.
- Real vendor skill use is host-executed through a workspace tool-use definition.
- Dreamer readiness and promotion work after evidence recording and next-session recovery.
- Context quality passes required recall, exclusion, citation, determinism, and at least 60 percent token reduction.
- Scheduler and general ops/HITL code and tests are absent after migration.
- Security, migration, doctor, drift, adopter rehearsal, full tests, smoke, secret scan, and second opinion pass.

## Default implementation decisions

- Initialization succeeds without Brain credentials; Brain commands fail explicitly until binding.
- `skill_ref` has one canonical external identity with host-specific generated aliases.
- Brain is remote by default for cross-machine portability.
- Git is canonical for operating policy; Brain is canonical for portable evidence and company knowledge; S3 is canonical for large bytes.
- No product-boundary question remains open. Tasks may decide implementation details only within this contract.
