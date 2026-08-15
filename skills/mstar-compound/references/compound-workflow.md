# mstar-compound — 工作流详情

> Loaded by `mstar-compound` SKILL.md at the self-check and Phase 1–7 steps. **Read `mstar-harness-core` first.** Path symbols → `mstar-plan-conventions`.

## 是否值得结晶 —— 完整自检（Q1–Q8）

在调用本 skill 前，PM（或触发方）**必须**逐条回答以下问题。得分仅辅助决策，不替代判断。每条回答 Yes / No / Not sure。

| # | 问题 | 说明 |
|---|------|------|
| Q1 | 这个问题的诊断过程耗时是否 ≥ 15 分钟（或 ≥ 3 次尝试）？ | 若只是 1-2 次尝试就找到答案，可能太琐碎 |
| Q2 | 解决方案是否涉及**非显而易见**的知识（隐含假设、框架行为、workaround）？ | 显而易见的知识无需文档化（如"少了个分号"） |
| Q3 | 同一个开发者在未来遇到类似问题时，是否可能**再次花费相似的时间**来诊断？ | 核心问题：知识能否复用？ |
| Q4 | 问题的**根因**是否是项目特定的（不是通用语言/框架问题）？ | 通用问题可搜索到，项目特定问题必须自己记录 |
| Q5 | `{KNOWLEDGE_DIR}` 中是否**已有**与此高度重叠的文档？ | 若有 → 更新已有文档，不新建（见 Phase 2 重叠检测） |
| Q6 | 此解决方案是否可能**引导未来架构决策**或成为约定？ | Knowledge track 的典型触发条件 |
| Q7 | 此解决方案中的"**什么没起作用**"部分是否有价值？ | 失败的尝试往往是最有教学价值的部分 |
| Q8 | 问题是否涉及** ≥ 2 个模块/组件**的交互？ | 跨模块问题最难排查，最值得记录 |

### 决策矩阵

| 得分 | 行动 |
|------|------|
| **Yes ≥ 4**（含 Q5=No） | **强烈建议结晶**。执行完整 Phase 1-7。 |
| **Yes = 3** | **建议结晶**。使用 Lightweight 模式（Phase 1 单遍）。 |
| **Yes ≤ 2** | **跳过**。在 conversation/Completion Report 中注明"跳过结晶（<简述原因>）"。 |
| **Q5 = Yes（高重叠）** | 无论其它得分如何，**不要新建**。执行 Phase 2 重叠检测，更新已有文档即可。 |
| **任一 Not sure** | 倾向于回答者的默认判断。若 Q1-Q4 有 ≥ 2 个 Yes，仍建议结晶。 |

### 示例判定

```
Q1: Yes — debug 了 40 分钟
Q2: Yes — ActiveRecord 的 counter_cache 在 after_destroy 回调中的时序问题
Q3: Yes — 下次遇到类似时序问题仍会踩坑
Q4: Yes — 是项目特有 model 结构导致的
Q5: No  — grep 了 knowledge/ 无匹配
Q6: No  — 纯 bug 修复
Q7: Yes — 第一次尝试了手动更新 counter 导致数据不一致
Q8: No  — 只涉及一个 model
→ Yes = 5 → 强烈建议结晶（Bug track）
```

## Phase 1: Gather context

Read the conversation history **and**, when `iteration_id` is known, scan **`{ITERATION_DIR}/<iteration-id>/`** package per **Iteration package promotion** (SKILL.md).

Understand:
- What problem was solved (the concrete issue)
- What was tried and didn't work
- What the working solution was
- Why the solution works (root cause)
- Which files/modules were involved
- The plan_id if applicable (link to `status.json`)

If `{KNOWLEDGE_DIR}/README.md` exists, scan its index for related existing documents.

Classify the problem into a track (bug vs knowledge) and category using `references/category-mapping.md`.

## Phase 2: Overlap detection

Before creating a new doc, check if an existing doc covers the same ground:

1. Extract keywords from the problem (module names, error messages, technical terms)
2. Search `{KNOWLEDGE_DIR}/**/*.md` using frontmatter fields (`module:`, `tags:`, `problem_type:`)
3. Score overlap across dimensions: problem statement, root cause, solution approach, referenced files, prevention

| Overlap | Action |
|---------|--------|
| **High** (4-5 dimensions match) | **Update** the existing doc with fresher context instead of creating a new one. Add `last_updated` field. |
| **Moderate** (2-3 dimensions match) | Create new doc; flag for consolidation review (potential `mstar-compound-refresh` trigger) |
| **Low/None** | Create new doc normally |

## Phase 3: Write the document

### 3.1 Determine path

