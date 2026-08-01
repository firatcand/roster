# Host activation fixtures

These fixtures are isolated project roots for opt-in live host probes. They do
not contain nested Git metadata. The probe harness copies each fixture to a
temporary directory and initializes the copy before invoking a host.

The checked-in attestations were recorded on these exact CLI patches:

| Fixture | Host command | Exact result |
|---|---|---|
| `claude-project` | `claude -p --model haiku --output-format text ROSTER_ACTIVATION_FIXTURE` with Claude Code `2.1.220` | `ROSTER_CLAUDE_PROJECT_LOADED` |
| `claude-rule` | `claude -p --model haiku --output-format text ROSTER_ACTIVATION_FIXTURE` with Claude Code `2.1.220` | `ROSTER_CLAUDE_RULE_LOADED` |
| `codex-project` | `codex exec --skip-git-repo-check --sandbox read-only --color never ROSTER_ACTIVATION_FIXTURE` with codex-cli `0.144.1` | `ROSTER_CODEX_PROJECT_LOADED` |

Run the opt-in repeatability gate with ambient host authentication:

```sh
ROSTER_HOST_ACTIVATION_SMOKE=1 node --test --experimental-strip-types test/host-activation-live.test.ts
```

Normal tests and npm lifecycle commands never invoke a host model.
