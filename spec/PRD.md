# Roster v2 — PRD

## Problem

Roster currently creates a rich agent-team scaffold, but the scaffold is not reliably activated by Claude Code or Codex during ordinary work. Real adopter repositories show agents, plans, guidelines, lessons, Brain data, tools, and Dreamer concepts, yet the host often receives large eager instruction trees and has no small, reliable path to discover the right definition, retrieve relevant company context, record evidence, or trigger learning.

Low usage is therefore not proof that these concepts are unnecessary. The audit found multiple activation failures:

- the CLI emphasizes broad installation, scheduling, pending work, operations, and persistence rather than the agent-facing discovery/context loop;
- host instructions do not consistently lead Claude Code or Codex through discovery, plan interpretation, evidence recording, and Dreamer checks;
- structured plans exist as authored guidance but have no clear host-owned execution contract;
- Dreamer depends on manual or schedule paths and mismatched log locations, so the self-improvement loop does not reliably start;
- tool definitions mix company use cases with provider execution concerns instead of layering on top of vendor skills; and
- portable evidence is buried inside a much larger operations/HITL state machine.

The product must become a thin, coherent scaffolding and context-retrieval layer without flattening away useful authoring structure.

## Target user

The primary user is a founder or operator who starts Claude Code or Codex inside a company working directory and asks it to perform specialized or repeated work.

The direct machine consumer is the host agent. It needs stable, JSON-first commands for discovery, validation, context, Brain, evidence, and learning state. The human should experience Roster through the host's native conversation, approval, scheduling, and task interfaces.

## Primary job to be done

When the human gives a specialized task to Claude Code or Codex, the host can discover a purpose-built agent and structured plan, receive the smallest relevant company context and tool-use guidance, execute with its own reasoning and tools, record portable evidence, and improve later work through human-approved lessons.

## Product principles

- Claude Code or Codex is the workflow runtime.
- Roster owns scaffolding, static contracts, bounded context, Brain, evidence, and learning state.
- Structured plans are host-interpreted operating guides, not a Roster-executed DSL.
- Workspace hierarchy organizes authorship; runtime retrieval is one flat, bounded bundle.
- Vendor skills own tool setup and mechanics; workspace tool-use definitions own company-specific application.
- Brain is a company knowledge system, not merely an internal Roster database.
- Durable evidence precedes optimization or removal decisions.
- Fresh workspaces and host prompts are sparse.
- Learning candidates may be automatic; active policy requires human approval.

<!-- forge:adr-section:authority-model -->
## Authority model

| Information | Canonical authority |
|---|---|
| Functions, agents, plans, subagents, guidelines, tool-use definitions | Working-directory files in Git |
| Approved active lessons | Working-directory playbook or lesson files in Git |
| Company facts, entities, relationships, examples, ideas, documents, events | Roster Brain/PostgreSQL with source provenance |
| Raw media and large immutable artifacts | Roster Brain/S3-compatible object storage |
| Completed runs, feedback, Dreamer evidence and candidates, decision history | Brain operational/learning schemas |
| Human conversation, pending UI, schedule, wake/resume state | Claude Code or Codex host |
| External source-of-record data | Original system until explicitly ingested into Brain |
| External tool installation, authentication, provider syntax, and execution | Referenced skill plus Claude Code or Codex host |
| Markdown run logs | Optional local projection, never the portable authority |

Brain is one first-party product subsystem backed by both PostgreSQL and S3-compatible storage whenever activated. External tools remain host/skill-owned regardless of API, CLI, MCP, connector, browser, or other invocation surface.
<!-- /forge:adr-section:authority-model -->
## Per-feature breakdown

<!-- forge:adr-section:feature-1-sparse-workspace-scaffolding-and-discovery -->
## Feature 1: Sparse workspace scaffolding and discovery

### User outcome

Through the host, the user can initialize a folder and create only the functions, role-based agents, plans, subagents, guidelines, tool-use definitions, and lessons that are actually needed.

### Required behavior

- `roster init` creates a minimal workspace contract and no empty capability forest.
- `roster scaffold <kind>` creates a requested record at a deterministic, workspace-confined path.
- Qualified identities prevent same-named agents or plans in different functions from colliding.
- `roster discover` resolves definitions by kind, scope, identity, text query, and reference.
- `roster validate` performs schema, ownership, reference, path, skill-reference, and drift checks.
- User-owned authoring files and generated host adapter files have explicit ownership markers.
- A Chief of Staff or expert can create and revise structures through the host in a human-managed session.
- Initialization, scaffolding, discovery, validation, and external-tool guidance work without PostgreSQL or object storage.

