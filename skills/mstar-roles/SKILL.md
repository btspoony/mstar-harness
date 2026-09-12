---
name: mstar-roles
description: Morning Star role prompt hub and the **single load-selection authority** for Morning Star roles — `agents/*.md` shells plus full behavior in `references/*.md`. Role files are **identity-first** (mission / responsibilities / NEVER rules); topic `mstar-*` skills appear only as **PM-activated skill presets** (Assignment `Skill presets:` field), not default dependencies — this hub's § Load Order owns the omission / `none` / named-preset / resume / unknown-preset decision. Always load for any Morning Star role (`project-manager`, `product-manager`, `architect`, `code-reviewer`, `fullstack-dev`, `fullstack-dev-2`, `frontend-dev`, `qa-engineer`, `qc-specialist*`, `ops-engineer`, `writing-specialist`, `prompt-engineer`). Cross-role **Role → skill presets** summary in this SKILL.md; per-role preset menus in `references/*.md` are authoritative once PM activates them. Full topic skill index → **`mstar-harness-core`**.
---

## Load Order

This hub is the **single load-selection authority** for Morning Star roles (Spec A2): `mstar-harness-core` stays the lifecycle/authorization semantic authority and the global entry whenever it is loaded, but this hub owns the selection decision — core does not maintain a second mandatory-role table. When a Morning Star role starts work in a session:

1. Read this `mstar-roles` skill; resolve role mapping and parameter tables below. This bootstrap is the **one exception** to topic→core: it does not require `mstar-harness-core` first.
2. Read the corresponding `references/<role>.md` file — **identity-first**: mission, scope, and NEVER rules come before any skill list. Non-PM roles also read the linked minimal leaf boundary (`references/_shared/leaf-executor-core.md` — role-owned, always loads with the reference).
3. Apply the Assignment **`Skill presets:`** decision — explicit `none` ⇒ no optional topic preset (identity + assignment + role-owned methods only); omitted on a substantive implementation / QC / QA round ⇒ the role's `standard` preset; explicit named preset ⇒ that role's supported members; omitted on a trivial route ⇒ identity only. **Role-owned** QC/QA methods and assigned evidence obligations load regardless of preset. `none` never grants delegation and never waives gates. **Unknown preset** or missing required identity ⇒ return Needs Context / Blocked — never infer `project-manager`.
4. Whenever `mstar-harness-core` is loaded by that decision (PM required reads, `standard` routes, direct topic invocation) it remains the global entry (state machine, gates, routing); if any conflict appears, `mstar-harness-core` remains the authoritative source for lifecycle, gates, routing, and invariants.
5. Resume: retain loaded identity/contract only when the source hashes are unchanged; read changed / phase-required material; never reinterpret `none` as permission.
6. Expand placeholders from role parameters before execution.

The table below summarizes each role's preset menu; when a role file's preset section differs, follow the role file for that session.

Exception: `project-manager` is the core orchestrator and keeps **required reading** (not a preset, never preset-gated) — see `references/project-manager.md`.

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

PM-owned activation; the omission / `none` / named-preset / resume / unknown-preset rule is defined once in **§ Load Order** above — this table only summarizes each role's preset menu (role refs own their named member lists). Role-owned files (e.g. `references/qc-specialist/`, `references/qa-engineer/acceptance-gate.md`) are excluded from presets; they always load with the reference.

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

> **Engine check (when available):** run `mstar roles validate` (or import `validateRoleMapping` / `lintLoadOrder` from `@mstar-harness/engine` in a host hook) to validate the mapping and parameter tables above against the on-disk `references/*.md` layout (shared families included) and lint the load-order declarations (topics declare core-first; this hub's bootstrap is the single exception and must declare the § Load Order decision matrix). On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Maintenance Rules

- Edit behavior in `references/*.md`.
- Edit role family parameters in this file.
- Keep shared-family roles (`fullstack-dev*`, `qc-specialist*`) on one shared reference file.
- Role references stay **identity-first**: mission / responsibilities / NEVER rules before any skill list; topic-skill loads live only in the **Skill Preset (PM-Activated)** section.
- Add new roles by updating mapping, parameters (if needed), and adding corresponding `agents/*.md` shell.

## Workflow

加载顺序：Read 本 skill（角色映射 + 参数表；本 skill 即加载选择权威）→ 解析对应 `references/<role>.md`（身份优先：mission / NEVER / responsibilities 在前）+ 非 PM 角色读取其链接的 leaf 边界 → 按 § Load Order 的 `Skill presets:` 决策加载专题 skill（解释权只在 § Load Order；角色 ref 只列成员名单）。映射 / 参数表与磁盘 `references/*.md` 布局不符时先修再继续。

## Evidence

正确结果 = 角色映射与加载契约可机器校验：`mstar roles validate` 通过（映射 0 violations；加载顺序 0 violations —— 专题声明 core-first，`mstar-roles` hub bootstrap 走唯一例外并声明 identity-first / none / standard / role-owned methods / unknown-preset 决策矩阵，见上方 Engine check blockquote 的 import 形态），`references/*.md` 布局与上表一一对应，shared-family 角色共用同一 reference 文件（引擎校验可用时先跑；不可用时以本文件为准）。

## References

- 角色正文 → `references/<role>.md`（本 skill 内；leaf QC / QA 等子目录见 `references/qc-specialist/`、`references/qa-engineer/`）
- 全局角色 → `mstar-harness-core` 加载矩阵与专题 skill 索引

- Explicit independent E2E/browser/device requests → `mstar-e2e` (PM orchestrates; `ops-engineer` executes; routine QA does not trigger it).
