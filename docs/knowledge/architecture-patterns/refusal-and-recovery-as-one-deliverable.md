---
module: collaboration replacement guard, remote outbox recovery, milestone stage full lane
date: 2026-11-26
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
applies_when:
  - "a guard refuses an operation the operator can finish from another command"
  - "a migration or new generation changes the shape of the state a refusal describes"
  - "a recovery surface is opened so that refused state can be settled at all"
tags:
  - refusal
  - recovery
  - guard
  - discoverability
  - outbox
related_components:
  - packages/engine collaboration store and remote outbox
  - packages/commands store-remote-outbox family
---

# A refusal and its recovery route are one deliverable

## Context

A replacement guard refused to proceed while an outbox held unsettled intents, and told the operator which
commands would settle them. Across one iteration that pairing failed twelve times in the same way: the guard
refused, the recovery text named a command that ALSO refused, and following the instructions exactly left the
operator with nothing to do. Each fix moved the dead end one command further down the chain.

## Guidance

Treat the refusal, its recovery text, and the command that text names as a single unit of work. Accept it only
when a test walks the text: start at the refusal, run every command the text names, and assert the state the last
one reaches is supported. A refusal whose recovery has not been walked is unfinished, not "documented".

Three rules follow:

1. **Name the actionable tail, not the head of the chain.** A refusal must name the step the operator can run
   NOW given the state it is looking at, with that state's own command — not the entry point they already tried.
   When several states block, list each one with its own oldest operation id and its own verb.
2. **Prove the route, not the sentence.** The test asserts the refusal AND that following its text reaches a
   supported state. A test that only matches the message text passes while the route is closed.
3. **Keep the guard and the text in one change.** When a migration or a new generation changes the shape of the
   state the refusal describes, the recovery text is part of that change — otherwise the text describes the
   world before it.

The same discipline covers a recovery surface opened for that purpose: a lane that a guard refuses to read often
needs one narrow, stated-limit write path so settlement is possible at all, and that path's own refusals must
name their next step too.

## Why This Works

The recovery text is the only interface an operator has inside a refusal. If it is wrong the system is
unrecoverable from the outside, no matter how correct the guard is. Walking the text in a test turns "the message
looks right" into "the route exists", which is the property the operator actually depends on.

## Prevention

- Review a guard and its recovery text together, in the same diff, with the walk-through test.
- When several states can block, assert one line per state in the refusal and settle each one in the test.
- After any migration that renames or removes what a refusal mentions, grep the refusal texts for the old shape.
