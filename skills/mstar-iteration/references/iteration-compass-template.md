# Iteration Compass Template

Copy this template when creating `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`.

```markdown
---
iteration_id: <id>
start_date: YYYY-MM-DD
status: active
iteration_base_branch: <branch-or-ref>
target_branch: <branch>
plans: []
---

# <iteration-id> Delivery Compass

## Scope

本迭代锁定的 spec 点：

- <spec point 1>
- <spec point 2>

## Plans

| plan_id | Name | Status | Notes |
|---------|------|--------|-------|
| <plan-id-1> | <plan name> | Todo | |
| <plan-id-2> | <plan name> | Todo | |

Status values: `Todo` | `InProgress` | `InReview` | `Done` | `Blocked`

## Milestones

| Milestone | Target date | Status |
|-----------|-------------|--------|
| Spec freeze | YYYY-MM-DD | pending |
| Dev complete | YYYY-MM-DD | pending |
| QC complete | YYYY-MM-DD | pending |
| Iteration close | YYYY-MM-DD | pending |

## Acceptance Criteria

- <迭代级验收项 1>
- <迭代级验收项 2>

## Non-Goals

- <明确排除项 1>
- <明确排除项 2>

## Roadmap Position

- **Current iteration（<iteration-id>）**：<what this iteration delivers>
- **Next iteration**：<what comes next>，触发条件：<condition>，owner：<who>
- **最终目标**：<the long-term Done definition this iteration contributes to>

## Delivery Branch Policy

> Mirror of frontmatter; keep in sync with `{HARNESS_DIR}/status.json` `metadata`.

| Field | Value |
|-------|-------|
| `iteration_base_branch` | <branch-or-ref integration branch is cut from> |
| `spec_integration_branch` | <e.g. iteration/<iteration-id>> |
| `target_branch` | <PR target after iteration-close> |

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| <risk> | Low/Med/High | Low/Med/High | <mitigation> |

## Iteration package

> Sibling paths under `{ITERATION_DIR}/<iteration-id>/` — not in `{SPECS_DIR}/` or `{KNOWLEDGE_DIR}/`. Promoted to knowledge at iteration-close via **`mstar-compound`**.

| Path | Purpose |
|------|---------|
| `guides/` | Exploration, process notes |
| `specs/` | Iteration-scoped spec drafts |
| `README.md` | Package document index (recommended when non-trivial) |

## Quality Gate Summary

> Filled at iteration-close. Human summary only; per-plan gate details stay in each main plan, and open residual SSOT stays in `{HARNESS_DIR}/status.json`.

| plan_id | QC decision | QA gate | Residuals | Durable summary |
|---------|-------------|---------|-----------|-----------------|
| <plan-id-1> | Approve / Approve with residuals / Request Changes / N/A | mandatory / pm-acceptance / report-only / N/A | none / R1,R2 / accepted | `{PLAN_DIR}/<plan>.md#review-gate-summary` |

Notes:

- Raw review bundle: `{SDD_DIR}/review/` (ephemeral; do not rely on it after Done).
- Open residual SSOT: `{HARNESS_DIR}/status.json` root `residual_findings[<plan-id>]`.

## Compound Round Summary

> Filled at iteration-close.

- 结晶文档数：<N>
- 新增 CONCEPTS.md 条目：<N>
- 触发 compound-refresh：<是/否>

## Iteration Retrospective (minimal)

> Filled at iteration-close.

- 做得好的：
- 可改进的：
- 下迭代建议：
```

## Fields guide

| Field | Required | When to fill |
|-------|----------|-------------|
| `iteration_id` | Yes | Phase 1 |
| `start_date` | Yes | Phase 1 |
| `end_date` | No | Phase 3 §3.4 only |
| `status` | Yes | Phase 1 → `active` / `locked`（§1.6 PM lock）；Phase 3 §3.4 → **`completed`**（YAML frontmatter，非 prose completion status） |
| `iteration_base_branch` | Yes | Phase 1; integration branch must be created from this ref |
| `target_branch` | Yes | Phase 1; final PR target after Phase 3 |
| `plans` (frontmatter) | Recommended | Phase 1 (initial), Phase 2 (add new) |
| `## Plans` table | Yes | Phase 2 (sync status), Phase 3 (final) |
| `## Milestones` | Recommended | Phase 1, Phase 2 (update) |
| `## Acceptance Criteria` | Yes | Phase 1 |
| `## Non-Goals` | Yes | Phase 1 |
| `## Roadmap Position` | **Yes** | Phase 1（必填节，非散落于 general context prose）；Phase 3 §3.3（current iteration → `delivered`） |
| `## Risk Register` | Optional | Phase 1, Phase 2 (update) |
| Iteration package (`guides/` / `specs/`) | Optional | Phase 1 §1.5.5; root index one row → `{ITERATION_DIR}/README.md` |
| `## Quality Gate Summary` | Yes | Phase 3 §3.4 |
| `## Compound Round Summary` | Yes | Phase 3 §3.4 |
| `## Iteration Retrospective` | Recommended | Phase 3 §3.4 |

## Legacy compass drift

若仓库中已有 compass **无** YAML frontmatter、**无** `## Roadmap Position`，或只有 prose completion status：

- **新迭代**：Phase 1 必须按本模板写入 **`{ITERATION_DIR}/<iteration-id>/delivery-compass.md`**，不延续 prose-only 或根目录 flat 文件惯例。
- **收口时**：`mstar-iteration` §3.0.5 在 Phase 3 入口规范化，再执行 §3.3–§3.4。
- **Legacy path**：若仍存在 `{ITERATION_DIR}/<iteration-id>-delivery-compass.md`，读时兼容；本轮若改写该迭代，迁入 `<iteration-id>/delivery-compass.md`。
