---
name: mstar-harness-core
description: Morning Star (启明星) harness **生命周期 / 授权语义权威与全局入口** —— 信息源优先级、最小交付循环、状态机与 Done 权限、Task category 路由（含 quick 禁豁免）、@explore 边界、长任务纪律、核心研发守则、护栏不变量、Morning Star Skill 索引与宿主入口。加载**选择**权威在 **`mstar-roles`**（hub § Load Order 按 Assignment `Skill presets:` 决策；本 skill 不另设全局必读表）：PM 与标准路线仍以本 skill 为全局入口；独立直接调用专题时本 skill 是首个依赖；explicit `none` 角色路线以身份 + 角色自有方法自洽（唯一 hub bootstrap 例外）。`@project-manager` 开轮必读 + `mstar-dispatch-gates` / `mstar-phase-gates` / `mstar-conventions` 等；实现/审查/QA 按其角色 preset 清单加载。Prepare/派发/Git/residual/QC 细则在专题 skill，不在此重复。版本漂移（version drift）/ CLI 与插件版本不一致 / 提示更新插件或 CLI → 按「版本对齐」节处理（doctor 检查 + 定向更新提示）。
---

# Morning Star Harness Core（启明星核心）

本 skill 是 harness 的**唯一全局入口与裁决层**。专题 skill 展开细节；**冲突时以本 skill 的状态机、Done 权限与索引为准**。

## 与其它 `mstar-*` skill 的加载契约

- 本 skill 是 harness 的**生命周期 / 授权语义权威**（状态机、Done 权限、门禁、路由以本 skill 为准）；加载**选择**权威是 **`mstar-roles`**（hub bootstrap → 角色身份 → Assignment `Skill presets:` 决策，见其 § Load Order）。本 skill 不维护第二份全局必读角色表。
- **独立直接调用专题**（不经角色 hub bootstrap）时，`mstar-harness-core` 仍是首个依赖：各专题 SKILL.md 的 Load Order / First action 节须声明 core-first。**唯一例外**是 `mstar-roles` hub bootstrap —— explicit `none` 下角色以身份 + 角色自有方法自洽，不强制读任何专题（含本 skill）；此时授权、反递归、证据诚实等 load-bearing 语义由角色引用与其 leaf 边界承接。
- 各专题 SKILL.md 含 **Load order**；按 **`mstar-roles`** 的加载选择 + 本 skill 专题索引按需加载，**禁止**为「保险」通读全部专题。
- **加载条件（`mstar-engine-legacy`）**：`mstar-engine-legacy` 是**条件契约档案**（engine-absent fallback）。**engine 约束激活（或宿主含 engine 能力）时不加载**——engine-present 宿主以运行时 skills 的 engine-check 指针 + engine 校验为权威；仅 engine-absent 宿主（无 `mstar` CLI / engine import）为找回被 engine 校验接管的 contract 全文而读取（触发契约见其 description）。

## Standalone harness（`mstar-*` 自洽）

- **`mstar-*` skill 体系**在本仓库内自洽运行：正文与 load order **不得**依赖仓库外的 skills、CLI、或 MCP 服务。
- **Commands**（如 `/iteration-start`）可引用本仓库 bundled、**非 `mstar-*`** 的辅助资产（例如 `skills/grill-me/`）；该引用**仅**存在于 command 层，**不**进入 `mstar-*` 专题索引或 load matrix。
- 框架/SDK/API 问题：先 Read/Grep 项目内文档、规格与源码；仍不确定时再向用户澄清。不将第三方文档工具写入 `mstar-*` 必读路径。

## 信息源优先级

1. 当轮用户显式指令  
2. 项目 `AGENTS.md` / `CLAUDE.md`  
3. `{KNOWLEDGE_DIR}/README.md` 索引（**若该文件存在**；发现 Active 行并仅跟随与当轮相关的文档）  
4. `mstar-*` skills（本 skill + 专题）  
5. `mstar-roles` 角色正文  

冲突且用户未覆盖 → **暂停升级人工**。Knowledge **永不**高于用户 / `AGENTS.md`。

## 最小交付循环

**per-plan**：`specify → clarify → plan` → `plan(locked) → tasks → implement`（多 task 默认 SDD）→ plan QC tri + **QA gate**（`mandatory` 派 QA 或 `pm-acceptance`）→ Done（`inline` 单席例外）。阶段细则 → **`mstar-phase-gates`**；QA 分级 → **`mstar-roles/references/project-manager/qa-trigger-matrix.md`**。

