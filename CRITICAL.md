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

# V2 authored workspace policy, bounded discovery, and portable vendor-skill
# mapping — these paths decide which policy and project-local code reaches hosts
src/lib/workspace-*.ts
src/lib/internal/workspace-tool-use-snapshot.ts
src/lib/internal/workspace-update-lock.ts
src/lib/vendor-skills/**
src/lib/authored-secret-detector.ts
src/lib/founder-skills/lockfile.ts
src/lib/founder-skills/manifest-schema.ts
src/lib/founder-skills/sync.ts
src/commands/update.ts

# Copied verbatim into users' workspaces by `roster init`
templates/scaffold/**

# Persistence boundary — DB binding/grants, create-only object store, durable
# local ledger/outbox, setup journal (writes users' Postgres/S3/.roster/ops)
src/lib/persistence/**
src/commands/ops.ts
data/ops/schema/**

# Run + artifact ledger (#323) — trust taxonomy, sealed provenance, sanitized
# index projections, and the admin-only version-id repair (mutates users' ops DB)
src/commands/run.ts
src/lib/run-args.ts
src/lib/persistence/run-events.ts
src/lib/persistence/run-compose.ts
src/lib/persistence/run-repair.ts
src/lib/persistence/sanitize-index.ts
src/lib/persistence/artifact-declarations.ts

# HITL state machine (#319) — the approval authority predicate, the insert-only
# generation/version identity, the DB-enforced decision trigger, and the local
# v1->v2 conversion barrier (a bug here authorizes an action nobody approved)
src/lib/persistence/hitl-machine.ts
src/lib/persistence/hitl-store.ts
src/lib/persistence/hitl-sweep.ts
src/lib/persistence/hitl-local-migrate.ts
src/lib/persistence/hitl-local-records.ts
data/ops/schema/hitl/**

# npm publish allowlist + release CI (wrong = ships secrets or breaks install)
package.json
.github/workflows/**
