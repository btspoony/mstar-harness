---
name: mstar-roles
description: Morning Star role prompt hub — `agents/*.md` shells plus full behavior in `references/*.md`. Role files are **identity-first** (mission / responsibilities / NEVER rules); topic `mstar-*` skills appear only as **PM-activated skill presets** (Assignment `Skill presets:` field), not default dependencies. Always load for any Morning Star role (`project-manager`, `product-manager`, `architect`, `code-reviewer`, `fullstack-dev`, `fullstack-dev-2`, `frontend-dev`, `qa-engineer`, `qc-specialist*`, `ops-engineer`, `writing-specialist`, `prompt-engineer`). Cross-role **Role → skill presets** summary in this SKILL.md; per-role preset menus in `references/*.md` are authoritative once PM activates them. Full topic skill index → **`mstar-harness-core`**.
---

## Load Order

When a Morning Star role starts work in a session:

1. Read this `mstar-roles` skill; resolve role mapping and parameter tables below.
2. Read the corresponding `references/<role>.md` file — **identity-first**: mission, scope, and NEVER rules come before any skill list.
3. Load topic skills per the Assignment **`Skill presets:`** field, following that role's **Skill Preset (PM-Activated)** section. Omitted on an implementation / QC / QA round ⇒ the role's `standard` preset applies by default; explicit `Skill presets: none` (or a trivial route) ⇒ execute from identity + assignment alone without topic skills. Whenever `mstar-harness-core` is loaded, it remains the global entry (state machine, gates, routing).
4. Expand placeholders from role parameters before execution.

If any conflict appears, `mstar-harness-core` remains the authoritative source for lifecycle, gates, routing, and invariants. The table below summarizes each role's preset menu; when a role file's preset section differs, follow the role file for that session.

Exception: `project-manager` is the core orchestrator and keeps **required reading** (not a preset) — see `references/project-manager.md`.

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

### Role → skill presets (PM-activated)

PM-owned activation with a safe default: omitted `Skill presets:` on an implementation / QC / QA round means `standard`; explicit `none` runs identity-only. Rows summarize each role's preset menu — role-owned files (e.g. `references/qc-specialist/`, `references/qa-engineer/acceptance-gate.md`) are excluded; they always load with the reference.

| Role | Preset menu |
| --- | --- |
| `project-manager` | `mstar-dispatch-gates`, `mstar-phase-gates`, `mstar-conventions`, `mstar-roles` ref; + `references/project-manager/qa-trigger-matrix.md` for QA gate tiers; + `mstar-review-qc` before QC; + `mstar-branch-worktree` / `mstar-artifacts` as the round requires; + `mstar-skill-authoring` for skill work; + `mstar-iteration` for iteration lifecycle (start/drive/close); + `mstar-strategy` for strategic alignment; + `mstar-compound` / `mstar-compound-refresh` pre-loaded by `mstar-iteration` § iteration-close |
| `fullstack-dev*`, `frontend-dev` | `mstar-coding-behavior`, `mstar-dispatch-gates`, `mstar-branch-worktree` (if repo writes); plan path symbols from `mstar-conventions` (minimal); `mstar-design-md` when implementing styled UI |
| `qc-specialist*` | Presets: `mstar-branch-worktree`, `mstar-artifacts` (review bundle paths); `mstar-design-md` when reviewing UI. Role-owned (never gated): `references/qc-specialist/` workflow/checklist/template (+ lenses on demand) |
| `qa-engineer` | Presets: `mstar-branch-worktree`, `mstar-artifacts` (closing R#); `mstar-design-md` when verifying visual output. Role-owned (never gated): `references/qa-engineer/acceptance-gate.md` |
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
- Role references stay **identity-first**: mission / responsibilities / NEVER rules before any skill list; topic-skill loads live only in the **Skill Preset (PM-Activated)** section.
- Add new roles by updating mapping, parameters (if needed), and adding corresponding `agents/*.md` shell.

## Workflow

加载顺序：Read 本 skill（角色映射 + 参数表）→ 解析对应 `references/<role>.md`（身份优先：mission / NEVER / responsibilities 在前）→ 按 Assignment 的 `Skill presets:` 字段加载专题 skill：实质轮次（implementation / QC / QA）缺省即默认该角色的 `standard` 预设；显式 `none`（或 trivial 路由）则以身份 + Assignment 执行。映射 / 参数表与磁盘 `references/*.md` 布局不符时先修再继续。

## Evidence

正确结果 = 角色映射与加载契约可机器校验：`mstar roles validate` 通过（映射 + 加载顺序 0 violations，见上方 Engine check blockquote 的 import 形态），`references/*.md` 布局与上表一一对应，shared-family 角色共用同一 reference 文件（引擎校验可用时先跑；不可用时以本文件为准）。

## References

- 角色正文 → `references/<role>.md`（本 skill 内；leaf QC / QA 等子目录见 `references/qc-specialist/`、`references/qa-engineer/`）
- 全局角色 → `mstar-harness-core` 加载矩阵与专题 skill 索引