### Acceptance

- A fresh repository contains only `roster.yaml`, a short host-neutral `ROSTER.md`, and generated host activation files when installed.
- Functions, agents, plans, guidelines, tool-use definitions, and lesson directories appear on first use.
- Two same-named agents in different functions resolve unambiguously by qualified identity.
- Unknown fields, broken references, duplicate identities, path escapes, unsafe symlinks, stale generated files, and literal machine-specific absolute paths produce actionable diagnostics. Validation remains callable for a partially configured Brain, reports local structural results, and exits nonzero with `BRAIN_CONFIGURATION_INCOMPLETE`; doctor reports local subsystems independently, marks Brain invalid, and exits nonzero.
- A workspace with no Brain configuration remains healthy for local-only behavior; a declared Brain requires complete PostgreSQL and S3-compatible configuration before Brain use.
- Discovery returns compact metadata by default and full content only when requested or included in a context bundle.

### Flow and edge cases

The human asks the host to initialize or create one structure; the host calls the exact scaffold verb, validates the result, and later discovers it by qualified identity. Name collisions require qualification, edited generated files block overwrite, and absent Brain configuration does not block local scaffolding. If the user activates Brain, the host supplies both compatible storage services and ambient credentials before retrying Brain initialization.
<!-- /forge:adr-section:feature-1-sparse-workspace-scaffolding-and-discovery -->
## Feature 2: Structured plan authoring and validation

### User outcome

An expert can turn a role's operating process into a versioned, reviewable, step-by-step guide that Claude Code or Codex can interpret more consistently than a single long prompt.

### Required behavior

- A plan identifies its function and agent, purpose, inputs, ordered steps, expected artifacts or outputs, completion criteria, and optional decision or approval guidance.
- Steps may reference subagents, nested plans, cross-agent collaboration, Brain context selectors, guidelines, and workspace tool-use definitions.
- The schema permits useful structure such as caps, retry guidance, conditions, and expected output shape as instructions to the host.
- Static validation resolves all references and rejects cycles, missing targets, impossible ordering, unknown step kinds, and unbounded or unsafe authoring constructs.
- The entire selected plan is available to the host so it can reason across steps.

### Explicit boundary

Roster does not compile a plan into an executable manifest, select a current step, resolve prior outputs, reduce transitions, enforce runtime types, run retries, or emit a next step. The host performs all of those runtime behaviors using the plan as guidance.

### Acceptance

- Both Claude Code and Codex can read the same validated plan and complete the seeded workflow.
- Validation catches missing agent, subagent, nested-plan, guideline, Brain selector, and tool-use references before work begins.
- Conditions, retry guidance, and approval guidance remain human-readable and host-interpreted; no arbitrary code, shell expression, or hidden runtime grammar is introduced.
- Editing an authored plan affects later context resolution without creating or migrating active Roster run cursors.

### Flow and edge cases

The host discovers a plan, validation resolves every static reference/cycle, and the complete plan enters context for host interpretation. Missing or ambiguous references fail before work; edited plans need no active-run migration because Roster owns no cursor.

<!-- forge:adr-section:feature-3-bounded-context-assembly -->
## Feature 3: Bounded context assembly

### User outcome

The host asks Roster for the context needed for one user request and receives one deterministic, cited bundle instead of recursively loading the whole repository and Brain.

### Required inputs

- Workspace with target function and agent.
- Optional completely configured workspace Brain; no Brain configuration is valid local-only operation.
- Optional explicitly selected root plan; Roster never infers one.
- Human request or task query.
- Optional host-supplied step hint.
- Token budget.

### Required output

- Workspace and target identity.
- The selected function/agent definitions.
- When a plan is selected, its root definition plus the complete deduplicated transitive nested-plan definition closure from one validated snapshot.
- Mandatory agent default guidelines and every guideline explicitly referenced by a closure plan.
- For each actual closure `kind: tool` step, the mandatory effective workspace tool-use definition paired with its canonical external skill reference; membership catalogs select nothing.
- Optional applicable approved lessons ranked ahead of optional untrusted Brain evidence.
- Immutable workspace/source/version/object/extractor Brain citations when evidence is included.
- Trust classification, provenance, inclusion reason, workspace and narrower scope labels, version/hash, and deterministic budget accounting for every included fragment.
- Authoritative bounded exclusion/scalar counts and sanitized diagnostics; per-candidate diagnostic examples are optional.

