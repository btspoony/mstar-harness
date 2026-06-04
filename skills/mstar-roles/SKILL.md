---
name: mstar-roles
description: Morning Star role prompt hub — `agents/*.md` shells plus full behavior in `references/*.md`, each with a **Required Skill Dependencies** list (which `mstar-*` topic skills to load after `mstar-harness-core`). Always load for any Morning Star role (`project-manager`, `product-manager`, `architect`, `fullstack-dev`, `fullstack-dev-2`, `frontend-dev`, `qa-engineer`, `qc-specialist*`, `ops-engineer`, `writing-specialist`, `prompt-engineer`). Cross-role summary table in this SKILL.md; per-role lists are authoritative for that role's session.
---

## Load Order (Required)

When a Morning Star role starts work in a session:

1. Read `mstar-harness-core` first (SKILL.md), then **only** the topic `mstar-*` skills required for this role/task (see matrix below — do not read all topic skills by default).
2. Read this `mstar-roles` skill.
3. Resolve role mapping and parameter table below.
4. Read the corresponding `references/<role>.md` file — each role file lists **Required Skill Dependencies** for that role (canonical per-role load list).
5. Expand placeholders from role parameters before execution.

If any conflict appears, `mstar-harness-core` remains the authoritative source for lifecycle, gates, routing, and invariants. The table below is the cross-role summary; when a role file lists different **on-demand** skills, follow the role file for that session.

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

Treat these as baseline dependencies **where the role touches implementation, review, verification, or ops execution** (see `mstar-harness-core` load contract). Load **on demand**, not as a fixed bundle.

| Skill | Use when task involves |
| --- | --- |
| `mstar-harness-core` | **Always** (non-trivial work): entry, state machine, Task category, explore boundary, skill index |
| `mstar-phase-gates` | Prepare/Execute gates, clarify, hotfix path, intention gate |
| `mstar-dispatch-gates` | PM dispatch; **all leaf executors** before any Task/subagent call |
| `mstar-branch-worktree` | Git write, parallel worktrees, QC/QA checkout fields |
| `mstar-plan-conventions` | `{HARNESS_DIR}` discovery, init, Spec branch naming, `writing-plans` path |
| `mstar-plan-artifacts` | Main plan, `reports/`, `status.json`, residual, knowledge/iteration, Done compaction |
| `mstar-review-qc` | QC workflow, template, verdict, high-risk checks |
| `mstar-coding-behavior` | Implementation/debug/refactor (**not** PM orchestration-only) |
| `mstar-superpowers-align` | Superpowers plugin on; Assignment `Superpowers` lines |
| `mstar-host` | Host-specific behavior (auto-detect; `references/opencode.md` / `cursor.md` / `codex.md`) |

### Role → typical topic skills (after `mstar-harness-core`)

| Role | Typical adds |
| --- | --- |
| `project-manager` | `mstar-dispatch-gates`, `mstar-phase-gates`, `mstar-plan-conventions`, `mstar-superpowers-align`, `mstar-roles` ref; + `mstar-review-qc` before QC; + `mstar-branch-worktree` / `mstar-plan-artifacts` as the round requires |
| `fullstack-dev*`, `frontend-dev` | `mstar-coding-behavior`, `mstar-dispatch-gates`, `mstar-branch-worktree` (if repo writes); plan path symbols from `mstar-plan-conventions` (minimal) |
| `qc-specialist*` | `mstar-review-qc`, `mstar-branch-worktree`, `mstar-plan-artifacts` (report paths) |
| `qa-engineer` | `mstar-review-qc`, `mstar-branch-worktree`, `mstar-plan-artifacts` (closing R#) |
| `architect`, `product-manager` | `mstar-phase-gates` (Prepare), `mstar-plan-artifacts` (knowledge/specs) |
| `ops-engineer` | `mstar-coding-behavior`, `mstar-branch-worktree` |
| `prompt-engineer` | All topic skills when editing harness text |

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
| `qc-specialist` | `1` | Architecture coherence and maintainability risk | `qc1` → `{PLAN_DIR}/reports/<plan-id>/qc1.md` |
| `qc-specialist-2` | `2` | Security and correctness risk | `qc2` → `…/qc2.md` |
| `qc-specialist-3` | `3` | Performance and reliability risk | `qc3` → `…/qc3.md` |

PM consolidated: `…/qc-consolidated.md` (same folder; no `<plan-id>` basename prefix). Naming SSOT: `mstar-plan-artifacts/references/plan-files-and-reports.md`.

## Maintenance Rules

- Edit behavior in `references/*.md`.
- Edit role family parameters in this file.
- Keep shared-family roles (`fullstack-dev*`, `qc-specialist*`) on one shared reference file.
- Add new roles by updating mapping, parameters (if needed), and adding corresponding `agents/*.md` shell.
