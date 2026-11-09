# Active-authority projection capture

Hard-won rules from building a dashboard projection that reads an ACTIVE execution authority (DB-backed) instead of pre-activation files. Each was learned from a real failure; recorded so the next implementation does not re-derive them.

## Derive projections from the served graph, never raw domain tables

The authority's read adapter (for example a `readExecutionState`-style served graph) returns the root-register-scoped active lifecycles. The underlying domain tables hold **full history**: on one live store the workflow table held two orders of magnitude more rows than the served graph. Raw table enumeration projects historical rows that the authority does not serve; those rows routinely fail current domain validation, and one invalid row blocks the entire capture — the dashboard goes empty even though the authority is healthy. Enumerate what the authority serves; table rows outside the served set are invisible to the authority and must be invisible to the projection.

## Projection source-kind columns are closed sets

Projection source tables typically carry a CHECK-constrained `kind` column. Adding new kinds for new source families requires a migration; the cheaper honest mapping is **by role** (for example: a registry/root successor maps to the root kind; per-entity state rows map to the entity family), with per-source precision carried by the source key and logical relative path instead of the kind.

## Movement anchors: compare inside the publication transaction

Per-source digests catch content drift of captured rows but miss **insertions** (a new child row for an already-captured parent changes no captured digest) and race the verify→publish window. Use a store-wide revision that every writer bumps, snapshotted at capture and re-compared INSIDE the same `BEGIN IMMEDIATE` transaction that performs the generation flip — SQLite's single-writer lock then makes the check race-free. Verify the anchor's semantics in code first: authority-family revisions often cover only membership/root changes, while plan/lease mutators bump only row or store revisions.

## Authority-read failure is fail-closed

If the served-graph read fails, the capture is blocked: empty source set, one sanitized diagnostic, last-good generation retained. Never fall back to wider table enumeration — that downgrade converts an authority outage into a wrong-projection publication. Sanitize the diagnostic to a fixed prefix plus an allowlisted error-class name; upstream messages can embed payload bytes and source excerpts.

## The real type gate is the package build

A repo-root `tsc` invocation commonly typechecks only root-level files. A package's own build (`bun build` + package-scoped `tsc`) is the gate that catches missing type imports in package sources — runtime test suites pass regardless because Bun strips types. A CLI that bundles a workspace dependency package resolves that package's built `dist`; build the dependency first, or the CLI silently bundles stale code while tests against source stay green.

## Feature worktrees need their own install

`bun install --frozen-lockfile` in a fresh worktree before any root typecheck or test run; per-package `node_modules` (including nested plugin dependencies) do not otherwise exist there, and failures surface as confusing unrelated module errors.
