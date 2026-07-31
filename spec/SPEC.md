# Roster v2 — Technical SPEC

## Architecture summary

Roster is a local, agent-facing CLI plus a remote company Brain. It wraps a working directory with versioned authoring structures and gives Claude Code or Codex bounded access to those structures, company knowledge, use-case-specific tool guidance, evidence, and learning state.

```text
Human
  ↓ native conversation / task / approval / schedule
Claude Code or Codex                         ← workflow runtime
  ↓ discover / validate / context / brain / record / dream status
Roster CLI                                  ← thin framework and context layer
  ├── Working Directory                     ← Git-canonical operating policy
  ├── Company Brain / Postgres               ← knowledge, indexes, evidence, learning
  └── Company Brain / S3                     ← raw media and large artifacts

External vendor skills / CLIs / MCPs / APIs ← invoked by the host, not Roster
```

The core dynamic is:

```text
scaffold → resolve → host executes → record → learn
```

### Ownership boundary

Roster owns:

- sparse scaffolding and deterministic file ownership;
- schemas, static validation, reference resolution, indexing, discovery, and drift diagnostics;
- bounded context selection and citations;
- Brain storage, ingestion, extraction, indexing, retrieval, and graph-shaped company knowledge;
- tool-use definition schemas and external skill references;
- completed-run, artifact, feedback, and human-decision evidence;
- Dreamer readiness, candidates, decisions, and approved lesson materialization; and
- generated Claude Code and Codex activation instructions.

Claude Code or Codex owns:

- interpreting the whole selected plan;
- choosing and carrying runtime step state;
- reasoning, prompting, subagent delegation, nested work, retries, and conditions;
- loading and invoking external vendor skills, CLIs, MCPs, APIs, connectors, and browsers;
- provider failures and fallbacks;
- presenting and enforcing human decisions;
- native schedules, reminders, wake/resume, and session state; and
- rendering results to the human.

Roster must not implement a plan compiler/reducer, active-run cursor, current-step selector, provider router, general task/operations engine, scheduler, or approval authority.

## Stack

- TypeScript, ESM, strict mode.
- Node `^22.18.0 || >=24.0.0`.
- `tsdown` bundled executable.
- Hand-rolled argv parsing and JSON-first output.
- YAML for authored structured definitions with bounded parsing.
- Neon/Postgres for Brain state.
- S3-compatible storage for immutable bytes and large artifacts.
- Optional OpenAI embeddings behind privacy and configuration policy.
- Infisical-managed environment injection; no generated `.env` files.

## Canonical identifiers

Identifiers are stable strings and never use absolute checkout paths as global identity.

| Identifier | Purpose |
|---|---|
| `workspace_id` | One Roster-managed working directory identity |
| `brain_space_id` | One company Brain identity shared by authorized workspaces |
| `binding_id` | Authorized workspace-to-Brain binding with allowed scopes |
| `function_id` | Role/function namespace within a workspace |
| `agent_id` | Agent identity qualified by function |
| `plan_id` | Plan identity qualified by function and agent |
| `subagent_id` | Subagent identity qualified by its owner |
| `guideline_id` | Authored policy identity and scope |
| `lesson_id` | Approved materialized lesson identity and scope |
| `tool_use_id` | Workspace company-use definition for an external skill |
| `skill_ref` | Canonical external vendor skill package/name identity |
| `logical_source_id` | Stable source identity across versions and workspace relocation |
| `source_version_id` | Immutable content version with provenance |
| `object_id` | Content-addressed S3 object identity |
| `run_id` | Host-assigned or Roster-generated completed-work evidence identity |
| `candidate_id` | Dreamer lesson candidate identity |

Qualified authoring identities use slash-separated components internally, for example `gtm/social-manager#opportunity-discovery`. Individual component values are lowercase kebab-case and cannot contain path separators, traversal segments, control characters, or platform-reserved names.

## Working-directory model

### Minimal initialization

A fresh workspace contains:

```text
roster.yaml
ROSTER.md
```