Category → directory under `{KNOWLEDGE_DIR}/`. Examples:
- Bug track: `build-errors/`, `runtime-errors/`, `performance-issues/`, `database-issues/`, `security-issues/`, `integration-issues/`
- Knowledge track: `architecture-patterns/`, `design-patterns/`, `conventions/`, `workflow-patterns/`, `tooling-decisions/`, `best-practices/`

Filename: `<sanitized-slug>.md` (lowercase, hyphen-separated, no date prefix).

### 3.2 Frontmatter

Required fields for both tracks (SSOT: `references/schema.yaml`):

```yaml
---
module: <area>
date: YYYY-MM-DD
problem_type: <enum value>
category: <directory name>
severity: critical|high|medium|low
plan_id: <optional, link to status.json>
tags: [<keywords>]
---
```

Bug-track adds: `symptoms`, `root_cause`, `resolution_type`.
Knowledge-track adds: `applies_when` (optional).

### 3.3 Body

Follow the section structure from `assets/resolution-template.md` for the determined track.

### 3.4 Validate

After writing, validate the YAML frontmatter:
- `---` delimiters are correct
- All required fields present
- Enum values match allowed values
- `date` is YYYY-MM-DD format
- Array fields use `[item1, item2]` syntax

### 3.5 知识文档质量门：HEAD-resolvability & prose hygiene

写作完成、进入 Phase 4 前，对文档运行本质量门（writing-specialist 编辑 durable harness artifacts 时适用同一 rubric — 见 `mstar-roles/references/writing-specialist.md` Output Guidance 指针）：

- **The one test**：读者在 HEAD（无 chat transcript / dispatch prompt / 未合并草稿访问权）能否解析每个引用并验证每个声明？
- **mstar 泄漏分类**（vantage 来自 authoring session 而非仓库现状；修剪或重述）：
  - dead session citations：chat-only decision 序号 → 引 plan/knowledge/roadmap 属主路径，或独立重述事实
  - durable docs 中的 change narration：knowledge/roadmap/README 陈述现状；已修回归 → counterfactual-present（「without X, Y happens」）
  - review choreography：谁在哪轮确认 → 平实事实；finding id 留在 review bundle（其 sanctioned genre）
  - reviewer-addressed justification（向评审自辩的措辞）
  - control-flow narration（过程/控制流叙述）
  - hedges without markers → 既有 `simplify:` / `temporary` 标记约定（`mstar-coding-behavior`；引用不重复）
  - authoring-language slips：双语对之外的 zh/en 混杂
- **Keep 规则（mstar-sanctioned）**：review bundle / QC report 内的 R# 与 finding id；issue 引用；带 provenance 词的 measured bounds；runtime old/new 生命周期态；Alternatives-considered genre 节；HEAD 持久工件中的 iteration/plan id
- **过度修正陷阱**：义务↛背书翻转；hypothetical 保持标记；共享一句时删子句不删句。「修剪前枚举命题」→ complete-proposition rule（`mstar-roles/references/writing-specialist.md` Output Guidance — SSOT，不在本节重述；前向引用合法）

## Phase 4: Discoverability check

Check whether the project's `AGENTS.md` or `CLAUDE.md` would lead a future agent to discover `{KNOWLEDGE_DIR}`.

If `{KNOWLEDGE_DIR}` is not mentioned in the root instruction file, propose the smallest addition that surfaces the knowledge store. Example:

```markdown
- `{HARNESS_DIR}/knowledge/` — captured solutions and reusable patterns
```

Ask for user consent before applying (PM can approve). If the user declines, the doc is still written — only the discoverability edit is skipped.

## Phase 5: CONCEPTS.md synergy

If the captured learning introduces or clarifies a domain term whose meaning is project-specific and not obvious to a newcomer, propose adding it to `CONCEPTS.md` at the repo root.

Read `references/concepts-vocabulary.md` for inclusion rules. Only propose when the term meets the qualifying bar:
- Its meaning in this project is precise enough that a new engineer would need it defined
- It is not general programming vocabulary

If `CONCEPTS.md` doesn't exist yet, ask whether to seed it. A seed populates the core domain nouns of the area the learning touches; a full repo-wide bootstrap is the job of `mstar-compound-refresh`.

## Phase 6: Update indexes

1. Add a row to `{KNOWLEDGE_DIR}/README.md` index table (create if missing):
   - Document (link), Source Plan (`plan_id`), Description, Status (`Active`)

2. If `plan_id` was provided, optionally update `status.json` metadata to reference this doc under `knowledge_refs`.

**iteration-close gate**: `mstar-iteration` §3.2 #5 — **each** new doc in the compound round must complete this phase; do not skip for lightweight captures.

## Phase 7: Refresh trigger

After capturing, check if the new learning suggests an older doc may now be stale (contradicted, superseded, or in a refactored domain). If so, recommend:

```
Consider: /pm compound-refresh <scope hint>
```

Do not automatically run refresh — only flag when there's a concrete reason.
