# Host activation fixtures

These fixtures are isolated project roots for opt-in live host probes. They do
not contain nested Git metadata. The probe harness copies each fixture to a
temporary directory and initializes the copy before invoking a host.

The checked-in attestations were recorded on these exact CLI patches:

| Fixture | Host/version | Auto-load result | Shared `ROSTER.md` pointer result |
|---|---|---|---|
| `claude-project` | Claude Code `2.1.220` | `ROSTER_CLAUDE_PROJECT_LOADED` | `ROSTER_CLAUDE_PROJECT_SHARED_LIFECYCLE_LOADED` |
| `claude-rule` | Claude Code `2.1.220` | `ROSTER_CLAUDE_RULE_LOADED` | `ROSTER_CLAUDE_RULE_SHARED_LIFECYCLE_LOADED` |
| `codex-project` | codex-cli `0.144.1` | `ROSTER_CODEX_PROJECT_LOADED` | `ROSTER_CODEX_PROJECT_SHARED_LIFECYCLE_LOADED` |

The auto-load probe proves that the host reads the activation path. The pointer
probe gives the wrapper only an instruction to read `ROSTER.md`; the exact
answer exists only in that shared file. Together they prove lifecycle
reachability on the listed patch, not that a model will obey an entire business
workflow.

Both probes passed on the exact versions above on 2026-08-02. The checked-in
`CHECKED_IN_HOST_ATTESTATIONS` records bind both fixture files by SHA-256 and
label their proof scope as activation plus shared-lifecycle reachability. They
do not claim broader workflow obedience.

Run the opt-in repeatability gate with ambient host authentication:

```sh
ROSTER_HOST_ACTIVATION_SMOKE=1 node --test --experimental-strip-types test/host-activation-live.test.ts
```

Normal tests and npm lifecycle commands never invoke a host model.