`roster install --tool claude|codex` generates the selected host activation files in host-native locations. `.roster/` may be created lazily for generated indexes, locks, caches, migration backups, and optional projections. No function, agent, plan, guideline, tool, Dreamer, schedule, pending, run-log, or placeholder directory is created until requested.

### Authored hierarchy

The canonical logical layout is:

```text
functions/<function-id>/
  function.yaml
  guidelines/<guideline-id>.md
  agents/<agent-id>/
    agent.yaml
    guidelines/<guideline-id>.md
    plans/<plan-id>.yaml
    subagents/<subagent-id>.yaml
    tools/<tool-use-id>.yaml
    playbook/<lesson-id>.md
```

Equivalent future physical layouts require a versioned migration. The registry, not incidental directory scanning, owns qualified identity and paths.

### File ownership

Every managed path is one of:

- `authored`: user/host-owned canonical source; Roster never overwrites it silently;
- `generated`: reproducible Roster-owned output with content/version markers;
- `state`: local generated cache or migration state; or
- `projection`: optional local rendering of Brain-canonical data.

Scaffold manifests store generated hashes and schema versions. `roster update` may replace an unedited generated file, refuse an edited generated file, and report authored/generated shadows. Atomic writes, workspace confinement, component-wise symlink checks, regular-file checks, byte limits, and collision checks apply to every path.

## Workspace schemas

All authored YAML is parsed with byte, alias, node, scalar, and nesting limits. Unknown fields fail by default. Schema version is required.

### Workspace registry

```yaml
schema_version: 2
workspace_id: my-roster
brain:
  binding: personal-company
functions:
  gtm:
    path: functions/gtm
hosts:
  claude: enabled
  codex: enabled
```

`brain` is optional at initialization. Its absence never causes local scaffold or validation commands to fail, but any Brain-dependent command returns `BRAIN_NOT_BOUND` with setup guidance.

### Agent definition

```yaml
schema_version: 2
id: social-manager
function: gtm
purpose: Manage evidence-based social discovery and response workflows.
plans:
  - opportunity-discovery
default_guidelines:
  - brand-voice
```

Agent definitions contain role, responsibility, plan membership, default context selectors, and allowed collaboration references. They do not contain provider credentials, runtime state, or shell commands.

### Structured plan

```yaml
schema_version: 2
id: opportunity-discovery
agent: gtm/social-manager
purpose: Produce a reviewed list of relevant reply opportunities.
inputs:
  channels:
    description: Requested social channels.
  lookback:
    description: Time window requested by the human.
steps:
  - id: prepare
    kind: reasoning
    instruction: Derive request-specific filters from the task, ICP, and examples.
    context:
      brain: [icp, messaging, successful-replies]
  - id: discover
    kind: tool
    tool_use: social-opportunity-research
    instruction: Find current opportunities using the prepared filters.
  - id: review
    kind: reasoning
    instruction: Remove duplicates and explain relevance with citations.
  - id: present
    kind: approval
    instruction: Present the shortlist and wait for the human's selection.
completion:
  artifacts: [opportunity-shortlist]
  criteria:
    - Every item has a canonical URL and relevance reason.
```

Supported `kind` values describe host behavior, initially `reasoning`, `subagent`, `cross-agent`, `nested-plan`, `tool`, `approval`, and `artifact`. They are not Roster executor opcodes.

Static validation checks:

- unique ordered step IDs;
- existing agent, plan, subagent, guideline, Brain selector, and tool-use references;
- direct and transitive nested-plan cycles;
- impossible forward references in explanatory bindings;
- bounded caps and retry guidance;
- declared expected artifacts and completion criteria;
- no arbitrary code, templates that execute code, shell command strings, goto, worker queue, or hidden expression language.

Input/output shapes are documentation and lint targets for the host, not transition gates. Roster returns the whole selected plan in context.

### Workspace tool-use definition

