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

<!-- forge:adr-section:canonical-identifiers -->
## Canonical identifiers

Identifiers are stable strings and never use absolute checkout paths as global identity.

| Identifier | Purpose |
|---|---|
| `workspace_id` | One logical Roster workspace and its dedicated Brain database/S3 namespace identity |
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

`workspace_id` appears in tracked `roster.yaml` and protected database metadata. A Brain command performs the minimum protected-metadata identity handshake before reading company content, touching S3, or mutating Brain state. Clones of one logical workspace retain the same identity and Brain authority; a distinct workspace requires a distinct `workspace_id`, PostgreSQL database, and S3 namespace.

Qualified authoring identities use slash-separated components internally, for example `gtm/social-manager#opportunity-discovery`. Individual component values are lowercase kebab-case and cannot contain path separators, traversal segments, control characters, or platform-reserved names.

<!-- /forge:adr-section:canonical-identifiers -->
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

<!-- forge:adr-section:workspace-registry -->
### Workspace registry

```yaml
schema_version: 2
workspace_id: my-roster
brain:
  secrets_path: /my-roster
  storage:
    bucket: my-roster-vault
    region: eu-central-1
    root_prefix: brain
functions:
  gtm:
    path: functions/gtm
hosts:
  claude: enabled
  codex: enabled
```

`brain` is optional at initialization. It contains only portable non-secret organization: the Infisical path/reference and the S3 bucket, region, optional endpoint/path-style settings, and optional root prefix that together form this workspace's storage namespace. Connection URLs and credentials remain ambient and Infisical-injected. The retired `brain.binding` shape is rejected with migration guidance rather than preserved as a compatibility shim.

For first initialization, the host asks Roster for the deterministic non-secret runtime role name, stores a strong workspace-specific `ROSTER_BRAIN_URL` at the tracked Infisical path, and retries under ambient injection. Roster validates and uses that credential but never mints, stores, returns, or prints it.

Each configured Brain database stores a protected `workspace_id` and the validated S3 namespace fingerprint. Roster first reads only that protected metadata, compares it with `roster.yaml`, and fails closed on a mismatch before reading company content, touching S3, or mutating Brain state. Any clone carrying the same authored `workspace_id` and authorized Infisical access reaches the same Brain; a different workspace ID must use a different database.

Brain absence never causes local scaffold or validation commands to fail. For `roster context`, absence returns the complete local bundle, an empty `brain_evidence` array, exit status zero, and exactly one warning-severity `BRAIN_NOT_CONFIGURED` diagnostic. Brain-dependent commands retain the fatal `BRAIN_NOT_CONFIGURED` contract with setup guidance.

<!-- /forge:adr-section:workspace-registry -->
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
  request:
    description: The human's current discovery request.
    required: true
    shape: Plain text.
brain_selectors:
  successful-replies:
    description: Examples of successful prior replies.
    required: false
guidelines:
  - gtm/guidelines/brand-voice
artifacts:
  search-brief:
    description: Filters prepared by the host for the selected search tool.
  opportunity-shortlist:
    description: The human-reviewed shortlist.
    shape: Markdown list with canonical URLs and relevance reasons.
caps:
  candidates:
    maximum: 25
    guidance: Keep only opportunities that match the current request.
steps:
  - id: prepare
    kind: reasoning
    instruction: Derive request-specific filters from the task, ICP, and examples.
    context:
      brain: [successful-replies]
      guidelines: [gtm/guidelines/brand-voice]
    expected:
      artifacts: [search-brief]
      output_guidance: Explain why each filter matches the request.
  - id: discover
    kind: tool
    tool_use: social-opportunity-research
    instruction: Find current opportunities using the prepared filters.
    retry_guidance:
      max_attempts: 2
      instruction: Narrow the host-prepared filters before retrying.
  - id: review
    kind: reasoning
    instruction: Remove duplicates and explain relevance with citations.
  - id: present
    kind: approval
    instruction: Present the shortlist and wait for the human's selection.
    approval_guidance: Wait for the human in the host interface.
  - id: return
    kind: artifact
    instruction: Return the approved shortlist.
    artifact: opportunity-shortlist
