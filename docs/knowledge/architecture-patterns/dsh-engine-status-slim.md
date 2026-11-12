---
module: @mstar-harness/dsh
date: 2026-08-20
last_updated: 2026-11-12
problem_type: architecture_pattern
category: architecture-patterns
severity: medium
plan_id: "<plan-id>"
tags:
  - system-prompt
  - digest
  - engine-status
applies_when:
  - editing engineStatusSummary
  - changing GLOBAL mstar:engine-status injection
  - considering idle vs active workflow selection for prompt context
---

# GLOBAL `mstar:engine-status` is version + active workflow only

## Context

v3.1.0 capped plan/lease joins (8/4) but the digest was still a repo-wide summary. Idle sessions looked busy because `buildCatalogSources` / `resolveReadWorkflow` falls back to the latest **terminal** snapshot by mtime. Product need: inject **plugin version** plus the **active** workflow (`status.json` `workflows[]`), nothing else.

## Guidance

- Surface: `engineStatusSummary` in `packages/dsh/src/gates/system-prompt.ts` only. Do **not** change `renderEngineStatusCatalog` / pre-step `<mstar_engine_status>`.
- Idle (no harness, empty `workflows[]`, `selection.kind !== 'active'`): exactly `mstar engine status: v<version>`.
- Active: second line `workflow <id> (<type>) <status> | plans: <non-Done id(status), cap 8 + +N more | none registered>`; the plans segment comes from `plansSegment` in `packages/dsh/src/gates/catalog.ts`, the one assembler the pre-step row also renders, so both surfaces share the wording (`none registered` for an empty registry, `all done` when every plan is Done) and differ only in their cap.
- Omit residuals, leases, direction, iteration-gate, harness, enforcement from this context (harness/enforcement live in `mstar:harness-rules`).
- Keep `buildCatalogSources`; renderer ignores non-`active` selection. Trust `workflows[]`; stale-registered terminal snapshots show the snapshot's own status word. Missing snapshot → version-only, no throw.
- Fields `MstarHarnessState.workflowType` / `workflowStatus` are ALWAYS-present nullable, filled from the already-read snapshot.
- `DIGEST_PLAN_CAP = 8` (module-private) is passed to `plansSegment` in `gates/catalog.ts`, which applies the non-Done filter and the shared `joinCapped` from `gates/_shared.ts` with the final `+N more` marker. `DIGEST_LEASE_CAP` is gone from the digest. The digest's own cap stays private; the catalog renderer uses its own `CATALOG_STATE_JOIN_LIMIT`. `joinCapped` itself still lives in `_shared.ts`, so neither surface imports it directly from the other; the `system-prompt.ts → catalog.ts` direction now carries `plansSegment` (a value import, no cycle: `catalog.ts` never imports `system-prompt.ts`).

## What Didn't Work

Join caps alone. Session→workflow bind (no field). Direct `resolveActiveWorkflow` in `system-prompt.ts` (would duplicate version/plan projection and add I/O).

## Why This Matters

GLOBAL prompt tokens must not invent a running workflow. Catalog/panel can still show history via terminal-mtime fallback.

## When to Apply

Any change to GLOBAL engine-status injection or idle/active selection for prompt context.