### Explicit boundary

The bundle never contains a Roster-selected current step, transition, next action, provider route, runtime output binding, approval receipt, external-provider response parser, or Roster execution state. An optional step is only a host assertion used for relevance. Claude Code or Codex interprets and executes the returned definitions and referenced skills.

### Acceptance

- Required function/agent/policy, complete selected-plan closure, and step-referenced effective tool/skill pairs are reserved before optional lessons or Brain evidence.
- Required content is never truncated: a reachable budget shortfall reports an exact accepted retry, while a mandatory minimum above the host ceiling reports a distinct unservable error.
- Missing Brain configuration exits successfully with the complete local bundle, empty Brain evidence, and one `BRAIN_NOT_CONFIGURED` warning diagnostic.
- Partial Brain configuration makes `roster context` return no bundle, a fatal `BRAIN_CONFIGURATION_INCOMPLETE` diagnostic, and a nonzero exit before opening PostgreSQL or S3-compatible storage; local scaffolding, discovery, and validation remain available.
- A configured database/object-namespace identity mismatch stops after the protected-metadata handshake and before company-content reads, object-store access, or mutation.
- Optional retrieval failure, rejected candidates, or candidate diagnostic examples cannot corrupt or overflow a servable mandatory local bundle.
- Equivalent inputs and equivalent source versions yield the same semantic bundle and inclusion explanation for Claude Code and Codex.
- Authored policy, approved lessons, external-skill instructions, Brain evidence, and tool output are visibly separated by trust.
- Sanitized representative bundles reduce eager-load tokens by at least 60 percent while passing required-context recall and irrelevant-context exclusion thresholds.

### Flow and edge cases

The host submits a target, task, optional selected plan and step hint, and budget. Roster resolves one validated local snapshot, returns the complete selected definition closure and mandatory policy/tool guidance, then ranks optional approved lessons and same-workspace Brain evidence using scope labels as retrieval selectors. Without Brain configuration it degrades to the complete local bundle. A partial Brain or wrong database/object namespace fails closed. Reachable mandatory overflow returns the exact retry; an oversized closure is reported as unservable; remote optional failure and hostile evidence never become policy or suppress local context.
<!-- /forge:adr-section:feature-3-bounded-context-assembly -->
<!-- forge:adr-section:feature-4-company-brain-knowledge-and-source-lifecycle -->
## Feature 4: Company Brain knowledge and source lifecycle

### User outcome

The user and their hosts can save, retrieve, relate, update, promote, and cite company knowledge from every machine or clone authorized for one logical Roster workspace.

### Knowledge scope

Roster Brain ships as a first-party product subsystem. Each logical workspace owns a different PostgreSQL Brain database and configured S3-compatible namespace. Both services are required to activate Brain. That Brain may contain workspace-wide company knowledge plus narrower function, agent, and plan retrieval labels. It may represent people, organizations, customers, prospects, products, projects, tasks, decisions, content, ideas, examples, documents, media, events, facts, claims, metrics, relationships, and provenance.

### Required behavior

- Tracked `roster.yaml` carries the stable `workspace_id`, a generic secret path/reference, and non-secret object namespace organization; secrets remain ambient.
- Brain initialization validates compatible PostgreSQL and S3-compatible storage together. Missing either side is a fatal incomplete Brain, while a workspace declaring neither remains valid for local-only behavior.
- The host creates and injects the workspace-specific runtime URL through its chosen credential mechanism. Roster derives the expected role, validates and proves the ambient credential during initialization, and never mints, stores, returns, or prints the URL or password.
- The Brain database stores protected matching workspace/storage identity. Every Brain command first performs the minimum identity handshake and rejects a mismatch before company-content reads, object-store access, or mutation.
- A different workspace ID uses a different database. Clones of the same workspace may share its database and object namespace.
- Workspace/function/agent/plan scopes are typed context-selection labels, not database authorization principals.
- File and fetched-media logical source identities derive automatically from workspace-relative path and canonical origin/upstream metadata respectively. Inline text, structured records, and produced artifacts require a host-supplied stable key. Every accepted ingest creates an immutable version independent of checkout paths.
- Raw bytes and large artifacts are content-addressed inside the workspace object namespace; PostgreSQL records intent, metadata, current state, provenance, privacy/trust/assurance, and recovery state.
- Admin and least-privilege runtime roles are separate; runtime cannot mutate schema, protected workspace identity/provenance, or bypass the closed write surface.
- Extraction creates versioned text/chunks and structured candidates.
- Lexical and structured retrieval work without an embedding credential.
- Optional embeddings and graph expansion are measured enhancements with recorded provider/model/version metadata.
- Superseded, tombstoned, and default-excluded `legacy-unverified` content cannot silently become authority.
- Preserved `legacy-unverified` history is absent from default retrieval, visible only through an explicit future host request, and never treated as authority, policy, or instructions.
- Phase-2 lifecycle and migration-foundation work preserves object bytes; physical deletion requires a separately reviewed cutover policy.
- Explicit promotion can turn selected evidence into a stronger fact, example, relationship, or lesson candidate while preserving source lineage.