completion:
  artifacts: [opportunity-shortlist]
  output_guidance: Return the approved shortlist with relevance rationale.
  criteria:
    - Every item has a canonical URL and relevance reason.
```

Supported `kind` values describe host behavior, initially `reasoning`, `subagent`, `cross-agent`, `nested-plan`, `tool`, `approval`, and `artifact`. They are not Roster executor opcodes.

Static validation checks:

- unique ordered step IDs;
- existing agent, plan, subagent, guideline, Brain selector, and tool-use references;
- direct and transitive nested-plan cycles;
- bounded caps and retry guidance;
- declared expected artifacts and completion criteria;
- no arbitrary code, executable template, binding, shell command, goto, worker queue, transition, or hidden expression language.

Array position is the only sequence; the schema has no output binding, dependency, transition, or current-step grammar. Input/output shapes, condition guidance, retries, caps, and approvals are inert instructions for the host, not transition gates. Roster returns the whole selected plan in context.

### Workspace tool-use definition

```yaml
schema_version: 2
id: social-opportunity-research
scope: {}
skill_ref: exa:search
purpose: Find timely, credible posts that match our audience and positioning.
when:
  - discovering reply opportunities
capabilities:
  - web-search
  - content-retrieval
rules:
  - use attributable public sources
output_expectations:
  required: [canonical_url, author, published_at, relevance_reason]
  guidance: [reject profile and company-homepage URLs as candidate posts]
brain:
  read: [icp, messaging, previously-presented-opportunities]
  write: [discovered-opportunity, retrieval-provenance]
effects:
  allowed: [external-read, brain-read, brain-write]
approval:
  requirement: none
evidence:
  required: [canonical_url, retrieved_at]
```

The plan can own a same-ID overlay at its registered plan tool path:

```yaml
schema_version: 2
id: social-opportunity-research
scope:
  function: gtm
  agent: social-manager
  plan: opportunity-discovery
skill_ref: exa:search
purpose: Rank timely opportunities for this discovery request.
how:
  - search first-party and high-credibility sources for the requested lookback
  - exclude previously presented URLs using Brain history
  - rank by ICP relevance before engagement volume
filters:
  - exclude URLs already presented according to Brain history
approval:
  requirement: human
  guidance: [wait for the human before any engagement]
```

The definition may reference the relevant subset of a vendor skill but must not duplicate provider setup, credentials, syntax, or generic best practices. Raw secret material is forbidden. Effects and approval are policy guidance presented to the host, not Roster enforcement.

Tool-use ancestry is resolved broad-to-narrow:

```text
workspace → function → agent → plan
```

Only `purpose` uses most-specific replacement. `skill_ref` must remain identical;
`when`, `how`, capabilities, filters, rules, output guidance, approval guidance,
and evidence accumulate with stable deduplication; Brain selectors are additive
requested intent, never authorization. An explicit `effects.allowed` set may only
narrow an inherited set, and approval may only become stricter from `none` to
`human`. There is no override, clear, negation, or safety-relaxation syntax.
The flat result retains contributor and field provenance, while expected output
remains host guidance rather than a provider result gate.

<!-- forge:adr-section:discovery-and-validation -->
## Discovery and validation

`roster discover [query] --json` returns compact records with qualified ID, kind, path, purpose, scope, schema version, content hash, and reference summary. Optional filters narrow by function, agent, plan, or kind.

`roster validate [target] --json` performs:

- bounded schema parsing;
- qualified identity and path ownership checks;
- static cross-reference and cycle checks;
- tool-use and vendor skill-reference checks;
- Brain configuration, database workspace identity, S3 namespace, and typed retrieval-scope checks when relevant;
- generated adapter and manifest drift checks; and
- secret-pattern and unsafe-content checks.

Validation is read-only unless the user requests an explicit scaffold, update, or migration action.

<!-- forge:adr-section:context-request-and-response -->
## Context request and response

### Request

```json
{
  "target": "gtm/social-manager#opportunity-discovery",
  "query": "Find reply opportunities from the last 24 hours",
  "step_hint": "discover",
  "budget_tokens": 12000,
  "explain": true
}
```

`step_hint` is optional and host supplied. It may rank already-eligible optional context but never selects or prunes a step, widens the authored Brain selector catalog, or becomes Roster execution state. Roster never infers a plan when `#plan` is omitted.

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

