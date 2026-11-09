---
title: Host-neutral MCP surface with main-session authority
category: architecture-patterns
module: mcp-authority
date: 2026-09-26
last_updated: 2026-10-10
problem_type: architecture_pattern
severity: low
status: active
tags:
  - mcp
  - authority
  - session
  - d19
  - host-neutral
created: 2026-09-26
source: iter-20260926-v4-phase5
---

# Host-neutral MCP surface with main-session authority

## Problem

Exposing CLI workflow commands over MCP invites two wrong designs: (a) requiring per-call proof of which host/agent invoked the tool (impossible without host-native carriers, and unnecessary), or (b) trusting model-supplied `sessionId`/`role` fields as authority (lets a child-agent mint a coordinator).

## Decision (compass D19, validated by M3 + H2–H4)

- The MCP surface is host/agent-neutral. `host` is an explicit, validated context selector checked against existing supported-host definitions — it is context, never a role.
- `sessionId` is the main conversation session, supplied by the invocation context at runtime (`InvocationContext.sessionId`). CLI operator `--session-id` flags are CLI-syntax metadata mapped into that context — never model-visible schema fields.
- Workflow ownership, path scope, state transitions and CAS checks live in shared handlers; a model-supplied role/session/authority field cannot mint a coordinator or bypass them. Child-agent scheduling is internal orchestration, not a public identity hierarchy.

## Implementation shape

Single canonical `packages/commands` definitions → generated CLI adapter + MCP descriptors → per-host native bridges (omp/opencode/dsh) or config-only packaging (cursor/codex/kimi/zcode). Request-local immutable context per call; no process-global caller state.

## Evidence

iter-20260926-v4-phase5: M3 invocation tests (wrong-session refusals carry shared-handler codes; main-session bind succeeds), H3 opencode cutover (context-only `workflow.recover-coordinator`), plan QC fix waves C-1/C-2 (bind identity + selector pipeline), compass D19.

## Amendment — identity as a declared per-call input (2026-09-30)

Issue owner ruling (2026-09-30), recorded via plan 004-mcp-session-identity-per-request (rev 2, GitHub #327): identity-consuming commands (e.g. `session.recover`) declare `sessionId` as an explicit per-call tool argument mirroring the CLI `--session-id` flag — CLI↔MCP parity per U2. Threat model: a local, single-operator tool; the "never model-visible schema fields" clause in the decision above is consciously superseded for these commands, and the environment read no longer sources MCP identity. Unchanged: ownership/CAS wrong-session refusals, the recover family's attestation + expect-token gates, safe-path-component validation, and coordinator bootstrap staying host-tool-only (AC-R5's coordinator-minting prohibitions remain satisfied structurally).

## Amendment — the ENV identity axis is acceptable exactly where a token CAS authorizes the write (2026-10-03)

Recorded via plan 20261003-issue-373-register-identity (GitHub #373). The CLI collects session identity once, with source attribution (`sessionIdSource: "flag" | "env"`; `MSTAR_HOST_SESSION_ID` is the env axis, produced host-side — omp's model-handoff extension injects it per bash call; empty/whitespace counts as unset). Policy is branch-local, not adapter-global:

- **Token-CAS-authorized writes accept env-sourced identity** — all ACTIVE execution forms (`workflow.register`/`workflow.evidence`/`iteration.register` active routes, `plan bind --execution` both roles): the full execution token is the authorization; the sessionId is attribution. This is what makes the MCP/CLI 1:1 tuple hold with the sessionId input axis as the only difference (CLI = flag/env, MCP = host per-call param).
- **Where identity itself is the authorization, env never suffices** — the legacy (pre-activation) `plan bind --coordinator` bootstrap requires an explicit `--session-id` (no CAS exists there; pinned by plan-coordination env-refusal regression), and the legacy `--resume` form ignores ambient env while refusing a DECLARED (flag/host) identity — resume must not re-identify the caller.
- **MCP stdio keeps ignoring the environment** for its resolver (anti-spoof); per-call params are caller-supplied by definition and are never stamped "env".
- Refusal UX follows the same honesty rule as the rest of the contract: name each missing field, state the per-route recovery (CLI flag/env, MCP host per-call), and explain the session.run child's minted identity.

Anti-pattern this replaces: a single unconditional adapter-level env fallback, which silently let ambient env authorize a legacy coordinator bootstrap (caught by the boundary regression before landing).

## Amendment — ACTIVE-only identities: the acquired binding authorizes, a reference is a checked constraint (2026-10-10)

Recorded via plan `20261009-issue428-coordination-residuals`, which retired the file execution route end to end. The two route-scoped clauses of the 2026-10-03 amendment — the pre-activation `plan bind --coordinator` bootstrap and the legacy `plan bind --resume` — describe a route that no longer exists: `plan bind` now accepts only `--execution` (bind the coordinator seat) or `--resume-ref` (resume through an active session reference), both on the ACTIVE store. What survives, now that every route is ACTIVE-only:

- **Identity-bound privileged mutations resolve an ACQUIRED execution identity; a caller-supplied reference is a checked constraint, never the authority.** `milestone assign` acquires the coordinator identity in the command layer (`--session-id` supplies attribution only; the execution tuple comes from the launched session's minted `MSTAR_EXECUTION_IDENTITY`), refuses when no acquired identity is present or its seat is not the workflow's coordinator, and passes an optional `--session-ref` (decoded wire) into the mutation context. The engine checks that reference against the ACTIVE coordinator-session binding — store id/epoch plus the active session row — and re-checks it inside the write transaction before replay or mutation, so a stale reference cannot authorize a later write.
- **creator == binder.** `bindExecutionSession` refuses `coordination.identity-mismatch` when the trusted caller differs from the workflow header's recorded creator. First-bind adoption exists only for a creator-less lifecycle that records no coordinator rows (the adopting bind stamps its own identity as the creator); every other mismatch routes to `recoverExecutionCoordinator` naming the recorded coordinator instead of silently adopting the lifecycle. Fixtures and smokes that need a lawful ACTIVE binding must register and bind under one identity.
- **The unified registration route keeps the same constraint shape.** A supplied `--expect` is asserted, a supplied `--operation` pins the replay id, and both omitted derive a deterministic request-derived id plus a token read inside the registration transaction (retry-idempotent) — "supplied ⇒ checked, omitted ⇒ derived", exactly as `--session-ref` behaves for the mutation verbs.
