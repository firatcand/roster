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
- `claude-plugin/` is the only local plugin passed to Claude with
  `--plugin-dir`.
- `codex-project/` is copied into the fresh Codex project root so Codex can
  discover the same skills through `.agents/skills`.
- Expected semantic bytes live outside the copied host corpus and are available
  only to the harness after a host run completes.

The delivered Claude and Codex skill files must remain byte-identical to their
corresponding files under `common/skills/`. The local plugin is loaded
explicitly; the harness never manufactures or copies Claude trust state.

## Proof boundary

Deterministic tests run in normal CI and verify fixture closure, product
primitives, durable replay behavior, skill parity, and attestation freshness.
Authenticated host calls are opt-in and never run from install, package, smoke,
or ordinary test scripts.

Final behavior bytes require one certification consisting of three consecutive
Claude Code 2.1.220 passes and three consecutive Codex CLI 0.144.1 passes. Each
pass uses an independent git-initialized workspace and two fresh host
processes. The executable proof runs on macOS and binds those exact host
versions. No process, model, infrastructure, or semantic failure is retried
automatically: any failure aborts the attempt, and certification restarts all
six passes in a new root on one unchanged final byte set.

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
`debug prompt-input` probe. For Codex 0.144.1, the probe accepts exactly five
messages: permissions and the exact eight-skill inventory (five system, the
generated Roster skill, and two fixture skills), the exact sandbox-canary
developer instruction, two binary-owned developer contributions, workspace
instructions/environment, and the literal request.
The debug subcommand rejects `--strict-config` and cannot accept paid
`exec`-only flags. The launch contract records that exact limitation; the probe
derives its global arguments from the paid launch by removing only the single
unsupported `--strict-config` argument, while the paid-only flag set is closed
and attested. The probe therefore proves the exact configurable prompt
contributions without claiming byte-identical command lines.
Discovery and approval are probed separately. Every plugin, skill, prompt, and
sandbox probe uses its own clean home/config/temp roots and never shares host
state with a paid turn.

Context commands retain the complete seeded Roster result as the integrity
source, while the test adapter exposes a closed actionable projection to the
host. The projection carries the full raw-context digest and every controlled
JSON result is rehearsed below 28,000 JavaScript characters before a paid
turn. Claude also receives `BASH_MAX_OUTPUT_LENGTH=150000` as defense against
its first Bash limiter; the projection is what stays below its independent
foreground-result persistence ceiling.

The exact model versions, binary hashes, Node version, non-secret launch
configuration, run date, input manifest, and normalized outcomes belong only in
`test/attestations/host-led-learning.json`. Raw transcripts, absolute machine
paths, session identifiers, API keys, and adapter output never belong in the
checked-in corpus or attestation.

Run the live certification only with secrets injected by the caller's secret
manager:

```sh
ROSTER_HOST_LED_LOOP_SMOKE=1 \
  node --test --test-concurrency=1 --experimental-strip-types \
  test/host-led-learning-live.test.ts
```