The selected plan response contains the root definition first plus the complete, deduplicated transitive closure of every statically referenced nested-plan definition from one validated workspace snapshot. Remaining definitions use deterministic code-point order while authored step and array order is preserved. Roster returns definitions only; Claude Code or Codex interprets steps, chooses branches, delegates, invokes tools, and waits for human decisions.

Mandatory context is workspace/function/agent identity and policy, agent default guidelines, every guideline explicitly referenced by a closure plan, and each effective tool-use definition paired with its canonical skill reference when named by an actual `kind: tool` step in the closure. Registry/function/agent/plan `tool_uses` arrays are ownership catalogs and select nothing. Approved lessons and all Brain evidence are optional. Human-approved lessons rank ahead of untrusted Brain extracts. A plan Brain selector marked `required` is nonfatal retrieval intent that ranks matches only inside the Brain tier; tool-use Brain reads can match but never carry required intent.

Each fragment includes stable identity, workspace and narrower scope labels, version or hash, trust class, inclusion reason, required/optional status, and deterministic byte/token accounting. Effective composite tool guidance uses contributor content hashes plus its semantic hash rather than claiming one raw-source hash. Brain extracts contain an immutable workspace/logical-source/version/object/extractor citation envelope and remain structurally separate from policy.

The response cannot contain Roster run state, a Roster-selected current step, prior-output bindings, a provider route, an approval receipt, `next_actions`, or a transition. Missing Brain configuration is nonfatal for context as defined by the workspace registry contract. Optional retrieval failure or candidate rejection cannot corrupt or overflow the otherwise servable mandatory local bundle; per-candidate diagnostics are optional examples and fixed budget counters remain authoritative.

### Selection algorithm

1. Resolve the workspace, exact target function/agent, and optional selected root plan from one complete validated snapshot.
2. If a root is named, resolve its complete deduplicated transitive nested-plan definition closure. Reserve the selected function/agent, root and closure definitions, default and explicitly referenced guidelines, and every closure tool-step effective tool-use/canonical-skill pair as mandatory.
3. Resolve applicable approved lessons as optional context. Plan-scoped lesson and Brain evidence eligibility compares the fully qualified plan identity; a same-named plan owned by another agent grants no scope. Membership catalogs do not select policy or tools.
4. Derive the authored Brain selector catalog from closure plan selectors and selected effective tool-use Brain reads. Query and step hint never widen it. Workspace/function/agent/plan scopes are retrieval labels, not database credentials.
5. When Brain is configured, read only the protected database identity metadata and verify that `workspace_id` and the S3 namespace match `roster.yaml`. A mismatch stops before company-content reads, S3 access, or mutation. Retrieve bounded candidates only from that workspace database, then reject scope-ineligible, secret, stale, tombstoned, privacy-incompatible, duplicate, uncited, malformed, invalid-rank, unrequested, and low-trust candidates under one deterministic primary reason each.
6. Rank approved lessons before untrusted Brain extracts, then rank each tier deterministically under the remaining budget. Required selector intent affects only the Brain tier and a no-match produces one nonfatal aggregate warning/count.
7. Admit complete optional fragments by deterministic first-fit accounting; never truncate one. Candidate exclusion diagnostics are considered last as optional examples.
8. Emit citations, trust separation, provenance, exact budget accounting, authoritative exclusion/scalar counts, and sanitized diagnostics. Reverify every contributing local source before returning.

