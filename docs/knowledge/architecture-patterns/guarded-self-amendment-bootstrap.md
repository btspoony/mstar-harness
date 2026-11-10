---
module: harness engine + cli + workflow lifecycle
date: 2026-09-16
last_updated: 2026-11-09
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: <plan-id> (frozen route in the shared prepare-amendment spec)
applies_when:
  - "a change widens the authorized surface of a protected writer"
  - "the widened surface would otherwise be the only lawful way to register the work that ships it"
  - "a prerequisite lifecycle must be initialized before the new API exists"
  - "a later plan adopts an accepted prerequisite instead of reimplementing it"
tags:
  - bootstrap
  - self-authorization
  - protected-writer
  - workflow-registration
  - create-only-writer
  - adoption
  - verified-merge
---

# Guarded self-amendment bootstrap: widening a protected writer without letting the new surface authorize its own delivery

## Context

A protected writer (the workflow snapshot) refuses exactly the mutation a user-approved scope change needs, and no lawful writer for it exists: generic snapshot replacement cannot change plan rows at all, and the plan-level verbs require a row that is already present. The approved remedy is a new narrow engine operation — append explicitly approved, unique `Todo` plan rows, record the reviewed integration checkout, and set the single approved concurrency-policy key — delivered through the ordinary lifecycle gates.

That remedy has a self-reference problem. The new operation is the only lawful way to register a plan row on a workflow that is still in Prepare; if the plan implementing the operation were registered by the operation itself, an unshipped API would authorize its own implementation, and a row that does not exist would be executed as if it did. The frozen route therefore splits the work into two identities: an independent, normally registered prerequisite workflow that ships the operation using pre-existing writers, and the original plan that later adopts the accepted revision.

This document records the route's rules and the failure modes they exist to prevent. Its evidence is the shared prepare-amendment contract, the bootstrap plan and compass, and the prerequisite's own implementation and review records.

## Guidance

1. **Freeze the prerequisite identity before implementation.** The bootstrap owns exactly one plan and one workflow id, both distinct from the original iteration's and from the later adoption plan's. Distinct plan ids are what prevent two workflows from claiming the same rows: the original snapshot stays untouched until the prerequisite is merged and closed, and the original plan is not registered while it has no lawful writer.

2. **Initialize with pre-existing writers only.** The prerequisite is created as a one-off composition of already-exported constructors: the complete, reviewed one-row snapshot is written by the existing create-only snapshot writer, then registered through the existing root registration call, after configuring the active artifact store for the resolved harness root. No new generic registration producer, no direct protected-JSON edit, no unregistered SDD fallback that treats a missing row as registered — and no dependency on the verb the delivery itself ships.

3. **Require an actual root-entry readback before any execution.** Creation success plus registration success plus a read of the registered entry are the admission gate for bind/prepare/lease/work. This is the same ordering invariant the generic promote path uses; see `architecture-patterns/audit-promote-workflow-registration.md` for snapshot-before-register, its re-promote guard and its register-failure rollback. The bootstrap adds the self-authorization constraint, not a second registration protocol.

4. **Stop on create-success / registration-failure.** A partial outcome leaves an orphan snapshot that is *not* executable: registration refuses and writes nothing, the address route reports the workflow as not found, and re-creation never overwrites the orphan. The only lawful recovery is to prove that the existing creation is exactly the expected one and then retry registration alone; a conflicting snapshot is never overwritten, and the gap is never papered over by editing protected state.

5. **Never manufacture ownership to unblock.** No missing-row execution and no synthetic lease: an absent row is absent, and a lifecycle with no execution ownership does not acquire one by writing it into the snapshot. Where a prerequisite genuinely does not exist, create it through the normal route (this one) instead of pretending it is registered.

6. **Delivery under its own identity, then verified merge, then terminal close, then adoption.** The prerequisite passes the normal path: task leaves, a fresh per-task review for each task, plan QC tri-review, mandatory PM Acceptance, handoff/integration/complete, then a PR. Merging is a verified act — it happens only when every required CI check is green and the configured review gate is a clean pass at the agreed bar; a failing condition keeps the PR open, and neither auto-merge nor a partial pass counts. Only after that verified merge does the normal workflow terminal close/unregister run, using the workflow's own genuine coordinator envelope. Adoption by the original iteration comes last and stays blocked until then.

7. **The adoption plan reuses evidence instead of re-implementing.** The original plan is appended as a `Todo` row — never imported as `Done` — and its remaining task cites the accepted revision, the prerequisite's review reports and the unchanged tested API revision as reusable evidence. Adoption reviews the adoption delta; it fabricates no new code change and does not repeat the implementation. Distinct plan ids keep the two claims separate, and the accepted prerequisite code must be an ancestor of the original integration branch before adoption can proceed.

