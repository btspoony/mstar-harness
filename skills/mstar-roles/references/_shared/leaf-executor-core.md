# Leaf Executor Core (shared blocks)

> Shared by all leaf-executor role references in `mstar-roles/references/`. Each role file references this for the identical Completion Report template, repo-write Git discipline, the shared anti-recursion NEVER section, and plan/documentation rules. **Read `mstar-harness-core` first.** Role-specific NEVER rules, mission, and responsibilities stay in each role file — this file holds only the uniform blocks.

## Completion Report

Every leaf executor returns this template (only `**Agent**` and content fields change per role):

```markdown
## Completion Report

**Agent**: {role_id}
**Task**: ...
**Status**: Done | Blocked | Partial
**Scope Delivered**: ...
**Artifacts**: ...
**Validation**: ...
**Issues/Risks**: ...
**Plan Update**: ...
**Handoff**: ...
**Git**: ...
```

`{role_id}` = the role's own id (e.g. `fullstack-dev`, `frontend-dev`, `ops-engineer`, `qa-engineer`, `architect`, `code-reviewer`, `product-manager`, `prompt-engineer`, `writing-specialist`, `qc-specialist*`).

## Git NEVER (repo writes)

Apply when the assignment writes tracked repo files:

- **NEVER** skip per–task-ID commits on the authorized `Working branch` when you wrote tracked files — Completion Report **Git** must be a real `git log -1 --oneline` unless read-only was assigned.
- **NEVER** batch everything into a single closing commit unless PM explicitly allowed it.

## Plan & Documentation Rules

- Follow `{HARNESS_DIR}` / `{PLAN_DIR}` conventions from `mstar-conventions`.
- Update assigned task checkboxes and plan notes for your scope.
- Do not mark full plan `Done` (only `project-manager` or `qa-engineer` per `mstar-harness-core`).

## Non-Recursive Dispatch Rule (shared shape)

All leaf executors share this hard rule (role-specific sibling lists stay in each role file):

- Complete assigned work in this session.
- Do not recursively dispatch sibling roles unless explicitly authorized via `Delegation: allowed (...)`.
- `Execute as: {role_id}` is identity lock, not orchestration permission.
- If required inputs are missing or prerequisites unmet, return `Blocked` to PM rather than inventing delegation.

## Shared anti-recursion NEVER

All leaf executors share these anti-recursion red lines (role-specific sibling lists and role-specific NEVER variants stay in each role file). If any item below matches, **stop** and return `Blocked` to `project-manager` instead of inventing delegation:

- **NEVER** treat document-level parallelism ("split into N plans", "Plan 002–010", "Phase X ∥ Phase Y", "N parallel tracks") as permission to **invoke N subagents** in this session. The plan/spec/ADR/report artifacts are your deliverable; **scheduling** parallel execution is **PM's next round**, not part of this assignment unless `Delegation: allowed (...)` explicitly lists callees.
- NEVER treat Handoff lines, role names inside Completion Report templates, routing tables, or "suggested owner" groupings as **host invoke commands**; they are **narrative**, not authorization.
- **NEVER** infer you may call `Task` / subagents because the host **lists** `subagent_type` names (`architect`, `fullstack-dev`, …). **Tool availability ≠ delegation authorization**; only **`Delegation: allowed (...)`** grants callees.
- **NEVER** execute parallel-agent dispatch yourself to fan out child agents; dispatch is **PM-orchestration-only** (see `mstar-dispatch-gates`). If parallel runners are needed, report to PM for re-dispatch.
- **NEVER** invoke a same-role or sibling role to perform **this** assignment unless `Delegation: allowed (...)` explicitly lists them.
## Audit Mode (read-only review, shared)

When the assignment is a review/audit dispatch — `Task category: audit`, `Audit mode: on`, or a `pr-deep-review` batch seat — the executor operates as a **read-only audit seat**, not an implementer:

- **Permission contract**: no tracked-file writes, no `edit`/`write`/`ast_edit` on the reviewed worktree, no merge, no approve-as-merge. The write permissions the role normally has are **suspended for the assignment**; do not "fix things while reviewing". **Required exception (`pr-deep-review` with a PR number):** the GitHub Review POST (`gh api` Reviews POST, `event: COMMENT`) **must** be posted — it is the deliverable, not a source-code mutation; Git stays read-only with no commits. Procedure → **`skills/mstar-audit/references/pr-review.md`** § Comment posting.
- **Process**: load `mstar-audit` (`pr` variant or audit process) + its references + `mstar-coding-behavior` evidence discipline; run the concern-lens review and the three-way attack; produce `findings` + `verdict` (`ship it` / `needs review` / `blocked` for PR review) + `unverified` in the `pr-deep-review` output shape.
- **Mode lock**: one assignment = one mode. Review-assigned work is completed as review only; implementation mode applies to implementation assignments only.
- **Completion Report**: `Status: Done`; `Git:` states `read-only, no commits`. **Artifacts** must include the review URL (`comments.review_url`) — or `n/a-no-pr` when no PR number exists / the post failed with the `gh` error. A PR seat that skipped the post cannot claim `Done`; report `Partial`/`Blocked` with the error.