Mandatory content is never truncated. If its minimum is within the accepted host ceiling but exceeds the caller budget, return `CONTEXT_BUDGET_REQUIRED_OVERFLOW` with the exact accepted retry budget and no partial bundle. If the mandatory minimum exceeds the 128,000-token host ceiling, return `CONTEXT_MANDATORY_UNSERVABLE` with safe section/contributor counts rather than an impossible retry. Token counts use the fixed deterministic estimator and always include raw byte counts.
<!-- /forge:adr-section:context-request-and-response -->

<!-- /forge:adr-section:context-request-and-response -->
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

<!-- forge:adr-section:data-model -->
## Data model

### Company Brain

One logical Roster workspace owns one PostgreSQL Brain database and one configured S3 namespace. The database is the cross-workspace isolation boundary; distinct workspaces do not share Brain tables or credentials.

### Workspace identity and scope

Protected `brain_meta.workspace_identity` metadata records the stable `workspace_id` and S3 namespace fingerprint. The runtime role may read this identity for the mandatory handshake but cannot alter it. A command that sees a mismatch stops before company-content reads, S3 access, or mutation; the database cannot be activated by another workspace ID.

Workspace/function/agent/plan values on relevant rows are typed hierarchical retrieval labels. They guide selection, ranking, explanation, and exclusion inside one trusted workspace; they are not database authorization principals. Privacy class, trust class, actor assurance, and provenance remain explicit policy metadata.

Admin and least-privilege runtime roles remain separate. The runtime role cannot create arbitrary tables, change schema, mutate protected workspace identity/provenance, or bypass the closed write surface. No `brain_spaces`, `workspace_bindings`, per-binding login roles, or cross-workspace/cross-scope RLS are part of v2.

### Source lifecycle

Conceptual tables:

```text
brain_meta.workspace_identity
logical_sources
source_versions
objects
extractions
chunks
embedding_indexes
source_tombstones
ingest_intents
```

`logical_sources` owns stable typed origin identity and its current-version pointer. `source_versions` is immutable and points to a content-addressed `object_id`, retrieval/fetch provenance, source timestamp, privacy/trust classification, actor assurance, typed retrieval scope, and current/superseded state. Extraction records include extractor identity/version and immutable source version. Chunks never silently move between source versions. Equal bytes may reuse one object without merging distinct logical sources.

Workspace files derive origin identity automatically from stable `workspace_id + workspace-relative POSIX path`. Fetched media derives origin identity automatically from a canonical provider/origin plus upstream stable ID, with canonical URL only where no stable provider ID exists. Inline text, structured records, and produced artifacts require a host-supplied stable key. Content hashes identify bytes/versions, never the continuing logical source. Absolute paths may be stored only as legacy or local locators.

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

Facts, events, and edges cite their originating source version or explicit human/host assertion. Caller-asserted actor fields remain marked unverified unless backed by a stronger host assurance mechanism. Merges preserve history and redirects. Deletion is tombstone-first and retrieval-scope aware.

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

Operational rows share the workspace Brain identity, object storage, typed retrieval scopes, and provenance infrastructure but are not normal semantic knowledge. They are excluded from ordinary lexical/vector/graph retrieval and embedding by default. Explicit promotion creates a lineage link into semantic knowledge.

### Object layout

S3 keys are relative to the workspace's validated bucket/root-prefix namespace and derive from hashes and bounded IDs, never raw user paths:

```text
objects/<sha256-prefix>/<sha256>
evidence/<run-id>/<artifact-id>
exports/<export-id>
```

Conditional writes, content hashes, object version IDs where supported, and database intent rows make cross-store operations recoverable. The database stores and verifies the configured namespace fingerprint before object access. S3 endpoint configuration requires HTTPS by default and explicit trust for non-standard endpoints; private/link-local targets are rejected unless explicitly authorized for a known deployment.

<!-- /forge:adr-section:data-model -->
<!-- forge:adr-section:brain-ingestion -->
## Brain ingestion