**迭代级**：`iteration-start → [per-plan cycle × N] → iteration-close → PR delivery → PR merge-ready loop`。细则 → **`mstar-iteration`**。

## 加载约定（强制）

加载选择 SSOT：**`mstar-roles`** hub § Load Order（Assignment `Skill presets:` 决策；PM required reading 不受 preset 门控）。下表是各角色的**典型追加指引**，不是第二套选择机制；冲突时以 hub 为准。

| 角色 | 始终 | 按任务追加（典型） |
|------|------|-------------------|
| **全部** | 加载选择 → **`mstar-roles`**（hub § Load Order；本 skill = 生命周期/授权权威，`mstar-roles` hub bootstrap 是 core-first 的唯一例外） | — |
| **`@project-manager`** | 本 skill | `mstar-dispatch-gates`、`mstar-phase-gates`、`mstar-conventions`、`mstar-roles`；implement 波次 `mstar-sdd`；派 QC 前 `mstar-review-qc`；并行/审查 `mstar-branch-worktree`；plan/status/review bundle `mstar-artifacts`；UI 类 plan Prepare 阶段 `mstar-design-md`（DESIGN.md 门禁）；新建/大改 skill 时 `mstar-skill-authoring`；迭代管理 `mstar-iteration`（Phase 1–5）；战略性工作 `mstar-strategy`；`audit` 类请求 `mstar-audit`（执行归 `@code-reviewer`）。**不**读 `mstar-coding-behavior` |
| **实现/审查/运维** | 本 skill + `mstar-coding-behavior` + 角色 ref | 有 git 写：`mstar-branch-worktree`；有 plan 路径：`mstar-conventions`；**PM** 派 QC 前：`mstar-review-qc`；**`qc-specialist*`**：`mstar-roles` → `references/qc-specialist/`；`qa-engineer`：`references/qa-engineer/`；改 status/residual：`mstar-artifacts`；UI：`mstar-design-md`；知识库：`mstar-compound`（PM） |
| **leaf 承接方** | 上栏 + **`mstar-dispatch-gates`**（反递归节） | — |

Routing eval（Cursor 插件内回归用，**非**运行时必读）→ `.cursor/skills/mstar-routing-eval/`。

## 状态机

`Todo` → `InProgress` → `InReview` → `Done` | `Blocked`

- **`Done`**：仅 `@project-manager` 或 `@qa-engineer`。
- 实现类可设 **`InReview`**，不可设 **`Done`**。

`status.json`（v2 根）/ workflow snapshot / project register 字段与 residual → **`mstar-artifacts`**。

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
| `audit` | `@code-reviewer`（mstar-audit 承载；大型仓库经 Assignment `Delegation: allowed (scout/explore only, read-only)` 扇出只读 scout；read-only advisory；不进入状态机） |

**硬规则**：`quick` **从不**跳过 `specify → clarify → plan`；禁止把新 CLI/API/多模块/新测例标为 `quick`。已启用 `{HARNESS_DIR}` 时，首次 implement 前须有主 plan 路径 + `status.json` 登记（见 **`mstar-conventions`**）。

## `@explore` 边界

- 已分派角色的 Assignment：**禁止**用 `@explore` 代替实现/测试/审查/文档交付。
- 允许短窄只读辅助；`glob`/`grep`/`read` 够用时不必 `@explore`。
- PM 分派前摸底：**推荐**；分派后承接方**勿**转包。

## 长任务纪律

可追踪清单（plan `tasks` 或 Todo）；偏离时 PM 拉回；完成前须可核对证据（实现侧自检见 **`mstar-coding-behavior`**；门禁证据见 **`mstar-phase-gates`** / **`mstar-review-qc`**）。

**Durable Roadmap Gate**：凡声明“分批 / 后续 / next plan / later / temporary workaround”的非热修任务，必须在 `{PLAN_DIR}` 主 plan、CreatePlan mirror、`status.json`/residual、或 PM Task Board 中写清后续路线（批次、依赖、owner/触发条件、完成定义）。只在对话或 Completion Report 里说“以后做”不算可追踪，不能进入 implement GO 或 Done。

## 专题 skill 索引

