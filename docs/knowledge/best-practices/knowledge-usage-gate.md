---
module: harness skills
date: 2026-08-22
last_updated: 2026-11-09
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 20260822-skill-pointer-hygiene
tags:
  - knowledge-usage
  - knowledge-index
  - info-source-priority
  - iteration-research
  - pre-implement
applies_when:
  - 任何 mstar 项目开始非平凡工作前
  - iteration-start Research 阶段
  - implement 派发前
---

# Knowledge 使用门禁：结晶必须可被发现并被使用

## Context

`{KNOWLEDGE_DIR}` 是项目经验结晶的 SSOT（iteration-close 经 `mstar-compound` 写入）。但「只结晶不使用」会让知识库沦为死档案：101 篇知识文档若无消费路径，等于没有。

Audit 2026-08-22 发现：原 harness 中 knowledge 的使用是**条件式**的——implement 前读取依赖 `plans[].metadata` 登记了 `primary_spec`/`spec_refs` 等链接；PM 若忘了登记，implementer 默认不读知识库。核心入口（信息源优先级、iteration-start Research）也没有 knowledge 索引。

## Guidance

**发现（discover）而非仅登记（honor）**：knowledge 消费分两层，两层都要：

1. **索引级发现（默认）**：`{HARNESS_DIR}/store.db` 的 catalog（`kind=document`、`document_kind=knowledge`、`lifecycle=active`）是发现入口（`mstar catalog list`）。`{KNOWLEDGE_DIR}/README.md` 若存在仅为散文导览，无登记行义务。
   - `mstar-harness-core` 信息源优先级 = 用户指令 → `AGENTS.md`/`CLAUDE.md` → **当轮相关 knowledge 文档（登记/完整性查 catalog）** → `mstar-*` skills → 角色正文。
   - Knowledge **永不**高于用户 / AGENTS。
   - 只查 catalog 元数据（title/description）+ 读相关 Active 行，不要求通读全库。
2. **链接级登记（增强）**：`plans[].metadata` 的 `primary_spec` / `spec_refs` / `iteration_compass` / `iteration_refs` 仍须读取（`knowledge-and-designs.md`）——登记链接是强约束，索引扫描是默认义务。

**生命周期位置**：iteration-start §1.1 Research 查 catalog 取 knowledge 候选（`mstar catalog list`）；implement 派工前默认查 catalog（即使 metadata 无链接）；iteration-close 结晶时同时检查旧知识是否过时（`mstar-knowledge` `## Workflow — Maintain`）。

## Why This Matters

- 结晶成本（compound 结构化重写 + catalog 登记）只有在使用收益存在时才划算。
- 单一入口（catalog）比「记得登记 metadata」可靠：metadata 登记是 PM 记忆负担，catalog 查询是默认动作。
- 只查 catalog 元数据不读全库 → 上下文开销可控（每次约 1 次 catalog 查询）。

## When to Apply

- 新建 mstar 项目：确认 `{KNOWLEDGE_DIR}` 的文档已在 catalog 登记，且 harness 信息源指向 catalog。
- PM 派 implement 前：检查 plan 是否有 knowledge 链接；无链接也默认查 catalog。
- 任意非平凡任务开始：先查知识库，再向用户提问（`mstar-phase-gates` clarify 纪律同源）。

## Examples

- 本迭代（iter-20260822-audit-simplify）实现前，任务 reviewer 与 implementer 通过索引发现 `architecture-patterns/` 既有模式，避免重复设计。
- 反例（改造前）：`plans[].metadata` 未登记 knowledge 链接时，implementer 不读 `{KNOWLEDGE_DIR}`，重复了既有坑。

## 相关

- `mstar-phase-gates` 信息源优先级（harness-core §信息源）
- `mstar-iteration` §1.1 Research（查 catalog）
- `mstar-knowledge`（结晶写路径 + Maintain 维护，不新增读路径）
