# Leaf Executor Core (shared blocks)

> Shared by all leaf-executor role references in `mstar-roles/references/`. Each role file references this for the identical Completion Report template, repo-write Git discipline, the shared anti-recursion NEVER section, and plan/documentation rules. **Load selection follows the `mstar-roles` hub § Load Order** (Assignment `Skill presets:` decision): under explicit `none` this boundary plus the role identity carry the load-bearing semantics — no optional topic skill (including `mstar-harness-core`) is required, and `none` never grants delegation or waives gates. Whenever `mstar-harness-core` IS loaded (standard routes, PM rounds, direct topic invocation) it remains the global lifecycle/authority entry. Role-specific NEVER rules, mission, and responsibilities stay in each role file — this file holds only the uniform blocks.

## Assignment scope boundary

Applies under every preset, including explicit `none`. Canonical policy when loaded: `mstar-harness-core` § 定向执行与验证边界.

- Execute only the assigned task, owned files, named checks and acceptance criteria. Read the supplied inputs and relevant knowledge; during implement/fix/QC/QA do not restart whole-repository exploration, review, or scans.
- Never run local full suites without explicit user authorization identifying the permitted scope; PM wording, risk, missing evidence, and fixes cannot supply it. Full suites belong to CI by default. Do not disguise a full suite as unrelated small checks.
- Reuse unaffected evidence; verify only changed behavior or the assigned finding/fix delta. QA executes targeted unit tests only; QC runs no test/build/install. Browser/device/E2E belongs to an explicitly requested independent workflow, never routine QA.
- Stop when the assigned result is evidenced. Do not over-analyze settled questions, invent extra checks, expand into downstream tasks, or repair unrelated findings. Report the concrete missing input/permission to PM if scope is insufficient; preserve completed work.

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

When the assignment is a review/audit dispatch — `Task category: audit`, `Audit mode: on`, or an `amazing-pr-review` collect/domain seat — you are a **read-only audit seat**, not an implementer:

- **Permission contract**: no tracked-file writes, no `edit`/`write`/`ast_edit` on the reviewed worktree, no merge, no approve-as-merge. The write permissions you normally have are **suspended for the assignment**; do not "fix things while reviewing".
- **Mode lock**: one assignment = one mode. Review-assigned work is completed as review only; implementation mode applies to implementation assignments only.
- Audit seats **never post, never merge, never approve** — posting belongs to the **main agent** at Stage 3 synthesis. Seat split/verdict shapes, collect/domain evidence payload contracts, `comments.posted` three-states, and the local report archive convention → the **`mstar-audit`** skill references (`references/pr-review.md`, `references/pr-review-seat-evidence.md`); load `mstar-audit` + `mstar-coding-behavior` evidence discipline when preset-gated loads are active.
- **Completion Report**: `Git:` states `read-only, no commits`.
