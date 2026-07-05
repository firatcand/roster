# Design: `roster second-opinion`

**Status:** approved (brainstorm) — pending implementation plan
**Date:** 2026-07-05
**Author:** brainstorm session (Firatcan + Claude)

## Summary

A generic "ask another model" capability for roster. It auto-spawns a **different**
AI CLI (Codex, Gemini, or Claude) in a fresh process to review any artifact —
writing, design, product docs, or code — and returns a structured verdict with a
graceful raw-text fallback.

It ports the *idea* of forge's `/second-opinion` (a fresh-process, cross-model,
honest reviewer) but **not** forge's implementation, which is welded to forge's
orchestrator (task claims, `ReviewVerdict` keyed to `CRITICAL.md`, git-diff-only,
`settings.agents.review_host_cli`). Roster has none of that machinery, so we adapt
the shape to roster's "thin skill over hardened CLI verb" architecture.

## Goals

- One command to get a second opinion on **any artifact** (files, piped text, or a
  git diff) from a model different than the one you're working with.
- Works for **writing, design, and product** feedback first — code is a supported
  side-effect, not the primary case.
- Structured, actionable output (prioritized findings) that still degrades to raw
  prose when the reviewer doesn't emit clean JSON.
- Stays on the user's **subscription** by construction (never silent API billing),
  even after the source audit that used to enforce this is relaxed.

## Non-goals

