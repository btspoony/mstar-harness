---
module: engine recovery/replacement protocol (execution-recovery, execution-migrate) and DSh admission seams
date: 2026-09-21
problem_type: architecture_pattern
category: architecture-patterns
severity: high
plan_id: <plan-id>
applies_when:
  - "a destructive action must be justified by a condition that a concurrent writer can change"
  - "a check and the rename/replace it guards live in the same function"
  - "a crash mid-protocol can leave a temporary artifact behind"
tags:
  - atomicity
  - crash-safety
  - async-window
  - recovery
  - scratch-reclaim
last_updated: 2026-09-21
---

# The verdict and the action it justifies must be one indivisible window

## Context

A restore protocol verifies that the store is quiescent and then replaces it. Written as a straight line of `await`s, the verification and the replacement are separated by suspension points — and a writer that acts during a suspension point is exactly what the verification was supposed to exclude. This was a Critical in the migration/recovery plan: the sidecar/identity verdict was followed by an awaited byte-hash computation and only then by `renameSync`, so a new writer could create uncommitted WAL in between while the main-database hash still matched, and the restore proceeded over it. The same iteration hit the shape twice more (a synchronous admission seam that read retired bytes before deciding, and a reaper whose safety predicate had to prove the artifact was not an in-flight attempt's).

## Guidance

- **Order the statements so that nothing can yield between the last check and the action.** Move every `await` (including hashing, I/O and any probe) to *before* the verdict, so the sequence that runs from the final check to the rename is synchronous end to end. State the property in a module comment and pin it in a test.
- **Make the final check the one that guards the action.** A convenient check is not necessarily the last one: after reordering, confirm the *last* thing read is the live state the action depends on (sidecars, identity, ref), not an incidental value computed earlier.
- **If a runtime primitive makes a non-yielding sequence impossible, stop and say so.** Do not ship the window with a comment. The correct outcome is `BLOCKED` with the concrete mechanism, or a design that removes the need for the window (for example: never open the live artifact at all — copy it to a private image and operate on the copy, which also removes every "did my probe mutate the thing I was inspecting?" question).
- **A destructive step that can crash must leave its temporary artifacts reclaimable — with a conservative predicate.** A crash between "scratch copy created" and "replacement installed" leaks a store-sized file forever if nothing ever sweeps it. Reclaim only what is *provably* orphaned: the durable receipt says the copy was never installed (and, where the write ordering makes it possible, no receipt exists yet for that attempt while the protocol lock excludes a live owner). Never reclaim an artifact whose receipt says it was installed, and never reclaim one an in-flight attempt could still own.
- **Keep the scratch artifact on the same filesystem as the target.** An atomic `rename` requires it; moving scratch into a tidier directory silently breaks the atomicity the protocol depends on.
- **Sweep best-effort.** A failed reclaim must not fail the operation it precedes; the sweep runs inside the protocol's own lock, after the loss gate (so a refused operation still changes nothing) and before the step whose predicate it compares against.

## Why This Matters

An atomic-looking protocol that is actually a sequence of suspension points is worse than an obviously non-atomic one: it passes review, passes tests (single-threaded tests never suspend at the wrong moment), and fails only under the concurrency it was written for. The same reasoning applies to the recovery side: a protocol that can crash is only crash-safe if the artifacts a crash leaves behind are both harmless and reclaimable.

## When to Apply

Replacement/restore/migration protocols; any check-then-act pair over a resource another process can touch; scratch-copy or staging designs; reapers and garbage collectors for protocol artifacts; any code where a reviewer would ask "what if this yields here?".

## Examples

- Restore replacement (fix round 3 of the recovery task): the awaited byte verification moved before the verdict, making the live sidecar/identity check the last pre-rename statement. Red evidence was a test that injects a sidecar from the first event-loop turn inside the sequence's own yield — it failed against the pre-fix source and passed after.
- Never-open-the-live-store (fix round 2 of the same task): any writable SQLite access to a WAL store whose `-wal` is absent creates one, so "preview mutates nothing" was unreachable through any connection to the live file. The design became: byte predicate to identify the shape, copy to a `mkdtemp` image, create the empty `-wal` beside the **image**, and take the read intent of the image.
- Reaper for crashed restores (QC-driven fix round): `reclaimAbandonedRestoreScratch()` runs at restore start inside the maintenance lock, after the loss gate, and reclaims the image plus `-wal`/`-shm`/`-journal` only when the durable receipt proves the copy was never installed — verified with a real SIGKILL probe that left a 12 MB artifact behind.
