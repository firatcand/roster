# ADR-0002: Scoped `claude -p` exception for the second-opinion claude adapter <!-- roster-audit-ok: claude-p-flag -->

**Status:** Accepted
**Date:** 2026-07-05
**Deciders:** Firat (project owner)
**Relates to:** ADR-0001 (subscription-only billing), ROS-155

## Context

ROS-155 adds `roster second-opinion`: a verb that spawns a *different* AI CLI
(codex | gemini | claude) in a fresh process to review an artifact and return a
structured verdict. For claude as a reviewer host, the only headless invocation
is print mode — the flag banned globally by the ADR-0001 subscription guarantee
and enforced by the static audit (`src/lib/audit.ts` BAN_RULES, `roster doctor`,
CI) and the crontab scanner (`src/lib/migrate/scan.ts`).

The ban exists to prevent one failure mode: **an invocation that silently bills
an API key or the Agent SDK credit pool instead of the user's subscription.**
The original design for ROS-155 proposed relaxing the ban globally and relying
on env-var scrubbing. A Codex second-opinion review of that plan (2026-07-05)
rejected it with two blocking findings:

1. Env-scrub is not an airtight billing guarantee — `claude` can still reach
   API billing via an `apiKeyHelper` in `settings.json` (not an env var) or
   Bedrock/Vertex mode.
2. Removing the global ban weakens protection for the entire codebase and
   reintroduces the unattended-billing risk ADR-0001 was written to prevent.

## Decision

**Keep the global ban. Grant one marked, preflight-guarded exception.**

- `BAN_RULES` and the crontab scanner are **unchanged**. Any new occurrence of
  the banned literals anywhere in shipped source still fails `roster doctor`
  and CI.
- The single sanctioned spawn site — the claude adapter in
  `src/lib/second-opinion/adapters.ts` — carries the existing per-line,
  per-rule opt-out marker (`roster-audit-ok: claude-p-flag`), the same
  mechanism doc mentions of the literal already use.
- The exception is sound only because it is **fail-closed**: before spawning,
  `runClaudePreflight` (`src/lib/second-opinion/claude-preflight.ts`) refuses —
  error `HOST_NOT_SUBSCRIPTION`, child never spawns — unless ALL hold:
  - `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are unset;
  - no `apiKeyHelper` in `~/.claude/settings.json` or the spawn cwd's
    `.claude/settings.json` / `.claude/settings.local.json` (unreadable or
    malformed settings also refuse — cannot-verify fails closed);
  - `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` are not enabled;
  - a subscription OAuth credential is present (`oauthAccount` in
    `~/.claude.json`, the credentials file, or the Keychain seam).
- Defense-in-depth on top of the preflight: the child env is scrubbed of
  `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and the Bedrock/Vertex flags,
  and the review brief travels via stdin (never argv, never a temp file).
- The path is **human-invoked only**. Scheduled/autonomous dispatch is
  untouched: the orchestrator still uses native in-host subagent primitives
  and never print mode (ADR-0001 unchanged on that axis).

The codex and gemini adapters get the same treatment with their own gates:
codex reuses `runCodexPreflight` (ROS-36); gemini refuses on
`GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_GENAI_USE_VERTEXAI` and requires
`~/.gemini/oauth_creds.json`.

## Options considered

1. **Relax the ban globally, rely on env-scrub** (original plan) — rejected per
   the Codex findings above: scrub misses `apiKeyHelper`/Bedrock/Vertex, and
   the whole codebase loses its guard.
2. **Interactive hand-off instead of spawning** (render a prompt, user pastes
   it into the other tool) — subscription-safe by construction but manual and
   multi-step; rejected as the primary UX, though `HOST_NOT_SUBSCRIPTION`
   refusals effectively degrade to "fix env or switch host".
3. **Scoped exception + fail-closed preflight** — chosen. Narrowest change
   that ships a true cross-model reviewer; the residual risk is a preflight
   bypass bug, which is covered by a fail-closed test matrix
   (`test/second-opinion-claude-preflight.test.ts`).

## Consequences

- The subscription guarantee's enforcement for this one path moves from
  "the literal cannot appear in source" to "the spawn site is provably gated".
  The audit still pins that no *unmarked* occurrence can ship, and the
  clean-tree audit test keeps the marked set auditable (any new marker shows
  up in review as a diff to a test-pinned file set).
- `roster doctor` and CI behavior are unchanged for the rest of the codebase.
- If Anthropic changes print-mode billing or credential layout, the preflight
  (not the ban) is the single place to update; its checks are unit-tested
  individually.
- The `/second-opinion` skill instructs agents to never work around a
  preflight refusal (no API-key exports, no direct CLI invocation).

## References

- ADR-0001 §Hard requirements #1 (subscription-only billing)
- ROS-155 + Codex second-opinion round 1 findings (Linear comment, 2026-07-05)
- `docs/superpowers/specs/2026-07-05-roster-second-opinion-design.md`
