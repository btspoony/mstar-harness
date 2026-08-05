# Leaf Executor Core (shared blocks)

> Shared by all leaf-executor role references in `mstar-roles/references/`. Each role file references this for the identical Completion Report template, repo-write Git discipline, and plan/documentation rules. **Read `mstar-harness-core` first.** Role-specific NEVER rules, mission, and responsibilities stay in each role file — this file holds only the uniform blocks.

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

`{role_id}` = the role's own id (e.g. `fullstack-dev`, `frontend-dev`, `ops-engineer`, `qa-engineer`, `architect`, `product-manager`, `prompt-engineer`, `writing-specialist`, `qc-specialist*`).

## Git NEVER (repo writes)

Apply when the assignment writes tracked repo files:

- **NEVER** skip per–task-ID commits on the authorized `Working branch` when you wrote tracked files — Completion Report **Git** must be a real `git log -1 --oneline` unless read-only was assigned.
- **NEVER** batch everything into a single closing commit unless PM explicitly allowed it.

## Plan & Documentation Rules

- Follow `{HARNESS_DIR}` / `{PLAN_DIR}` conventions from `mstar-plan-conventions`.
- Update assigned task checkboxes and plan notes for your scope.
- Do not mark full plan `Done` (only `project-manager` or `qa-engineer` per `mstar-harness-core`).

## Non-Recursive Dispatch Rule (shared shape)

All leaf executors share this hard rule (role-specific sibling lists stay in each role file):

- Complete assigned work in this session.
- Do not recursively dispatch sibling roles unless explicitly authorized via `Delegation: allowed (...)`.
- `Execute as: {role_id}` is identity lock, not orchestration permission.
- If required inputs are missing or prerequisites unmet, return `Blocked` to PM rather than inventing delegation.