8. **A changed surface invalidates only the affected evidence.** Reuse is bounded: when the accepted revision's behaviour differs from what was reviewed, the evidence that depends on the changed behaviour is invalid and must be re-established — not the whole evidence set. An annotation that a row was delivered elsewhere carries no lifecycle state with it.

9. **The new surface keeps its own admission gates.** Widening the writer does not widen what may be mutated. The operation is Prepare-only: the workflow must be running and in the Prepare phase, with no execution ownership anywhere in the document (no leases, no per-row coordination blocks, no progress), and every authorizing document's current byte version must be supplied. The delta stays approved appends + reviewed checkout + the single approved policy key.

## Failure modes this pattern exists to prevent

| Failure mode | Why it is tempting | What refuses it |
|---|---|---|
| Missing-row execution fallback | "The row will exist soon; run the plan anyway" | The registration + readback gate before execution; a row that does not exist has no address to run from |
| Synthetic lease | Unblocking the lifecycle by writing ownership nobody granted | Ownership arrives only through the normal grant route; a fabricated lease is not a prerequisite |
| Unshipped API self-authorizing | Registering the delivery with the very API the delivery ships | The prerequisite is initialized by pre-existing writers; the adoption plan stays unregistered until accepted code exists |
| Partial create/register leaving a non-executable orphan | Treating a created-but-unregistered snapshot as usable | The orphan is inert (unregistered, therefore not addressable), is never overwritten, and is reused only after exact-creation proof, for a registration-only retry |

## Why This Matters

Without the split, a protected surface's first use is its own delivery, and every guard that makes the surface safe also removes the ability to verify that delivery: there is no prior reviewed revision to adopt, no registered identity for the work, and no way to distinguish a missing prerequisite from a missing registration. The route buys three fail-closed properties: the delivery is registered by machinery that already shipped and is already tested; the new surface's own gates get exercised against a workflow that was created lawfully; and adoption has an accepted, reviewable revision to point at instead of an in-flight one. It also bounds the blast radius of a partial bootstrap to an inert file rather than to a running lifecycle.

## When to Apply

- Adding a guarded writer for a structure the existing writers refuse to change (rows, anchors, policy keys) where the plan shipping it would itself need that writer.
- Any prerequisite delivery that must land before the plan it unblocks can be lawfully registered.
- Adopting an accepted revision into a different workflow/plan identity without importing state or duplicating source.
- Establishing the merge → terminal close → adoption ordering for a change that widens a protected surface.
- Reviewing a proposed "small workaround" (execute the row anyway, synthesize a lease, register with the new verb) — the table above is the refusal list. The route itself is governed by the shared prepare-amendment contract (`{PROJECT_DIR}/_default/references/prepare-workflow-amendment.md`, § Lawful bootstrap / § Original adoption and final ownership); its guarded operations are reached through the ACTIVE store's `workflow.*` / `plan.*` verbs, so a re-run must not script the retired `show-prepare` / `amend-prepare` / `recover-coordinator` command names, and the gate it names is **PM Acceptance**.

## Examples

- Synthetic identity shape: workflow `iter-<plan-id>` owns exactly plan `<plan-id>`; the create-only writer stores the reviewed one-row snapshot, root registration accepts it, and a readback of the root entry precedes coordinator bind and any lease. Plan `<plan-id>` belongs to a *different* workflow, stays unregistered while no lawful writer exists, and is appended as `Todo` only after the bootstrap PR is verified-merged and the bootstrap workflow is closed.
- Orphan shape: registration fails while the snapshot exists → the workflow is not addressable, a command aiming at it reports the workflow as unknown, and the retry performs registration only, leaving the snapshot bytes untouched.
- Adoption shape: the original plan's remaining task cites the accepted revision and the prerequisite's review reports; the review of the adoption delta reuses that evidence, finds no new code change to review, and the original rows remain the original workflow's own.
- Boundary shape: the prerequisite's review records that the original workflow's snapshot, the unrelated active workflow and the root register entry are byte-unchanged by the prerequisite's delivery, and that the original plan's row count is unchanged until adoption.

## Related

- `architecture-patterns/audit-promote-workflow-registration.md` — the snapshot-before-register invariant, re-promote guard and register-failure rollback this bootstrap reuses.
- `architecture-patterns/shared-lifecycle-lockdir-pattern.md` (archived) — historical: the lockdir and byte-version CAS substrate the retired file-route commits used. The ACTIVE store commits through its own transaction, so this is context, not a live dependency.
- `architecture-patterns/dispatch-binding-fail-closed.md` — the fail-closed binding gate that keeps an unregistered or foreign identity from being executed.