| Skill | 职责 |
|-------|------|
| `mstar-harness-core` | 本文件：入口、状态机、Task category、explore、索引、护栏 |
| `mstar-phase-gates` | per-plan 双阶段门禁：Prepare/Execute、意图门禁、hotfix、可验证编辑 |
| `mstar-iteration` | 迭代管理：Phase 1–5（start / Autonomous Execute / iteration-close / PR delivery / PR merge-ready loop） |
| `mstar-dispatch-gates` | 派发、Delegation、反递归、依赖与隔离驱动并行、SDD 路径 plan QC 强制 tri |
| `mstar-engine-legacy` | 条件契约档案（engine-absent fallback）：status v1→v2 字段历史、lease 协议全文、各宿主 N=3/N=1 重述、反递归全清单、Engine-check 样板；engine 激活时不加载 |
| `mstar-sdd` | Subagent-driven development：file handoff、per-task review、ledger |
| `mstar-branch-worktree` | 功能分支、worktree、QC/QA 检出对齐 |
| `mstar-conventions` | `{HARNESS_DIR}` 发现、初始化、Spec 分支模型摘要、产物路径 SSOT |
| `mstar-artifacts` | 主 plan、review bundle / durable summaries、`status.json`（v2 根）+ workflow snapshots + project register、residual、knowledge |
| `mstar-project-governance` | 项目治理层：`projects/<id>/roadmap.md` 编写约定 + `residuals.json` register 生命周期（open → verified close in place）、`_default` 回退、provenance；schema 与 engine `project.ts` 逐字一致 |
| `mstar-design-md` | DESIGN.md 设计系统规范 —— 创建/审计/维护 design tokens，三级检查清单，light/dark 双主题 |
| `mstar-review-qc` | PM：QC tri 编排、residual 留档、四层边界；leaf 执行 → `mstar-roles/references/qc-specialist/` |
| `mstar-coding-behavior` | Think / Simplicity / Surgical / Debugging / Review Feedback / Goal-Driven |
| `mstar-compound` | 知识结晶 —— 已解决问题→结构化知识文档，双轨（Bug/Knowledge），「是否值得结晶」自检清单，重叠检测，可发现性检查，CONCEPTS.md 协同 |
| `mstar-compound-refresh` | 知识维护 —— 审查/更新/合并/删除 `{KNOWLEDGE_DIR}` 文档；**项目知识 bootstrap**（无/残旧 STRATEGY.md、CONCEPTS.md、`{KNOWLEDGE_DIR}`）→ `references/project-knowledge-bootstrap.md` |
| `mstar-strategy` | `STRATEGY.md` 全局战略方向 —— 产品愿景、技术方向、决策原则 |
| `mstar-skill-authoring` | 通用 skill 撰写门控（SkillsBench 六原则）：trigger 契约、紧凑 5 问 body、渐进披露、paired 证据 |
| `mstar-audit` | Variant carrier：common core（hard rules、recon、vet、variant dispatch）+ SKILL.md `## Plan output (all variants)`（Status block、plan files、handoff）+ `references/codebase-audit.md`（full-audit 变体：9 类别 fan-out、effort、scope variants、Phase 4 excerpt/reconcile、audit index 模板）+ `references/security-review.md`（security 深查：exploitability 门槛、FP 纪律、LLM/供应链面）+ `references/pr-review.md`（`pr` 变体）；`audit-playbook` + `finding-format` + `plan-quality-bar` |
| `mstar-e2e` | 用户显式启动的独立真实浏览器 / 真机 / E2E 验证 workflow；PM 编排、ops 执行，不进入迭代 QA gate |
| `mstar-roles` | 角色正文 hub |
| `mstar-host` | 宿主适配（自动识别；`references/opencode.md` / `cursor.md` / `codex.md` / `kimi.md` / `parallel-dispatch.md`） |

## 宿主 `mstar-host`

Read **`mstar-host`** after this skill; detect host per its table, then Read the matching reference.

| 宿主 | 要点 |
|------|------|
| OpenCode | `question`、**task tool**（**subagent** 参数）→ `references/opencode.md` |
| Cursor | Task 并行 QC；Plan 双写 → `references/cursor.md` · `cursor-plan-mode-bridge.md` |
| Codex | plugin skills、sandbox/apply_patch/tool discovery；无 invoke 工具时不声称 subagent dispatch → `references/codex.md` |
| Kimi | `Agent`/`AgentSwarm`（仅 `coder`/`explore`/`plan`）；角色绑定在 prompt（C5b）；Plan 双写 → `references/kimi.md` · `kimi-plan-mode-bridge.md` |
| 其它 | 同 `mstar-host` skill；按工具信号选 reference |