### Acceptance

- Retrying identical ingestion converges without duplicate current versions; changed content preserves history and becomes current.
- Checkout relocation does not change logical workspace or source identity.
- Partial Brain, wrong-database, object-namespace, runtime-role, or credential configuration stops before company-content reads, object-store access, or mutation and reports an actionable redacted error.
- No Roster JSON, human output, generated file, diagnostic, or context contains any credential, including a runtime URL or password.
- PostgreSQL/object-store partial failures resume or reconcile without orphaning authoritative state.
- Every retrieval result resolves to the exact source version, object identity, extractor version, locator, typed retrieval scope, trust/privacy class, and retrieval reason.
- Structured and document retrieval can be combined in one bounded context response without mandatory embeddings.
- Existing workspace data upgrades in place without a Brain-space wrapper, cross-workspace RLS, or permanent compatibility shim.
- External systems are not bulk mirrored by default; every ingestion records origin and selection provenance.

### Flow and edge cases

The host starts from tracked workspace Brain configuration and ambient admin credentials. Roster requires and verifies both services and the database/storage identity, then proves the least-privilege runtime credential. The host explicitly selects a source; Roster converges object and source-version state, extraction/indexing becomes ready, and later retrieval returns immutable citations. Identical retries deduplicate, changed bytes version, cross-store failure repairs, embedding-free mode stays correct, tombstones hide content without erasing history, and configuration mismatch fails closed. Runtime credential rotation is explicit and never occurs as an init side effect.
<!-- /forge:adr-section:feature-4-company-brain-knowledge-and-source-lifecycle -->
<!-- forge:adr-section:feature-5-workspace-tool-use-definitions -->
## Feature 5: Workspace tool-use definitions

### User outcome

For a particular function, agent, or plan, the host knows not only which external skill to load but how and why the company wants that capability used. The same product contract works for APIs, CLIs, MCPs, connectors, browsers, and future host-supported surfaces.

### Three-layer contract

1. **External or workspace skill:** owns installation, authentication, provider syntax, capabilities, version compatibility, parsing, and provider-specific best practices.
2. **Workspace tool-use definition:** owns purpose, scope, when to use the skill, relevant capability subset, request/filter strategy, company rules, expected result, approval guidance, Brain reads/writes, and evidence requirements.
3. **Plan reference:** points to a tool-use definition for one step and adds only task-local instruction.

### Required behavior

- Humans create or revise tool-use definitions through Claude Code or Codex.
- Definitions may apply at workspace, function, agent, or plan scope and use deterministic precedence.
- `skill_ref` is the canonical author-time provider/surface binding that host adapters map to a reviewed installed or workspace-local skill.
- Roster statically validates references, effect/risk declarations, expected fields, provenance, drift, and secret-free content.
- The context bundle includes the definition and skill reference; the host loads and invokes the skill.
- The host derives request-specific inputs and filters using its reasoning within authored company rules.
- Switching provider or invocation surface is an authored `skill_ref` change or sibling tool-use definition, not runtime Roster routing.

### Example

```yaml
schema_version: 2
id: market-research
scope:
  function: growth
  agent: researcher
  plan: opportunity-discovery
skill_ref: research-provider:search
purpose: Find timely material that matches company priorities.
when:
  - discovering opportunities
how:
  - exclude canonical URLs already presented according to Brain history when Brain is active
  - rank company relevance before engagement volume
output_expectations:
  required: [canonical_url, author, published_at, relevance_reason]
  guidance: [include citations for every candidate]
brain:
  read: [audience-and-positioning, previously-presented-opportunities]
  write: [discovered-opportunity, retrieval-provenance]
effects:
  allowed: [external-read, brain-read, brain-write]
approval:
  requirement: human
  guidance: [wait for the human before any external write]
evidence:
  required: [canonical_url, retrieved_at]
```