```yaml
schema_version: 2
id: social-opportunity-research
scope:
  function: gtm
  agent: social-manager
  plans: [opportunity-discovery]
skill_ref: exa:search
why: Find timely, credible posts that match our audience and positioning.
when:
  - discovering reply opportunities
capabilities:
  - web and social search
how:
  - search first-party and high-credibility sources for the requested lookback
  - exclude previously presented URLs using Brain history
  - rank by ICP relevance before engagement volume
output_expectations:
  required: [canonical_url, author, published_at, relevance_reason]
brain:
  read: [icp, messaging, previously-presented-opportunities]
  write: [discovered-opportunity, retrieval-provenance]
effects: read-only
approval: none
```

The definition may reference the relevant subset of a vendor skill but must not duplicate provider setup, credentials, syntax, or generic best practices. Raw secret material is forbidden. Effects and approval are policy guidance presented to the host, not Roster enforcement.

Tool-use precedence is most-specific-wins among compatible definitions:

```text
plan > agent > function > workspace
```

Narrower definitions may add restrictions or specificity but cannot relax a broader safety rule without an explicit authored override that validation reports.

## Discovery and validation

`roster discover [query] --json` returns compact records with qualified ID, kind, path, purpose, scope, schema version, content hash, and reference summary. Optional filters narrow by function, agent, plan, or kind.

`roster validate [target] --json` performs:

- bounded schema parsing;
- qualified identity and path ownership checks;
- static cross-reference and cycle checks;
- tool-use and vendor skill-reference checks;
- Brain binding/scope checks when relevant;
- generated adapter and manifest drift checks; and
- secret-pattern and unsafe-content checks.

Validation is read-only unless the user requests an explicit scaffold, update, or migration action.

## Context request and response

### Request

```json
{
  "target": "gtm/social-manager#opportunity-discovery",
  "query": "Find reply opportunities from the last 24 hours",
  "step_hint": "discover",
  "budget_tokens": 8000,
  "explain": true
}
```

`step_hint` is optional and host supplied. Roster never infers or persists a current step.

### Response sections

```json
{
  "schema_version": 2,
  "workspace": {},
  "target": {},
  "request": {},
  "agent": {},
  "plan": {},
  "guidelines": [],
  "lessons": [],
  "brain_evidence": [],
  "tool_uses": [],
  "skill_refs": [],
  "provenance": [],
  "budget": {},
  "diagnostics": []
}
```

Each fragment includes stable identity, scope, version or hash, trust class, inclusion reason, required/optional status, and byte/token accounting. Brain extracts also contain an immutable citation envelope.

The response cannot contain Roster run state, a Roster-selected current step, prior-output bindings, a provider route, an approval receipt, `next_actions`, or a transition.

### Selection algorithm

1. Resolve workspace, target agent, and selected plan.
2. Reserve mandatory workspace/function/agent/plan policy and complete plan content.
3. Resolve applicable lessons and tool-use definitions by scope and precedence.
4. Derive authorized Brain selectors from the target, query, plan, guidelines, and tool-use definitions.
5. Retrieve structured knowledge and document candidates.
6. Reject stale, tombstoned, unauthorized, privacy-incompatible, duplicate, and low-trust candidates.
7. Rank optional fragments deterministically under the remaining budget.
8. Emit citations, selection/exclusion reasons, trust separation, and diagnostics.

If mandatory material exceeds the budget, return `CONTEXT_BUDGET_REQUIRED_OVERFLOW`. Optional retrieval failure is explicit but does not corrupt mandatory material. Token counts use a deterministic configured estimator and always include raw byte counts.

## CLI surface

Canonical commands:

```text
roster init
roster install [--tool claude|codex]
roster update
roster doctor [--json]
roster migrate --dry-run|--apply

roster scaffold function|agent|plan|subagent|guideline|tool-use|lesson
roster discover [query] [--kind ...] [--scope ...] --json
roster validate [target] --json

roster context <function>/<agent>[#plan]
  --query <task>
  [--step <host-supplied-hint>]
  [--budget <tokens>]
  [--explain]
  --json

roster brain init
roster brain doctor [--repair]
roster brain ingest|save|get|query|event|link|merge|fs
roster brain record run|feedback|artifact|decision

roster dream status [--scope ...] --json
roster dream candidates list|create|promote|reject|retire
```

