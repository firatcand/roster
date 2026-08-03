# Host-led learning fixture

This corpus supports issue #350's seeded proof that Claude Code and Codex can
interpret the same Roster workspace, use controlled test adapters, persist a
fixture-only learning state, wait for a human decision, and observe one later
lesson in context.

Everything in this directory is test-only. It is not a production Brain,
Dreamer, provider, approval, scheduling, or execution contract. The fixture
commands, identifiers, state fields, watermark behavior, and plugin are
non-normative examples. `test/` is outside the package allowlist.

## Layout

- `common/` contains the host-readable requests, untrusted data, separate
  closed discovery/approval output schemas, launch contract, and canonical
  skill bytes.
- `claude-plugin/` is the only fixture plugin passed to Claude explicitly with
  `--plugin-dir`; host-owned personal state remains outside the fixture.
- `codex-project/` is copied into the fresh Codex project root so Codex can
  discover the same skills through `.agents/skills`.
- Expected semantic bytes live outside the copied host corpus and are available
  only to the harness after a host run completes.

The delivered Claude and Codex skill files must remain byte-identical to their
corresponding files under `common/skills/`. The local plugin is loaded
explicitly. The harness uses the adopter's existing logged-in host profile; it
never manufactures or copies Claude or Codex trust/auth state. The hosts and
their probes may transiently inspect ambient contributions, and the harness's
`ProcessCapture` hashes captured output in memory. The attestation retains only
the sanitized host-auth projection and controlled or required proof hashes; it
does not persist raw personal state or treat personal state as authority.

## Proof boundary

Deterministic tests run in normal CI and verify fixture closure, product
primitives, durable replay behavior, skill parity, and attestation freshness.
Authenticated host calls are opt-in and never run from install, package, smoke,
or ordinary test scripts. Live certification uses the `ambient-auth-v1`
profile: Claude authenticates through the installed host's existing
`claude.ai` first-party login and Codex through its existing ChatGPT login.
Roster injects no Anthropic, OpenAI, or Codex model-provider API key.

Personal settings, plugins, cache, browser state, and other host-owned state
may exist and may change independently. This seeded fake-tool proof consumes
only host authentication/cache lookup; other personal dependencies are
tolerated but deliberately not required or granted authority in the paid
session. Codex and model-free probes may transiently inspect ambient
contributions as part of normal host operation, but the harness does not copy
or recursively scan them. Captured process output is transiently hashed, so
the proof does not claim that no derivative of personal state can exist. Raw
personal state is never persisted, and neither personal state nor its
contributions can satisfy a required fixture skill, workspace instruction,
sandbox control, or action-trace assertion. Managed or enterprise settings
remain fail-closed because they can add hooks or permissions that the session
envelope cannot safely ignore. Later real vendor/browser certification may
declare the exact personal plugins, KState, browser login, and tool credentials
it depends on without making those inputs Roster policy authority.

Provider variables may exist in the launching shell for other purposes, such
as Brain embeddings. Every Claude/Codex child environment is rebuilt from an
allowlist and still rejects Anthropic/OpenAI model credentials or routing
overrides. Authentication is proven from the host's first-party account state.

Final behavior bytes require one certification consisting of three consecutive
Claude Code 2.1.220 passes and three consecutive Codex CLI 0.144.1 passes. Each
pass uses an independent git-initialized workspace and two fresh host
processes, while authentication and host-owned cache lookup come from the same
ambient adopter profile. The executable proof runs on macOS and binds those
exact host versions. It proves the loop for that profile, not for every
personal configuration or browser/vendor workflow. No process, model,
infrastructure, or semantic failure is retried automatically. Durable artifact
equality is checked after every pass so drift aborts before another paid host
runs. Any failure still restarts all six passes in a new root on one unchanged
final byte set.

Discovery shows the human the full pending candidate: its closed neutral
meaning fields, deterministically rendered recommendation and falsification
wording, citations, and content hash. Approval is a fresh interaction. It reads
the durable `pending_candidate` projection and completed run's bounded
`reviewed_query`, must observe the same record and hash before promotion, and
must reuse the exact reviewed query when resolving context. The approval result
intentionally omits the prior shortlist and Brain diagnostics; those belong
only to discovery.

Claude receives each human request through stdin. Codex receives each request
as one positional prompt in both its paid turn and its matching model-free
`debug prompt-input` probe. The Codex probe must contain the ordered required
subset exactly once: permissions, the exact sandbox-canary instruction, the
generated Roster skill and two fixture skills at their exact repo paths and
bytes, binary collaboration/multi-agent contributions, canonical workspace
instructions, the controlled environment contribution, and the final literal
human request. Ambient system/user skill summaries may add contributions, but
they cannot replace, duplicate, reorder, or shadow the required subset.

