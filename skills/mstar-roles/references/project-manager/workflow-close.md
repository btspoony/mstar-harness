# Workflow close after a verified merge

> Responsibility: close a registered workflow once its route's completion prerequisite is satisfied — a verified delivery merge for a route that delivers through a PR, or QC and PM Acceptance under the registered completion policy for a report-only workflow — writing the terminal state, unregistering, reconciling projections, then handing off cleanup explicitly. Both callers load this file: the iteration route (`mstar-iteration` SKILL.md「Phase route map」Phase 6) and the standalone routes in `mstar-roles/references/project-manager/plan-management.md`. **Read `mstar-harness-core` first.** For a route with a merge, `mergeable` ≠ merged: the engine cannot probe remote PR state, so the caller verifies the merge before invoking close, and the close verb is not a merge verifier; a report-only workflow closes with no PR and no merge.

| Route | Entry fact |
|---|---|
| Standalone development | Its own PR is merged, and close consults the local Git association proof. |
| Report-only | QC and PM Acceptance under the registered completion policy, with no PR and no merge. |
| Iteration | Every delivery PR is merged and the accepted content is on `branch.target`, verified by the primary coordinator because the engine verifies no iteration merge today (#819); the entry rests on the PR owner's merge-ready, authorization and unresolved-thread evidence — `pr-delivery.md`「Merge-ready checklist」,「Merge authorization」and「Unresolved conversation gate」 — including an owner self-merge before confirmation, which enters close with that head's per-thread dispositions recorded under「Unresolved conversation gate」. |

## Entry

1. Print `## Phase 6: post-merge close`.
2. Append the host todo `phase-6-post-merge-close` (session todos SSOT → `mstar-iteration/references/command-shared-invariants.md`).
3. Resumable: close may run in a later session, and it is idempotent against an already terminal lifecycle (a fully closed retry changes no authoritative target and does not rewrite `ended_at`).

Ordered pipeline (HARD — fixed order, no skipping or inversion): **Terminal write → Unregister → Projection reconciliation → Cleanup handoff.**

## Terminal write

```text
mstar status workflow-close --workflow <id> --session-ref <wire> --expect <full-execution-token> \
  --operation <id> --reason <text> [--harness <absolute-path>] [--json]
```

- Close rereads current authoritative state under its transaction, validates identity/shape, returns a valid terminal no-op, or requires all rows Done and no dangling workflow integration exclusion, then writes completed + `ended_at`. The terminal state and the DB root unregister commit in the same transaction, and a failed transition rolls back whole. Per-row execution leases are removed.
- A dangling lease, a non-`Done` row, or a missing or mismatched identity refuses the call; no failed transition is committed.
- **`type: plan` delivery-evidence consult:** a completed close runs `verifyDeliveryEvidence` (pure evidence rules plus the local Git proof) and the read-only gate reads terminal facts only without rerunning that proof. A development plan missing its compound disposition or a proved merge, or a report-only plan missing its registered completion policy, is refused with `PHASE6_DELIVERY_*`, and the current authority stays running + registered. Repair only through `mstar workflow evidence` (session reference + scope token + operation id; flags from help), never by hand-writing state; failed / stopped need no successful-delivery evidence.
- The delivery kind is declared at registration: `mstar workflow register` declares it, as does `migrate` when it lifts an ACTIVE plan; there is no invented channel to add a kind afterwards. Full registration and declaration constraints → frozen contract `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`; command shape from help.
- **Never** release a lease or forge Done to pass close — close never releases any lease, not even the caller's own. It only composes the legal bookkeeping implied by evidence the current authority records and takes no foreign ownership; releasing an exclusion belongs to direct complete in its verified attempt.
- Close records its own timestamp and does not accept a caller-supplied clock reading; `--ended-at` is a usage refusal.

## Unregister

The same command closes the lifecycle with terminal-then-unregister semantics: it unregisters from the DB root register (`execution_registry`).

- **Fixed order:** a valid terminal state first, then unregister; executed by the DB transaction, never a hand-written file.
- Close is **one transaction as a whole**: the terminal write and the DB root register unregister commit together, and either failure rolls back the whole — the workflow stays running + registered and is recoverable. A retry reruns close as a whole (no partial-close model, no unregister-only retry), and retrying a committed close is an idempotent replay that does not rewrite `ended_at`.
- A fully closed retry changes no authoritative target (the DB row) and reports already-closed.

## Projection reconciliation

Align only the projections the selected route actually has to the ACTIVE DB terminal state and the store issue rollup:

1. the `{PLAN_DIR}` authored plan — every route
2. compass `## Plans` — an iteration route only; the iteration README is prose only, with no status registration rows
3. the store project roadmap content and issue rollup — where the project has them; the project register is migration history only and is not updated

- **Never** forge a `Done` row and **never** close an open residual to match. Reconciliation invents no Done/closed, closes no entry to align, and does not relax the `zero-residual` rule; under `allow-residual`, a registered and disclosed non-blocking open R# **stays open** and does not "close along with" the lifecycle end (a real remaining finding blocks `zero-residual` delivery instead of being silently closed).
- **Never** slip new tracked product or documentation commits into the close (any step) — a newly found product fix opens its own authorized workflow.

## Cleanup handoff

Physical cleanup (integration worktree / local branch / remote branch deletion) is an **explicit separate step** after Terminal write → Unregister → Projection reconciliation — timing lane 2: the integration surface is cleaned only after a valid terminal close plus a verified merge. It covers only the merge-backed resources of the development routes: a report-only close has none and records the handoff as not applicable, while the guarded timing below is unchanged for development resources. This file fixes only the order and the guards; it does not implement deletion:

- Cleanup is **never automatic** and never bypasses ownership or merge-evidence guards. The contract body (ownership, merge evidence, refusals, apply order) has one home → **`mstar-branch-worktree`**「Worktree / branch cleanup」; this section is only the call site.
- `mstar worktree cleanup --workflow <id> [--harness <path>] [--apply] [--remote] [--worktree <path>] [--all-workflows] [--verbose]` — dry-run by default, printing `verdict | kind | ref | reason` per candidate (flag semantics, default candidate scope and guards live in the owning contract above); check that every protected row reads `keep`/`refuse` in the dry run before `--apply`.
- Cleanup/close never releases an exclusion to force eligibility. Direct complete owns release for its verified attempt; a remaining foreign or in-flight claim stays protected and must be resolved through its owning authority. Never hand-edit state or revive a transfer sequence.
- A squash-merged branch (its tip is not an ancestor of base) → STOP → residue; **never** `git branch -D`.

The close-state gate checks **local state only** (valid terminal shape + no dangling lease + root entry unregistered + `type: plan` delivery evidence); it does **not** verify remote merged evidence and does **not** check whether physical cleanup happened.

> **Engine check:** run `mstar iteration gate --phase 6 --workflow <id>` (engine `evaluatePostMergeCloseFromExecutionAuthority`) — a read-only close-state probe over the local post-merge close state (valid terminal shape + no dangling lease + root entry unregistered; stable codes `PHASE6_*`; an invalid or unreadable root is not proof that the entry is unregistered). On `fail`, do not proceed — fix and re-run. Contract → `mstar-use-cli/references/checks-and-lints.md` § Engine check callouts.

## Standalone plans and abandonment

- The semantic authority for a standalone plan's delivery lifecycle (register → delivery tail or a registered report-only completion policy → proved merge where the route merges → terminal close) is the frozen contract `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`; this file fixes the close side only (same close command; the local gate verifies no remote merged evidence).
- A `type: plan` standalone lifecycle closes with the **same** completed-close command — after its PR merges for a development plan, or under its registered completion policy with no merge for a report-only plan (no second verb, no `--outcome` / `--force`).
- An abandoned lifecycle **must not** silently run completed close: an already terminal (`failed` / `stopped`) lifecycle keeps its state and the CLI reports the actual status; completed close belongs only to a satisfied route completion — a proved merge where the route merges, or the registered completion policy where it does not.

## Evidence

Close is complete when the ACTIVE `mstar status workflow-close` applied/replay receipt is retained, terminal `completed` + `ended_at` and the same-transaction unregister are confirmed, `mstar status validate` (no explicit file path) confirms the current DB root register does not contain the id, and `mstar iteration gate --phase 6 --workflow <id>` exits 0 with no dangling lease and consistent narrative projections. A current ACTIVE read does not return unregistered workflow history, so root absence alone is not terminal proof. Tick the host todo when done.

## References

- When routing the close or judging a phase-transition boundary: route / transition-gate SSOT → `mstar-iteration` SKILL.md「Phase route map」+「Phase transition gates」; standalone routes → `mstar-roles/references/project-manager/plan-management.md`
- Open when writing a close receipt, judging terminal `completed` + `ended_at`, or needing lease semantics and `unregisterWorkflow`: `mstar-artifacts/references/status-and-residuals.md`
- Cleanup ownership / guard contract body (two timing lanes) → `mstar-branch-worktree`「Worktree / branch cleanup」
