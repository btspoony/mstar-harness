---
name: mstar-roles
description: Morning Star role prompt hub. This skill is the single entry for role-specific behavior text: `agents/*.md` remain lightweight shells (frontmatter + role parameters), while full role behavior lives in `references/*.md`. Always load this skill for any Morning Star role (`project-manager`, `product-manager`, `architect`, `fullstack-dev`, `fullstack-dev-2`, `frontend-dev`, `qa-engineer`, `qc-specialist*`, `ops-engineer`, `writing-specialist`, `prompt-engineer`) before execution.
---

## Load Order (Required)

When a Morning Star role starts work in a session:

1. Read `mstar-harness-core` first (SKILL.md + task-relevant references).
2. Read this `mstar-roles` skill.
3. Resolve role mapping and parameter table below.
4. Read the corresponding `references/<role>.md` file.
5. Expand placeholders from role parameters before execution.

If any conflict appears, `mstar-harness-core` remains the authoritative source for lifecycle, gates, routing, and invariants.

## Role Reference Mapping

| Agent id | Reference file | Parameterized slots |
| --- | --- | --- |
| `project-manager` | `references/project-manager.md` | — |
| `product-manager` | `references/product-manager.md` | — |
| `architect` | `references/architect.md` | — |
| `fullstack-dev` | `references/fullstack-dev-shared.md` | `role_id`, `track` |
| `fullstack-dev-2` | `references/fullstack-dev-shared.md` | `role_id`, `track` |
| `frontend-dev` | `references/frontend-dev.md` | — |
| `qa-engineer` | `references/qa-engineer.md` | — |
| `qc-specialist` | `references/qc-specialist-shared.md` | `role_id`, `reviewer_index`, `focus`, `report_suffix` |
| `qc-specialist-2` | `references/qc-specialist-shared.md` | `role_id`, `reviewer_index`, `focus`, `report_suffix` |
| `qc-specialist-3` | `references/qc-specialist-shared.md` | `role_id`, `reviewer_index`, `focus`, `report_suffix` |
| `ops-engineer` | `references/ops-engineer.md` | — |
| `writing-specialist` | `references/writing-specialist.md` | — |
| `prompt-engineer` | `references/prompt-engineer.md` | — |

## Shared Skill Dependencies

Treat these as baseline dependencies **where the role touches implementation, review, verification, or ops execution** (see `mstar-harness-core` load contract).

| Skill | Use when task involves |
| --- | --- |
| `mstar-harness-core` | State machine, phase gates, task category, branch/worktree policy, dispatch anti-recursion |
| `mstar-plan-conventions` | `{HARNESS_DIR}` / `{PLAN_DIR}`, `status.json`, residual lifecycle, plan metadata |
| `mstar-review-qc` | QC workflow, review template, verdict rules, high-risk checks |
| `mstar-coding-behavior` | Think-before-coding, simplicity, surgical changes, goal-driven execution (**not** required for `project-manager` orchestration-only work) |
| `mstar-superpowers-align` | Superpowers alignment, dispatching/worktree constraints, delegation compatibility |
| `mstar-host-opencode` / `mstar-host-cursor` | Host-specific behavior and capabilities (match the active host) |

Use skill names (not absolute filesystem paths) in role references.

Role `references/*.md` files include explicit **`NEVER`** sections (anti-recursion, tool misuse, Git discipline). Treat those bullets as **hard gates** alongside `mstar-harness-core`; do not treat them as optional style tips.

## Parameter Table (SSOT)

### Dev track (`fullstack-dev` family)

| role_id | track | Meaning |
| --- | --- | --- |
| `fullstack-dev` | `primary` | Backend-led primary implementation track |
| `fullstack-dev-2` | `parallel_secondary` | Second implementation track for parallel independent modules |

### QC reviewer (`qc-specialist*` family)

| role_id | reviewer_index | focus | report_suffix |
| --- | --- | --- | --- |
| `qc-specialist` | `1` | Architecture coherence and maintainability risk | `qc1` |
| `qc-specialist-2` | `2` | Security and correctness risk | `qc2` |
| `qc-specialist-3` | `3` | Performance and reliability risk | `qc3` |

## Maintenance Rules

- Edit behavior in `references/*.md`.
- Edit role family parameters in this file.
- Keep shared-family roles (`fullstack-dev*`, `qc-specialist*`) on one shared reference file.
- Add new roles by updating mapping, parameters (if needed), and adding corresponding `agents/*.md` shell.
