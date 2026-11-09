---
title: Derive session authority from host facts, never tool input
category: architecture-patterns
source: iter-20260916-omp-model-handoff (model row Task 3, Critical fix 298339c9)
status: active
---

# Host-derived authority beats caller-asserted authority

## Lesson

An extension tool that gates a privileged action (here: arming a model switch
for a coordinator session) must derive **who is calling** from host-observed
facts — session id/type from the host's own session records, the workspace's
registered workflows, and the engine's coordinator envelope — and must refuse
with a visible record when the derivation fails. Accepting an
`authority: "coordinator"` field from tool input means any session can assert
the privilege; the reviewer demonstrated the scoped-plan PM session arming the
switch through exactly that field.

## Practice

1. Strip authority/intent/entry fields from the tool input schema entirely —
   strict validation then rejects even a forged raw call.
2. Derive identity from three independent sources and cross-check:
   host session ledger, engine coordinator envelopes, root register.
3. Prove the negative with three probes: no-params, per-key schema rejection,
   and a raw schema-bypassing call that must still refuse.
4. Disclose the residual boundary honestly: derivation is not cryptographic
   caller proof; an iteration without an envelope yet remains within the
   accepted trusted-assertion boundary.

## Related

- `shared-lifecycle-lockdir-pattern.md` (archived) — same iteration's envelope↔snapshot
  re-read per probe and symlink-retarget freshness lessons; the lockdir mechanism itself is retired.
- The general rule the bootstrap iteration established: never let a new
  capability authorize its own delivery.
