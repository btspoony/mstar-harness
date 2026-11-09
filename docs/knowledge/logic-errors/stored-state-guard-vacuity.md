---
module: packages/engine workflow snapshot validation (completion coherence for report-only workflows)
date: 2026-09-23
last_updated: 2026-11-09
problem_type: logic_error
category: logic-errors
severity: critical
plan_id: "20260922-report-only-completion"
symptoms:
  - "A workflow whose stored handoff was rewritten to a non-completed state still closes to a terminal status"
  - "The phase gate accepts the same document that the coherence checks were supposed to reject"
  - "Integration-contamination, worktree and lease invariants are never evaluated for the rewritten shape"
root_cause: "The coherence validator returned early when the stored handoff state was not the expected completed state, so every invariant it owned — integration contamination, worktree anchors, branch anchors and lease absence — became vacuous for exactly the stored shape an adversary had rewritten"
resolution_type: code_fix
tags:
  - fail-closed
  - read-side-guard
  - stored-state
  - terminal-bypass
  - validator
  - door-enumeration
---

# A guard that early-returns on an unexpected stored state makes its own invariants vacuous

## Problem

A report-only workflow could be completed normally, and then have **only** its stored handoff rewritten (`handoff.state` set back to `accepted`, `completed_at` dropped, optionally an `integration` record added) — after which `workflow-close` succeeded and wrote the terminal status, the root registry entry was unregistered, and the phase gate reported OK. The document that was closed was precisely the contaminated shape the coherence validator existed to reject.

## Symptoms

- The terminal write and the root unregistration happen with no refusal, on a document carrying an integration record it must not have.
- The phase gate agrees with the close (it reads the same validator), so no layer disagrees with any other.
- The refused assertions the plan's acceptance named — integration contamination, worktree path, branch anchor, absence of a row execution lease — are simply not evaluated; a test that reads the validator's own violation list sees an empty list for the rewritten shape.
- The other transport (the DB-backed completion path) already refused the same document, so the defect looked transport-specific.

## What Didn't Work

- **Guarding only the mutation path.** The completion writers already revalidated route, policy, evidence and ownership at their own boundary. The bypass did not go through them: it rewrote the stored state and then entered through the *close* door, which normalizes and revalidates a document rather than mutating a row.
- **Fixing only the rewritten-state shape.** The first fix required the expected state positively for a row that still carried a `coordination` block. The same family reappeared one step away — a coordinated `Done` row whose whole handoff block was *deleted* still validated — because the fix was scoped to the shape that had been reproduced rather than to the family.
- **Reading the adversarial case as a test-only gap.** The rewrite is a raw stored-state edit that no authorized writer produces, which makes it tempting to down-rank; the reproduction ran it end to end through real CLI subprocesses, and the impact was a fabricated terminal state, not an internal inconsistency.

## Solution

Make the expected stored state a **positive requirement inside the shared read-side validator** instead of a precondition for checking anything:

```ts
// Before — "not the state I expect" meant "not my business": every invariant below was skipped
if (handoff.state !== "completed") return;

// After — a Done row must carry a completed handoff; anything else is a violation of the row itself
const completed = handoff.state === "completed";
if (row.status !== "Done" && !completed) return;      // in-progress rows keep their own semantics
if (row.status === "Done" && !completed) {
  violations.push(highViolation("coordination.row.handoff-field", /* names the field */));
}
// ...the contamination / worktree / branch / lease checks now run for this shape too
```

**Live shape (2026-11-09):** the file-route `handoff` block this episode rewrote was retired with the FILE plan-pm protocol — the remaining `handoff` references are migration sources only (`execution-import-rows.ts` projects a legacy `handoff` into the row's `completion`; `validateWorkflowSnapshot` treats imported snapshots as migration input). The durable form of the rule now lives in `packages/engine/src/coordination-write.ts`: `validateRowCoordination` / `validateCompletionRecord` state the required members (source branch/SHA, worktree, QC + QA evidence refs, integration record per route) as **violations of the stored block**, and `rowValidationRoute` derives the route from the snapshot rather than from caller input. When you add a member there, the same discipline applies: a `Done` row's required facts are asserted, never used as a guard that skips the rest of the checks.

Because the requirement lives in the snapshot validator, **every door inherits it** rather than each writer having to remember it:

- the close path normalizes and validates through the same validator, so it refuses with zero writes;
- the delivery pre-write validation reaches it;
- the phase-only writer cannot introduce the field (its projection refuses any field other than phase/timestamp);
- the read-only phase gate reaches the same validator and reports its own gate-level refusal — the gate and the close cannot disagree.

Two controls must be preserved, and they are what make the requirement safe:

- an **in-progress** row whose handoff is `accepted` (what the retired `accept` verb wrote, and what the import projection still maps) stays valid — the requirement is stated over the terminal row status, not over the state alone;
- a terminal row with **no** coordination block at all stays accepted, because a legacy producer mints that shape. That exception is a reachability question, not a guard: the argument must be recorded (which producer mints it, and whether a contaminated coordinated workflow can be reduced to it by deletion) — otherwise the family is not closed, only narrowed.

The same lesson applied to a sibling field in the same episode: the recorded completion block became immutable once any owned row is terminal, refusing a later patch with the transition error while keeping an identical re-record an accepted no-op.

## Why This Works

Stored state is an input the reader does not control, so "I only validate the shapes I expect" inverts the gate: the unexpected shape is exactly the one to validate. Requiring the expected value positively turns the adversarial shape into an explicit violation and keeps every downstream invariant reachable. Putting the requirement in the shared validator (rather than in each writer) is what makes the closure hold for every door, including doors added later — which is also the review test: enumerate every path that can reach the validator and say what each one does with the refusing document.

## Prevention

- **State invariant guards positively.** For a terminal state, require the terminal facts rather than returning early on anything else.
- **Enumerate the doors when closing a gate-class defect.** For each read/write path that reaches the validator, record whether it refuses, cannot introduce the field, or agrees with the gate. A fix that closes one door and leaves another is the same defect one layer out.
- **Sweep the family, then bound it explicitly.** After fixing one member (a rewritten field), ask what else produces the same shape (a deleted block, a missing field) and either close it or record a reachability argument as a residual. An accepted boundary with no written argument reads as an unclosed bypass.
- **Assert through real subprocesses for terminal-state defects.** The reproduction used real CLI invocations and asserted the refusal, byte-identical snapshot and still-registered root entry, which is what distinguishes "the guard exists" from "no door reaches the terminal write".
- **Keep the controls red-proofed.** The two preserved shapes (in-progress `accepted`, legacy no-coordination) each need a case that fails if the new requirement over-reaches; without them the fix would be indistinguishable from a refusal that blocks legitimate completion.

## Source

Iteration `iter-20260921-execution-2b-cutover`, plan `20260922-report-only-completion` (#270). Evidence: the plan QC consolidated, the security/correctness seat's round-1 reproduction and round-2 revalidation, the closure-round report, and the L4 QA report — all under `{SDD_DIR}/review/` for that plan. Related: `architecture-patterns/route-specific-completion-and-identity-repair.md` (route-specific completion predicates), `architecture-patterns/indivisible-verdict-action-window.md` (the refusal-before-mutation window the close path preserves).