### Explicit boundary

Roster does not provide external-provider routing, health checks, fallback execution, credentials, child-process execution, MCP calling, browser control, API transport, provider response parsing, or provider-specific result certification. Brain commands are the built-in first-party storage exception and require complete PostgreSQL plus S3-compatible configuration.

### Acceptance

- Multiple hermetic fixtures use different provider/surface `skill_ref` values and company use cases through both generated host projections via bounded test-only reference drivers, including at least one non-search or non-MCP shape; optional live smokes separately exercise actual logged-in hosts.
- The referenced skill remains the single source for provider setup, authentication, syntax, parsing, and compatibility.
- The same external skill can have different company uses in different agents or plans without duplicating the skill.
- Missing skills, broken definitions, unsafe effect claims, raw secrets, ambiguous precedence, and unreviewed or drifted workspace skills fail validation or doctor checks.
- One explicitly selected live skill per host may be smoke-tested through a currently logged-in host, but no named commercial provider, direct model API key, personal configuration, or live provider is required by CI.

### Flow and edge cases

The host resolves the applicable ancestry into one flat definition: only `purpose` is replaced by the most-specific value, company guidance accumulates, effects may only narrow, approval may only become stricter, and Brain selectors remain requested intent rather than authorization. It then loads `skill_ref`, derives task-specific inputs within company rules, invokes the skill, and records provenance. Missing installs, ambiguous scope, unsafe effect changes, unreviewed or drifted project-skill provenance, and secret material block validation or doctor. Reviewed mutable refs remain visible as `revision_immutable: false`; they are never mislabeled as immutable.
<!-- /forge:adr-section:feature-5-workspace-tool-use-definitions -->
## Feature 6: Portable run, feedback, artifact, and decision evidence

### User outcome

Work performed on one machine can inform retrieval and learning on another without turning Roster into an operations platform.

### Required behavior

- The host records one completed-run summary with agent/plan identity, request summary, start/end time, outcome, source/tool summary, artifacts, and content/version digests.
- Optional progress events may be appended for diagnostics, but Roster does not need them to drive execution.
- Feedback can reference a run or artifact and identify correction, preference, success, or failure.
- Human decisions may be recorded with a normalized action digest, decision, actor, timestamp, and provenance for portability and audit.
- Evidence writes are idempotent and append-oriented.
- Operational evidence uses a separate schema and S3 prefix from semantic knowledge and is excluded from ordinary embedding and retrieval by default.
- A controlled promotion operation may turn selected evidence into semantic company knowledge or a Dreamer candidate while preserving lineage.

### Explicit boundary

A stored human decision is evidence, not an authorization token. The host owns prompting, waiting, native safety gates, and whether an external action may execute. Roster does not poll, lease, wake, resume, or enforce the action.

### Acceptance

- Equivalent replay does not duplicate a run, artifact, feedback item, or decision record; conflicting replay returns a stable conflict.
- Another bound machine can retrieve the completed run and feedback.
- Normal Brain search does not surface raw operational logs unless explicitly requested or promoted.
- The minimal evidence model remains usable after the general operations, queue, lease, outbox, and approval-state-machine code is removed.

### Flow and edge cases

After work, the host records one completed summary plus artifacts and optional feedback/decision evidence. Equivalent replay returns the existing record, conflicting replay fails, partial artifact writes recover, and operational evidence cannot enter semantic search without an explicit lineage-preserving promotion.

## Feature 7: Evidence-driven Dreamer

### User outcome

Roster becomes self-improving in a controlled way: repeated outcomes and feedback produce cited lesson proposals, and approved lessons shape later work.

### Required behavior

- Roster computes durable `due` or `not_due` readiness from new eligible evidence, scope policy, thresholds, and a watermark.
- Readiness is checked by host activation instructions after evidence recording and on the next Roster-backed interaction.
- When due, the host invokes the Roster Dreamer skill.
- The skill queries eligible Brain evidence, detects recurring patterns, cites supporting and conflicting examples, and stores idempotent lesson candidates in Brain.
- The host presents candidates to the human and waits for promote, reject, revise, or retire decisions.
- Promotion materializes an approved lesson into the appropriate working-directory playbook scope and records the decision in Brain.
- A later context bundle selects the approved lesson according to scope and precedence.

