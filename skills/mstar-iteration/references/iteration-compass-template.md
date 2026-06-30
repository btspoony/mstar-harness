# Iteration Compass Template

Copy this template when creating a new iteration compass in `{ITERATION_DIR}/`.

```markdown
---
iteration_id: <id>
start_date: YYYY-MM-DD
status: active
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

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| <risk> | Low/Med/High | Low/Med/High | <mitigation> |

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
| `iteration_id` | Yes | iteration-start |
| `start_date` | Yes | iteration-start |
| `end_date` | No | Add at iteration-close §3.4 only |
| `status` | Yes | iteration-start → `active` / `locked`（§1.6 PM lock）；iteration-close §3.4 → **`completed`**（YAML frontmatter，非 prose completion status） |
| `plans` (frontmatter) | Recommended | iteration-start (initial), iteration-drive (add new) |
| `## Plans` table | Yes | iteration-drive (sync status), iteration-close (final) |
| `## Milestones` | Recommended | iteration-start, iteration-drive (update) |
| `## Acceptance Criteria` | Yes | iteration-start |
| `## Non-Goals` | Yes | iteration-start |
| `## Roadmap Position` | **Yes** | iteration-start（必填节，非散落于 general context prose）；iteration-close §3.3（current iteration → `delivered`） |
| `## Risk Register` | Optional | iteration-start, iteration-drive (update) |
| `## Compound Round Summary` | Yes | iteration-close §3.4 |
| `## Iteration Retrospective` | Recommended | iteration-close §3.4 |

## Legacy compass drift

若仓库中已有 compass **无** YAML frontmatter、**无** `## Roadmap Position`，或只有 prose completion status：

- **新迭代**：iteration-start 必须按本模板重写，不延续 prose-only 惯例。
- **收口时**：`mstar-iteration` §3.0.5 在 iteration-close 入口规范化，再执行 §3.3–§3.4。
