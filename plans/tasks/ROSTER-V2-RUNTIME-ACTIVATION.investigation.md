# Roster v2 scaffolding and context activation investigation

Date: 2026-07-31
Repository revision: `a080033`
Product version: `1.8.1`

## Question

Why do real Roster-managed repositories bypass functions, structured plans, tools, Brain retrieval, evidence, and Dreamer, and which current or proposed surfaces are truly unnecessary under the approved product boundary?

This investigation explicitly rejects the inference that low observed use means low product value. A capability may be unused because activation, deployment, guidance, or implementation is broken.

## Approved product boundary

Roster is a thin agent-facing CLI and context framework around a folder. Claude Code or Codex is the runtime.

Roster owns sparse scaffolding, discovery, static plan/reference validation, bounded context, company Brain, workspace tool-use definitions, portable evidence, Dreamer readiness/candidates, and generated host activation.

The host interprets plans, executes external tools and subagents, carries outputs, handles conditions/retries, obtains human decisions, schedules sessions, and renders results.

Roster must not own a plan reducer/current-step machine, external provider router, scheduler, general operations platform, or approval authority.

## Evidence reviewed

- Roster source, tests, templates, generated host skills, docs, migrations, and current CLI.
- `my-roster` real Social Media Manager structures and runs.
- `roster-lobu` real scaffold and usage patterns.
- Git history through `a080033`.
- Open GitHub issues #329–#369 and previously closed operations/retrieval issues.
- Current generated BRIEF/PRD/SPEC/decomposition.
- The user's target architecture and clarifications in the current product session.

The repository's baseline typecheck, build, and test suite were healthy before this planning pass: 2,397 tests discovered, 2,040 passing, 357 skipped, and 0 failing. The problem is product activation and ownership, not general repository instability.

## Current implementation shape

At the audited revision:

- TypeScript source: approximately 44,680 LOC.
- TypeScript tests: approximately 54,297 LOC across 142 test files.
- Persistence/general operations: approximately 17,285 source LOC.
- Scheduling: approximately 4,924 source LOC.
- Persistence/HITL tests: approximately 19,139 LOC.
- Schedule/orchestrator tests: approximately 7,632 LOC.
- Brain: approximately 4,944 source LOC and 5,689 test LOC.

Scheduling plus operations account for roughly half of implementation and test weight. The canonical CLI exposes install/init/update/upgrade/doctor, schedule, pending, review, task, ops, run, hooks, migrate, skills, and Brain surfaces, but no primary `discover`, granular `scaffold`, static plan validation, bounded `context`, workspace tool-use definition, or Dreamer evidence/lifecycle path (`src/bin/roster.ts`).

## Reproduction and observations

### 1. Initialization and agent creation are eager

`src/commands/init.ts` copies the scaffold tree recursively. `src/lib/create-agent/paths.ts` creates optional `pending`, `logs`, `playbook`, host configuration, and placeholder structures for every new agent.

Result: the repository communicates a large capability surface before a real function, plan, guideline, tool use, or lesson exists. Hosts see structure but not a compact activation contract.

### 2. Authorship exists, activation is incomplete

The templates preserve functions, agents, subagents, plans, guidelines, playbooks, and lessons. These are useful organizing concepts. However, the host instructions do not reliably drive the sequence:

```text
discover target → select/validate plan → retrieve bounded context
→ load company-specific tool guidance → host executes
→ record evidence → check Dreamer
```

Hosts therefore fall back to broad instruction loading and ad hoc execution.

### 3. Plans are guidance without a static contract

Current plans are largely prose/YAML interpreted by the host. They lack one bounded schema/reference-validation path. That does not justify a Roster compiler/reducer. It justifies static parsing, reference checks, cycle detection, discoverability, and inclusion of the complete selected plan in a bounded context bundle.

The earlier v2 spec incorrectly proposed that Roster compile the plan, own current-step state, accept typed results, and emit transitions. This recreates a second agent runtime and contradicts the approved boundary.

### 4. Tool intent is too shallow

Current agent tool configuration is approximately an environment variable plus a required flag (`src/lib/agent-config-schema.ts`). Founder-skill sync has reusable source pinning, hashes, ownership-aware pruning, and Claude/Codex fan-out, but it does not model company-specific use at workspace/function/agent/plan scope.

The missing layer is a workspace tool-use definition. It should reference a vendor skill and specify why, when, relevant capability subset, filters, business rules, expected output, approval guidance, Brain reads/writes, and evidence. The host derives request-specific filters and invokes the vendor skill.

### 5. Dreamer has a broken activation path

Dreamer is not merely unused:

1. There is no durable eligibility/observation accumulator.
2. Session bootstrap counts already-created pending items instead of checking reflection readiness (`skills/roster-orchestrator/SKILL.md`).
3. The Dreamer skill declares manual or Roster-scheduled triggers (`skills/dreamer/SKILL.md`).
4. The nightly plan searches singular `log/runs` and `log/feedback`, while agents scaffold plural `logs/...` (`templates/scaffold/dreamer/plans/nightly-reflection.yaml`).
5. Below-threshold observations have no durable watermark.
6. Promotion is coupled to Slack, a local queue, and same-run approval behavior.

Conclusion: Dreamer is a valuable self-improvement concept blocked by implementation and activation defects. Keep and rewrite it as a host-executed skill over Brain evidence.

### 6. Evidence is overgrown into an operations platform

Recent operations work contains useful primitives—canonical JSON, hashes, conflict semantics, trust labels, sanitization, migrations, conditional object writes, and content-addressed artifacts—but embeds them in queues, leases, outboxes, overlays, local sealed ledgers, capability negotiation, polling, wake/resume, and a general HITL state machine.

Roster only needs portable completed-run/artifact/feedback evidence plus optional action-digest-bound human-decision evidence. The host remains responsible for asking, waiting, authorizing, and executing.

### 7. Scheduling solves the wrong layer

Claude Code and Codex desktop/native environments own schedules, reminders, conversation state, wake/resume, and user interaction. Roster schedule/cron/fire/state code duplicates that host layer and became an accidental trigger dependency for Dreamer.

Conclusion: delete Roster scheduling and make host activation check Dreamer after evidence recording and on the next Roster interaction.

### 8. Brain is reusable but needs company scope and source identity

Brain already contains entities, facts, events, edges, aliases, merge/dedup history, append history, hybrid lexical/vector/graph primitives, backup, garbage collection, reindexing, and S3 primitives. These match the intended company Brain.

The current model still needs stable `brain_space_id`, explicit workspace bindings and scopes, privacy/RLS isolation, immutable source versions, stronger citations, and logical identity independent of an absolute checkout path. These are refactors, not reasons to delete Brain or its graph/provenance capabilities.

## Hypotheses tested

### H1: Unused functions, plans, and Dreamer should be removed

Rejected. The adopter and template evidence shows intended authorship, while activation and implementation defects explain bypass behavior. These capabilities are protected core.

### H2: A flat system requires deleting hierarchy and structured plans

Rejected. Flatness is needed at runtime context delivery, not authoring ownership. Hierarchy scopes agents, guidelines, lessons, and tool use; one bounded context bundle prevents recursive prompt loading.

### H3: Roster must compile plans to make them deterministic

Rejected. Static schemas, ordered guidance, references, completion criteria, and validation improve determinism without duplicating Claude/Codex runtime state. The host must see and interpret the whole plan.

### H4: Roster should execute or route external tools

Rejected. Vendor skills already own mechanics and best practices. Roster should add company-use guidance and return the skill reference. Host execution keeps Roster thin and avoids duplicating auth, compatibility, routing, parsing, and failure behavior.

### H5: Dreamer needs Roster scheduling

Rejected. Dreamer needs durable evidence/readiness plus reliable host activation. Native host schedules may start a session, but the same host-led workflow should work interactively.

### H6: Run and human-decision state must stay local Markdown

Rejected as the canonical design. Brain-backed evidence is portable across machines. Markdown may remain an optional projection. Operational evidence must stay separate from ordinary semantic company knowledge and embeddings.

## Root causes

1. **Product-shape inversion:** implementation centered schedule/operations rather than scaffold/context/learning activation.
2. **Missing host contract:** generated instructions do not consistently lead both hosts through discover → context → execute → record → learn.
3. **Eager context and filesystem shape:** recursive templates and optional trees increase prompt surface and ambiguity.
4. **Missing static plan/tool-use contracts:** useful authored concepts are not validated or retrieved through compact agent-facing commands.
5. **Dreamer activation defects:** no durable due state, mismatched paths, and dependence on manual/schedule/Slack flows.
6. **Evidence/authority conflation:** portable evidence was implemented together with Roster-owned queues and approval execution state.
7. **Brain identity/isolation gaps:** current source and workspace assumptions are narrower than a shared company Brain.
8. **Spec drift:** the first v2 decomposition overcorrected by proposing a plan runtime and provider layer the user did not want.

## Disposition matrix