### Explicit boundary

Dreamer is not a Roster scheduler, daemon, hidden background model, or automatic policy writer. Roster reports readiness and stores state; the host invokes the skill and manages the human interaction.

### Acceptance

- Below-threshold observations remain durable and later contribute to readiness.
- Rechecking the same watermark does not create duplicate candidates.
- Candidates cite both support and conflicts and never treat untrusted evidence as instruction.
- Promotion is human-confirmed by default and results in a reviewable Git file.
- A promoted lesson changes the next applicable context bundle in both host fixtures.
- The known `log/` versus `logs/` activation mismatch and manual/schedule-only trigger paths are eliminated.

### Flow and edge cases

Evidence advances a durable watermark, status becomes due, the host invokes Dreamer, and a human decision controls materialization. Below-threshold evidence accumulates, repeated checks/candidates deduplicate, conflicting lessons are surfaced, a missed post-run check recovers next session, and Dreamer cannot cite itself as independent evidence.

<!-- forge:adr-section:feature-8-thin-host-activation-migration-drift-control-and-doctor -->
## Feature 8: Thin host activation, migration, drift control, and doctor

### User outcome

Claude Code and Codex reliably activate the same Roster workflow without duplicated business logic, and existing workspaces can move to v2 safely.

### Required behavior

- Generated adapters teach each host to discover targets, retrieve context, interpret the selected plan, load referenced skills, execute work, record evidence, check Dreamer readiness, and present human decisions.
- Adapters contain host integration only; they do not contain business-agent logic, provider logic, or a plan interpreter.
- Generated files are versioned, reproducible, identifiable, and never canonical authoring sources.
- `roster update` detects generated-file drift, duplicate shadows, stale versions, unsupported host capability, and unsafe overwrite.
- `roster doctor` tests scaffold/discovery, plan references, context budgets, Brain activation state, protected database workspace identity, least-privilege roles, S3-compatible namespace trust, source/object/retrieval integrity, tool-use/skill references, evidence writes, Dreamer readiness/activation, host adapter versions, and migration state. It does not test external-provider health.
- Doctor treats no Brain configuration as healthy local-only operation, partial PostgreSQL/S3-compatible configuration as invalid, and complete configuration as eligible for native Brain checks.
- A dry-run migrator reports every create/move/rewrite/archive/delete action and supports one explicit apply.
- Local-only migration runs offline. Brain migration upgrades each workspace-owned PostgreSQL database/object namespace in place only when both services are configured, preserves authored structures and useful Brain/evidence data, and removes schedule/general-operations surfaces without shared-database tenancy or permanent compatibility code.
- Secret references remain vendor-neutral and migration never reads or persists secret values.
- Before the one-way #363 cutover, legacy Brain spellings remain parser-recognized only for protected-identity diagnostics or stable fail-closed disabled errors; no legacy operation executes, and `brain query` reports not ready until cited retrieval ships.

### Acceptance

- Both adapters complete the same golden flow from a human-style request without a simulated human Roster command.
- Doctor detects a missing Dreamer activation path even when all Dreamer files exist.
- Migration rehearsals pass on sanitized frozen representative workspaces, including local-only, complete Brain, partial configuration, wrong identity, and legacy-path cases.
- External-tool fixtures prove multiple skill/provider/surface bindings without a provider-specific Roster runtime or live-provider CI dependency.
- No permanent compatibility path preserves the old scheduler, reducer proposal, general ops state machine, or provider router.
- Issue #363 removes the temporarily recognized legacy Brain spellings; phase 2 never turns recognition into a compatibility implementation.

### Flow and edge cases

Install generates adapters from one contract; `roster update` synchronizes generated adapters and manifests, while doctor verifies versions and activation. Migration dry-runs, fingerprints, backs up, applies, and rechecks. Partial installs, edited generated files, duplicate shadows, unsupported host capabilities, source drift after dry-run, partial Brain configuration, and legacy secrets/unverified claims produce explicit stops or classifications.
<!-- /forge:adr-section:feature-8-thin-host-activation-migration-drift-control-and-doctor -->
<!-- forge:adr-section:acceptance-criteria-overall-v2 -->
## Acceptance criteria (overall v2)

