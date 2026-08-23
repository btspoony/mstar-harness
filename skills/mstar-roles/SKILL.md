---
name: mstar-roles
description: Morning Star role prompt hub — `agents/*.md` shells plus full behavior in `references/*.md`, each with a **Required Skill Dependencies** list (which `mstar-*` topic skills to load after `mstar-harness-core`). Always load for any Morning Star role (`project-manager`, `product-manager`, `architect`, `code-reviewer`, `fullstack-dev`, `fullstack-dev-2`, `frontend-dev`, `qa-engineer`, `qc-specialist*`, `ops-engineer`, `writing-specialist`, `prompt-engineer`). Cross-role **Role → typical topic skills** summary in this SKILL.md; per-role lists in `references/*.md` are authoritative for that role's session. Full topic skill index → **`mstar-harness-core`**.
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
| `code-reviewer` | `references/code-reviewer.md` | — |
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

### Role → typical topic skills (after `mstar-harness-core`)

| Role | Typical adds |
| --- | --- |
| `project-manager` | `mstar-dispatch-gates`, `mstar-phase-gates`, `mstar-conventions`, `mstar-roles` ref; + `references/project-manager/qa-trigger-matrix.md` for QA gate tiers; + `mstar-review-qc` before QC; + `mstar-branch-worktree` / `mstar-artifacts` as the round requires; + `mstar-skill-authoring` for skill work; + `mstar-iteration` for iteration lifecycle (start/drive/close); + `mstar-strategy` for strategic alignment; + `mstar-compound` / `mstar-compound-refresh` pre-loaded by `mstar-iteration` § iteration-close |
| `fullstack-dev*`, `frontend-dev` | `mstar-coding-behavior`, `mstar-dispatch-gates`, `mstar-branch-worktree` (if repo writes); plan path symbols from `mstar-conventions` (minimal); `mstar-design-md` when implementing styled UI |
| `qc-specialist*` | `mstar-branch-worktree`, `mstar-artifacts` (review bundle paths); `references/qc-specialist/` (workflow, checklist, template, lenses); `mstar-design-md` when reviewing UI |
| `qa-engineer` | `mstar-branch-worktree`, `mstar-artifacts` (closing R#); `references/qa-engineer/acceptance-gate.md`; `mstar-design-md` when verifying visual output |
| `architect`, `product-manager` | `mstar-phase-gates` (Prepare), `mstar-artifacts` (knowledge/specs); `mstar-design-md` (creator + design intent); `mstar-strategy` (STRATEGY.md creation/maintenance) |
| `code-reviewer` | `mstar-sdd` (per-task review mode); `mstar-audit` (audit mode: full workflow); `mstar-conventions` (paths); `mstar-artifacts` (plan-quality-bar for audit plans) |
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

**Job:** Independent **code review** on the plan branch diff (logic, security, contracts, maintainability, reliability). **Not** test execution — suites/builds belong to implementer (L1) and `qa-engineer` (L4). See `mstar-review-qc/references/review-responsibility-boundaries.md`.

**Default (SDD):** plan QC tri-review — `qc-specialist` / `qc-specialist-2` / `qc-specialist-3` → `{SDD_DIR}/review/qc1.md`…`qc3.md` + `qc-consolidated.md` when **`Execution mode: sdd`**.

**Exception (`inline` / hotfix):** single-seat → `{SDD_DIR}/review/qc.md` (`QC mode: single`).

| role_id | reviewer_index | focus | report_suffix |
| --- | --- | --- | --- |
| `qc-specialist` | `1` | Architecture coherence and maintainability risk | `qc1` → `{SDD_DIR}/review/qc1.md` |
| `qc-specialist-2` | `2` | Security and correctness risk | `qc2` → `{SDD_DIR}/review/qc2.md` |
| `qc-specialist-3` | `3` | Performance and reliability risk | `qc3` → `{SDD_DIR}/review/qc3.md` |

PM consolidated (tri mode): `{SDD_DIR}/review/qc-consolidated.md` (same folder; no `<plan-id>` basename prefix) + durable main-plan summary. Naming SSOT: `mstar-artifacts/references/plan-files-and-reports.md`.

> **Engine check (when available):** run `mstar roles validate` (or import `validateRoleMapping` / `lintLoadOrder` from `@mstar-harness/engine` in a host hook) to validate the mapping and parameter tables above against the on-disk `references/*.md` layout (shared families included) and lint the load-order declarations. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Maintenance Rules

- Edit behavior in `references/*.md`.
- Edit role family parameters in this file.
- Keep shared-family roles (`fullstack-dev*`, `qc-specialist*`) on one shared reference file.
- Add new roles by updating mapping, parameters (if needed), and adding corresponding `agents/*.md` shell.

## Workflow

加载顺序：Read `mstar-harness-core` → Read 本 skill（角色映射 + 参数表）→ 解析对应 `references/<role>.md` → 展开角色参数（`role_id` / `track` / `reviewer_index` 等）→ 按该角色文件的 Required Skill Dependencies 追加加载 → 执行。映射 / 参数表与磁盘 `references/*.md` 布局不符时先修再继续。

## Evidence

正确结果 = 角色映射与加载契约可机器校验：`mstar roles validate` 通过（映射 + 加载顺序 0 violations，见上方 Engine check blockquote 的 import 形态），`references/*.md` 布局与上表一一对应，shared-family 角色共用同一 reference 文件（引擎校验可用时先跑；不可用时以本文件为准）。

## References

- 角色正文 → `references/<role>.md`（本 skill 内；leaf QC / QA 等子目录见 `references/qc-specialist/`、`references/qa-engineer/`）
- 全局角色 → `mstar-harness-core` 加载矩阵与专题 skill 索引