Removed canonical commands and concepts:

```text
roster schedule ...
roster pending ...
roster ops ...
roster run start|next|submit|approve|fail|close
roster plan compile
roster tool resolve|health|route
roster invocation describe
```

`roster update` is the canonical synchronization verb for generated adapters and manifests. It replaces only unedited generated files and refuses edited targets unless an explicit migration contract applies.

`roster dream reflect` is a host skill workflow, not a CLI verb that implies Roster invokes a model. The skill may call `dream status`, Brain queries, and candidate commands.

Every mutating command supports stable idempotency where remote state is involved. JSON output never contains secret values, raw provider credentials, or arbitrary external command strings.

## Data model

### Company Brain

### Isolation and scope

`brain_spaces` identifies a company knowledge space. `workspace_bindings` associates a workspace with one or more allowed Brain spaces and read/write scopes. Every scoped row carries `brain_space_id`; relevant rows additionally carry workspace/function/agent/plan scope selectors, privacy class, trust class, actor assurance, and provenance.

Database roles enforce least privilege and row-level isolation. The runtime role cannot create arbitrary tables, change schema, bypass RLS, or read another Brain space. Schema migration is an explicit administrative operation.

### Source lifecycle

Conceptual tables:

```text
brain_spaces
workspace_bindings
logical_sources
source_versions
objects
extractions
chunks
embedding_indexes
source_tombstones
ingest_intents
```

`logical_sources` owns stable identity and origin metadata. `source_versions` is immutable and points to a content-addressed `object_id`, retrieval/fetch provenance, source timestamp, privacy/trust classification, and current/superseded state. Extraction records include extractor identity/version and immutable source version. Chunks never silently move between source versions.

Absolute paths may be stored only as legacy or local locators, never as logical identity.

### Structured company knowledge

Conceptual tables:

```text
entities
aliases
facts
events
edges
merge_history
promotions
```

Facts, events, and edges cite their originating source version or explicit human/host assertion. Caller-asserted actor fields remain marked unverified unless backed by a stronger host assurance mechanism. Merges preserve history and redirects. Deletion is tombstone-first and scope aware.

### Operational and learning evidence

Conceptual tables in a separate schema:

```text
completed_runs
run_artifacts
run_sources
run_tools
feedback
human_decisions
dream_policies
dream_watermarks
dream_candidates
dream_candidate_evidence
lesson_decisions
```

Operational rows share Brain identity, authorization, object storage, and provenance infrastructure but are not normal semantic knowledge. They are excluded from ordinary lexical/vector/graph retrieval and embedding by default. Explicit promotion creates a lineage link into semantic knowledge.

### Object layout

S3 keys are derived from validated identifiers and hashes, never raw user paths:

```text
brain/<brain-space-id>/objects/<sha256-prefix>/<sha256>
brain/<brain-space-id>/evidence/<run-id>/<artifact-id>
brain/<brain-space-id>/exports/<export-id>
```

Conditional writes, content hashes, object version IDs where supported, and database intent rows make cross-store operations recoverable. S3 endpoint configuration requires HTTPS by default and explicit trust for non-standard endpoints; private/link-local targets are rejected unless explicitly authorized for a known deployment.

## Brain ingestion

1. Validate Brain binding, scope, privacy, source origin, external-path grant, and size.
2. Normalize only identity metadata; do not mutate source bytes.
3. Compute content hash and create/reuse an ingest intent.
4. Conditionally store/reuse the object.
5. Insert/reuse immutable source version and current-version transition transactionally.
6. Extract bounded content with recorded extractor/version.
7. Build lexical indexes; optionally build privacy-permitted embeddings.
8. Mark ready and emit stable provenance.

