---
name: mstar-pr-loop
description: "Opt-in skill loaded when the user explicitly asks for a review → fix loop on an existing ready PR, or when iteration Phase 1 selects it as that iteration's `pr_merge_policy: reviewed-auto` review path. It never activates for routine review requests or on its own initiative."
---

# PR Review-Fix Loop

## Load Order

1. `mstar-harness-core` — lifecycle and authorization authority.
2. `mstar-audit`, `pr` variant → `references/pr-review.md` — review execution, re-review, verdict synthesis, posting and archival contracts.
3. `mstar-iteration` → `references/phase-4-5-pr-delivery.md` §5.0 / §5.1a — iteration fix-worktree discipline and push cadence; §5.0 applies only to iteration Phase 5.
4. `mstar-branch-worktree` — checkout authorization and the three-domain write table.
5. `mstar-dispatch-gates` — Assignment fields, writable dispatch and leaf boundaries.

Optional external review-seat channel (not part of the required reading order) — the channel reference under References applies only when this session can load a terminal-agent skill whose probe passes and the host has a matching agent kind; the default path above stays complete without it.

The project-manager orchestrates; implementers fix; review seats remain read-only. Loading the review variant does not authorize its seats to implement fixes.

## Scope

Enter only on the user's explicit request to loop review → fix on an existing ready PR, or when the active iteration recorded `pr_merge_policy: reviewed-auto` at its Phase 1. This is not routine review, and the loop never starts on its own initiative.

Under a recorded `reviewed-auto` this loop is that iteration's Phase 5 review gate, and its `ship it` row is the merge authorization `mstar-iteration` → `references/phase-4-5-pr-delivery.md` §5.3 reads. Outside such a recorded policy a `ship it` exit authorizes nothing: no merge, no lifecycle Done.

- Resolve `pr:<n>` preferentially, otherwise a branch with an open PR. If resolution fails or the PR is not ready, refuse with the actual cause and accepted forms: `pr:<n>` or a branch with an open, ready PR; supply that target or make the existing PR ready, then retry this entry.
- Accept one optional tier: `quick`, `default` or `deep`; otherwise use the review's own inference ladder (§ Review depth (tiers)), not a loop-specific default.
- An optional user-supplied round budget has no default. Honor an explicit budget or interruption, retain the latest report and residuals, and name the user action needed to resume; never invent a numeric round ceiling.

The loop does not own CI babysitting, review-thread resolution or the merge-ready gate; those remain with iteration Phase 5 / its separately discovered babysit helper. Never submit `APPROVE` or `REQUEST_CHANGES`, merge a PR, or close a finding-capture issue. A deferred-PR tracking issue must still be closed through the existing closure authority at that PR's review completion (`mstar-audit` → `references/pr-review.md` § Batch sibling PRs). A `ship it` exit is review-loop success, never lifecycle Done, and it authorizes a merge only where a recorded `pr_merge_policy: reviewed-auto` names it as that authorization.

## Workflow

One round is a review and its tally-derived transition, followed by a qualifying fix batch when required:

1. Check the current head's push gate (`mstar iteration push-cadence`) using §5.1a. Local diagnosis and fix commits may proceed while waves run, but head updates wait for idle CI and AI-review waves.
   - When the external review-seat channel is available, steps 2–3 (review, tally, synthesis and posting) run inside it: this session dispatches the round to that channel's independent host session, reads the archived report, and coordinates fixes for step 1, step 4 and the round loop.
2. Run the `mstar-audit` `pr` variant against the resolved PR head. Round 1 is a full review. Round 2 onward follows § Re-review (same target, later head): a settled ancestor report permits the covering path, revalidation of prior findings and the increment pack; otherwise review the full diff and state why. Use § Local report archive for `report.md` / `report-rN.md` and immutable evidence paths; do not overwrite prior reports.
3. Synthesize the current tally and verdict through § Verdict synthesis. Post a new `COMMENT` review and save the report under § Comment posting / § Local report archive; never rewrite or resolve prior threads. Posting failure retains the local report and error, not a success claim.
4. Apply the verdict transition table. For dispatchable findings, the PM issues bounded implementer Assignments through `mstar-dispatch-gates`, naming the finding, fix sketch, authorized branch, absolute fix-worktree path and scoped verification. Implementers commit locally at the fix site below; the PM performs any iteration integration merge serially. After the push gate is idle, batch the local fixes into one push, wait for the new head's waves, and begin the next review round.