The debug subcommand rejects `--strict-config` and cannot accept paid
`exec`-only flags. It also cannot use paid `--ignore-user-config`, so its user
configuration regime is deliberately broader than the paid turn. The launch
contract records that delta and limits the model-free result to a
one-directional required-subset proof; it does not claim byte-identical command
lines or complete prompt equality. Discovery and approval are probed
separately. Auth status, Codex skill discovery, and prompt probes use the
ambient host lookup with independent workspaces and temporary directories;
binary/help and Claude fixture-plugin validation remain hermetic. No probe
shares fixture state with a paid interaction. Probe output is inspected and
hashed transiently; only sanitized authentication and controlled or required
proofs may be retained in the attestation.

The paid session still has a closed side-effect envelope. Claude uses
project-only settings, strict empty MCP, no Chrome, no session persistence,
identity-scoped fixture skills, and controlled Bash adapters. Codex ignores
user configuration and rules, disables deliberate history persistence, and
uses the workspace-write/no-network sandbox. Both hosts must prove denied
outside-workspace writes and network access before the workflow. The ambient
home is never a sandbox writable root.

Claude Code 2.1.220 may emit one `rate_limit_event` even when a request
succeeds. Certification accepts only its exact closed structure with
`status: allowed`; malformed, duplicate, or non-allowed events fail. The event
is discarded before normalized trace hashing so its session and account
telemetry cannot enter the attestation.

Long xhigh turns may also emit `system` / `thinking_tokens` frames. Claude's
version-matched SDK classifies these approximate counters as ephemeral UI
progress rather than billed usage or workflow evidence. Certification accepts
only the exact six-field shape, nonempty identities, nonnegative safe-integer
counts, and at most 4,096 frames per turn. It erases them before assigning
normalized event ordinals or hashing the trace; malformed, extended, or
pathologically numerous frames fail closed.

Context commands retain the complete seeded Roster result as the local
integrity source, while the test adapter exposes the closed `host-context.v2`
projection to the host. The adapter validates the complete raw result before
encoding fixed sparse rows. The attested fixture skill supplies the row legend,
so removing repeated keys, hash prefixes, target-relative prefixes, and common
citation values does not remove plan meaning. Exact agent and plan hashes,
source revisions, effective policy, trust and scope, tool-resolution proof,
Brain citations, skill pins, budget/exclusion completeness, and the full
raw-context digest remain reconstructable. No controlled JSON result may exceed
8,000 JavaScript characters, and model-free rehearsal caps all ten controlled
results together at 25,000 characters before a paid turn. The exact seeded
pre-promotion context measures 7,363 characters. The complete rehearsal
measures 7,890 characters at maximum and 22,648 characters across all ten
outputs for either host. The controlled search result uses a self-describing
column/row projection that reconstructs every raw source value exactly while
removing repeated keys. The approval state response carries status, the exact
pending candidate and hash, and the persisted reviewed query; the complete
durable store is verified separately instead of being duplicated for the model.

Claude receives `BASH_MAX_OUTPUT_LENGTH=150000` as defense against its first
Bash stdout limiter. Claude Code 2.1.220 has a separate foreground-result
persistence threshold that may be changed by the logged-in account profile;
the compact wire projection provides margin below that independent boundary.

Claude's native `Skill` lifecycle is treated as an exclusive three-event
barrier: one Skill call, its exact `Launching skill: <identity>` result, then a
synthetic user-text expansion containing the resolved skill directory and the
skill body without frontmatter. The certification reconstructs and validates
those exact bytes only for the approved fixture skill call before another
action may appear, then erases the text and path into a content-free identity
marker. All three events must remain in the initialized root session, use
bounded control-free correlation IDs, and carry distinct event UUIDs. The call
also proves native direct-caller provenance, and the result's closed metadata
must name the same skill and report success. Cross-session or replayed event
envelopes and other user-text events are not accepted as Skill output.
Every actionable Claude call and result also has to remain in that initialized
root session with a null parent, valid role/timestamp, and unique event UUID.
Current and legacy persisted/truncated wrappers remain certification failures:
the harness never follows a host-owned saved-output path as a substitute for
model-visible bytes.

The exact model versions, binary hashes, Node version, non-secret controlled
launch policy, sanitized host-auth projection, curated child-environment key
set hashes, run date, input manifest, and normalized outcomes belong only in
`test/attestations/host-led-learning.json`. Raw auth-status output, account or
organization identity, raw personal config/cache/plugin contents, recursive
personal-state manifests, transcripts, absolute machine paths, session
identifiers, API keys, and adapter output never belong in the checked-in corpus
or attestation.

Run the live certification only after both exact hosts are already logged in.
Do not wrap this command in a model-provider secret injection mechanism; the
harness rejects provider credentials and switches:

```sh
ROSTER_HOST_LED_LOOP_SMOKE=1 \
  node --test --test-concurrency=1 --experimental-strip-types \
  test/host-led-learning-live.test.ts
```