1. Resolve tracked Brain configuration, read only protected identity metadata, and verify the database `workspace_id` and S3 namespace fingerprint before company-content reads, S3 access, or mutation.
2. Validate the typed retrieval scope, privacy, source kind/origin and identity contract (automatic for files and fetched media; a required host-supplied stable key for inline text, structured records, and produced artifacts), external-path grant, media type, and size.
3. Normalize only identity metadata; do not mutate source bytes.
4. Compute the content hash and canonical request fingerprint, then create or reuse a durable ingest intent.
5. Conditionally store or verify the content-addressed object inside the validated workspace S3 namespace.
6. Insert or reuse the immutable source version and update the logical source's current-version pointer transactionally.
7. Record locators and provenance; extraction and lexical/optional embedding readiness continue through their versioned lifecycle.
8. Mark the intent complete and emit stable source/version/object identity with sanitized recovery state.

Retries converge. A host-requested `roster brain doctor --repair` reconciles pending intents, missing objects, verified intent-owned orphan objects, stuck extraction, and index drift. Missing source bytes are never fabricated. `brain ingest` is confined to workspace paths by default; any external read requires an explicit, target-specific human-approved path grant. Fetched-media provider execution belongs to the host/tool; Roster receives selected bytes plus origin metadata.

<!-- /forge:adr-section:brain-ingestion -->
<!-- forge:adr-section:brain-retrieval -->
## Brain retrieval

The database connection establishes the workspace boundary before query. Roster first verifies the tracked/database `workspace_id` and S3 namespace, then combines:

- exact and structured filters;
- typed workspace/function/agent/plan retrieval labels;
- lexical search;
- alias-aware identity resolution where enabled; and
- optional embedding or bounded graph expansion only when configured and measured.

Retrieval applies selector-compatible scope labels, privacy, trust, current-version, and tombstone filters before final ranking. Scope labels guide context selection and exclusion; they do not grant authority. Results contain exact source-version citations and deterministic retrieval reasons. A workspace identity or storage-namespace mismatch stops after the protected-metadata handshake and before company-content reads, S3 access, or mutation, and returns an actionable sanitized diagnostic.

Default retrieval excludes `legacy-unverified` evidence. A future explicit host request may include it, but every result retains that trust class and remains evidence only; it can never supply authority, policy, or instructions.

Advanced retrieval remains evidence-gated:

- trigram aliases activate only if the adopter gold set shows benefit;
- embeddings are never default-on solely by assumption;
- multi-hop graph expansion, automatic edge extraction, and hosted reranking remain optional until measured quality, latency, cost, privacy, and maintenance thresholds pass.
<!-- /forge:adr-section:brain-retrieval -->
## Portable evidence

<!-- forge:adr-section:completed-run -->
### Completed run

A completed run records:

- `run_id`, stable workspace identity, and function/agent/plan retrieval labels;
- host identity/version and Roster version;
- normalized request summary and content hash;
- start/end timestamps and outcome;
- source/citation summary and tool-use/skill summary;
- artifact pointers and content digests;
- optional user feedback linkage; and
- actor/trust/provenance metadata.

It does not contain a current-step state machine. Optional progress observations are append-only diagnostics.

<!-- /forge:adr-section:completed-run -->
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

<!-- forge:adr-section:doctor -->
## Doctor

`roster doctor --json` reports independently:

- workspace identity and schema version;
- registry/path ownership and generated drift;
- structured plan references and cycles;
- context resolution and budget health;
- tracked Brain configuration, Infisical reference availability, protected database `workspace_id`, least-privilege role/schema state, S3 namespace trust, ingest recovery, and retrieval citation health;
- vendor skill installation and workspace tool-use references;
- evidence write/read health and semantic-separation policy;
- Dreamer policy, watermark, readiness, candidate state, and host activation instruction;
- Claude Code and Codex adapter version/capability drift;
- migration state and legacy surfaces; and
- secret and unsafe-path findings.

Doctor distinguishes missing configuration, unavailable credentials/services, wrong-database identity, misbound bucket/root prefix, role/schema drift, and source/object integrity failure with stable redacted diagnostics. It treats function/agent/plan scopes as retrieval-label correctness, never as an RLS authorization claim. Doctor never claims that Roster executed a plan. Fixtures verify activation behavior at the host boundary.