> **Engine check (when available):** use `mstar pr-review report-path`, `mstar pr-review tally`, `mstar pr-review validate-report`, `mstar pr-review worktree-setup`, `mstar pr-review seat-prompt`, `mstar pr-review post`, `mstar pr-review budget`, and `mstar iteration push-cadence` for the corresponding existing review and push checks. Read current verb help for arguments; a failed check requires repairing its cause and rerunning it, not bypassing the contract. Skill text below remains authoritative when the runtime is absent

## Decision Rules

### External-seat channel

1. The seat session is the round's main agent; this session never synthesizes, posts or re-verifies findings.
2. Fixes remain dispatched Assignments (§ Fix sites unchanged); the coordinator does not edit the PR.
3. Reuse the same channel session for the whole loop — a later round is a re-review of the same target, and the command resolves the prior report.
4. Read the archived report file before any transition; pane output alone is not evidence.

### Verdict transitions

| Verdict | Transition |
| --- | --- |
| `ship it` | Exit success only when the report is settled, `comments: posted`, and its `head` equals the current PR head. Otherwise repair posting/evidence or review the current head before claiming success. |
| `incomplete` | Never a fix round. Repair the cause/coverage recorded in `incomplete_reason` and `unscanned`, then rerun the same round without consuming a fix round. If unrepairable, stop as Blocked with recovery. No implementation dispatch. |
| `needs fixes` | Dispatch fixes only for qualifying findings under the fixable-finding rule below, then re-review the updated PR head. |
| `blocked` | Triage each finding, not a blanket keep-fixing instruction: only `file:line` + fix sketch + merge class `must-fix` / `should-fix` is dispatchable. Product, permission or external decisions stop the loop and are reported to their decision owner. |

Leftover `unmet` acceptance criteria are separate tally increments, not findings (§ Linked-issue hygiene in `mstar-audit` → `references/pr-review.md`). If they produce `needs fixes` or `blocked`, even with zero findings, stop as Blocked naming each criterion, its responsible owner and the recovery: that owner authorizes and completes the missing implementation or supplies the required decision, then rerun this entry against the current PR head. Never emit a duplicate Merge-class finding for the same criterion.

### Fix sites

| PR context | Head and fix site |
| --- | --- |
| Iteration PR | PR head = `branch.integration`; edit and commit in a fix feature worktree, then serially merge into the integration worktree. Follow §5.0, which is Phase-5-only. |
| Standalone `development` plan | PR head = registered `branch.work`; commits land in a dedicated worktree checked out on that branch, never the primary checkout. |

The iteration merge ritual is not generalized to standalone plans.

### Fixable findings and push discipline

- Dispatch only findings with `file:line`, a fix sketch and merge class `must-fix` or `should-fix`; do not dispatch `nit` by default. Missing evidence returns to review triage, not speculative implementation. Findings requiring product, permission or external decisions stop and report the decision needed.
- Fix commits stay local in the fix worktree until CI and AI-review waves are idle (§5.1a); then push one batch. Do not rebase or force-push inside the loop: rewritten history degrades the next round to a full review (§ Re-review).
- Keep product edits out of the primary checkout; review worktrees stay read-only. Report/evidence placement follows the review archive contract and `mstar-branch-worktree`'s three-domain table, not the fix-worktree location.

### Stop and recovery

Reuse `mstar-iteration` → `references/command-shared-invariants.md` § Continuous execution STOP list: real conflict, secrets, an irreversible scope gap or repeated failure to converge means Blocked. Report the latest review path, residual finding list and actual blocker without exposing secret values. Name the recovery path: the responsible owner resolves the conflict, rotates/removes exposed secrets, decides the scope gap or supplies the missing decision/permission; then rerun the same entry against the current PR head. Unrepairable coverage or posting failures likewise retain the report and name the concrete repair needed. Do not replace these semantics with a fixed round limit.

## Evidence

Return the PR identity and current head, latest report path and review URL, tally-derived verdict, fix commits and scoped checks actually exercised, plus residual findings (issue id and revalidated state when captured; `none` when empty). Success requires the `ship it` row's complete predicate. Blocked or budget-limited exits include unresolved state and a named recovery path; fixed findings do not authorize issue closure.

## References

- Review, tier inference, revalidation, settlement, tally, new COMMENT posting and report archival → `mstar-audit` → `references/pr-review.md` §§ Re-review (same target, later head), Verdict synthesis, Review depth (tiers), Comment posting, Local report archive.
- Iteration-only fix integration and shared push timing → `mstar-iteration` → `references/phase-4-5-pr-delivery.md` §5.0 / §5.1a; legal STOP semantics → `references/command-shared-invariants.md`.
- Checkout/write-domain ownership → `mstar-branch-worktree`; Assignment and dispatch shape → `mstar-dispatch-gates`.
- External review-seat channel → `references/herdr.md`.
