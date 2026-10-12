---
name: mstar-compound
description: Morning Star 知识结晶 —— 将已解决问题的经验沉淀为结构化知识文档，存入 `{KNOWLEDGE_DIR}`；迭代收口时从 `{ITERATION_DIR}/<iteration-id>/` package 提升 specs/guides。支持 Bug track 与 Knowledge track 双轨。含重叠检测、可发现性检查、CONCEPTS.md 协同。本技能只拥有**执行步骤**（`references/compound-workflow.md`：Q1–Q8 自检 + Phase 1–7 + 产出判据）；调用来自迭代收口（`mstar-iteration` Phase 3）或单 plan 交付尾段（`mstar-roles/references/project-manager/plan-management.md`），触发时机 / 写入面 / 记录面由调用方声明。产出：`{KNOWLEDGE_DIR}/<category>/<slug>.md`；无结晶时以 reasoned `skipped` 结束。
---

# mstar-compound（知识结晶）

## Load order

**Read `mstar-harness-core` first.** Path symbols (`{KNOWLEDGE_DIR}`, `{HARNESS_DIR}`) → **`mstar-conventions`**. On conflict, **`mstar-harness-core` wins**.

## Purpose

After solving a non-trivial problem, `mstar-compound` captures the learning as a structured document in `{KNOWLEDGE_DIR}`, so future plan research, debugging, and implementation can find and reuse it.

**In the mstar lifecycle**, compound is invoked by lifecycle flows — the iteration-close round or a standalone-development delivery tail — sharing one step sequence (see「Integration with mstar lifecycle」). It is never triggered at per-plan `Done`, and stays invocable standalone for ad-hoc captures.

Knowledge that isn't captured evaporates when the session ends. Knowledge that is captured but not discoverable is equally lost. This skill addresses both.

## 产物存储位置

**SSOT**: `mstar-conventions/references/artifact-storage-paths.md`。本 skill 不重定义路径；知识文档 → `{HARNESS_DIR}/knowledge/<category>/<slug>.md`，CONCEPTS.md → `<repo-root>/CONCEPTS.md`。`<category>` 取值见 `references/category-mapping.md`。

## 是否值得结晶（自检门禁）

调用本 skill 前，PM（或触发方）**必须**对候选问题逐条自检 Q1–Q8（诊断耗时 / 非显而易见性 / 可复用性 / 项目特异性 / 既有重叠 / 架构影响 / 失败尝试价值 / 跨模块）。完整问题表、决策矩阵（Yes≥4 强烈建议；Yes=3 Lightweight；Yes≤2 跳过；Q5=Yes 高重叠不新建）与示例判定 → **`references/compound-workflow.md`**「是否值得结晶」。

**快判**：Q5 高重叠 → 更新已有文档，**不新建**；其余按决策矩阵 Yes 数。

## Integration with mstar lifecycle

Compound 是**被生命周期流程调用**的知识结晶流程：本 SKILL 只拥有**执行步骤**（下方 + `references/compound-workflow.md`）；**触发时机、cwd、写入面与结果记录面由调用方流程声明** —— 迭代收口 → `mstar-iteration` Phase 3（`references/phase-3-iteration-close.md` §3.2）；单 plan 交付尾段 → `mstar-roles/references/project-manager/plan-management.md`。本 SKILL **不复述调用方细节**。

`iteration-start → [plan lifecycle × N] → iteration-close → mstar-compound → {KNOWLEDGE_DIR} → feeds next iteration's specify/plan`。per-plan `Done` **不是**触发点：迭代内 plan 行不各自运行（迭代整体收口时一次），独立交付 plan 走其交付尾段 disposition，**不强制新文档**（reasoned `skipped` 有效）。

### Iteration package promotion（package 盘点方法）

调用方声明需要盘点迭代 package 时（迭代收口流程强制 —— 见 `mstar-iteration` Phase 3 §3.2），compound 的盘点方法如下。

**路径**：`{ITERATION_DIR}/<iteration-id>/**`（含 `guides/`、`specs/`、扁平 `.md`；**默认排除** `delivery-compass.md` 除非 PM 显式纳入。Legacy 根目录 `*-delivery-compass.md` 同理排除）。

| 步骤 | 动作 |
|------|------|
| 1. Inventory | 列出 package 下全部 `.md`（除默认排除 compass）；读各文件 + package `README.md`（若有） |
| 2. Triage | 每篇：**Promote** / **Keep snapshot** / **Skip**（理由写入 compound 摘要） |
| 3. Promote | 值得跨迭代复用 → 走 Q1–Q8（或轻量判定）→ Phase 2 重叠检测 → Phase 3–6 **结构化重写**进 `{KNOWLEDGE_DIR}/`（**禁止**无改写整文件复制） |
| 4. Trace | 源文件顶栏或 package README：`Promoted to: <knowledge-path>`；provenance 记在 catalog 关系（`mstar catalog link`，关系取 `derived-from`），**不**在 README 表格加列 |
| 5. Summary | 记录本轮提升篇数、保留快照、跳过及原因（记录面由调用方承载） |

**Promote 典型**：迭代 spec 已验证且指导未来实现；guide 含非显而易见过程知识或失败尝试。**Keep snapshot**：仅迭代史、已被 `{SPECS_DIR}/` 取代的草案、或自检 ≤2 Yes 的琐碎笔记。边界 SSOT → **`mstar-iteration/references/iteration-artifact-boundaries.md`**。

## When to use / Skip

**Use**：迭代收口（`mstar-iteration` § iteration-close）批量回顾；独立触发（非迭代或紧急，任何非平凡问题解决后）；重大 bug 修复后（`mstar-iteration` 未启用时手动）；独立 development plan 交付前的 disposition review（PR head 定稿前，见「Integration with mstar lifecycle」）。