<!-- /forge:adr-section:doctor -->
<!-- forge:adr-section:migration -->
## Migration

Migration is explicit, one-way, and dry-run first.

### Dry run

The report classifies every path and database/storage surface as:

- preserve authored;
- transform with exact target and schema version;
- import as `legacy-unverified`;
- archive for manual inspection;
- remove generated legacy surface; or
- require human decision.

The report includes fingerprints, conflicts, possible secret locations, the intended stable `workspace_id`, tracked non-secret Brain configuration, protected database identity state, configured S3 namespace, external schedule blocks targeted for removal, and a backup plan. It never prints secret values.

### Apply

Apply creates a recoverable backup/fingerprint, acquires workspace and remote migration locks, revalidates the dry-run fingerprint, performs atomic local writes, records remote idempotency state, and emits a redacted final audit report.

For a database with no protected identity, apply initializes only the explicitly approved logical workspace's `workspace_id` and S3 namespace fingerprint. A different existing identity, ambiguous legacy ownership, or unvalidated bucket/root prefix stops after the protected-metadata handshake and before company-content reads, S3 access, or mutation, and becomes an explicit human-decision item.

Migration must:

- preserve authored agents, plans, guidelines, useful lessons, and tool intent;
- create or update tracked `roster.yaml` Brain organization without storing credentials;
- upgrade each existing workspace Brain in place in its own database/S3 namespace, without a Brain-space wrapper;
- convert legacy tool bindings into reviewed workspace tool-use definitions and external skill references;
- convert absolute-path source identities into stable logical source identities while retaining paths as legacy locators;
- preserve verifiable structured knowledge, graph history, S3 object versions, and source lineage;
- import useful logs, approvals, and candidates only as `legacy-unverified` evidence;
- map secret key names to Infisical references without reading or persisting values;
- remove Roster-managed schedule blocks only with exact targets and explicit consent;
- leave host-native schedules untouched;
- delete or archive general ops/HITL state after extracting minimal evidence; and
- provide no `brain_spaces`, `workspace_bindings`, per-binding credentials, cross-workspace/cross-scope RLS, permanent dual-write, or compatibility shim.

During phase 2, the legacy Brain spellings `mount`, `table`, `sql`, `config`, `reindex`, `gc`, `export`, and `import` remain parser-recognized only to return protected-identity diagnostics or a stable fail-closed disabled-command error; they never perform legacy behavior. `brain query` remains recognized but reports not ready until extraction, indexing, and cited retrieval ship. Issue #363 performs the one-way cutover that removes these spellings.

Existing tables and legacy S3 keys remain backed up and readable for verification until the one-way cutover completes. Frozen snapshots of `my-roster` and `roster-lobu` are mandatory migration fixtures. Phase-2 lifecycle and migration-foundation work does not delete S3 object bytes.
<!-- /forge:adr-section:migration -->
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

<!-- forge:adr-section:brain-isolation -->
### Brain isolation

- Each logical `workspace_id` owns a different PostgreSQL database and one validated S3 bucket/root-prefix namespace; clones of that workspace may share them through authorized Infisical access.
- Tracked `roster.yaml` identity and storage organization must match protected database metadata. A mismatch stops after the protected-metadata handshake and before company-content reads, S3 access, or mutation, and never becomes a guessed migration.
- The database is the cross-workspace boundary. Function/agent/plan scopes are typed retrieval labels, not authorization principals; v2 introduces no Brain-space tenancy, binding roles, cross-scope RLS, or per-agent credentials.
- Runtime roles cannot change schema, create arbitrary tables, mutate protected workspace identity/provenance, or bypass the closed write surface.
- Privacy class controls Roster-managed storage, extraction, embedding, retrieval, and export behavior. Secret-class content is never embedded or emitted in context.

<!-- /forge:adr-section:brain-isolation -->
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

<!-- forge:adr-section:environment-variables -->
## Environment variables

