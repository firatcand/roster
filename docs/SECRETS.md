# Secrets

Roster reads secrets from a workspace `.env` file (and optional per-agent `<agent>/.env` overrides). It does **not** integrate with any secret manager directly — and it doesn't need to. 1Password, Infisical, Vault, Doppler, and anything else that can emit environment variables compose cleanly with roster by **materializing** secrets into the `.env` files roster already reads.

This page is the supported recipe set. The one rule that matters: **render secrets into a file; never inject them into the process that launches roster's scheduled runs.** The "Why `op run` is unsafe here" section explains the trap.

## What roster already protects

Before reaching for a vault, know what the `.env` model already gives you:

- **`0600` enforcement** — `roster doctor` fails if `.env` (workspace or per-agent) is group/world-readable, and `--fix` chmods it.
- **Gitignored by default** — `roster init` adds `/.env` and `**/.env` to `.gitignore`.
- **Reference checks** — `roster doctor` errors if an agent's `config.yaml` names a key that resolves to unset, and warns on redundant per-agent redeclarations.
- **Hardcoded-secret scan** — `roster doctor` scans templates for leaked literals (`sk-…`, `AKIA…`, `ghp_…`, etc.).
- **Prompt-leak audit** — warns if a secret key is referenced in a visible schedule prompt.
- **Scheduled-run env scrubbing** — Codex cron jobs run under `/usr/bin/env -i`, forwarding only `HOME`, `PATH`, `CODEX_HOME`. See [SCHEDULING.md § Subscription-billing guarantees](SCHEDULING.md#subscription-billing-guarantees).

A vault adds **rotation, revocation, centralized access control, and audit logs** on top of this. It does **not** eliminate plaintext at rest for unattended runs — see "Headless / cron" below.

## 1Password

Keep a **template** file with `op://` references (safe to commit — it holds pointers, not secrets):

```bash
# .env.tpl  — commit this
LINEAR_API_KEY=op://Work/Linear/api_key
SLACK_BOT_TOKEN=op://Work/Slack/bot_token
```

Render it into the `.env` roster reads:

```bash
op inject -i .env.tpl -o .env    # output file is mode 0600 by default
```

`op inject` replaces each `op://vault/item/field` reference with the live secret. Re-run it whenever you rotate a secret. Per-agent overrides work the same way — keep a `<agent>/.env.tpl` and inject it to `<agent>/.env`.

Headless (cron, no biometric prompt) uses a **service account**:

```bash
export OP_SERVICE_ACCOUNT_TOKEN='ops_…'   # see "Headless / cron" for where this lives
op inject -i .env.tpl -o .env
```

## Infisical

Export your project's secrets straight to dotenv:

```bash
infisical export --format dotenv > .env && chmod 600 .env
# or: infisical export --format dotenv -o .env --env prod
```

Re-run on rotation. For per-agent overrides, export a different environment/scope into `<agent>/.env`.

Headless uses a **machine identity** (universal-auth) token:

```bash
export INFISICAL_TOKEN="$(infisical login --method=universal-auth \
  --client-id=… --client-secret=… --silent --plain)"
infisical export --format dotenv > .env && chmod 600 .env
```

## Why `op run` / `infisical run` is unsafe here

Both CLIs offer a *wrap* mode that injects secrets into the **environment** of a subprocess:

```bash
op run --env-file .env.tpl -- <command>      # ❌ do not wrap roster's scheduled runs
infisical run -- <command>                   # ❌ same
```

Do **not** wrap roster's Codex invocations (interactive or scheduled) this way. Roster deliberately scrubs the environment with `/usr/bin/env -i` so that a model-provider key in your shell can't silently switch Codex from your flat-rate subscription to per-token API billing. `op run` / `infisical run` defeat that: if your vault holds an `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `CODEX_API_KEY`, the wrapper injects it straight into the Codex process —

- at install time, it trips `codex-preflight` (the run is refused), or
- injected only at cron runtime, it **bypasses** install-time preflight and re-creates the silent billing leak the scrubbing exists to prevent.

`op inject` / `infisical export` write to a **file**, so they sidestep this entirely — the secrets land in `.env`, roster reads them at dispatch time, and the scrubbed cron environment stays scrubbed.

> **Keep model-provider keys out of the rendered `.env` used by scheduled Codex runs.** `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `CODEX_API_KEY` are blocklisted by `codex-preflight`. Put business-tool secrets (Linear, Slack, Apollo, …) in `.env`; leave model auth to Codex's own subscription login.

## Headless / cron: the honest caveat

Unattended rendering needs the vault's **own** credential available without a human — an `OP_SERVICE_ACCOUNT_TOKEN` or an Infisical machine-identity token. That bootstrap secret has to live *somewhere* the cron job can read: typically a `0600` file or an OS keychain.

So for the cron path, at-rest exposure is **roughly equal to today's `0600 .env`**: anyone who can read the bootstrap token can fetch everything downstream. What you still gain over a plain `.env` is real and worth it — **rotation, revocation, scoped access, and audit logs** — just not "zero plaintext on disk." Choose a vault for those operational properties, not for a local at-rest guarantee it can't provide here.

## Why not a native integration?

Decided in ROS-124. A per-provider integration (op/infisical/vault/doppler/aws-sm adapters, CLI/auth-mode drift, per-provider `doctor` checks) is disproportionate maintenance for a single-maintainer CLI, and — per the caveat above — buys little at-rest security for the unattended path that matters most. Keeping `.env` as roster's stable contract lets every secret manager compose today, with no roster release coupling. If demand for a paved-road integration grows, the future direction is a single generic dispatch-time `secrets.exec` hook (run a user-provided command, parse stdout as dotenv) — not a provider matrix.