Retries converge. A host-requested `roster brain doctor --repair` reconciles pending intents, missing objects, orphaned objects, stuck extraction, and index drift. `brain ingest` and `brain fs` are confined to workspace paths by default; any external read/write requires an explicit, target-specific human-approved path grant.

## Brain retrieval

The default path combines:

- exact and structured filters;
- lexical search;
- alias-aware identity resolution where enabled; and
- optional embedding or bounded graph expansion only when configured and measured.

Retrieval always applies Brain-space, scope, privacy, trust, current-version, and tombstone filters before final ranking. Results contain exact source-version citations and deterministic retrieval reasons.

Advanced retrieval remains evidence-gated:

- trigram aliases activate only if the adopter gold set shows benefit;
- embeddings are never default-on solely by assumption;
- multi-hop graph expansion, automatic edge extraction, and hosted reranking remain optional until measured quality, latency, cost, privacy, and maintenance thresholds pass.

## Portable evidence

### Completed run

A completed run records:

- `run_id`, Brain space, workspace/function/agent/plan identities;
- host identity/version and Roster version;
- normalized request summary and content hash;
- start/end timestamps and outcome;
- source/citation summary and tool-use/skill summary;
- artifact pointers and content digests;
- optional user feedback linkage; and
- actor/trust/provenance metadata.

It does not contain a current-step state machine. Optional progress observations are append-only diagnostics.

### Human decision evidence

A decision record contains a canonical action summary and digest, requested decision, human answer, actor assurance, timestamp, host provenance, and related run/artifact. It is portable audit evidence, not a receipt that authorizes Roster or any later host to execute the action.

The host must still use its native approval and safety mechanisms every time required.

### Idempotency

Agent-facing mutating calls accept an idempotency key or stable caller identity. Equivalent replay returns the existing record. Same identity with conflicting canonical content returns `IDEMPOTENCY_CONFLICT` without mutation.

## Dreamer protocol

### Readiness

`roster dream status` evaluates eligible completed runs and feedback after the scope's stored watermark. It applies a versioned policy containing minimum evidence, time window, success/failure mix, scope, and cooldown.

Output is `due` or `not_due` with policy version, evidence count, watermark, and reasons. The command does not dispatch, schedule, invoke a model, or create a candidate.

### Host activation

Generated host instructions require a readiness check:

- immediately after a successful evidence record when inexpensive; and
- on the next Roster-backed interaction as a recovery path.

If due, the host invokes the installed Roster Dreamer skill. This closes the activation gap without a daemon or Roster schedule.

### Reflection

The Dreamer skill:

1. queries eligible evidence and existing applicable lessons;
2. detects repeated patterns without treating its own prior outputs as independent evidence;
3. cites supporting, conflicting, and counterexample runs;
4. drafts a bounded candidate with proposed scope and expected effect; and
5. stores it idempotently in Brain.

Untrusted evidence is data, never instruction. Candidate text cannot directly overwrite authored files.

### Decision and promotion

The host presents pending candidates. The human may revise, promote, reject, or retire. Promotion:

1. records the decision in Brain;
2. writes a reviewable lesson file into the applicable workspace/function/agent/plan playbook scope;
3. stores the authored hash and lineage; and
4. advances the evidence watermark according to policy.

Context selection includes only approved, non-retired lessons whose scope matches. Conflicts are reported and resolved by explicit precedence plus human review.

## Host adapters

Host adapters are generated activation instructions and thin command mappings. Each adapter must teach the same lifecycle:

1. detect `roster.yaml`;
2. discover or validate the requested target;
3. ask Roster for bounded context;
4. read and interpret the entire structured plan;
5. load referenced vendor skills;
6. execute reasoning, subagents, tools, approvals, and retries in the host;
7. record completed evidence and feedback;
8. check Dreamer readiness; and
9. invoke Dreamer/present candidates when due.

Adapters never embed a business-specific plan, provider secret, schedule, reducer, or alternate authoring source. Common host-neutral content is generated from one source; host-specific wrappers are minimal. Adapter metadata records generator version, protocol version, content hash, and supported assurance level.

