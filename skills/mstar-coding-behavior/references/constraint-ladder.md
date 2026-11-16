# Constraint ladder

Route a correction to the strongest constraint that survives it, in this order: **remove the choice → deterministic check → runtime verification → prose**. Escalate only when the earlier level cannot see the violation; the ladder is a search order, not a menu.

## Levels

1. **Remove the choice** — when the wrong action is expressible, delete the option: the parameter, the overload, the alternate path, the ambient default. A choice that no longer exists needs no rule, no reviewer concern, and no memory.
2. **Deterministic check** — when the action must stay available but a machine can see the violation, fail it in a lint, type, schema or test, and name the supported form in the failure text. The check states the rule once and applies it every time.
3. **Runtime verification** — when only live state reveals the violation, assert it on that path and fail with the observed values. Use it where the boundary is real and statically invisible, not as a substitute for a check that could exist.
4. **Prose** — when nothing above can see the constraint, state it in the instruction the actor reads at that step. It is the weakest level: read probabilistically, it drifts from the code and is not evidence that anything was enforced.

A constraint stated only in prose is recorded as a residual, not counted as enforcement.

## Repeated corrections

A correction is repeated at the same root cause, not at the same wording: the second occurrence is a signal about the system, not a second accident. Move it up the ladder in the same change set as the fix — a deterministic check or a design change — and only then answer the report.

Restating the rule, at greater length or greater emphasis, is not a level of the ladder: it changes no behavior and adds load to every future read.

## Repeatedly misused interface

An interface that produces the same class of mistake across changes is a design defect, not a discipline problem. Trigger: the same root cause, `occurrence >= 2` — an issue's occurrence count is the natural signal.

The action ladder runs in order:

1. Ship the safe replacement — the new API, parameter shape or path boundary that makes correct usage the shorter one.
2. Make the old spelling fail — removed from the type, banned by the check, or refused by the command with a message naming the replacement.
3. Delete the old interface once callers migrate.

Deprecation without a failing spelling is prose: the old form keeps receiving the misuse, and the replacement only adds a second way to do it.

## The codebase is input

A remaining example teaches the next change: the next actor copies what it sees before reasoning about what it means. Removing an obsolete pattern is an input fix, not tidying — a leftover sample, an old call site or a commented-out path is a live instruction that the pattern is current.