**Skip**：自检 ≤2 Yes；Q5 高重叠（更新已有而非新建）；纯机械工作（格式化、依赖升级、typo）；问题未经验证。独立交付 plan 的 disposition 义务不因跳过结晶而消失——结晶跳过时以 reasoned `skipped` 记录结果（记录在 workflow，见「Integration with mstar lifecycle」）。

## Two tracks

| Track | What it captures | Section structure |
|-------|-----------------|-------------------|
| **Bug** | Incident-level fix — "X broke, here's why and how we fixed it" | Problem, Symptoms, What Didn't Work, Solution, Why This Works, Prevention |
| **Knowledge** | Durable guidance — "this is how we do X, and why" | Context, Guidance, Why This Matters, When to Apply, Examples |

Track 由 `problem_type` 决定，完整映射见 `references/category-mapping.md`。

## Execution modes

| Mode | When | Behavior |
|------|------|----------|
| **Full** (default) | Most cases | Dispatches research subagents for context analysis, solution extraction, overlap detection |
| **Lightweight** | Simple fixes, context-tight sessions | Single-pass documentation, no subagents, faster |

In Cursor, Full mode dispatches subagents via Task tool. PM selects mode.

## Workflow skeleton（Phase 1–7）

完整步骤细节（Gather context / Overlap detection / Write document 含 frontmatter schema + path + validate / Discoverability check / CONCEPTS.md synergy / Catalog registration / Refresh trigger）→ **`references/compound-workflow.md`**。每 Phase 一个关键决策：

1. **Gather** — 读对话史 + iteration package；分类 track/category（`references/category-mapping.md`）
2. **Overlap** — 高重叠 → 更新已有（加 `last_updated`）；中度 → 新建并标 consolidation review；低/无 → 正常新建
3. **Write** — path + frontmatter（SSOT `references/schema.yaml`）+ body（`assets/resolution-template.md`）+ YAML validate
4. **Discoverability** — 若 root `AGENTS.md`/`CLAUDE.md` 未提 `{KNOWLEDGE_DIR}`，提议最小补充（需用户同意；拒绝则仅跳过该编辑，doc 仍写）
5. **CONCEPTS.md** — 项目特定领域词满足 qualifying bar 时提议入 `CONCEPTS.md`（规则见 `references/concepts-vocabulary.md`）；全仓 bootstrap 归 `mstar-compound-refresh`
6. **Catalog** — 新文档在 `{HARNESS_DIR}/store.db` 的 catalog 中登记为 `kind=document`（`document_kind=knowledge`）：单行 `mstar catalog register`，或 reviewed `mstar catalog discover` + `mstar catalog import`；provenance/supersession 用 `mstar catalog link`（`derived-from` / `supersedes` 关系）；生命周期变更用 `mstar catalog update`（`active` / `archived` / `superseded`；revision 守卫见 help）。**不再**要求 `{KNOWLEDGE_DIR}/README.md` 索引行（README 是散文，不是登记表）。知识关联载体是 catalog relations（`mstar catalog link`）；snapshot `plans[].metadata.knowledge_refs` 仅 legacy 只读，不是写入面。**iteration-close gate**：每篇新 doc 必须完成本 Phase
7. **Refresh trigger** — 新知识暗示旧 doc 过时 → 推荐 `/pm compound-refresh <scope>`（不自动跑，仅 flag）

> **Engine check (when available):** run `mstar compound validate <doc-path> [--knowledge-dir <dir>]` (or `import { validateSchemaYaml, assertKnowledgeCatalogCompleteness } from "@mstar-harness/engine"` in a host hook) to validate the frontmatter against `references/schema.yaml` (Phase 3 Write) and assert that every knowledge body under `{KNOWLEDGE_DIR}` has a catalog row (Phase 6 Catalog, contract §4). The former README index-row assert is retired: the `assertIndexRows` export refuses actionably (`compound.index.retired`) instead of passing, and the `mstar compound validate --knowledge-dir` index-row check fails for the same reason. On `fail` -> do not proceed; fix and re-run. Skill text below remains authoritative when the runtime is absent.

## Support files

读 `references/compound-workflow.md`（Q1–Q8 + Phase 1–7）、`references/schema.yaml`（frontmatter）、`references/category-mapping.md`（track/path 映射）、`references/concepts-vocabulary.md`（CONCEPTS.md 规则）、`assets/resolution-template.md`（track 正文结构）。

## Skill dependencies

- **`mstar-conventions`** — path symbols（`{KNOWLEDGE_DIR}`、`{HARNESS_DIR}`）
- **`mstar-artifacts`** — store.db catalog 登记与生命周期（snapshot 为迁移源；project register 仅迁移历史）（README index maintenance retired）
- **`mstar-compound-refresh`** — capture 后知识维护；CONCEPTS.md 全仓 bootstrap

## NOT to do

- Do not create a doc for trivial fixes (typos, formatting, dep bumps)
- Do not write the doc before the solution is verified
- Do not skip the overlap check — creating duplicates degrades the knowledge store
- Do not edit AGENTS.md without user consent
- Do not create CONCEPTS.md entries for general programming vocabulary
- Do not modify product code — this skill writes documentation only

## Evidence

正确结果 = 一篇**可发现**的结晶文档：`{KNOWLEDGE_DIR}/<category>/<slug>.md` 通过 `references/schema.yaml` frontmatter 校验（Phase 3 Write）+ catalog 登记为 `kind=document`（`document_kind=knowledge`，Phase 6 Catalog；`mstar catalog list` 可查到，iteration-close 强制）+ 达标领域词入 `CONCEPTS.md`（Phase 5）+ 源文件 / package README 标注 `Promoted to: <knowledge-path>`（Phase 4 Trace）。