Gemini support is outside the initial v2 product boundary. Shared renderer interfaces may remain only if they do not impose shipping, test, or compatibility cost.

## Doctor

`roster doctor --json` reports independently:

- workspace identity and schema version;
- registry/path ownership and generated drift;
- structured plan references and cycles;
- context resolution and budget health;
- company Brain binding, connectivity, schema, RLS scope, S3 trust, and retrieval citation health;
- vendor skill installation and workspace tool-use references;
- evidence write/read health and semantic-separation policy;
- Dreamer policy, watermark, readiness, candidate state, and host activation instruction;
- Claude Code and Codex adapter version/capability drift;
- migration state and legacy surfaces; and
- secret and unsafe-path findings.

Doctor never claims that Roster executed a plan. Fixtures verify activation behavior at the host boundary.

## Migration

Migration is explicit, one-way, and dry-run first.

### Dry run

The report classifies every path and database surface as:

- preserve authored;
- transform with exact target and schema version;
- import as `legacy-unverified`;
- archive for manual inspection;
- remove generated legacy surface; or
- require human decision.

The report includes fingerprints, conflicts, possible secret locations, Brain identity changes, external schedule blocks targeted for removal, and a backup plan. It never prints secret values.

### Apply

Apply creates a recoverable backup/fingerprint, acquires a workspace lock, revalidates the dry-run fingerprint, performs atomic local writes, records remote idempotency state, and emits a final audit report.

Migration must:

- preserve authored agents, plans, guidelines, useful lessons, and tool intent;
- convert legacy tool bindings into reviewed workspace tool-use definitions and external skill references;
- convert absolute-path source identities into stable logical source identities while retaining paths as legacy locators;
- import useful logs, approvals, and candidates only as `legacy-unverified` evidence;
- map secret key names to Infisical references without reading or persisting values;
- remove Roster-managed schedule blocks only with exact targets and explicit consent;
- leave host-native schedules untouched;
- delete or archive general ops/HITL state after extracting minimal evidence; and
- provide no permanent compatibility shim.

Frozen snapshots of `my-roster` and `roster-lobu` are mandatory migration fixtures.

## Surplus and removal map

### Delete after extracting reusable primitives

- Roster schedule commands, cron writers, schedule registry/state/fire records, pending-from-schedule behavior, and schedule E2E/docs.
- General operations queues, inboxes, overlays, local sealed ledgers, outboxes, leases, sweeps, wake/resume, capability negotiation, and setup journals.
- General HITL state machine, polling, Slack-specific approval workflow, and execution receipts.
- Proposed plan compiler/reducer/current-step and `next/submit/approve` protocols.
- Generic external provider routing, health, fallback, and execution contracts.

### Keep and adapt

- Workspace path safety, bounded readers, atomic writes, hashes, locks, generated/authored ownership, upgrade conflict detection, and scaffold manifests.
- Founder-skill source pinning, provenance, hashes, and Claude/Codex fan-out, generalized as vendor skill management.
- Brain entities, facts, events, edges, aliases, merge history, lexical/vector/graph primitives, backup, GC, reindex, and S3 primitives.
- Canonical JSON, digests, idempotency conflicts, trust taxonomy, sanitization, Postgres migrations, conditional object writes, and content-addressed artifacts extracted into the smaller evidence core.
- Role-based functions/agents, structured plans, guidelines, playbooks, lessons, Chief of Staff authoring role, and Dreamer product concepts.

### Quarantine or measure

- Notion task state machine as an optional external integration through a vendor skill/tool-use definition.
- Second-opinion behavior as repository development tooling, not Roster product runtime.
- Tripwire as an optional report-only host defense, never a trust boundary.
- Gemini adapter until measured product demand.
- Trigram aliases, multi-hop graph search, automatic edges, default embeddings, and hosted reranking until quality evaluation justifies activation.

## Security model

### Trust classes

At minimum:

