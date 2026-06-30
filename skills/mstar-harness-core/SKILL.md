---
name: mstar-harness-core
description: Morning Star (启明星) harness **强制全局入口** —— 信息源优先级、最小交付循环、状态机与 Done 权限、Task category 路由（含 quick 禁豁免）、@explore 边界、长任务纪律、护栏不变量、反模式索引、Morning Star Skill 索引与宿主入口。**任何**非平凡任务开始前必须先 Read 本 skill；再按角色与任务 **按需** Read 其它 `mstar-*` 专题（勿默认通读全部）。`@project-manager` 开轮必读 + `mstar-dispatch-gates` / `mstar-phase-gates` / `mstar-plan-conventions` 等；实现/审查/QA 必读本 skill + `mstar-coding-behavior` 及角色清单（见 `mstar-roles`）。Prepare/派发/Git/residual/QC 细则在专题 skill，不在此重复。
---

# Morning Star Harness Core（启明星核心）

本 skill 是 harness 的**唯一全局入口与裁决层**。专题 skill 展开细节；**冲突时以本 skill 的状态机、Done 权限与索引为准**。

## 与其它 `mstar-*` skill 的加载契约

- 凡 **`mstar-*`**（`name` ≠ `mstar-harness-core`）假定读者**已 Read 本 skill**。
- **仅读专题、未读核心** → 未完成 harness 加载。
- 各专题 SKILL.md 含 **Load order**；按 **`mstar-roles`** 角色矩阵按需加载，**禁止**为「保险」通读全部专题。

## 信息源优先级

1. 当轮用户显式指令  
2. 项目 `AGENTS.md` / `CLAUDE.md`  
3. `mstar-*` skills（本 skill + 专题）  
4. `mstar-roles` 角色正文  

冲突且用户未覆盖 → **暂停升级人工**。

## 最小交付循环

**per-plan**：`specify → clarify → plan` → `plan(locked) → tasks → implement` → QC 三审 + QA → Done。阶段细则 → **`mstar-phase-gates`**。

**迭代级**：`iteration-start → [per-plan cycle × N] → iteration-close（含知识结晶 `mstar-compound`）`。细则 → **`mstar-iteration`**。

## 加载约定（强制）

| 角色 | 始终 | 按任务追加（典型） |
|------|------|-------------------|
| **全部** | 本 skill | — |
| **`@project-manager`** | 本 skill | `mstar-dispatch-gates`、`mstar-phase-gates`、`mstar-plan-conventions`、`mstar-superpowers-align`、`mstar-roles`；派 QC 前 `mstar-review-qc`；并行/审查 `mstar-branch-worktree`；plan/status/reports `mstar-plan-artifacts`；UI 类 plan Prepare 阶段 `mstar-design-md`（DESIGN.md 门禁）；迭代管理 `mstar-iteration`（iteration-start/drive/close 含 compound）；战略性工作 `mstar-strategy`。**不**读 `mstar-coding-behavior` |
| **实现/审查/QA/运维** | 本 skill + `mstar-coding-behavior` + 角色 ref | 有 git 写：`mstar-branch-worktree`；有 plan 路径：`mstar-plan-conventions`（路径符号节）；QC/QA：`mstar-review-qc`；改 status/residual：`mstar-plan-artifacts`；UI 任务：`mstar-design-md`（读取 DESIGN.md tokens）；写入知识库 `{KNOWLEDGE_DIR}`：`mstar-compound`（PM 触发） |
| **leaf 承接方** | 上栏 + **`mstar-dispatch-gates`**（反递归节） | — |

Routing eval（Cursor 维护）→ `.cursor/skills/mstar-routing-eval/`，**非**运行时必读。

## 状态机

`Todo` → `InProgress` → `InReview` → `Done` | `Blocked`

- **`Done`**：仅 `@project-manager` 或 `@qa-engineer`。
- 实现类可设 **`InReview`**，不可设 **`Done`**。

`status.json` 字段与 residual → **`mstar-plan-artifacts`**。

## Task category（路由摘要）

PM 在 Assignment 写 **`Task category`**（主类 + 可选 `secondary`）：

| Category | 倾向角色 |
|----------|----------|
| `visual` | `@frontend-dev`（复杂 IA 可前置 `@product-manager`） |
| `deep` | `@explore` → dev / `@architect` |
| `quick` | `@general` 或单 dev — **不豁免 Prepare** |
| `logic` | `@architect` + dev |
| `ops` | `@ops-engineer` |
| `docs` | `@product-manager` / `@architect` / `@writing-specialist` |

**硬规则**：`quick` **从不**跳过 `specify → clarify → plan`；禁止把新 CLI/API/多模块/新测例标为 `quick`。已启用 `{HARNESS_DIR}` 时，首次 implement 前须有主 plan 路径 + `status.json` 登记（见 **`mstar-plan-conventions`**）。

## `@explore` 边界

- 已分派角色的 Assignment：**禁止**用 `@explore` 代替实现/测试/审查/文档交付。
- 允许短窄只读辅助；`glob`/`grep`/`read` 够用时不必 `@explore`。
- PM 分派前摸底：**推荐**；分派后承接方**勿**转包。

## 长任务纪律

可追踪清单（plan `tasks` 或 Todo）；偏离时 PM 拉回；完成前须可核对证据（**`mstar-superpowers-align`** · `verification-before-completion`）。

