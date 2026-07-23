# Files requiring multi-model review (/second-opinion auto-triggers on /ship)
# Roster is an npm CLI that writes to users' machines and ships to npm, so the
# critical paths are: install logic, scheduling (writes crontab / agent config),
# the scaffold copied into user workspaces, and the publish/release config.

# Tool detection + install into ~/.claude, ~/.codex, ~/.gemini
src/lib/install*.ts
src/lib/install-scope.ts
src/lib/tools.ts
src/lib/hook-install.ts

# Scheduling — writes to the user's crontab and agent config (subscription-safety)
src/lib/schedule-*.ts
src/lib/codex-*.ts
src/lib/cron-*.ts

# CLI entry + path resolution
src/bin/roster.ts
src/lib/paths.ts

# Copied verbatim into users' workspaces by `roster init`
templates/scaffold/**

# Persistence boundary — DB binding/grants, create-only object store, durable
# local ledger/outbox, setup journal (writes users' Postgres/S3/.roster/ops)
src/lib/persistence/**
src/commands/ops.ts
data/ops/schema/**

# npm publish allowlist + release CI (wrong = ships secrets or breaks install)
package.json
.github/workflows/**
