---
name: second-opinion
description: "Get an honest second opinion on any artifact — writing, design docs, product specs, or code — from a DIFFERENT AI model in a fresh process. Builds a review brief and dispatches it via `roster second-opinion` to the codex/gemini/claude CLI (whichever differs from the current host), then renders the structured verdict. Triggers on /second-opinion or when the user asks for another model's take / a cross-model review / fresh eyes on a draft, plan, or diff."
version: "1.0.0"
trigger_conditions:
  - "User invokes /second-opinion"
  - "User asks for a second opinion, another model's take, or fresh eyes on an artifact"
---

# second-opinion

Ask a **different** AI to review something — in a separate process, with its own model and no memory of this conversation. That independence is the point: the reviewer can't be primed by what you (or I) already concluded, so it catches what an agent inheriting this chat's context would rationalize away.

Works on anything: an essay draft, landing-page copy, a PRD, a design doc, a plan, a code diff. The engine is `roster second-opinion`; this skill is the chat front door that owns brief quality and host choice.

## Data-egress notice (first use per session)

Before the FIRST dispatch in a session, state plainly and get a go-ahead:

> This sends the artifact to the reviewer's provider — codex → OpenAI, gemini → Google, claude → Anthropic — under your own logged-in subscription for that tool. OK to proceed?

Skip the notice on subsequent dispatches in the same session unless the target host changes.

## Host selection (always pass --host)

You know which tool you are running in; the CLI does not. Always pass `--host` set to the **first installed host that differs from the current one**, so the default is genuinely cross-model:

| Running in | Try in order |
|------------|--------------|
| Claude Code | `codex`, then `gemini` |
| Codex CLI | `claude`, then `gemini` |
| Gemini CLI | `codex`, then `claude` |

Check installs with `roster doctor --json` (or just try; `HOST_NOT_INSTALLED` / `BINARY_NOT_FOUND` name the fix). The user can override with an explicit host request — honor it, including same-model (fresh context still has value; say so).

## Building the dispatch

1. **Identify the artifact(s).** A file path is best (`--stdin` for pasted text, `--diff [ref]` for working-tree changes). Never re-type the artifact into the prompt — the CLI reads it.
2. **Sharpen the ask.** Turn the user's request into 2-4 concrete review questions and pass them via `--message`. "Review this" produces mush; "Does the intro bury the lede? Is the pricing section credible to a CFO?" produces findings.
3. **Dispatch:**

```bash
roster second-opinion draft.md --host codex \
  --message "1) Does the intro bury the lede? 2) Is the tone right for CTOs? 3) What would you cut?" \
  --json
```

Use `--json` and render the verdict yourself (below). Add `--timeout <sec>` for large artifacts (default 180).

## Rendering the verdict

From the JSON envelope:

- Lead with `summary`.
- Then findings grouped `major → minor → nit → praise`, each with its `location` and `confidence` when present.
- `structured: false` means the reviewer answered in prose — show `raw` and say it's unstructured. **It does not mean approval.**
- On `ok: false`, show `message` and each failure's `remedy` verbatim — especially `HOST_NOT_SUBSCRIPTION`, which means the preflight refused to spawn so nothing bills an API key. Do not work around a preflight refusal; fix the environment or pick another host.

## Evaluation discipline

Not every finding is right. Coach the user (or apply, if you're driving):

- **Factual/consistency findings** — usually real; act.
- **Taste findings** (tone, structure) — weigh against the artifact's audience; the reviewer doesn't know it.
- **"You should also do X"** scope findings — defer unless blocking.
- Cite adopted findings as "<host> 2nd-pass: …" so reasoning stays traceable.

## Subscription safety (do not bypass)

The CLI fail-closes: each host has a preflight that refuses to spawn unless the child is provably on the user's logged-in subscription (no API keys in env, no apiKeyHelper, no Bedrock/Vertex). Never route around it — never invoke reviewer CLIs directly with API-key env vars, and never suggest exporting a key to "make it work". If the preflight refuses, surface the remedies and stop.

## Failure modes

- **`roster` not on PATH** → `npm i -g @firatcand/roster`.
- **`HOST_NOT_INSTALLED` / `BINARY_NOT_FOUND`** → offer a different `--host` or the tool's install link.
- **`HOST_NOT_SUBSCRIPTION`** → show remedies verbatim; suggest another host meanwhile.
- **`TIMEOUT`** → retry with `--timeout 360` or a smaller artifact.
- **Reviewer returns nothing useful** → re-dispatch once with sharper `--message` questions; then report honestly.