```text
authored-policy
approved-lesson
vendor-instruction
brain-structured
brain-extract-untrusted
tool-output-untrusted
host-asserted
legacy-unverified
diagnostic
```

Authored policy, vendor instructions, Brain evidence, and tool output remain structurally separate. Narrower policy cannot silently relax broader safety policy. Evidence cannot inject new plan or tool instructions.

### Workspace safety

- All default file access is bounded to the resolved workspace root.
- Every component is checked for symlinks and type before read/write.
- External paths require an exact, explicit host-obtained human grant.
- No glob, environment variable, unresolved substitution, or raw user path identifies a destructive target.
- Migration deletions require fingerprints, explicit targets, and a recoverable backup.

### Brain isolation

- Every relevant row is bound to `brain_space_id` and authorized scope.
- RLS and role grants enforce isolation in the database, not only application filters.
- Runtime roles cannot change schema or execute arbitrary SQL/table creation.
- Privacy class controls storage, extraction, embedding, retrieval, and export.
- Secret-class content is never embedded or emitted in context.

### Network and storage

- HTTPS is required for remote S3 endpoints by default.
- Endpoint trust and private-network exceptions are explicit configuration.
- Object keys are derived from validated IDs/hashes.
- Postgres and S3 partial failures are detectable and repairable.
- Export and deletion actions are scoped and audited.

### Vendor skill supply chain

- Prefer immutable commit/digest pins over branches or mutable tags.
- Record source, resolved revision, content hash, install time, and review state.
- Source allowlists and human review precede activation where policy requires.
- External skill secrets remain in Infisical/provider mechanisms and never enter authored Roster files or context output.

### Human decisions

Decision evidence never bypasses native host safety prompts. An old decision cannot be replayed as authority for a materially different action. Action digests include normalized target, effect, scope, and material parameters.

## Environment variables

Roster configuration stores references and non-secret metadata only. Commands needing Brain secrets are invoked under `infisical run` or another explicitly supported ambient injection mechanism. Roster must not create `.env`, copy resolved values into generated files, print resolved secrets, or accept secret values inside tool-use definitions.

| Variable | Required for | Secret handling |
|---|---|---|
| `ROSTER_BRAIN_ADMIN_URL` | Explicit Brain initialization, schema migration, role administration, and administrative doctor operations | Infisical-injected; never logged or stored in workspace files |
| `ROSTER_BRAIN_URL` | Agent-facing Brain reads/writes, context retrieval, evidence, and Dreamer state | Infisical-injected least-privilege runtime URL |
| `OPENAI_API_KEY` | Optional privacy-permitted OpenAI embedding generation/reindex only | Infisical-injected; absence preserves lexical/structured behavior |
| `AWS_ACCESS_KEY_ID` | S3-compatible Brain object access | Infisical-injected; never stored in Brain config |
| `AWS_SECRET_ACCESS_KEY` | S3-compatible Brain object access | Infisical-injected; never stored in Brain config |
| `AWS_SESSION_TOKEN` | Optional temporary S3 credentials | Infisical-injected and never persisted |
| `AWS_REGION` | Optional S3 region fallback when Brain non-secret config omits it | Non-secret but supplied through the same command environment |

Bucket, region, endpoint, prefix, path-style behavior, embedding enablement, provider/model metadata, retrieval constants, and retention policy are non-secret Brain configuration. External vendor tool environment variables belong to their vendor skills and host sessions, not the Roster tool-use schema.

External vendor tool secrets and connection configuration are outside Roster's provider layer. The vendor skill and host own their use.

## Performance and quality targets

- Local discovery and static validation p95 under 250 ms for representative adopters after warm index.
- Local mandatory context assembly p95 under 500 ms excluding remote Brain query.
- Remote Brain query/context p95 under 2 seconds for representative gold tasks under configured result caps.
- Deterministic equivalent context selection across Claude Code and Codex.
- At least 60 percent fewer context tokens than the frozen eager-load `my-roster` baseline.
- Required-context recall and citation completeness thresholds defined by the adopter gold set; no launch with silent required-context loss.
- No raw secret canary in any JSON, diagnostic, log, context, migration, or artifact metadata surface.