| Surface | Decision | Required change |
|---|---|---|
| Functions, agents, subagents, plans | Keep/rebuild activation | Sparse registry, schemas, discovery, static validation, bounded whole-plan context |
| Guidelines, playbooks, lessons | Keep | Scope/precedence, lazy scaffolding, bounded selection |
| Dreamer | Keep/rewrite | Brain evidence, durable due watermark, host skill, candidate lifecycle, human promotion |
| Brain structured knowledge and graph | Keep/extend | Company Brain space, scopes/RLS, immutable source/citation lifecycle |
| S3 and retrieval primitives | Keep/refactor | Recoverable ingestion, privacy-aware indexes, quality evaluation |
| Founder skill sync | Keep/generalize | Vendor skill references, immutable pins/provenance, host aliases |
| Agent tool bindings | Replace | Workspace/function/agent/plan tool-use definitions |
| Context loading | Replace | One deterministic bounded bundle with explanations/citations |
| Evidence | Extract/rewrite | Small separate Brain evidence schema and S3 prefix |
| Human decisions | Small replacement | Action-digest-bound portable evidence, never execution authority |
| Schedule/cron/fire/state | Delete | Host-native scheduling uses normal Roster-backed session flow |
| General ops/queues/leases/outbox | Delete after extraction | Preserve only small reusable storage/idempotency primitives |
| Pending/review/Slack HITL | Delete after Dreamer replacement | Host interaction plus Brain candidate/decision state |
| Plan compiler/reducer proposal | Delete from spec/roadmap | Static plan validation; host interpretation |
| Provider route/health/fallback proposal | Delete from spec/roadmap | Vendor skills plus company-use guidance; host execution |
| Chief of Staff | Refactor | Host-facing scaffold assistant using deterministic verbs |
| Notion task state machine | Quarantine | Optional external tool integration, not Roster runtime |
| Second opinion | Quarantine | Repository/Forge development tooling |
| Tripwire | Optional | Report-only host defense, not a trust boundary |
| Gemini | Quarantine | Retain cheap interfaces only; no release commitment without demand |
| Doctor/update/migrate | Rewrite | v2 registry/context/Brain/evidence/Dreamer/adapter checks |

## Highest security and migration risks

- Consolidate every workspace read/write on one component-wise no-symlink path policy; current init/config/upgrade behavior is inconsistent.
- Bound Brain mount/FS paths or require an exact, host-obtained external path grant.
- Add `brain_space_id`, scope/privacy columns, RLS, and least-privilege roles; runtime roles cannot create tables.
- Require HTTPS/explicit trust for S3 endpoints and protect private/link-local access.
- Preserve actor assurance taxonomy; caller assertions are not host-attested facts.
- Make embeddings privacy-aware and never send secret-class chunks.
- Prefer immutable vendor skill pins with source/revision/hash/review provenance.
- Keep authored policy, vendor instructions, Brain evidence, and tool output structurally distinct against prompt injection.
- Replace `.env` materialization guidance with Infisical reference/injection guidance; migration prints key names only.
- Import legacy logs, approvals, candidates, and paths as unverified evidence/locators.
- Back up and fingerprint before migration; remove only exact Roster-managed cron blocks with consent.

## Corrected implementation approach

### Phase 1: host-led skeleton

Ratify the host ownership contract, build sparse registry/scaffold/discovery, statically validate plans and tool-use definitions, resolve one bounded seeded context bundle, generate thin adapters, and prove a seeded host-led loop with fake Brain/tool/Dreamer signals.

### Phase 2: real context and learning

Stabilize Brain identity/source lifecycle, split extraction/indexing, connect cited retrieval, prove real host tool use, connect live context, extract canonical evidence, implement Dreamer readiness/candidates/promotion/activation, evaluate context quality, and run real adopter workflows.

### Phase 3: breaking cutover and launch

Remove scheduling and general operations, harden Roster-owned security boundaries, eliminate adapter drift, decide optional retrieval features from evidence, build the one-way migrator and doctor, rehearse both adopters, and release.

## Required golden scenario

The first proof is `my-roster` Social Media Manager discovery:

1. Human asks Claude Code or Codex for current opportunities.
2. Host discovers the agent and complete plan.
3. Roster returns bounded company context, examples, guidelines, lessons, tool-use guidance, vendor skill refs, and immutable citations.
4. Host derives filters, invokes the appropriate vendor skill, and presents results.
5. Host records completed-run/artifact/feedback evidence.
6. Roster reports Dreamer due; host invokes Dreamer without a Roster schedule.
7. Human approves a cited lesson candidate.
8. A later context bundle includes that lesson.

The scenario must pass through both hosts and be repeated with a distinct `roster-lobu` workflow before launch.

## Investigation conclusion

Roster should become much smaller at the execution boundary but not conceptually hollow. The intended functions, plans, Brain, tools guidance, and Dreamer are the product. The unnecessary pieces are the second runtime wrapped around the host: scheduling, general operations, approval execution state, provider routing, and a proposed plan reducer.

Implementation must not begin against the superseded compiler/provider spec or the old #340 task graph. The product contract and tracker must first be rewritten around host interpretation and context activation.