## 版本对齐（CLI ↔ host 插件）

- 全局 CLI 与已安装的宿主插件**独立升级**；版本漂移是已知故障源（skills/commands 与 CLI 预期不再匹配）。
- 检查：`mstar-harness doctor --target <host>`（全部宿主已实现：opencode / cursor / codex / zcode / omp / dsh / kimi）。
- **CLI 较新** → 提示用户更新宿主插件；**插件较新** → 提示用户更新全局 CLI（`npm i -g @mstar-harness/cli@latest`）。
- 触发纪律：harness 行为异常/疑似过期、已知新版本发布后、或用户要求时运行——**不是**每个会话都跑。

## 定向执行与验证边界

本节是全部角色的范围与验证授权 SSOT；角色方法只展开其执行细节，`Skill presets: none` 仍由共享 leaf 边界承接这些限制。

- **本地全量测试默认禁止，完整套件交 CI。** 只有用户明确许可才能例外；Assignment 的 `Constraints` 引用许可，`Evidence Required` 写明命令、范围、环境与次数。PM 字段、风险等级、缺证据、fix wave 和早期探索都不产生许可；不得拆成多个无关“小测试”绕过全量边界。
- **全域只读调查限早期探索。** 实现、fix、QC、QA 只查本次变更、直接影响接口及相关 knowledge；不重新全仓扫描、测试或审查。通过知识索引只选相关 Active 条目；缺口超出范围时报告具体所缺信息，不自行扩展任务。
- **验证按变更映射。** 可执行逻辑使用对应单测；非可执行文档与 prompt/skill 策略使用真实定向静态或 before/after 证据，不制造测试文件。SDD 的 `Verification mode: scoped-check` 格式与适用性 → `mstar-sdd/references/file-handoffs.md`。报告结构校验不证明命令执行或 diff 适用性，也不是任意 shell 拦截器。
- **只使受影响证据失效。** HEAD 或 Review range 改变不等于全部重跑；复用仍有效的 L1/CI/先前 QA 证据，记明原范围及仍适用的理由。fix 只验证相关回归；QC 复审只看归属 finding、fix delta 与直接接口。`full tri-review` 表示席位数量，不授权全仓 review；QC 不运行 test/build/install。
- **QA 仅定向单元测试与验收证据映射。** 模式仅 `acceptance-only` / `targeted` / `report-only`。用户许可的本地全量由实现 owner 或 ops 另接明确行动，QA 只消费证据。真实浏览器、真机、安装/部署 E2E 仅由用户显式启动独立 `mstar-e2e` workflow，PM 编排、ops 执行；不作为迭代 QA gate。未验证的真实环境行为如实记录，不伪称通过。
- **依赖允许即并行。** PM 对无依赖、写所有权及 worktree 隔离的 ready tasks 并行派发；共享写目标、同一 session/ledger、前置接口与 integration merge 才按具体约束串行。leaf 不因并行策略获得派发权限。
- **完成即交付。** Assignment 给出任务、输入、所有权、允许检查与可观察结果；执行者只解答这些问题，不重复分析已解决内容、不顺手修复或增加“保险”检查。真实范围缺口返回 PM，已有证据充分即停止。

## 核心研发守则

全局工程不变量，适用于所有角色；实现级操作细节（The Ladder、surgical、debugging 等）→ **`mstar-coding-behavior`**。

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## 护栏（不变量）

- 未经用户同意不改宿主配置文件与用户凭据。
- 行为变更须有验证证据。
- 业务仓默认功能分支（Assignment `Branch policy` 例外）→ **`mstar-branch-worktree`**。
- **Dev 三角**：`@fullstack-dev` 后端主导；UI → `@frontend-dev`；第二轨 → `@fullstack-dev-2`（`mstar-roles` PM 节）。
- 工期仅 agent-oriented → **`mstar-conventions`** · effort-estimation。
- plan-writing artifacts land in `{PLAN_DIR}`, not external default plan directories.
- PM Assignment 键名英文；任务正文可中文；产出/报告默认英文。

## 升级触发

验收仍模糊、评审冲突、重复失败、根因不可收敛 → 升级报告（状态、方案、推荐路径）。

**专题 skill**（规则在各自 `SKILL.md`）：`mstar-phase-gates`、`mstar-branch-worktree`、`mstar-artifacts` 等 — 见上表索引。