Roster configuration stores references and non-secret metadata only. Each workspace names its Infisical path/reference in `roster.yaml`; commands needing Brain secrets are invoked under `infisical run` or another explicitly supported ambient injection mechanism. Roster must not create `.env`, copy resolved values into generated files, print resolved secrets, or accept secret values inside tool-use definitions. Runtime/admin URLs are workspace-specific, and their database identity must match the tracked `workspace_id` before use.

| Variable | Required for | Secret handling |
|---|---|---|
| `ROSTER_BRAIN_ADMIN_URL` | Explicit initialization/migration/repair for this workspace-owned Brain database | Infisical-injected through the tracked secret reference; never logged or stored in workspace files |
| `ROSTER_BRAIN_URL` | First Brain initialization plus agent-facing reads/writes, context, evidence, and Dreamer state for this workspace-owned Brain database | Host-created and Infisical-injected least-privilege runtime URL; Roster validates its derived role, uses it for initial role creation and a fresh authority proof, never returns or prints it, and rejects a database `workspace_id` mismatch |
| `OPENAI_API_KEY` | Optional privacy-permitted OpenAI embedding generation/reindex only | Infisical-injected; absence preserves lexical/structured behavior |
| `AWS_ACCESS_KEY_ID` | S3-compatible Brain object access | Infisical-injected; never stored in Brain config |
| `AWS_SECRET_ACCESS_KEY` | S3-compatible Brain object access | Infisical-injected; never stored in Brain config |
| `AWS_SESSION_TOKEN` | Optional temporary S3 credentials | Infisical-injected and never persisted |
| `AWS_REGION` | Optional S3 region fallback when Brain non-secret config omits it | Non-secret but supplied through the same command environment |

Bucket, region, endpoint, root prefix, path-style behavior, embedding enablement, provider/model metadata, retrieval constants, and retention policy are non-secret per-workspace Brain configuration. External vendor tool environment variables belong to their vendor skills and host sessions, not the Roster tool-use schema.

External vendor tool secrets and connection configuration are outside Roster's provider layer. The vendor skill and host own their use.

<!-- /forge:adr-section:environment-variables -->
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

<!-- forge:adr-section:unit-and-property-tests -->
### Unit and property tests

- bounded YAML parsing and schema failures;
- qualified identity, path confinement, symlink, collision, and atomic write behavior;
- static plan reference and cycle validation;
- tool-use scope/precedence and skill reference validation;
- deterministic budget selection and trust separation;
- source/version convergence, recovery, citations, tracked/database workspace identity, S3 namespace confinement, typed retrieval scopes, privacy, and embedding permission;
- evidence idempotency and semantic separation;
- Dreamer readiness/watermark/candidate/promotion/retirement;
- adapter generation and drift; and
- migration classification and fingerprinting.

<!-- /forge:adr-section:unit-and-property-tests -->
### Seeded golden flow

Both host fixtures discover the same agent and plan, interpret the plan themselves, receive equivalent bounded context and tool-use definitions, simulate vendor execution, record evidence, observe Dreamer due, promote a candidate after simulated human approval, and receive the lesson in a later bundle. The fixture contains no Roster reducer, current step, schedule, provider router, or approval authority.

### Real adopter flows

- `my-roster`: Social Media Manager discovery with real Brain retrieval and an authored Exa/Bright Data-style tool-use definition.
- `roster-lobu`: a representative distinct workflow proving the model is not social-media-specific.

<!-- forge:adr-section:adversarial-tests -->
### Adversarial tests

- hostile YAML, alias bombs, deep nesting, malformed references, path escapes, symlink swaps, unsafe external path grants;
- wrong-database workspace identity, misbound S3 namespace, crafted retrieval-scope labels, tombstoned/stale source leakage, hostile S3 endpoint, and embedding privacy violation;
- vendor skill mutation, secret canaries, prompt injection in Brain/tool output, forged actor claims;
- idempotency conflicts, Postgres/S3 partial failure, Dreamer self-evidence, conflicting lessons; and
- legacy unverified data attempting to become approved authority.

<!-- /forge:adr-section:adversarial-tests -->
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
