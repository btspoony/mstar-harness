---
title: Associate host and engine session identities explicitly
module: omp host adapter / engine coordination / CLI plan bind
date: 2026-09-18
problem_type: architecture_pattern
category: architecture-patterns
last_updated: 2026-11-09
severity: medium
source: plan 20260918-omp-model-handoff-session-identity (fix for the OMP Phase-1 handoff refusal)
status: active
tags:
  - session-identity
  - host-adapter
  - envelope-naming
  - cross-namespace
---

# Associate host and engine session identities explicitly

## Context

A host adapter and the workflow engine each name the same logical session in
their own namespace. The OMP adapter identifies a session with
`ctx.sessionManager.getSessionId()` (host-minted UUIDv7); the engine mints its
own `randomUUID()` per coordinator or plan-pm session and records it on the
snapshot plus its session envelope. Nothing bridged the two namespaces.

## Guidance

1. **Never compare identities across namespaces.** The adapter's Phase-1
   readiness check required `snapshot.coordination.coordinator.session_id ===
   host.sessionId`. The comparison can never hold, so the checkpoint is
   unreachable — and because the same equality also gated the
   foreign-coordinator, plan-pm and one-session-one-iteration guards, those
   guards were dead code that produced no error.
2. **Build the association, don't relax the check.** The host supplies its own
   identity to the tooling (`MSTAR_HOST_SESSION_ID` on the shell invocation,
   injected by the host adapter), the CLI resolves an explicit flag first and
   the environment second, and the engine *adopts* the supplied value as its
   session id. That channel is now three-deep (explicit `--session-id` → the
   launcher's `MSTAR_EXECUTION_IDENTITY` → `DSH_SESSION_ID` → ambient
   `MSTAR_HOST_SESSION_ID`), and an absent identity is a NAMED REFUSAL
   (`coordination.identity-missing`) — an identity is acquired explicitly and is
   never generated. Identity equality then holds by construction, and every
   existing ownership comparison becomes effective without being weakened.
3. **One identity, one role record.** The role set collapsed to `coordinator`
   alone (store migration 9 retired every `plan-pm` execution session into row
   metadata), so the second-record collision this rule bought is now historical.
   The shape still holds wherever a role-scoped path is derived —
   `sessionFilePath()` builds `<role>-<sessionId>.json` — and readers must resolve
   the path recorded on the envelope rather than re-deriving a name.
4. **Fail loudly on a missing association.** Refuse an unusable identity with
   an additive code *before* any write, and keep every pre-existing refusal
   code and message byte-identical; a missing association is a refusal, never
   a silent pass.

## Why This Matters

A cross-namespace equality test does not fail — it just never succeeds. The
damage is invisible: the checkpoint that should gate a privileged transition
stays shut for every legitimate caller, while the ownership refusals that
share the same predicate silently stop protecting anything. Restoring the
association revives all of them at once, which is why the fix belongs at the
identity boundary rather than at each comparison.

## When to Apply

- Wiring a host/plugin session identity into any out-of-process tool, CLI, or
  service that keeps its own session record.
- Designing storage for "one caller, several role records" — decide the
  disambiguator (role, plan, workflow) at the path layer, not by minting
  lookalike ids.
- Any review where a comparison between two independently minted ids is
  treated as evidence of ownership: ask which namespace each side comes from.

## Examples

- Precedence that works: explicit flag → host-injected identity → environment
  variable → ambient host variable; a blank value counts as absent, a hand-set
  `MSTAR_EXECUTION_IDENTITY` is refused rather than guessed, and a missing
  identity refuses instead of minting one.
- Regression shape worth pinning: bind both roles under one supplied identity
  in the same workflow, assert distinct role-scoped paths with an identical
  payload id, and re-assert that the second bind of either role still refuses.

## Related

- `host-derived-authority-tool-gates.md` — deriving *authority* from host
  facts (this document covers deriving the *identity* those facts are
  compared against).
