---
module: @mstar-harness/dsh
date: 2026-10-22
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: "<plan-id>"
tags:
  - "dsh"
  - "panel"
  - "panel-snapshot"
  - "store-backed"
  - "typert"
  - "transport-split"
  - "polling"
  - "projection"
---

# Store-backed panel snapshot: one RPC read composed on the host

## Context

The dsh workflow panel used to read a per-session EMISSION snapshot: an agent hook persisted the catalog payload on every step, the browser fetched it from a per-session store, and the panel was therefore only as fresh as the last step. Plan `<plan-id>` replaced that with a direct read of the harness's store authorities over one typert method, `mstar/panelSnapshot`. The panel now reads the same `DashboardView` layer the CLI's HTTP API reads, and the emission path is retired.

The pattern is small but every rule in it was earned by a review finding, and each one is a trap that reads as harmless until it is not. This document keeps the reusable lessons; the panel surface contract and projection moved to the unified dashboard (`packages/ui/`, root `DESIGN.md`), and the two panel-era docs that described them are archived.

## Guidance

### 1. One typert contribution per `<package>#<face>` — a new endpoint RIDES the existing one

typert admits exactly ONE contribution per `<package>#<face>` pair. A second `ctx.typert.register({ package: 'mstar', face: 'host', … })` from the same package THROWS, so a new method cannot get its own contribution. The panel's `mstar/panelSnapshot` descriptor therefore rides the pre-existing contribution's `invocations` ARRAY next to `mstar/selectWorkflow` (`src/engine-status-endpoint.ts:351-380`), while its own SERVICE stays a separate unit in `src/panel/panel-snapshot-endpoint.ts`. Consequences worth internalising:

- the descriptor list and the service are two different installs with two different optionalities — a new read must add an entry to the array, not a registration;
- the installer dedupes on a live `ctx.get(namespace)` probe BEFORE constructing, rather than catching typert's `already registered` text (`engine-status-endpoint.ts:391-460`) — the error-text match survives only as a containment fallback;
- a spec that hand-mounts the service proves nothing about the wire: the only meaningful assertion is that the COMPOSED plugin registers every descriptor, because a duplicate contribution would surface as a boot failure.

### 2. Share the generic read, keep the transport concern

What made the migration cheap: the engine already owned the generic half, so the plugin added no validation of its own. The split is

- `packages/engine/src/dashboard-view.ts` — view name → validated `DashboardFilters` → one `withStoreRead` envelope. No transport knowledge at all: unknown enum values, an over-limit page, an excessive literal search and a path-like id are all refused HERE, once, for every caller.
- `packages/commands/src/dashboard/store-read.ts` — the CLI's URL surface only (route table, detail-path decode, route-level id refusal), re-exporting the engine layer instead of restating a rule.
- `packages/dsh/src/panel/read-panel-snapshot.ts` — the plugin's RPC surface only: structured arguments in, one snapshot value out.

The test of the split: adding the plugin required ZERO new validation code, and the transport file re-exports rather than reimplements. When a second transport starts duplicating a rule instead of calling the shared layer, the split has already failed.

### 3. Resolve the target server-side — the browser does not know the ids

The browser can name a session and a workspace directory. It cannot honestly name a workflow, an iteration or a project: those are durable server facts (the session's picker record, the store's ACTIVE lifecycle, the harness catalog). Requiring the client to know them produced a panel where the roadmap and the stepper were permanently `not-applicable` — every absence render looked like an empty harness.

The read therefore resolves all three itself (`src/panel/read-panel-snapshot.ts`): the workflow from the durable binding (`readWorkflowSessionBinding`, folded by `readExecutionWorkflowSource`, whose `selectActiveWorkflow` already falls back to the single ACTIVE entry — do not write a second fallback), the project from the `projects` view (`_default`, else the single one), the iteration from the catalog's iteration page. The reuse matters: the `projects` view is read FIRST because it both resolves the roadmap's project and is itself a snapshot member, so resolution costs one read, not two.

Two disciplines keep this honest: a client-ASSERTED id is still shape-validated and still resolved against the server-resolved harness root (a claim can never redirect the read to another workspace), and an unresolvable target stays `not-applicable` instead of being guessed.

### 4. Three read states per member, and why `null` cannot express them

