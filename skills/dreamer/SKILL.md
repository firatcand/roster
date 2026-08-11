---
name: dreamer
description: "Reflection skill. When roster dream status reports due, reads the bounded readiness snapshot, drafts cited lesson candidates into the Brain, presents them to the human, and — only after the human decides — promotes, rejects, or retires them. The approved lesson becomes a file in the agent's playbook. Triggers when the user invokes /dreamer, when Roster reports the workspace is due, or when the user asks to consolidate lessons from past work."
version: "2.0.0"
trigger_conditions:
  - "User invokes the /dreamer slash command"
  - "roster dream status reports due for a scope"
  - "User asks to consolidate lessons, draft lessons from recent feedback, or review candidate lessons"
  - "User asks why an agent is or isn't learning, or how a lesson got promoted"
---

# Dreamer

You are the reflection pass. You read durable evidence, draft cited lesson
candidates, present them, and act on what the human decides. You never decide.

Roster stores and verifies; you reason. There is no scheduler, no queue, and no
approval engine anywhere in this loop — you are the runtime, and the human is the
authority.

## The loop

```text
roster dream status            -> due | not_due over observed evidence
roster dream candidates create -> a cited draft, stored in the Brain
(present it; the human answers)
roster brain record decision   -> the human's answer, durably
roster dream candidates promote|reject|retire
                               -> the approved lesson becomes a playbook file
```

Check `roster dream status` after recording evidence and at the start of a
session. When it reports `not_due`, stop — say why (the reasons are in the
output) and do nothing else.

## 1. Read the snapshot

```
roster dream status --json                 # workspace scope
roster dream status --agent gtm/sdr --json # one agent's scope
```

The output is a bounded snapshot. **Carry it verbatim into the draft** —
`readiness_key`, `policy.version`, `policy.fingerprint`, `watermark.ordinal`,
`frontier.ordinal`, and both consumed counts (`evidence.completed_runs` and
`evidence.feedback_records`). Do not recompute or round any of them. Roster
re-derives the readiness key from those fields and refuses a draft whose key does
not follow from its own snapshot.

## 2. Read the evidence you may cite

Query the Brain for the completed runs and feedback inside that snapshot. Two
rules are absolute:

- **Never cite your own runs, and never cite `dreamer` runs.** Reflection output
  cannot be independent evidence for itself. Roster refuses these regardless of
  policy — no policy edit can relax it.
- **Cite only compatible privacy classes.** `secret`-class evidence can never
  support a lesson, because a promoted lesson becomes a plaintext Git file. An
  `internal` citation needs an `internal` candidate.

## 3. Check for siblings before drafting

```
roster dream candidates list --json
```

Read the warnings. `SAME_LESSON_FILE` means another candidate targets the same
playbook file — both cannot be promoted. If that sibling is **open and shares
this candidate's exact occasion and target spelling**, supersede it with
`--supersedes`. Otherwise reject one of the siblings, or retire the promoted one
first. `SAME_LESSON_ID_OTHER_AGENT` names a genuinely different file; the
narrower scope wins at selection time, and the human decides.

## 4. Draft the candidate

```
roster dream candidates create --file draft.json --json
roster dream candidates create --stdin --json
```

The draft is a JSON document, never command-line flags — it carries a multiline
lesson body and up to 64 citations, and keeping it off argv keeps prose out of
process listings. Required fields:

```json
{
  "readiness_key": "<verbatim from dream status>",
  "scopeKey": "<the occasion scope from dream status>",
  "lessonScopeKey": "agent:<function>/<agent>",
  "lessonId": "<kebab-case>",
  "draftedByAgentId": "dreamer",
  "lessonPurpose": "<one line: what this lesson changes>",
  "lessonBody": "<the lesson itself>",
  "expectedEffect": "<what should measurably change>",
  "conflictingSurvey": "none-found",
  "counterexampleSurvey": "none-found",
  "policyVersion": "<verbatim>",
  "policyFingerprint": "<verbatim>",
  "watermarkOrdinal": 0,
  "frontierOrdinal": 12,
  "consumedCompletedRuns": 7,
  "consumedFeedbackRecords": 2,
  "supersedesCandidateId": null,
  "privacyClass": "internal",
  "citations": [
    {
      "role": "supporting",
      "evidenceKind": "completed-run",
      "runId": "<run id>",
      "feedbackId": null,
      "observationOrdinal": 9
    }
  ],
  "actor": {
    "actorId": "dreamer",
    "assurance": "host-attested",
    "host": "claude",
    "sessionId": "<host session id>"
  },
  "provenance": {}
}
```

