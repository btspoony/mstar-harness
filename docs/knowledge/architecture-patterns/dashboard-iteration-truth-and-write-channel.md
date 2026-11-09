# Dashboard read truth and the milestone write channel

Status: active · Scope: dashboard read model + dsh panel write surface · Derived from iteration
`iter-<plan-id>`

## Problem

The dashboard answered three iteration facts from the wrong authority: lifecycle from the catalog
registration row (`active` until archived), plan membership from sparse catalog links, and execution state
from a projection that only carried active-registered workflows. Separately, the project page had no write
surface although the engine already owned milestone verbs.

## Read-model decisions

- **Execution lifecycle is a DTO member, derived once.** `IterationDTO.executionLifecycle` is
  `active | completed | stopped | failed | none`, computed only in `composeIteration` from the workflow row
  (`none` when no workflow exists). The catalog registration lifecycle stays a separate, unchanged fact
  shown on the iteration detail. Do not re-derive the arm in a reader or in the UI.
- **Plan membership is the union of authored and registered.** The compass `plans:` frontmatter is projected
  (`plans_json`, projection format version bump + migration) and read as a de-duplicated union with the
  catalog `plan belongs-to iteration` links. A declared id missing from the catalog keeps the existing
  `catalog-missing` arm. No link-backfill migration ships: the union read is the only consumer of those links.
- **Terminal iteration workflows join the projection.** The projection carries active-registry workflows plus
  terminal `type === "iteration"` headers (`activeRegistration: false`); the workflows list keeps explicit
  active-registration membership at the read. Terminal plan workflows never widen it.
- **Multi-project membership is one truth.** `projects: string[]` comes from the same `belongs-to` membership
  the project filter uses; registration writes one link per repeated `--project`; later edits use the catalog
  link family (no new verb family).

## Write-channel decisions (dsh panel)

- All milestone writes ride the existing `mstarPanelSnapshot` typert service (add / update / assign / remove),
  call the engine verbs with the store revision read in the same read envelope, and pass engine refusals
  through verbatim (`{ ok: false, code, message }`). The UI never re-words a store refusal.
- **Idempotency is per logical write.** One `operationId` is reused across retries while the answer is
  transport-ambiguous (deadline abort); it is settled only on a terminal answer (success or a non-transport
  refusal). A retry after an ambiguous timeout therefore replays the store receipt instead of duplicating the
  write. Do not mint a fresh id per attempt.
- The read reloads on both success and refusal; no optimistic read-model state survives a refusal. The write
  surface is absent when the host supplies no write channel — the page stays read-only.
- Milestone creation always inserts `planned` (the engine add verb has no status field); status changes belong
  to the edit control.

## Migration note

The compass-plans projection adds a column and bumps the projection format. An older store must run the
documented `mstar store upgrade` before the next dashboard read; the projection rebuilds on that read.