Every workspace member answers `ok` (the authority answered — `data: null` means "nothing here"), `not-applicable` (nothing was read: no target resolved) or `unavailable` (a read was attempted and failed, carrying the store's own message verbatim). The whole snapshot is `unavailable` only when NO member reached the authority; a workspace with no resolvable harness root is the separate `no-harness` kind.

A flattened `null` would collapse four distinct situations a user acts on differently: "your harness has no roadmap", "we could not resolve your project", "the store refused", and "there is no harness here". The first is normal, the second is a configuration question, the third is a fault, the fourth is not a panel at all. The roadmap zone additionally splits the two `ok` shapes with `present: boolean`, which is what makes four absence renders possible (the projection rules now live in `packages/ui/`; the panel-era doc is archived).

### 5. A read scheduler must never drop a demanded read

The panel has since moved from a polled snapshot to per-view ONE-SHOT reads (`src/client/panel/once-reader.ts`, `use-mstar-dashboard-view.ts`, `use-mstar-session-digest.ts`: one read per view identity, plus an explicit `reload()` — no interval, no shared store, and `panel-snapshot-client.ts` is an RPC face with no timer except the per-request deadline). The rule the old poll scheduler earned still binds the new shape: a demand raised while a read is already outstanding must be REMEMBERED and served, never silently dropped. Dropping it looked harmless — a poll would come around anyway — but the settle path then found a different target and scheduled nothing, so a collapse→expand of the docked sidebar froze the panel until the tab was re-opened. The one-shot form keeps the rule structurally: a read for a NEW identity supersedes the old one (`begin(key, …)` writes `loading` and a superseded answer never lands), and the only way to re-read an unchanged identity is an explicit `reload()`, which clears the key rather than hoping a timer fires. Same class, same fix: a target CHANGE drops the stored view and last-good snapshot BEFORE the new read starts (the previous one belongs to another workspace).

### 6. A `needsProjection` read is not automatically a write

The natural fear is that reading projection-backed views forces a projection refresh, so reading one repeatedly would rewrite the store every time. Measured, it does not: `publishGeneration` (`packages/engine/src/projection.ts:1214`) returns EARLY when `meta.sourceSetHash === capture.sourceSetHash` AND `renderedDigest(stored) === renderedDigest(capture)` — no delete, no insert, no generation bump, and only a health-row touch when the stored freshness is stale.

The honest cost is therefore: one source capture per projection-bearing view (an unchanged digest still has to be computed to know it is unchanged), plus one empty `begin immediate`/`commit` write transaction per such view per tick. State that cost where the read is written down instead of restructuring the read to avoid a write that is not happening — but also do not add a bearing view for free: the panel's iteration resolution added a third one, which is acceptable only because of this short-circuit.

## What Didn't Work

- **A second `typert.register` for the new endpoint.** Throws (`one contribution per <package>#<face>`). The descriptor has to ride the existing contribution's `invocations`.
- **Letting the client assert the workflow/iteration/project.** Produced permanently `not-applicable` members for every session that had never used the picker; the browser simply does not hold those facts.
- **Folding the three absence situations into `data: null`.** Renders a fault as an empty state and an unconfigured workspace as a fault.
- **Dropping a refresh demand raised mid-flight.** Froze the panel after a collapse→expand, because the settle path rescheduled nothing.
- **Restructuring the read to avoid the projection write.** The write does not happen; the restructure would have invented an iteration back-reference the execution rows do not carry.
- **Validating the envelope inside every renderer.** The wire parse refuses an incomplete `ok` answer once (`unavailable('malformed-answer')`), so the projection only guards individual FIELDS. Duplicating the envelope check in render code hid which layer owned the rule.

## Why This Matters

The panel is the operator's view of the harness. A read path that only shows what an agent last emitted is stale by construction; a read path that requires the browser to know server ids is wrong by construction. Sharing the generic read with the CLI means one validation implementation for both transports, and stating the three states explicitly means the panel can never render a fault as "empty" — which is the failure mode that destroys trust fastest.

## When To Apply

Adding a read to a dsh client surface, adding a method to an existing typert package face, composing a multi-view snapshot, or debugging a panel that freezes, blanks, or reports an empty harness. Related: `packages/ui/` and root `DESIGN.md` (the unified dashboard that replaced the panel-era surface contract and projection; both old docs are archived), and `architecture-patterns/active-authority-projection-capture.md` (what the capture layer actually writes).
