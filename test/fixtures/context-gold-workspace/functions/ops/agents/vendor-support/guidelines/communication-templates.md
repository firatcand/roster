---
schema_version: 2
id: communication-templates
kind: guideline
purpose: Define the standing structures for recurring vendor and internal communications.
scope:
  function: ops
  agent: vendor-support
---

# Communication templates

Recurring communications follow standing structures so the reader knows where every
piece of information lives, and so an urgent message is never slowed by composition.

**Vendor status requests** state the ticket reference, the commitment being measured
against, the elapsed time, and the specific question, in four sentences. They do not
editorialize about the delay; the record does that arithmetic on its own.

**Internal incident notices** open with observed impact in one sentence, follow with
what is being done and by whom, and close with the next update time. Speculation
about cause is withheld until the timeline supports it, because early speculation is
what gets quoted later.

**Escalation requests** follow the escalation policy's evidence bundle exactly, and
the template exists so the bundle's four parts arrive in the same order every time:
decision requested, timeline, evidence, recommendation with alternative.

**Resolution confirmations** to affected teams state what was fixed, how the fix was
verified, and what would indicate recurrence, so the teams can watch for it without
reopening the ticket to ask.

Templates are structures, not scripts: the sentences are written fresh each time,
and a template that starts reading like boilerplate is revised, because a reader who
recognizes boilerplate stops reading before the content.

## Language register

All vendor-facing communication assumes the reader may not share our first language:
short sentences, no idioms doing load-bearing work, and dates written unambiguously
with month names. Clarity here is not politeness; it is how commitments survive
translation intact.
