# ADR: Review seats stop at a budget and declare what they did not cover

Status: implemented — a bounded seat keeps its reviewed-scope verdict, and the PM gate owns full coverage.

Date: 2026-09-17

Scope: harness-dispatched read-only review, QC and L2 task-review seats, their reports, and the PM gate that consumes them. PR-review seats use the engine's own tier table and are outside this record's ceiling.

## Problem

Read-only seats had no stop rule: a reviewer could expand until a human steered, or return a partial review that read like a complete one. Budget exhaustion was easy to conflate with `Unconfirmed`, although the evidence channel was intact and only scope was cut. The L2 review could exist only in conversation, so the PM could not read the file it claimed to rely on. A clean covered subset could then be mistaken for acceptance of the whole assigned scope.

## Decision

- Shared core owns the only numeric ceiling for harness-dispatched review, QC and L2 seats: a default of 12 file opens or 10 minutes. The PM may tighten the Assignment `Budget`, never widen it; a role adds a return obligation, not a second ceiling. PR-review seats are governed separately by the engine's `PR_REVIEW_TIER_BUDGETS` table (quick/default/deep: 12/20/30 file opens, plus wall-clock, findings and evidence-token caps); that table is the PR-review authority and does not widen this default.
- On reaching the bound, the seat stops expanding. It keeps the verdict and findings earned for the reviewed scope and discloses the stop in the report's `## Scope` with exactly `Truncated coverage: <what was not covered>`. The line appears only when the budget actually stopped expansion; a complete run omits it, including any "not truncated" spelling.
- A budget stop is not `Unconfirmed`. `Unconfirmed` stays reserved for a failed evidence channel. The QC parser keeps rejecting `Unconfirmed` combined with a `Truncated coverage:` label; the PM owns the separate full-coverage judgment.
- Every completed task under `Execution mode: sdd` has a fresh L2 report at `{SDD_DIR}/task-N-review.md`. The implementer's `{SDD_DIR}/task-N-report.md` is an input and is never overwritten or accepted as independent review. The reviewer writes the report, then returns a compact pointer and assessment to the PM.
- Partial findings remain valid. The PM retains them and does not append task-complete or release dependents while assigned review scope is uncovered; remaining scope goes through a fresh or tightened reviewer assignment. The PM does not invent `Needs fixes` merely because the budget ended, and does not overwrite an `Approved` earned for checked scope.
- No universal report schema, new result enum, runtime budget instrumentation or filename-discovery fallback is introduced. Dispatch continues to require `Budget` and `Return shape` presence; the existing parser shape is unchanged.

## Alternatives considered

- **A universal QA/QC/L2 report schema and result enum.** Rejected: existing report bodies plus the PM judgment already express the outcomes, and a new schema is another place to drift.
- **Duplicate numeric caps in each role.** Rejected: a second policy authority drifts from the core ceiling.
- **Relabel a bounded review as `Unconfirmed` or overwrite its earned verdict.** Rejected: it confuses channel validity, observed findings and coverage.
- **Make the QC parser reject every partial `Approve`.** Rejected: that is not its contract, and a parser cannot judge the PM's full-scope gate.
- **Use the implementer report as the L2 output, or accept either basename.** Rejected: it lets self-check replace independent review or overwrites implementation evidence.
- **Migrate historical outputs or add a discovery heuristic.** Rejected: historical artifacts stay untouched; the new producer/consumer contract is explicit.

## Consequences

- A clean checked subset cannot produce full acceptance; an uncovered required area blocks `Done`.
- A witnessed failure is retained in the AC map even when the report is truncated; coverage is disclosed alongside it, never instead of it.
- The durable plan summary keeps a compact AC/task-review trace with a report pointer, so raw-bundle cleanup cannot erase the only evidence.
- The role-specific mandatory-QA landing rule was retired with the separate QA seat; current acceptance ownership and the PM carrier are recorded in `2026-11-08-pm-acceptance.md`. The seat budget, truncation semantics and L2 output rule above remain live.