- No integration with a task/claim/lease state machine (forge's coupling). This is
  a standalone utility.
- No binary pass/fail "changes_requested" verdict — meaningless for prose.
- No config file / workspace requirement. It runs anywhere.
- Does **not** change the roster orchestrator's autonomous dispatch behavior:
  scheduled fires still use native in-host subagent primitives, never `claude -p`.

## Decisions (pinned during brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Review target | Generic — any artifact (file / stdin / diff) |
| 2 | Dispatch mechanism | Forge-style **auto-spawn** of the reviewer CLI, parse a structured verdict |
| 3 | Claude as reviewer | First-class via `claude -p` auto-spawn wrapper (not a special-case handoff) |
| 4 | Audit / billing | **Scoped exception + fail-closed preflight** (revised after Codex 2nd-pass — see §Second-opinion round 1). Ban STAYS (BAN_RULES + crontab scanner intact). A narrow audit opt-out marker covers ONLY the second-opinion claude adapter; a fail-closed `runClaudePreflight` refuses to spawn unless the child is provably on subscription. Env-scrub is defense-in-depth, not the sole guarantee. `claude api` + SDK imports stay banned. |
| 5 | Host selection | `--host` flag; smart default = first installed host **different** from the current one (via `detectTools()`) |
| 6 | Verdict shape | Structured findings + raw fallback, vocabulary generalized for non-code work |

## Surface

Workspace-optional utility (NOT gated on `config/project.yaml`, unlike most roster
verbs). Two pieces:

- **CLI verb** `roster second-opinion` — owns host selection, spawn, env-scrub,
  timeout, parse, render. Added to the `Subcommand` union + `--help` + dispatch in
  `src/bin/roster.ts`.
- **`/second-opinion` skill** (`skills/second-opinion/SKILL.md`) — chat front door.
  Owns prompt quality: gathers the artifact + the user's specific question, builds
  the review brief, calls the verb, renders the verdict. Ships to all three tools
  via the existing `installToTool` skills copy. No agent `.md` (it's a verb, not a
  dispatched subagent).

### Invocation

```
roster second-opinion [files...] \
  --host codex|gemini|claude \
  [--message "what to focus on"] \
  [--stdin] \
  [--diff] \
  [--json]
```

- Input sources: file paths, piped stdin (`--stdin`), and/or `--diff` (git diff of
  cwd). **At least one required.**
- `--host` optional. Split responsibility so cross-model is guaranteed where it
  can be:
  - The **skill** knows which tool it is running in, so it always passes `--host`
    set to the first installed host that **differs** from the current one → the
    interactive default is genuinely cross-model.
  - The **verb**, called directly with no `--host`, cannot know the caller's host.
    It defaults to the first installed host in a fixed priority order
    (`codex → gemini → claude`) and prints which host it picked. Direct callers who
    care about cross-model pass `--host` explicitly; scripting stays deterministic.
- `--message` is the reviewer's focus / the specific question ("is the hero copy
  burying the lede?"). Optional but strongly encouraged by the skill.
- `--json` emits the full envelope; default prints `summary` then findings grouped
  by severity.

## File layout

```
src/commands/second-opinion.ts          executeSecondOpinion → human + --json render
src/lib/second-opinion/
  run.ts             orchestrator: select host → build brief → preflight → spawn (brief on stdin) → parse
  adapters.ts        per-host argv + env-scrub + preflight hook: codex `exec`, gemini, claude `-p`
  claude-preflight.ts fail-closed subscription check for the claude adapter (mirrors runCodexPreflight)
  schema.ts          Zod envelope + sentinel-framed verdict extraction from stdout
src/lib/second-opinion-args.ts          parse flags (files / --host / --message / --stdin / --diff / --json)
skills/second-opinion/SKILL.md          chat front door (+ one-time data-egress notice)
```

Reuses: `detectTools()` / `getToolByKey` (`src/lib/tools.ts`) for hosts,
`runCodexPreflight` (`src/lib/codex-preflight.ts`) for the codex path (and its
pattern for the new `runClaudePreflight`), and the `spawn`-factory + `env`-override
**test seam** established by `src/lib/schedule-run.ts`. The brief travels via the
child's **stdin (written then closed)** — never argv (ps-visible; Codex 2nd-pass ④)
and never a temp file (implementation improvement over the drafted 0600-temp-file
approach: no on-disk artifact at all, and headless children need no file-read
permission; closing stdin avoids the FORGE-135 print-mode hang).

## Verdict schema

```ts
type Severity = 'major' | 'minor' | 'nit' | 'praise';

type Finding = {
  severity: Severity;
  message: string;
  location?: string;   // freeform: "hero section", "paragraph 2", or "src/foo.ts:42"
  confidence?: number; // 1-10
};

type SecondOpinionResult = {
  summary: string;
  findings: Finding[];
  raw: string;            // full reviewer stdout, ALWAYS kept
  host: 'codex' | 'gemini' | 'claude';
  structured: boolean;    // false when the model didn't emit clean JSON
                          //   → findings = [], raw holds the prose
};
```

- The wrapper's prompt asks the reviewer to wrap its verdict in a **unique
  sentinel** the wrapper generates per-run (e.g. `<<<RSO:{nonce}>>> … <<<END:{nonce}>>>`),
  with the json block inside (plus a word cap and "be direct"). `schema.ts`
  extracts the json **between the sentinels**, not "the last ```json block" — this
  defeats a reviewed artifact that itself contains a fenced json block trying to
  spoof the verdict (Codex 2nd-pass ③).
- Output is size-capped; stdout beyond the cap is truncated with the tail kept
  (the sentinel/verdict is emitted last).
- Parse failure / missing sentinel → `structured: false`, `findings: []`, `raw`
  preserved. **Never a hard error, and `structured:false` never implies "approved"**
  — it means "unstructured, read the raw." (roster's verdict has no pass/fail, so
  there is nothing to falsely read as a pass.)
- `--json` output is the whole envelope. Human output: `summary`, then findings
  grouped `major → minor → nit → praise`, each with confidence if present.

Rationale for the generalized vocabulary: a binary `pass|changes_requested` verdict
and `path:line` findings (forge's schema) are meaningless for an essay or a campaign
brief. `severity` spans prose and code; `location` is a freeform pointer; `praise`
keeps "what's working" from being discarded. The same shape serves code untouched
(`location` becomes `file:line`).

## Subscription safety (fail-closed preflight + defense-in-depth)

Env-scrub alone is **not** an airtight guarantee (Codex 2nd-pass ①): Claude Code
can also bill via an `apiKeyHelper` in `settings.json` (not an env var, so scrub
can't touch it) or via Bedrock/Vertex mode. So each adapter runs a **fail-closed
preflight** *before* spawn — refuse rather than risk a surprise API bill — with
env-scrub as a second layer:

| Host | Spawn | Fail-closed preflight (refuse unless…) | Env-scrub (defense-in-depth) |
|------|-------|----------------------------------------|------------------------------|
| claude | `claude -p` | new `runClaudePreflight`: no `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`; no `apiKeyHelper` in resolved settings.json; not `CLAUDE_CODE_USE_BEDROCK`/`_USE_VERTEX`; a subscription credential (OAuth/setup-token) is present | strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_*` key vars |
| codex | `codex exec` | existing `runCodexPreflight` | (preflight owns it) |
| gemini | headless gemini | check no `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_GENAI_*` API path; require an OAuth/CloudShell login | strip `GEMINI_API_KEY`, `GOOGLE_API_KEY` |

Preflight failure → `HOST_NOT_SUBSCRIPTION` (never spawns). This is the real
guarantee; env-scrub hardens the spawned env on top. The global source-audit ban
and crontab scanner **stay** — this feature is a *scoped, guarded exception*, not a
relaxation (see §Ban: scoped exception).

## Error model

Stable `code` values on the failure envelope (`ok: false`):

- `NO_INPUT` — no files, no `--stdin`, no `--diff`.
- `HOST_UNKNOWN` — `--host` not one of codex|gemini|claude.
- `HOST_NOT_INSTALLED` — requested/selected host CLI not detected.
- `BINARY_NOT_FOUND` — CLI resolved but not executable on PATH.
- `TIMEOUT` — reviewer exceeded the wall clock.
- `REVIEW_FAILED` — reviewer exited non-zero.
- `HOST_NOT_SUBSCRIPTION` — fail-closed preflight refused (API key / apiKeyHelper /
  Bedrock-Vertex detected, or no subscription credential). Never spawns.

(`structured: false` is **not** an error — it's a successful review the parser
couldn't structure.)

## Ban: scoped exception (not relaxation)

**Revised after Codex 2nd-pass ② — the ban STAYS.** `src/lib/audit.ts` `BAN_RULES`
is unchanged; the crontab scanner (`src/lib/migrate/scan.ts`) is unchanged. The
codebase-wide guard against surprise-billed headless calls stays intact. This
feature gets a **narrow, marked exception** instead:

1. **`src/lib/second-opinion/adapters.ts`** — the single line that spawns
   `claude -p` carries the existing per-rule opt-out marker
   `<!-- roster-audit-ok: claude-p-flag -->` (the audit's `OPT_OUT_MARKER` already
   supports per-line, per-rule suppression). Nothing else in `src/` is exempted.
2. **Guarded by `runClaudePreflight`** (see §Subscription safety) — the exception is
   only sound because the adapter fail-closes on any non-subscription auth path.
3. **`test/doctor-safety-audit.test.ts`** — UNCHANGED expectations for BAN_RULES.
   Add: (a) the second-opinion adapter line with the opt-out marker is **suppressed**
   (audit stays green); (b) a `claude -p` occurrence WITHOUT the marker still
   **fails** (guard still bites the rest of the codebase).
4. **`skills/roster-orchestrator/SKILL.md`** — the "Banned primitives" list stays.
   Add a one-line note: `claude -p` remains banned everywhere EXCEPT the
   `second-opinion` claude adapter, which is a sanctioned, preflight-guarded,
   **human-invoked** path (never autonomous / never a scheduled fire).
5. **Docs** — README install matrix + HOWTO section; `docs/roadmap.md`; CHANGELOG.
6. **New ADR** `docs/adr/0002-second-opinion-claude-adapter.md` — records why the
   scoped exception is sound (fail-closed preflight replaces the blanket ban *for
   this one path*), why the global ban + cron scanner were KEPT, and the residual
   risks considered (Codex round-1 findings + resolutions).

## Prompt construction (owned by the skill)

The skill builds a self-contained brief before calling the verb:

1. **Data-egress notice (first use)** — before the first dispatch, the skill states
   plainly what leaves the machine and to whom (claude→Anthropic, codex→OpenAI,
   gemini→Google) and confirms (Codex 2nd-pass ④). The reviewer sees the artifact
   contents.
2. **Context** — what the artifact is, who it's for.
3. **The artifact** — file paths / stdin / diff gathered by the verb; contents are
   embedded in the brief delimited as data-not-instructions, **never** argv.
4. **The ask** — the user's specific `--message` focus, as concrete questions.
5. **Output contract** — "return findings with `severity` + `confidence`, a short
   `summary`, wrap the json verdict between the per-run nonce sentinels
   `<<<ROSTER-VERDICT-{nonce}>>>` / `<<<END-ROSTER-VERDICT-{nonce}>>>`", plus a
   word cap and "be direct."

The verb delivers this brief on the child's stdin and closes the stream (never
argv — Codex 2nd-pass ④). The verb owns spawn + preflight + parse; the skill owns
*review quality* + egress consent.

## Testing (complete coverage)

- `second-opinion-args` — flag parsing, "at least one input" enforcement, unknown
  `--host` rejection, `--json`/`--message` handling.
- `adapters` — argv construction per host; env-scrub asserts the correct keys are
  stripped for each host and non-key env is preserved; brief never appears in argv.
- `claude-preflight` — fail-closed matrix: `ANTHROPIC_API_KEY` present → refuse;
  `apiKeyHelper` in settings → refuse; Bedrock/Vertex flag → refuse; no subscription
  credential → refuse; clean subscription env → pass.
- `run` — via the `spawn` test-seam (no real CLI): host-selection default (installed
  ≠ current), preflight refusal → `HOST_NOT_SUBSCRIPTION` (no spawn), `TIMEOUT`
  (child killed), `BINARY_NOT_FOUND`, non-zero exit → `REVIEW_FAILED`; brief written
  to stdin and the stream closed.
- `schema` — sentinel-framed json → parsed findings; missing sentinel / malformed →
  `structured:false` + `raw` preserved; an artifact that embeds a decoy ```json
  block outside the sentinels does **not** spoof the verdict; oversized stdout capped.
- `doctor-safety-audit` — BAN_RULES expectations UNCHANGED; the marked adapter line
  is suppressed (green); an unmarked `claude -p` still fails.
- Skill contract test in the style of roster's existing skill tests.

Phase gate before PR: `pnpm typecheck && pnpm build && pnpm test`.

## Second-opinion round 1 (Codex, on the plan — 2026-07-05)

Codex reviewed the plan+spec against the real source and returned
`changes_requested`. All four findings accepted; resolutions folded above:

- **① block — env-scrub not an airtight subscription guarantee** (misses
  `apiKeyHelper` in settings.json, Bedrock/Vertex). → Added fail-closed
  `runClaudePreflight`; env-scrub demoted to defense-in-depth.
- **② block — removing the global ban weakens the whole codebase.** → Reversed:
  ban + cron scanner KEPT; feature uses a narrow marked opt-out + preflight instead.
- **③ improvement — last-json parsing is spoofable/truncation-prone.** → Sentinel
  framing + output cap; `structured:false` never implies approval.
- **④ improvement — argv leaks private data; no egress consent.** → Brief delivered
  via 0600 temp file (not argv); one-time data-egress notice in the skill.

## Open items / follow-ups (out of scope for v1)

- Tracked as **ROS-155** (In Progress) / GitHub #300.
- Possible future: `roster second-opinion` reading a roster workspace's brain for
  extra context — deferred; keep v1 a pure utility.
- Possible future: a `--all-hosts` fan-out that asks every installed reviewer and
  diffs their verdicts — deferred.
- Follow-up review: re-run `/second-opinion` on the implementation diff at `/ship`
  (auto-triggers — CRITICAL.md paths), replaying this round's findings as the
  prior-round summary.