- The product exposes the documented minimal CLI and no canonical schedule, runtime-transition, generic ops/HITL, or external-provider execution/routing/parsing commands.
- Both hosts complete the seeded golden loop and sanitized representative host-interpreted workflows.
- Local initialization, scaffolding, validation, bounded context, and external-tool guidance work without infrastructure.
- Activating Brain requires both compatible PostgreSQL and S3-compatible storage; a real example can then be ingested, versioned, retrieved with immutable citations, and included within a bounded context budget without mandatory embeddings.
- Multiple external-skill provider/surface bindings are selected through workspace tool-use definitions and executed by the host with provenance; no named live provider is required by CI.
- Portable completed-run and feedback evidence makes Dreamer due without a Roster schedule.
- A human-approved Dreamer lesson changes later context selection.
- Retrieval quality, context quality, security, migration, drift, and release thresholds pass on sanitized reproducible fixtures.
- `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm test:scaffold-scripts`, and `pnpm smoke` pass at every phase gate.
<!-- /forge:adr-section:acceptance-criteria-overall-v2 -->
<!-- forge:adr-section:explicit-non-goals -->
## Explicit non-goals

- A Roster-owned plan compiler, reducer, current-step cursor, transition engine, retry engine, or output-binding runtime.
- Roster-owned scheduling, cron, daemons, wake/resume, polling, or session management.
- A generic task queue, lease system, outbox, inbox, operations platform, or channel-specific control plane.
- Roster-owned approval authority. The host waits for and enforces human decisions; Roster may store action-bound decision evidence for portability.
- A generic external-provider connection, routing, fallback, secret-injection, health, execution, or response-parsing layer.
- A hosted Roster agent, chat UI, or requirement that humans call Roster CLI themselves.
- Automatic ingestion of everything from task systems, social networks, repositories, or other company systems.
- Executing plans, subagents, or external tools inside Roster.
- Selecting or persisting the current plan step.
- General loop/goto/worker/queue semantics.
- Hosting secrets for external tools or requiring one secret manager, provider, transport, or invocation surface.
- Scheduling Dreamer or business work.
- Owning the host conversation, task UI, approval UI, wake/resume, or reminders.
- Automatically mirroring every external business system into Brain.
- A partially activated Brain: Brain deliberately requires both PostgreSQL and S3-compatible storage.
- Making embeddings, graph traversal, edge extraction, or hosted reranking mandatory without measured evidence.
<!-- /forge:adr-section:explicit-non-goals -->
<!-- forge:adr-section:cross-feature-flows -->
## Cross-feature flows

### Create and run a purpose-built agent

1. The human asks Claude Code or Codex to create a role-based agent and structured plan.
2. The host uses Roster scaffolding to create the function/agent/plan and a company-specific tool-use definition.
3. Static validation resolves references and doctor verifies activation without contacting the external provider.
4. Later, the human asks for work.
5. The host discovers the agent, selects the plan, and requests bounded context.
6. Roster returns the plan, local policy, optional company context and lessons, the tool-use definition, and external skill reference.
7. The host interprets the plan, derives request-specific inputs, invokes the referenced skill through its available surface, and renders the result.
8. The host records evidence and checks Dreamer readiness.

### Ingest and retrieve an example

1. The user first activates Brain with both compatible PostgreSQL and S3-compatible storage.
2. The human gives the host an example document or the host selects an artifact during a run.
3. The host explicitly calls Brain ingestion with source provenance and scope.
4. Roster stores or reuses immutable bytes in the object namespace and converges source/version state in PostgreSQL.
5. Extraction and lexical/structured indexes become ready; embeddings are optional.
6. A later bounded query returns the relevant extract and immutable citation.

### Learn from feedback

1. The human edits or evaluates an output in the host.
2. The host records feedback against the completed run or artifact in the complete Brain.
3. Roster reports Dreamer due when policy thresholds and a new-evidence watermark are met.
4. The host invokes Dreamer, which stores a cited candidate.
5. The human approves, revises, rejects, or retires it through the host.
6. An approved lesson is written to the relevant playbook and selected in a later context bundle.

### Wait for a human decision

1. A plan tells the host that an action needs human confirmation.
2. The host uses its native conversation/task interface to present the normalized action and wait.
3. After the human decides, the host may record action-digest-bound decision evidence in Brain.
4. The host alone decides whether to execute or stop. Roster never authorizes, polls, or resumes the action.
<!-- /forge:adr-section:cross-feature-flows -->