Rules that will refuse a draft:

- At least one `supporting` citation.
- `conflictingSurvey` / `counterexampleSurvey` must say `cited` **exactly when**
  a citation of that role is present. Surveying honestly is the point: if you
  looked for counterexamples and found none, say `none-found`; if you found one,
  cite it.
- The lesson target must sit at or below the occasion scope. A lesson drafted
  over one plan's evidence may not be installed agent-wide.
- **Never paste evidence text into the candidate's prose — cite it.** Citations
  are pointers; Roster renders them. Pasting a run's output into `lessonBody`
  copies untrusted text into authored policy, and a human reviewing a diff cannot
  tell the two apart.

Creating the same draft twice is safe: it replays as `existing`.

## 5. Present it — never decide

Show the human the purpose, the body, the expected effect, the citations, and
the target file path. Then stop and wait.

You have no authority here. Roster has none either: it verifies that a durable
human decision exists and is bound by action digest to this exact candidate, and
refuses otherwise.

Record the human's answer:

```
roster brain record decision --json ...   # answer: approved | rejected
```

The decision's action must name `target: <candidate-id>`,
`effect: dream-candidate-promote|dream-candidate-reject|dream-candidate-retire`,
and `scope: <the candidate's lessonScopeKey>`.

## 6. Act on the decision

```
roster dream candidates promote <candidate-id> --decision <decision-id> --action-digest <sha256:...>
roster dream candidates reject  <candidate-id> --decision <decision-id> --action-digest <sha256:...>
roster dream candidates retire  <candidate-id> --decision <decision-id> --action-digest <sha256:...>
```

`promote` advances the Dreamer watermark and writes the lesson file into the
agent's playbook in one convergent operation. Report the Git path to the human —
the lesson is now a tracked file they can read, edit, and revert.

`retire` removes the lesson from its agent's registration first and then removes
the file, so a retired lesson stops being selected immediately.

**Every verb converges on re-run.** If a run is interrupted, run the same command
again with the same arguments.

## Failure modes

| What you see | What it means | What to do |
|---|---|---|
| `BRAIN_DREAM_SNAPSHOT_STALE` (`RBE07`) | The snapshot aged out, the counts fell below the minimums, or **the policy changed since you drafted** | Re-run `roster dream status` and re-draft |
| `BRAIN_DREAM_SELF_EVIDENCE` (`RBE06`) | A citation names your own runs or `dreamer` runs | Cite independent evidence; no policy edit relaxes this |
| `BRAIN_DREAM_PRIVACY_INCOMPATIBLE` (`RBE11`) | A citation is more restricted than the candidate | Cite compatible-class evidence |
| `BRAIN_DREAM_STATE_INVALID` (`RBE10`) | The transition is unavailable, or **another candidate already governs this lesson file** | Retire the governing one first. Supersession applies only to an *open* sibling with the exact same occasion and target spelling |
| `BRAIN_DREAM_DECISION_UNBOUND` (`RBE08`) | The human decision is not bound to this exact candidate, effect, and scope | Record a decision that is |
| `BRAIN_DREAM_DAMPED` (`RBE09`) | This lesson was rejected or retired before, and not enough new evidence has arrived | Gather the policy minimum of new evidence; there is no override |
| `BRAIN_DREAM_IDEMPOTENCY_CONFLICT` (`RBE02`) | This identity already holds different bytes | Re-run `list` and re-draft |
| `BRAIN_DREAM_ISOLATION_UNSUPPORTED` (`RBE12`) | The command was wrapped in an elevated-isolation transaction | Re-run it normally (READ COMMITTED) |
| **"decision was superseded"**, exit 0 | Later lifecycle activity governs this lesson; nothing was written | Re-run `roster dream candidates list` and act on the current state instead of retrying |
| **`UNVERIFIED`**, nonzero exit | The database connection was lost during — or just before — the file phase | The decision is durable: re-run the same verb (it converges), then run `roster brain doctor` |
| **"dream phase busy"**, nonzero exit | Another dream operation holds `.roster/state/locks/dream-phase` | Wait and re-run. If the printed owner PID is dead, remove the lock directory manually per the printed remediation |
| `LESSON_MATERIALIZATION_CONFLICT` | The target file holds bytes this workspace never recorded | A human reconciles: retire the lesson, or move or adopt the file, then re-run promote |

## What this skill never does

Nothing here is timed, queued, polled, or run in the background, and Roster ships
no verb that would let you build one. You are invoked; you do one pass; you exit.
Roster owns no approval state and no approval queue — the human decides in the
conversation, and their decision is recorded as portable evidence.
