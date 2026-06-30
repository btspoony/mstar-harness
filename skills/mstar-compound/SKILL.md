---
name: mstar-compound
description: Morning Star 知识结晶 —— 将已解决问题的经验沉淀为结构化知识文档，存入 `{KNOWLEDGE_DIR}`。支持 Bug track（症状/失败尝试/解决方案）与 Knowledge track（上下文/指南/适用场景）双轨。含重叠检测（更新已有文档）、可发现性检查（AGENTS.md 索引）、CONCEPTS.md 领域词汇协同。触发：PM 在 Done 后调用、Debug 修复后、或任何非平凡问题解决后。产出：`{KNOWLEDGE_DIR}/<category>/<slug>.md` + 可选 AGENTS.md 更新。
---

# mstar-compound（知识结晶）

## Load order

**Read `mstar-harness-core` first.** Path symbols (`{KNOWLEDGE_DIR}`, `{HARNESS_DIR}`) → **`mstar-plan-conventions`**. On conflict, **`mstar-harness-core` wins**.

## Purpose

After solving a non-trivial problem, `mstar-compound` captures the learning as a structured document in `{KNOWLEDGE_DIR}`, so future plan research, debugging, and implementation can find and reuse it. This is the **closing loop** of the mstar delivery cycle: `Done → compound → knowledge feeds back to future specify/plan`.

Knowledge that isn't captured evaporates when the session ends. Knowledge that is captured but not discoverable is equally lost. This skill addresses both.

## 产物存储位置

**SSOT**: `mstar-plan-conventions/references/artifact-storage-paths.md`。本 skill 不重定义路径；知识文档 → `{HARNESS_DIR}/knowledge/<category>/<slug>.md`，CONCEPTS.md → `<repo-root>/CONCEPTS.md`。`<category>` 取值见 `references/category-mapping.md`。

## 是否值得结晶（自检清单 · 必须逐条回答）

在调用本 skill 前，PM（或触发方）**必须**逐条回答以下问题。得分仅用于辅助决策，不替代判断。

### 自检问题（每条回答 Yes / No / Not sure）

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

## Integration with mstar lifecycle

Compound 在迭代收口时触发（`mstar-iteration` § iteration-close），不在 per-plan Done 后单独执行：

```
iteration-start → [plan lifecycle × N: specify→...→Done] → iteration-close
                                                                  │
                                                             mstar-compound
                                                             (per-iteration round)
                                                                  │
                                                             {KNOWLEDGE_DIR}
                                                                  │
                                               feeds back into next iteration's specify / plan
```

迭代内所有 plan Done 后，PM 回顾整轮迭代中产生的可结晶知识，批量 compound。per-plan Done 是 per-plan 的闭环终点；compound 是迭代级收口活动。

## When to use (trigger)

- **迭代收口时**（`mstar-iteration` § iteration-close）：PM 批量回顾所有 plan 的产物
- **独立触发**（非迭代模式或紧急情况）：任何非平凡问题解决后，PM 或开发者手动触发
- **Debug 后**：`mstar-iteration` 尚未启用时，重大 bug 修复后手动触发

### Skip when

- 自检清单判定 ≤ 2 个 Yes
- Q5 高重叠（应更新已有文档而非新建）
- 纯机械性工作：格式化、依赖升级、typo 修复
- 问题仍在进行中或方案未经验证

Compound can also be invoked standalone at any point where a meaningful learning occurred outside a formal plan.

## Usage

```
/pm compound                    # PM invokes after Done (from conversation context)
/pm compound "the N+1 query in brief generation"
/pm compound plan_id:<id>       # Link knowledge to a specific plan
/pm compound mode:lightweight   # Single-pass mode for simple captures
```

## Two tracks

The skill classifies work into one of two tracks based on problem type:

| Track | What it captures | Section structure |
|-------|-----------------|-------------------|
| **Bug** | Incident-level fix — "X broke, here's why and how we fixed it" | Problem, Symptoms, What Didn't Work, Solution, Why This Works, Prevention |
| **Knowledge** | Durable guidance — "this is how we do X, and why" | Context, Guidance, Why This Matters, When to Apply, Examples |

Track is determined by `problem_type`. See `references/category-mapping.md` for the full mapping.

## Execution modes

| Mode | When | Behavior |
|------|------|----------|
| **Full** (default) | Most cases | Dispatches research subagents for context analysis, solution extraction, and overlap detection |
| **Lightweight** | Simple fixes, context-tight sessions | Single-pass documentation, no subagents, faster |

In Cursor, Full mode dispatches subagents via Task tool. PM selects mode.

## Phase 1: Gather context

Read the conversation history to understand:
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

## Phase 7: Refresh trigger

After capturing, check if the new learning suggests an older doc may now be stale (contradicted, superseded, or in a refactored domain). If so, recommend:

```
Consider: /pm compound-refresh <scope hint>
```

Do not automatically run refresh — only flag when there's a concrete reason.

## CONCEPTS.md bootstrap requests

If invoked specifically to create CONCEPTS.md from scratch (not to document a solved problem), redirect to `mstar-compound-refresh` (which handles full repo-wide vocabulary bootstrapping). `mstar-compound` only seeds vocabulary as a side effect of capturing a real learning.

## Support files

Read on demand at the step that needs them:

- `references/schema.yaml` — canonical frontmatter schema (Phase 3)
- `references/category-mapping.md` — problem_type → directory + track mapping (Phase 1)
- `references/concepts-vocabulary.md` — CONCEPTS.md rules (Phase 5)
- `assets/resolution-template.md` — section structure per track (Phase 3)

## Skill dependencies

This skill integrates with:
- **`mstar-plan-conventions`** — path symbols (`{KNOWLEDGE_DIR}`, `{HARNESS_DIR}`)
- **`mstar-plan-artifacts`** — `status.json` linking, index maintenance
- **`mstar-compound-refresh`** — for knowledge maintenance after capture

## NOT to do

- Do not create a doc for trivial fixes (typos, formatting, dep bumps)
- Do not write the doc before the solution is verified
- Do not skip the overlap check — creating duplicates degrades the knowledge store
- Do not edit AGENTS.md without user consent
- Do not create CONCEPTS.md entries for general programming vocabulary
- Do not modify product code — this skill writes documentation only
