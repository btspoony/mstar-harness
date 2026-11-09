# ADR: Standalone development completion is a distinct delivery route

Status: implemented — a single-row development plan completes from its own delivery anchors; an iteration still proves an integration merge.

Date: 2026-09-17

Scope: plan-row completion in `packages/engine/src/execution-coordination.ts`, `coordination-transitions.ts` and `coordination-write.ts`, plus the workflow anchors a coordinator may repair.

## Problem

A standalone plan workflow registers a delivery branch and target; it has no integration branch and no integration worktree. The completion writer nevertheless required integration anchors and an integration checkout, so such a plan could not reach row `Done` without inventing an integration stage that never happened. The obvious relaxation — accepting either anchor set — is worse: an iteration whose integration anchors are missing would silently complete as if it were standalone, and a merge that was never verified would read as delivered.

## Decision

Completion is selected by route, and each route has exactly one predicate:

- `deliveryRouteOf(snapshot)` classifies a workflow as `report-only`, `development` (exactly one owned row, `type: plan`, `delivery_kind: development`), or `integration`. Route selection never tests anchor presence.
- A development row asserts `standaloneDeliveryAnchors`: the row's recorded worktree, the registered delivery branch, and `branch.target`. It verifies the feature checkout, its branch tip, the reviewed source commit and `review_head === source_sha`. It records no integration block.
- An iteration row asserts `integrationAnchors` (`branch.integration` plus `integration_worktree_path`) and an exact merge result. A missing anchor refuses `coordination.integration-unresolved`; a bad merge graph refuses `coordination.integration-diverged`.
- There is no `source ?? integration` fallback. Route-aware row validation (`RowValidationRoute = "integration" | "standalone-development" | "standalone-report-only"`) refuses an integration record on a standalone row and requires one on an integration row.
- A report-only row consults no Git and records no fulfilment payload; its completion policy is declared at registration.
- `Done` is acceptance, not proof of PR submission or merge. Delivery evidence ordering, close gates and the separate evidence operation are unchanged.
- Wrong registered anchors are corrected through the ordinary `workflow delivery-anchors` CAS operation, or declared during a v1 lift with `store upgrade --delivery`. There is no general snapshot editor, no import-`Done` path, and no automatic anchor derivation from Git truth.

## Alternatives considered

- **Optional anchors on one shared predicate.** Rejected: an iteration with missing integration anchors would look exactly like a valid standalone route.
- **Synthetic integration branches or copying a source SHA into an integration result.** Rejected: it misstates what was reviewed and adds an unperformed stage to ordinary delivery.
- **Relaxing evidence ordering or importing `Done` from a merged PR.** Rejected: it confuses row acceptance with delivery evidence and bypasses the accepted before/after ordering.
- **Reusing evidence declaration, registration or Prepare amendment to correct a source anchor.** Rejected: none is a lawful anchor write for a running workflow.
- **A general anchor editor.** Rejected: `delivery-anchors` is bounded to the three branch anchors under CAS and a stated reason; arbitrary snapshot mutation stays unavailable.

## Consequences

- Future registrations must record their true delivery source; a default/protected branch in `branch.work` is normally wrong.
- A development plan may complete before any delivery PR exists. Closing the workflow still requires the registered delivery evidence.
- Iteration delivery keeps every existing guard; the two routes cannot be confused by a missing field.
- Legacy v1 lifts declare their delivery kind at import. A misregistered anchor is repaired through the ordinary CAS operation, so the repair is revisable and repeatable while the workflow runs, and a closed lifecycle refuses it.
- Tests must exercise the public coordination writer, not a permissive private predicate; route-specific negative arms are part of the contract.