## Observability

Structured diagnostics use stable codes, command, workspace/Brain scope, duration, counts, versions, and redacted correlation IDs. They do not include secret values or raw sensitive context by default.

Key metrics:

- discovery/validation failure by reason;
- context required/optional tokens, inclusions, exclusions, retrieval latency, and citation completeness;
- Brain ingest/recovery/index state and retrieval mode;
- evidence write conflicts;
- Dreamer due checks, watermarks, candidate decisions, and later lesson selection;
- adapter version/activation drift; and
- migration classification and conflict counts.

There are no scheduler-fire, step-transition, provider-route-health, lease, queue, or approval-authority metrics in core.

## Key flows

### Scaffold and activate

```text
human asks host to create agent
→ host calls roster scaffold
→ Roster writes minimal authored structure
→ roster validate
→ generated host adapter points to discover/context lifecycle
```

### Execute a structured plan

```text
human asks host for work
→ host discovers agent/plan
→ host calls roster context with request and optional step hint
→ Roster returns whole plan + bounded cited context + tool-use definitions
→ host interprets steps, loads vendor skills, executes, waits for human when needed
→ host records completed evidence
→ host checks dream status
```

### Ingest and retrieve knowledge

```text
host explicitly selects source
→ roster brain ingest
→ S3 immutable object + Postgres source/version intent
→ extraction + lexical/optional embedding indexes
→ later roster context query
→ cited current-version extract
```

### Learn

```text
completed evidence/feedback
→ roster dream status = due
→ host invokes Dreamer skill
→ cited candidate in Brain
→ human decision through host
→ approved lesson materialized in Git
→ later context includes lesson
```

## Test strategy and release gates

### Unit and property tests

- bounded YAML parsing and schema failures;
- qualified identity, path confinement, symlink, collision, and atomic write behavior;
- static plan reference and cycle validation;
- tool-use scope/precedence and skill reference validation;
- deterministic budget selection and trust separation;
- source/version convergence, recovery, citations, RLS scopes, privacy, and embedding permission;
- evidence idempotency and semantic separation;
- Dreamer readiness/watermark/candidate/promotion/retirement;
- adapter generation and drift; and
- migration classification and fingerprinting.

### Seeded golden flow

Both host fixtures discover the same agent and plan, interpret the plan themselves, receive equivalent bounded context and tool-use definitions, simulate vendor execution, record evidence, observe Dreamer due, promote a candidate after simulated human approval, and receive the lesson in a later bundle. The fixture contains no Roster reducer, current step, schedule, provider router, or approval authority.

### Real adopter flows

- `my-roster`: Social Media Manager discovery with real Brain retrieval and an authored Exa/Bright Data-style tool-use definition.
- `roster-lobu`: a representative distinct workflow proving the model is not social-media-specific.

### Adversarial tests

- hostile YAML, alias bombs, deep nesting, malformed references, path escapes, symlink swaps, unsafe external path grants;
- cross-Brain and cross-scope access, tombstoned/stale source leakage, hostile S3 endpoint, embedding privacy violation;
- vendor skill mutation, secret canaries, prompt injection in Brain/tool output, forged actor claims;
- idempotency conflicts, Postgres/S3 partial failure, Dreamer self-evidence, conflicting lessons; and
- legacy unverified data attempting to become approved authority.

### Removal verification

Tests assert that schedule, general ops/HITL, plan transition, provider route, and old pending/Slack activation surfaces are absent from the shipped CLI, templates, docs, migrations, and package contents.

### Required phase gate

```text
pnpm typecheck
pnpm build
pnpm test
pnpm test:scaffold-scripts
pnpm smoke
```

Critical Brain/storage, scaffold/path, migration, evidence, Dreamer, and host-adapter changes also require focused integration tests, secret scanning, security review, and a second opinion before merge.