**Durable Roadmap Gate**：凡声明“分批 / 后续 / next plan / later / temporary workaround”的非热修任务，必须在 `{PLAN_DIR}` 主 plan、CreatePlan mirror、`status.json`/residual、或 PM Task Board 中写清后续路线（批次、依赖、owner/触发条件、完成定义）。只在对话或 Completion Report 里说“以后做”不算可追踪，不能进入 implement GO 或 Done。

## 专题 skill 索引

| Skill | 职责 |
|-------|------|
| `mstar-harness-core` | 本文件：入口、状态机、Task category、explore、索引、护栏 |
| `mstar-phase-gates` | per-plan 双阶段门禁：Prepare/Execute、意图门禁、hotfix、可验证编辑 |
| `mstar-iteration` | 迭代管理：iteration-start（锁定范围/Roadmap）、iteration-drive（跨 plan 追踪）、iteration-close（收口 compound、更新 roadmap） |
| `mstar-dispatch-gates` | 派发、Delegation、反递归、并行 invoke、QC 同消息三审 |
| `mstar-branch-worktree` | 功能分支、worktree、QC/QA 检出对齐 |
| `mstar-plan-conventions` | `{HARNESS_DIR}` 发现、初始化、Spec 分支模型摘要、产物路径 SSOT |
| `mstar-plan-artifacts` | 主 plan、reports、`status.json`、residual、knowledge、Done 归档 |
| `mstar-design-md` | DESIGN.md 设计系统规范 —— 创建/审计/维护 design tokens，三级检查清单，light/dark 双主题 |
| `mstar-review-qc` | QC 工作流、模板、verdict、residual 留档、deep review 透镜 |
| `mstar-coding-behavior` | Think / Simplicity / Surgical / Debugging / Goal-Driven / Communication |
| `mstar-compound` | 知识结晶 —— 已解决问题→结构化知识文档，双轨（Bug/Knowledge），「是否值得结晶」自检清单，重叠检测，可发现性检查，CONCEPTS.md 协同 |
| `mstar-compound-refresh` | 知识维护 —— 审查/更新/合并/删除 `{KNOWLEDGE_DIR}` 文档 |
| `mstar-strategy` | `STRATEGY.md` 全局战略方向 —— 产品愿景、技术方向、决策原则 |
| `mstar-superpowers-align` | Superpowers × harness 优先级与短语 |
| `mstar-roles` | 角色正文 hub |
| `mstar-host` | 宿主适配（自动识别；`references/opencode.md` / `cursor.md` / `codex.md` / `parallel-dispatch.md`） |

## 宿主 `mstar-host`

Read **`mstar-host`** after this skill; detect host per its table, then Read the matching reference.

| 宿主 | 要点 |
|------|------|
| OpenCode | `question`、`@explore`、named-role invoke → `references/opencode.md` |
| Cursor | Task 并行 QC；Plan 双写 → `references/cursor.md` · `cursor-plan-mode-bridge.md` |
| Codex | plugin skills、sandbox/apply_patch/tool discovery；无 invoke 工具时不声称 subagent dispatch → `references/codex.md` |
| 其它 | 同 `mstar-host` skill；按工具信号选 reference |

## 护栏（不变量）

- 未经用户同意不改 `opencode.json`、凭据、`secrets.env`。
- 行为变更须有验证证据。
- 业务仓默认功能分支（Assignment `Branch policy` 例外）→ **`mstar-branch-worktree`**。
- **Dev 三角**：`@fullstack-dev` 后端主导；UI → `@frontend-dev`；第二轨 → `@fullstack-dev-2`（`mstar-roles` PM 节）。
- 工期仅 agent-oriented → **`mstar-plan-conventions`** · effort-estimation。
- `writing-plans` 落盘 `{PLAN_DIR}`，非 `docs/superpowers/plans/`。
- PM Assignment 键名英文；任务正文可中文；产出/报告默认英文。

## 库文档（Context7）

框架/SDK/API 问题 → **`references/library-docs-protocol.md`**（MCP 优先，CLI 兜底，禁双跑）。

## 升级触发

验收仍模糊、评审冲突、重复失败、根因不可收敛 → 升级报告（状态、方案、推荐路径）。

## 反模式（索引）

| 反模式 | 详见 |
|--------|------|
| QC 串行 rollout / dispatch incomplete | `mstar-dispatch-gates` |
| fix 后无脑重派三审 / 用 `-rev2` 代替原位复验 | `mstar-plan-artifacts` · `mstar-review-qc` |
| 递归误派 / 误读 Handoff | `mstar-dispatch-gates` |
| `quick` 跳过 Prepare | 上表 + `mstar-phase-gates` |
| 多 worktree 未归并就 QC | `mstar-branch-worktree` |
| residual 只写 plan 不写 SSOT | `mstar-plan-artifacts` |
| 角色文件塞流程长文 | 用专题 skill |
| 无证据宣称完成 | `mstar-coding-behavior` / verification |
| CreatePlan 不落盘 / 无 `{HARNESS_DIR}` mirror | `mstar-host` · `cursor-plan-mode-bridge` |
| 临时方案 / 后续计划只写在对话里 | `mstar-phase-gates` · Durable Roadmap Gate |

## 可选：OpenViking Memory

会话有 **`memsearch`** 工具时 Read **`references/openviking-memory-plugin.md`**。

## References（保留在 core）

- `references/open-harness-principles.md` — 理念与分层 `AGENTS.md`
- `references/library-docs-protocol.md` — Context7
- `references/openviking-memory-plugin.md` — 条件加载

**专题 skill**（规则在各自 `SKILL.md`）：`mstar-phase-gates`、`mstar-branch-worktree`、`mstar-plan-artifacts` 等 — 见上表索引。
