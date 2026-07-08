# 更新日志

本仓库 harness 发布面版本以 [CHANGELOG.md](CHANGELOG.md) 为准：**1.1.0**。

| 发布面 | 位置 | 版本 |
| --- | --- | --- |
| monorepo 根 | `morning-star`（`package.json`） | **1.1.0** |
| CLI | `@mstar-harness/cli`（`packages/cli`） | **1.1.0** |
| OpenCode 插件 | `@mstar-harness/opencode`（`packages/opencode`） | **1.1.0** |
| Cursor 插件 | `.cursor-plugin/plugin.json` | **1.1.0** |
| Codex 插件 | `.codex-plugin/plugin.json` | **1.1.0** |

各包独立日志：[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)、[packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md)。

## [1.1.0] - 2026-07-08

### Harness（临时 review bundle）

- **Review bundle 默认策略**：QC/QA 原始过程报告现在进入 `{SDD_DIR}/review/`（gitignored）；进入 git 的 handoff 产物是主 plan gate summary 与 `{HARNESS_DIR}/status.json` residual findings。
- **Legacy tracked reports**：`{PLAN_DIR}/reports/` 仅作为 legacy / 显式 audit mode，不再是默认 QC/QA 报告目标。
- **Iteration compass**：新增 `Quality Gate Summary` 区块，用于迭代级 QC/QA verdict 与 residual 汇总，不替代 per-plan summary 或 `status.json`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.1.0**。

## [1.0.6] - 2026-07-08

### Harness（SDD per-task reviewer 派发）

- **`mstar-sdd`**：L2 per-task reviewer 固定为 **`subagent_type: generalPurpose`**；task 级禁止 `qc-specialist*`（全部 task 完成后的 plan QC tri 仍为 L3）。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.6**。

## [1.0.5] - 2026-07-07

### Harness（分层 QA gate + 角色域 QC/QA 引用）

- **分层 QA gate**（`mandatory` | `pm-acceptance` | `report-only`）与 PM 派发矩阵（`qa-trigger-matrix.md`）；hotfix/小型干净后端默认 `pm-acceptance`；中型+、UI、residual 仍须 mandatory QA。
- **L4 验收收窄**（`qa-engineer/acceptance-gate.md`）：复用 QC consolidated 证据；`QA mode: acceptance-only` 时默认不全量重跑测试。
- **角色域执行引用**：leaf QC → `mstar-roles/references/qc-specialist/`；L4 QA → `qa-engineer/`；**`mstar-review-qc`** 收窄为 PM 编排层。
- **正面加载列表**：各角色只写「该读什么」，避免 leaf agent 被反向引导去读 `mstar-review-qc`。
- **Routing eval v17**：hotfix/small-backend → `pm-acceptance`；UI 仍 `mandatory`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.5**。

## [1.0.4] - 2026-07-07

### Harness（并行 implement worktree 门禁）

- **新增 `mstar-branch-worktree/references/parallel-writable-pre-dispatch.md`**：同仓 **≥2 可写 implement 并发** 的派发前 SSOT 清单 — `git worktree add`、绝对路径 **`Worktree path`**、PM 留在集成分支、未就绪则 emit-zero。
- **`mstar-dispatch-gates`**：**双门禁表** — 工具并发（同条消息 N 次 invoke）与同仓写隔离；明确 **N invoke ≠ worktree 合规**。
- **`mstar-branch-worktree`**、`mstar-iteration`、`mstar-phase-gates`、`project-manager`、`dispatch-and-assignment`、`fullstack-dev-shared`：瘦身为指向 reference 的短链；去除重复清单正文。
- **`mstar-harness-core`**：反模式索引新增「并行 implement 无 worktree」。
- **Routing eval v16**：并行 implement 缺 per-track **`Worktree path`** 硬失败；强化并行开发场景的 worktree 断言。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.4**。

## [1.0.3] - 2026-07-07

### Harness（iteration 连续推进）

- **`iteration-drive`**：新增 Phase 2–5 **Continuous execution（HARD）** — 进度汇报后禁止例行 yes/no；turn 须以 in-flight dispatch 收束；per-plan 串行 implement；明确合法 STOP 边界。
- **`mstar-iteration` §2.6**：扩展 **Push 纪律（Autonomous Execute）** — Phase 5 merge-ready exit 前连续编排；task/plan/phase 间禁止确认问句。
- **`pm` skill**：恢复 **Autonomous Execute push** 为第 4 条规则；迭代语义 SSOT 仅 **`mstar-iteration`**（runtime skills 不引用 command 名）。
- **Skills 与 command 分层**：自 runtime `mstar-*` skills 移除 `iteration-drive` 反向引用（host、project-manager、sticky implementer、dispatch-and-assignment）。
- **Routing eval v15**：mid-execute 向用户 check-in 硬失败；新增 `iteration-drive-continuous-after-plan-wave` 场景。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.3**。

## [1.0.2] - 2026-07-07

### Harness（iteration 产物边界收紧）

- **`mstar-iteration` §1.5.5 / §1.6**：Phase 1 边界 — `{SPECS_DIR}/` 为已锁定长期规格；`{ITERATION_DIR}/<iteration-id>/` 工作区（`guides/`、`specs/`）存迭代级草案；**iteration-start 禁止**向 `{KNOWLEDGE_DIR}/` 新增。
- **`iteration-start` / `mstar-dispatch-gates`**：Review & Edit 链 — product/architect 改 specs + workspace；writing-specialist 做 **specs corpus hygiene** 与既有 knowledge 归档。
- **`mstar-compound`**：iteration-close **强制盘点** `<iteration-id>/` workspace，将值得保留的 specs/guides **提升**至 `{KNOWLEDGE_DIR}/`（结构化重写，非整文件复制）。
- **新增 reference**：`iteration-artifact-boundaries.md`、`iteration-corpus-hygiene.md`、`iteration-workspace-readme-template.md`；`knowledge-and-designs.md`、角色引用、`artifact-storage-paths.md` 已对齐。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.2**。

## [1.0.1] - 2026-07-07

### Harness（SDD iteration-drive + sticky implementer + pm shim）

- **`iteration-drive` / `mstar-iteration`**：Phase 2 显式强制 per-task SDD 循环（Boot 载入 `mstar-sdd`）；禁止多 task plan 用 inline 大包派发。
- **Sticky implementer**（`SDD implementer session: sticky`）：可选同一 dev subagent 跨 task 续会话（Cursor Task `resume`）；`implementer-session.json` 账本；**task reviewer 仍每 task fresh**。
- **`pm` skill**：精简为跨宿主入口 shim；iteration 编排 Boot 在 **`commands/`**；SSOT → `project-manager.md`。
- **派发模板**：`SDD implementer session` 字段；SDD vs inline Assignment 对照表。
- **Routing eval v14**：iteration Phase 2 SDD 硬失败项；新增 `sdd-sticky-implementer-multi-task`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.1**。

## [1.0.0] - 2026-07-07

### Harness（SDD + plan QC 三审）

- **新增 `mstar-sdd`**：文件交接、per-task implementer + **task reviewer**（L2）、`progress.md` 账本。
- **SDD 路径 plan QC**：**强制 tri-review**（QC#1/#2/#3 交叉审整分支，**N=3**）— 单 plan 与 iteration 均适用；**不是**仅一次单席 final review。
- **单席 `qc.md`**：仅 `Execution mode: inline` / hotfix 或用户 override。
- **Plan 模板**：Global Constraints、Interfaces、自检门；`status.json` 可选 `sdd_dir`、`task_commits[]`。
- **PM Assignment**：`Execution mode`、`SDD dir`、`Model tier`；多 task 默认 SDD。
- **CLI**：`init`/`doctor` 追加/检查 `.mstar/sdd/` gitignore。
- **Routing eval v11**：SDD + 强制 tri-review；inline/hotfix 单席。

### Breaking changes

1. 多 task 实现默认 **`Execution mode: sdd`**。
2. **SDD 下 plan QC 强制三审**；per-task 由 **task reviewer** 负责，不是单席 QC 代替。
3. **单席 `qc.md`** 仅 inline/hotfix 或 override。
4. 新 plan 须含 Global Constraints + Interfaces。
5. `.mstar/sdd/` 须 gitignore。

### 与 Superpowers v6

L2 task reviewer + L3 **tri 交叉审**（非 v6 仅 single final reviewer）。详见 `.harness/specs/sdd-1.0.0-design.md`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.0.0**。

## [0.7.9] - 2026-07-06

### Harness（Assignment plain role id / OpenCode `@` 卫生）

- **Assignment SSOT**：`dispatch-and-assignment.md` 模板、PM 路由表、`project-manager.md` Language 规则 — Assignment **正文**角色引用一律 **plain role id**（无 `@`）；宿主派发用 task tool **`subagent`** 对齐 `Execute as`。
- **`mstar-dispatch-gates`** 与 **leaf-executor checklist**：反递归 NEVER 改为 `role-id` 提及表述（避免 `@<role>` 字面量）。
- **`mstar-host/references/opencode.md`**：Role-mention hygiene — Assignment 正文 vs task-tool 派发；警告文案不含会触发 OpenCode 自动派发的 `@` 字面量。
- **iteration commands**、**`mstar-branch-worktree`**、**`mstar-plan-artifacts`**（plan 勾选职责）、**`pm` skill**、各 **role NEVER** 引用已对齐 plain id。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.8 → 0.7.9**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.8] - 2026-07-06

### Harness（iteration Phase 4–5 / PR merge-ready loop）

- **`mstar-iteration` Phase 4–5**：生命周期扩展为 **PR 交付**（Phase 4）与 **PR merge-ready loop**（Phase 5）——验证—修复—再验证，直至 mergeable、required CI 全绿、review threads resolved（修复后须 per-thread comment + resolve）。Loop SSOT 留在 `mstar-*`；不反向引用 host command。
- **`iteration-drive`**：编排 Phase 2 → 3 → 4 → 5；**Done** 仅以 Phase 5 exit checklist 为准。Phase 5 可按环境发现 **non-`mstar-*`** helper（`greploop`、`babysit`）；fallback 与 babysit 同级（CI + reviews）。
- **`mstar-harness-core`**：迭代 lifecycle 索引与「开 PR 后跳过 Phase 5」反模式；PM load contract 覆盖 `mstar-iteration` Phase 1–5。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.7 → 0.7.8**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.7] - 2026-07-04

### Harness（`mstar-*` 自洽 / 解耦第三方 runtime）

- **Standalone harness 护栏**（`mstar-harness-core`）：`mstar-*` load order 不得依赖仓库外 skills、CLI、MCP；库文档/API 问题优先 Read/Grep 项目内文档与源码。
- **bundled `grill-me` 仅 `/iteration-start`**：新增 `skills/grill-me/SKILL.md`；仅 command §3 引用，不进入 `mstar-*` 索引或 load matrix。`mstar-iteration` §1.2 增加通用 **Direction lock**（不点名 grill-me）。
- **移除 runtime 路径中的第三方耦合**：删除 `library-docs-protocol.md`（Context7）、`openviking-memory-plugin.md`（OpenViking）；`mstar-host` 去掉 Context7 节；`mstar-design-md` 去掉 Open Design 集成；`mstar-host/references/opencode.md` 去掉 Optional MCPs 表。
- **`open-harness-principles.md` 蒸馏**：harness 术语对照并入 `mstar-harness-core`；`AGENTS.md` 分层 → `mstar-plan-conventions/references/harness-bootstrap-and-agents-layering.md`；原文件删除。
- **`mstar-roles`**：保留 **Role → typical topic skills** 跨角色矩阵；专题索引仍在 `mstar-harness-core`。**`prompt-engineer`** 保留新建/大改 skill 时的 **`skill-creator`** 要求（`AGENTS.md` 记录 standalone 例外）。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.6 → 0.7.7**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.6] - 2026-07-01

### Harness（iteration 派发 / commands–skills 分层）

- **Commands 与 skills 分层**：`iteration-start`、`iteration-drive` 负责编排（Boot、phase 状态机、步骤 checklist）；`mstar-iteration`、`mstar-dispatch-gates` 保持与 command 名无关的 SSOT。移除 skill ↔ command 循环引用。
- **`iteration-start` / `iteration-drive`**：PM invariants、Phase 2→3→PR 过渡门禁、派发回合纪律、Phase 3 开 PR 前置条件；仅剩 1 个非 Done plan 时追加 `phase-3-iteration-close` host todo。
- **`mstar-iteration`**：Phase transition gates 表；§2.5 派发回合规则；compass 模板字段按 Phase 1–3 标注（不再用 command 名）。
- **`mstar-dispatch-gates`**：**Specialist review-and-edit dispatch**（通用）；Phase 1 链为**顺序**派发；paste-only 与跳过 Phase 3 反模式。
- **`mstar-host`**：删除 Mode A/B/C 补充执行路径；统一 canonical invoke 派发；无可用工具时 **`Blocked`**；`codex.md`、`parallel-dispatch.md` 对齐。
- **`pm` skill**：迭代段落去重，仅指向 `mstar-iteration`。
- **Phase 1 Review & Edit chain**：改为**顺序** `product-manager` → `architect` → `writing-specialist`（上一角色落盘后再 invoke 下一角色）；本链禁止并行 batch。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.5 → 0.7.6**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.5] - 2026-07-01

### Harness（iteration / 分支策略）

- **显式迭代分支策略**：正式 iteration 必须在 compass frontmatter 与 `status.json` metadata 中登记 `iteration_base_branch`、`spec_integration_branch`、`target_branch`。禁止静默默认 `main` / `master` 作为集成分支起点或最终 PR 目标。
- **`iteration-start` / `iteration-drive`**：grill-me 分支确认、pre-commit checklist 分支项、§2.0 branch metadata 门禁、创建 integration 分支时显式 `git checkout -b <spec_integration_branch> <iteration_base_branch>`。
- **`mstar-iteration` §2.3**：metadata 解析链（`status.json` → compass frontmatter → 询问用户）；QC `Review range` merge-base 使用 `target_branch` 或 PM 指定 ref。
- **Compass 模板**：新增 `## Delivery Branch Policy`；`status-and-residuals.md` 补充 metadata 示例 JSON。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.4 → 0.7.5**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.4] - 2026-07-01

### Harness（skills / docs）

- **移除 Morning Star 运行时对 Superpowers 的依赖**：删除 Superpowers 安装引导与对齐表述；Morning Star assignment 改为依赖 mstar-native 的 dispatch、worktree、plan、review 与 evidence 契约。
- **将 execution practices 并回 `mstar-coding-behavior`**：删除 `mstar-execution-practices`；将 review feedback handling 并入 `mstar-coding-behavior`；RCA、测试优先检查、完成证据留在编码行为基线，PM 门禁证据仍由 `mstar-phase-gates` / `mstar-review-qc` 承担。
- **新增 `mstar-skill-authoring`**：提供 Morning Star-native 的 skill 编写指导，覆盖 trigger contract、渐进披露、pressure scenarios 与行为变更证据。`prompt-engineer` 在新建 skill、重大重写或修改触发描述前必须读取该技能。
- **文档与宿主适配同步**：README / README_CN、OpenCode 安装说明、角色引用与 host references 不再要求外部 skill 插件。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.3 → 0.7.4**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.3] - 2026-06-30

### Harness（iteration-close / commands / docs）

- **`mstar-iteration` Phase 3 收口门禁**：iteration-close 明确为所有 plan `Done` 后的独立 phase；final plan closure 只能提供输入，不能替代 close。收口要求按需规范化 compass 结构，打印 close entry / close exit checklist，执行 compound round，更新 roadmap，写入 compass frontmatter `status: completed` + `end_date`，并在 PR 前 commit 到 integration 分支。
- **Compass 模板加固**：新 compass 模板不再预填 `end_date`；`## Roadmap Position`、`## Compound Round Summary`、`## Iteration Retrospective (minimal)` 是 close 阶段的预期写入位置。历史正文 completion status 必须在 close 时规范化为 YAML frontmatter。
- **Compound 索引门禁**：iteration-close compound round 中每篇新增 knowledge doc 都必须完成 `mstar-compound` Phase 6，并登记到 `{KNOWLEDGE_DIR}/README.md`；lightweight capture 不豁免。
- **README / README_CN**：Harness Commands 列出 `/mstar-bootstrap`、`/iteration-start`、`/iteration-drive`；Harness Workflow 更新为 `iteration-start → per-plan execute loop → iteration-close → PR`；Core Skills 表补齐 iteration、design、compound、compound-refresh、strategy 等专题技能。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.2 → 0.7.3**。**`@mstar-harness/cli` 保持 0.5.4**。

## [0.7.2] - 2026-06-30

### CLI / Cursor 安装

- **Cursor 插件路径布局**：`mstar-harness init --target cursor` 在 Cursor 插件路径安装**真实 git checkout**（`git clone` / `git pull`），不再软链接到 `~/.mstar/harness`。Cursor **无法发现**软链接形式的插件目录。
- **`doctor --target cursor`**：插件路径为 symlink 时报错；`init` 会删除已有 symlink 并 clone。
- **文档**：`docs/cli.md` § Install path layout；README/CN 手动安装与维护者刷新说明已更新。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.1 → 0.7.2**。**`@mstar-harness/cli`**：**0.5.3 → 0.5.4**。

## [0.7.1] - 2026-06-30

### Harness（skills / iteration-start）

- **`/iteration-start` Review & Edit chain 硬门禁**：§5 在 integration 分支 commit 前强制完成——通过 Task 派发 `@product-manager`、`@architect`、`@writing-specialist`（可并行）；PM 线程不得代做全部专业角色编辑。Done = 已修订的 compass/plans/specs + compass `status: locked`，而非初稿落盘即完成。
- **`mstar-iteration` §1.6**：将 review chain 记为 integration 分支前置条件（skill SSOT）；**不**要求 `reports/<iteration-id>/` 审查报告——与 per-plan QC 不同，迭代审查无后续审计链，SSOT 为被编辑的文档本身。
- **`skills/pm`**、**`mstar-dispatch-gates`**、**`mstar-harness-core`**：iteration-start dispatch-first 规则、反模式与 pre-commit checklist 与命令 §5 对齐。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.7.0 → 0.7.1**。**`@mstar-harness/cli` 保持 0.5.3**。

## [0.7.0] - 2026-06-30

### Harness（skills / iteration, compound, strategy, qc, commands）

- **新增 `mstar-compound` 技能**：知识结晶，含 Bug/Knowledge 双轨模板、YAML frontmatter schema、8 题自检清单、重叠检测（更新已有文档而非创建重复）、可发现性检查（提议 AGENTS.md 更新）、CONCEPTS.md 词汇协同。在**迭代收口**时执行，非 per-plan Done 后。
- **新增 `mstar-compound-refresh` 技能**：知识维护——对照当前代码库审查/更新/合并/替换/删除知识文档，CONCEPTS.md reconciliation。
- **新增 `mstar-strategy` 技能**：STRATEGY.md 创建与维护，作为项目上游锚点（愿景、技术方向、指导原则、决策日志）。
- **新增 `mstar-iteration` 技能**：完整迭代生命周期管理——Phase 1 iteration-start（范围/Roadmap 锁定、compass 创建），Phase 2 Autonomous Execute（per-plan 派发循环：分支→实现→QC→QA→Done→合并，跨 plan 进度同步），Phase 3 iteration-close（compound 轮、roadmap 更新、回顾、commit）。Autonomous Execute driver 从 `skills/pm/SKILL.md` 移入此处；PM skill 精简为角色身份、host 入口与 dispatch-first 规则。
- **新增 `/mstar-bootstrap` 命令**：为空白/残旧知识项目从代码库提炼 STRATEGY.md、CONCEPTS.md 与基线知识文档（7 阶段流程）。
- **新增 `artifact-storage-paths.md`**：产物路径集中 SSOT，位于 `mstar-plan-conventions` 下，所有产出技能引用此表，防止路径漂移。
- **QC deep review 透镜**：以自检透镜清单（12 个透镜、6 个触发信号）替代 persona subagent 派发。不派发子代理，解决与 `mstar-dispatch-gates` 的反递归冲突。
- **索引更新**：`mstar-harness-core` 拆分为 per-plan 与迭代级周期；全部 skill 索引表、`mstar-roles` 依赖矩阵、`mstar-phase-gates` per-plan 门禁均已更新。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`：**0.6.22 → 0.7.0**。**`@mstar-harness/cli` 保持 0.5.3**。

## [0.6.22] - 2026-06-27

### Harness（skills / dispatch-gates, roles）

- **反递归：身份剥夺框架替代纯禁止规则**：leaf executor（QC reviewer、dev、QA）仍然进入"考虑 dispatch"的意图窗口，因为 `NEVER` / `MUST NOT` 禁止规则要求模型先激活被禁止行为再抑制。本次修复将语义从"你不能用 Task"（禁止）转为"你就是 leaf executor，Task 不是你的工具"（身份 + 能力剥夺）。
  - Assignment 模板（`dispatch-and-assignment.md`）：在 `**You MUST NOT:**` 列表之前新增 **IDENTITY** + **CAPABILITY BOUNDARY** 块。`Delegation` 字段移至 `Execute as` 之后，提升可见性。
  - `mstar-dispatch-gates/SKILL.md`：在 Load order 与 NEVER 列表之间插入 leaf-executor 身份前言，并显式回指 Assignment 的 IDENTITY 块。
  - `qc-specialist-shared`：`Non-Recursive Dispatch Rule` 改为第一人称身份断言，附带递归 dispatch 陷阱识别（"If you ever think 'this would be more efficient if I dispatched X' — stop"）。
  - `leaf-executor-checklist`：checklist 项之前增加第一人称前言。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`：**0.6.21 → 0.6.22**。**`@mstar-harness/cli` 保持 0.5.3**，Cursor / Codex 插件 manifest 保持 **0.6.21**。

## [0.6.21] - 2026-06-26

### Harness（skills / design-md）

- **DESIGN.md YAML frontmatter 作为 SSOT**：`mstar-design-md` 模板和规范现在使用 YAML frontmatter 作为 token 值的唯一数据源。模板格式版本升至 0.1.0。明暗双主题模板（`DESIGN.md.template`、`DESIGN.dark.md.template`）、规范参考、完整性检查清单以及 Vercel 示例均已更新。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor / Codex 插件 manifest：**0.6.20 → 0.6.21**。CLI：**0.5.2 → 0.5.3**。

## [0.6.20] - 2026-06-26

### Harness（commands）

- **`/iteration-start` Review & Edit 链**：§5 从"Review Chain"改为"Review & Edit Chain"。product-manager、architect、writing-specialist 三个角色现在 review 后直接编辑文档，而非仅标记问题。PM 只做最终 review 和 lock，不再承担汇总其他 reviewer 修订的工作。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.19 → 0.6.20**。**`@mstar-harness/cli` 保持 0.5.2**。

## [0.6.19] - 2026-06-26

### Harness（skills / coding-behavior）

- **将 Ponytail 编程守则蒸馏入 `mstar-coding-behavior`**：四节均加强：
  - **§1 Think Before Coding**: 新增"先读懂再偷懒"——先完整阅读任务和每个涉及文件再动手；小 diff 改错地方是第二个 bug，不是效率。
  - **§2 Simplicity First**: 新增 YAGNI 门禁（"是否需要写代码？"）、The Ladder（7 级决策层级：不写→复用已有→stdlib→原生平台→已安装依赖→一行→最少代码）、"删除优于添加 / 简洁优于聪明"、`simplify:` 标记规范（有意简化时标注天花板和升级路径）。
  - **§3 Surgical Changes**: 新增"Bug 修根因，不休症状"——编辑前 grep 所有调用点；在共享入口修一次，不只修 ticket 提到的那条路径。
  - **§4 Goal-Driven Execution**: 新增"非平凡逻辑的最小检查"——任何非平凡改动须留下一个可运行检查（assert/最小 demo/单个 test）；YAGNI 同样适用于测试。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.18 → 0.6.19**。**`@mstar-harness/cli` 保持 0.5.2**。

## [0.6.18] - 2026-06-26

### Harness（commands）

- **`/iteration-start` Boot 节**：新增显式 `## 0. Boot` 节，与 `/iteration-drive` 对齐。在开始调研前加载 `mstar-harness-core`、`mstar-roles` → `references/project-manager.md`、`skills/pm/SKILL.md`（Host entry + Boot）、`mstar-phase-gates`（Prepare）以及 `mstar-plan-conventions` / `mstar-plan-artifacts`。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.17 → 0.6.18**。**`@mstar-harness/cli` 保持 0.5.2**。

## [0.6.17] - 2026-06-26

### Harness（commands）

- **`/iteration-drive` PR 目标修复**：最终 PR 的目标分支改为从迭代元数据（`status.json` → `target_branch`）解析，而非硬编码 `main`。未设置 `target_branch` 时默认 `main`。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.16 → 0.6.17**。**`@mstar-harness/cli` 保持 0.5.2**。

## [0.6.16] - 2026-06-25

### Harness（commands）

- **新增 `/iteration-drive` 命令**：添加调用 PM Autonomous Execute driver（`skills/pm/SKILL.md` § Autonomous Execute driver）的命令，将全部非 `Done` plans 推进至完成。命令首先检查三个前置条件门禁；若 Prepare 未完成，则引导用户使用 `/iteration-start`。否则执行完整的 implement → QC → QA → Done 逐 plan 循环，直到所有 plans 完成，最后可选从集成分支向 `main` 提交 PR。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.15 → 0.6.16**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.15] - 2026-06-24

### Harness（commands）

- **新增 `iteration-start` 命令**：添加可复用的命令（`/iteration-start`）用于启动新一轮 harness 迭代。命令引导 PM 完成六个检查站步骤：调研（结构化 harness 目录 + 非结构化 glob 搜索 `roadmap*.md`、`deferred*.md`、`features*.md` 等）、探索产品完备性候选方向、使用 `grill-me` 锁定方向、编写迭代 compass 与 plans、运行审查链（`@product-manager` → `@architect` → `@writing-specialist` → PM 锁定）、从 `main` 创建迭代集成分支。同时注册到 Cursor（`commands/` 自动发现）和 OpenCode（通过插件代码捆绑 `harness-commands/`）。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.14 → 0.6.15**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.14] - 2026-06-24

### Harness（skills / design-md）

- **新增 `mstar-design-md` 技能**：用于创建、审计和维护项目级 `DESIGN.md` 设计系统规范的专用技能。三级完整性检查清单（MVP/标准/生产）渐进定义了 agent 从设计系统生成一致 UI 所需的内容，避免猜测 token。包含 Vercel Geist 作为带注释参考范本、light/dark 双主题支持（`DESIGN.md` + `DESIGN.dark.md`，相同 token 名、不同值）以及内置 `LEVEL*_PLACEHOLDER` 标记用于迭代成熟度升级。技能包含完整 references（`design-md-spec.md` 规范、`completeness-checklist.md`、`vercel-example.md`）和 templates（`DESIGN.md.template`、`DESIGN.dark.md.template`）。
- **Phase gate：DESIGN.md 检查**：PM Prepare 快速判定新增"若 plan 涉及 UI 工作，DESIGN.md 是否存在且满足声明的 completeness level"。
- **角色集成**：`mstar-design-md` 在所有相关角色依赖中注册 —— architect 为主创建者，product-manager 提供设计意图/需求，frontend-dev 和 fullstack-dev 为消费方（实现 styled UI 前读取 token），qc-specialist 为验证方（检查 UI 与 DESIGN.md 对齐），qa-engineer 验证视觉输出。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.13 → 0.6.14**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.13] - 2026-06-20

### Harness（agents）

- **移除 `model: inherit`**：清除全部 13 个 `agents/*.md` 文件中的 `model: inherit` 行。这些 agent 通过插件 manifest 继承默认模型，无需逐个显式覆盖，减少 frontmatter 噪音并避免与模型固定混淆。（Cursor frontmatter 清理。）

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.12 → 0.6.13**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.12] - 2026-06-20

### Harness（skills / dispatch gates）

- **Assignment 反模式头部**：每个 PM Assignment 开头新增 `**You are a leaf executor. You MUST NOT:**` 块，针对该分配的角色+上下文列出最易发生的派发违规。PM 在通用底线（禁止递归派发、禁止将路由叙事当 invoke、工具可用≠授权）之上追加具体反模式。`Orchestration Guard` 节引用此新顶部块。（`mstar-roles/references/project-manager/dispatch-and-assignment.md`）
- **Leaf executor 自检清单**：更新为要求每次收到 Assignment 时首先阅读 `**You are a leaf executor. You MUST NOT:**` 块。（`mstar-dispatch-gates/references/leaf-executor-checklist.md`）
- **派发门禁**：在反递归红线节追加了对新 Assignment 级反模式块的引用。（`mstar-dispatch-gates/SKILL.md`）

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.11 → 0.6.12**。**`@mstar-harness/cli` 保持 0.5.1**。

## [0.6.11] - 2026-06-16

### Cursor 插件 / agents

- **Subagent 注册**：全部 `agents/*.md` frontmatter 改为 Cursor 优先（`name`、`description`、`model: inherit` 置于 OpenCode `mode`/`tools`/`permission` 之前），使插件 manifest 中的 `agents/` 可被 Task 识别，**无需**额外安装到 `~/.cursor/agents/`。
- **CLI Cursor 安装路径**：global/project 插件软链统一为 `morning-star-harness`（与 `.cursor-plugin/plugin.json` 的 `name` 一致）。
- **CLI doctor**：校验 plugin agent 文件存在且使用 Cursor 优先 frontmatter。
- **文档**：更新 README（中英）、CLI 指南、插件 README、LOCAL-VALIDATION subagent 冒烟测试及 `mstar-host` Cursor 参考。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.10 → 0.6.11**。
- `@mstar-harness/cli`：**0.5.0 → 0.5.1**。

## [0.6.10] - 2026-06-11

### Harness（skills / agents）

- **Profile B Done 压缩（`plans-done.json`）**：权威 schema 收紧为**仅** `{ "plans": [<plan-id>, ...] }`，不再使用富字段目录对象（`title`、`done_at`、`plan_file`、`archived_record` 等）。单条详情以 `archived/plans/<plan-id>.json`（单个 `plans[]` 行快照）为准。SSOT：`mstar-plan-artifacts/references/done-compaction.md`。
- **模板与初始化**：新增 `templates/plans-done.empty.json`；在 `mstar-plan-conventions` harness bootstrap 与 PM `plan-management.md` 中补充 Profile B 初始化说明。
- **Profile B 约束**：禁止并行索引（`_index.json`、对象数组目录）；旧版 `plans-done.json` 须整文件改写为 id 列表。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.9 → 0.6.10**。**`@mstar-harness/cli` 保持 0.5.0**。

## [0.6.9] - 2026-06-09

### Harness（skills / agents）

- **`pm`（PM 编排入口）**：从仅 Cursor/Codex `/pm` 扩展为跨宿主通用入口 — **Cursor/Codex** 以 `/pm` 启动 `project-manager` 并驱动 Execute 自动化；**OpenCode** 在当前 agent 非 PM 时切换为 PM 编排身份。
- **Autonomous Execute driver**：Pre-implement **GO** 后读取 `{HARNESS_DIR}/status.json` 待办，检出 iteration **`spec_integration_branch`**，按 plan 执行 **`create <plan-feature> from integration` → implement → QC/QA → merge 回 integration**，直至全部 plan `Done`；每波工作前设置宿主 todos（Cursor `TodoWrite`、Codex `update_plan`、OpenCode UI），避免会话目标漂移。
- **`mstar-roles`（PM 壳）**：交叉引用更新，指向 `pm` skill 新章节（宿主入口、Execute driver、dispatch-first）。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.8 → 0.6.9**。**`@mstar-harness/cli` 保持 0.5.0**。

## [0.6.8] - 2026-06-04

### Harness（skills / agents）

- **QC 修复后复验（默认）**：dev 修完 blocking 项后，PM **只派**提出该问题的 QC 席（**targeted re-review**），不再默认无脑重派三审。各 QC **原位更新**同一份报告（`## Revalidation`）；PM 原位更新 `qc-consolidated.md`。仅当 Assignment 写明 **`QC re-review: full tri-review`** 时才复跑三审并使用 `qcN-rev2.md` 新文件名。
- **QC 报告命名**：`{PLAN_DIR}/reports/<plan-id>/` 下使用 `qc1.md`、`qc2.md`、`qc3.md`、`qc-consolidated.md`（文件名**不再**带 `<plan-id>` 前缀；`plan_id` 在 frontmatter 与目录中体现）。SSOT：`mstar-plan-artifacts/references/plan-files-and-reports.md`。
- **派发**：`mstar-dispatch-gates` 与 `mstar-host` 并行派发支持 targeted 复验 **N=1–3** 同条消息；首轮三审仍为 **N=3**。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.7 → 0.6.8**。**`@mstar-harness/cli` 保持 0.5.0**。

## [0.6.7] - 2026-06-03

### Harness（skills / agents）

- 新增 Codex Plan / Goal Mode bridge reference，明确 `/plan`、`update_plan`、`/goal`、goal progress 与 thread summary 不能替代 `.mstar/` SSOT 或 Morning Star Done 权限。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.6 → 0.6.7**。**`@mstar-harness/cli` 保持 0.5.0**。

## [0.6.6] - 2026-06-03

### Harness（skills / agents）

- 新增 `codex/agents/` 下的 Codex custom-agent 源文件，使可派发的 Morning Star 角色可安装到 Codex 的 `agents/*.toml` 子代理配置面；`project-manager` 仍通过 `/pm` 进入。
- 将项目 `{HARNESS_DIR}` 主推荐默认值改为 `.mstar/`，同时继续识别 `.agents/`、`.plans/`、`plans/` 等 legacy 布局。

### CLI

- Cursor 与 Codex 安装流程改为维护共享本地仓库 `~/.mstar/harness`，再创建宿主侧软链接；不再默认使用 Cursor project submodule 或 Codex URL-source marketplace 条目。
- `init` 会将 `codex/agents/*.toml` 链接到全局或项目 Codex agents 目录，`doctor` 同步校验这些链接。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.5 → 0.6.6**。
- `@mstar-harness/cli`：**0.4.0 → 0.5.0**。

## [0.6.5] - 2026-06-03

### Harness（skills / agents）

- **Durable Roadmap Gate**：强化 `mstar-harness-core`、`mstar-phase-gates`、PM 门禁、Cursor Plan 模式桥接，以及产品/架构模板；凡分批、部分交付或临时 workaround，都必须在 implement GO / Done 前写清目标状态与 roadmap。
- **编码行为**：将 `Simplicity First` 明确定义为“最小耐久切片”，不是临时补丁；暂缓项必须进入 plan/status 工件，不能只写在对话里。
- **Cursor routing-eval**：路由评估升至 v8，新增 `durable-roadmap-required-for-staged-work`，防止“先做一半，后续 plan 再说”的失败模式。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.4 → 0.6.5**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.4] - 2026-06-03

### Cursor Plan 模式 × Harness

- **Build resume contract**：Cursor Build 视为 plan resume，而不是 `/pm` replay。Morning Star plan 必须重新加载 harness 上下文，恢复 PM 编排，并通过 dispatch 执行实现，禁止父 Build 会话直接改产品代码。
- **Cursor routing-eval**：新增 `cursor-plan-build-resume`，防止在 SSOT plan 注册、PM Assignment 与 host Task dispatch 之前由父会话直接实现。
- **Cursor 插件 manifest**：`.cursor-plugin/plugin.json` 注册 `agents/`，与插件文档和本地校验清单对齐。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.3 → 0.6.4**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.3] - 2026-06-03

### Harness（skills / agents）

- **`pm`（`/pm`）**：精简入口（约 60 行），以 **`/pm`-only rules** 为 SSOT — **dispatch-first**（implement 须 Assignment + invoke，禁止父代理写产品代码、禁止以会话上下文跳过 Task）、**Autonomous Execute push** 定义为派发循环（单迭代可多 plan）、**branch truth**（禁止 plan/`status.json` 与 cwd 静默不一致）。细则指向 `mstar-dispatch-gates`、`mstar-host` 与 `project-manager` 引用。
- **`mstar-roles`（PM 壳）**：`/pm` 会话改为指向 `skills/pm` § `/pm`-only rules`，避免重复长文。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.2 → 0.6.3**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.2] - 2026-06-02

### Harness（skills / agents）

- **`pm`（`/pm`）**：新增 **Autonomous Execute push** — Execute 阶段启动后（`plan` 锁定、Pre-implement **GO**），按**当前迭代**连续推进全部待办（可跨**多个** `plan_id`），直至 implement → InReview → Done 收尾；不向用户追问基础性 yes/no，按 PM 推荐默认执行；流程与门禁以 **`mstar-*`** 技能为准（仅真冲突或 plan/spec 未覆盖的不可逆范围取舍时 **Blocked** / 升级用户）。
- **`mstar-roles`（PM 壳）**：补充指向 `skills/pm` § Autonomous Execute 的说明，供 `/pm` 会话对齐。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.1 → 0.6.2**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.1] - 2026-06-01

### Harness（skills / agents）

- **`mstar-plan-artifacts`**：新增只读 `scripts/tech-debt-rollup.sh`（jq），从 open `residual_findings` 计算 `metadata.tech_debt_summary` 并输出 PASS/DRIFT；在 `references/status-and-residuals.md`（英文）中作为 canonical 汇总路径。
- **`mstar-roles`（PM）**：当存在 **>=2 个独立** 后端/全栈任务单元时，默认在 `fullstack-dev` 与 `fullstack-dev-2` 间并行双轨或串行轮换；合并到单一 dev id 须 `single_stream_justified` 与书面 override。
- **Cursor routing-eval**：新增 `sequential-backend-batches-rotation`；收紧 `two-parallel-backend-modules` 对无 justification 单 dev 的 hard_fail。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.6.0 → 0.6.1**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.6.0] - 2026-05-30

### 统一宿主 skill

- **破坏性变更**：将 `mstar-host-opencode` 与 `mstar-host-cursor` 合并为 **`mstar-host`**（`skills/mstar-host/`，自动识别宿主 + `references/opencode.md`、`cursor.md`、`codex.md`、`parallel-dispatch.md`、`cursor-plan-mode-bridge.md`）。
- 新增 `references/codex.md`，覆盖 Codex 插件 skills、clarify 行为、沙箱文件/命令、工具发现，以及没有真实 multi-agent invoke 工具时的派发边界。
- 删除 `skills-cursor/` 与 `packages/opencode/skills/`；OpenCode 仅注册 `harness-skills/`；Cursor 插件仅挂载 `./skills/`。
- 同步角色/专题引用与 Plan 规则路径。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.5.1 → 0.6.0**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.5.1] - 2026-05-29

### Cursor Plan 模式 × Harness（Cursor 插件）

- **双写桥接**：CreatePlan 须同步落盘至 `{HARNESS_DIR}` / `{PLAN_DIR}` SSOT（`.agents/plans/`、`status.json`）；固定前缀 todo：`harness-init`、`spec-register`、`mirror-plan`；implement todo 完成前须 per–task-ID commit。详见 `skills-cursor/mstar-host/references/cursor-plan-mode-bridge.md`，及 `mstar-host-cursor`、`pm`、`mstar-harness-core` 更新。
- **Rules**：新增 `rules/mstar-cursor-plan-mode.mdc`（`alwaysApply`）；`.cursor-plugin/plugin.json` 注册 `"rules": ["rules/"]`，确保插件 rules（含 `mstar-entry`）可被加载。
- **维护者**：发版前自检清单迁至 `.cursor/LOCAL-VALIDATION.md`（自 `.cursor-plugin/` 移除）。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.5.0 → 0.5.1**。**`@mstar-harness/cli` 保持 0.4.0**。

## [0.5.0] - 2026-05-26

### Codex 集成

- 将已过时的仓库内 `.codex/marketplace.json` 路径替换为当前支持的个人 marketplace：`~/.agents/plugins/marketplace.json`，并使用指向本仓库的 `"source": "url"` 条目。
- `@mstar-harness/cli` 增加 Codex 支持：`init --target codex` 写入个人 marketplace 条目，`doctor --target codex` 校验该配置。
- 更新英文 / 中文安装文档，覆盖 Codex CLI 安装与手工 personal marketplace 配置。

### Harness（skills / agents）

- 修复 `/pm` skill frontmatter，使 Codex 插件可从仓库根目录通过校验。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.4.1 -> 0.5.0**。
- `@mstar-harness/cli`：**0.3.1 -> 0.4.0**。

## [0.4.1] - 2026-05-19

### Harness（skills / agents）

- **`mstar-plan-artifacts`**：将 `templates/`（`status.empty.json`、`notes.empty.json`）从 `mstar-plan-conventions` 迁入，与 `status.json` / residual SSOT 同 skill；`mstar-plan-conventions` 仍负责路径发现与初始化步骤，模板路径指向 `mstar-plan-artifacts/templates/`。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.4.0 → 0.4.1**。**`@mstar-harness/cli` 保持 0.3.1**。

## [0.4.0] - 2026-05-19

### Harness（skills / agents）

- **专题 skill 拆分**（按需加载）：新增 `mstar-phase-gates`、`mstar-dispatch-gates`、`mstar-branch-worktree`、`mstar-plan-artifacts`（含 `status.json` / residual SSOT，不再单独 `mstar-status-residuals`）；瘦身 `mstar-harness-core` 与 `mstar-plan-conventions`；`mstar-phase-gates` / `mstar-branch-worktree` 规则内联于 `SKILL.md`。
- **角色**（`mstar-roles`）：各 `references/<role>.md` 增加 **Required Skill Dependencies**；hub 矩阵在 `mstar-roles` SKILL.md；PM 子文档 severity SSOT 指向 `mstar-plan-artifacts`。
- **宿主**（`mstar-host-cursor`、`mstar-host-opencode`）：加载顺序与 QC/worktree 引用对齐专题 skill。
- **计划目录**（`mstar-plan-conventions`）：正式约定 `{ITERATION_DIR}` 与 `{KNOWLEDGE_DIR}`；`docs/` 与 harness 子树边界；`status.json` 可选 `iteration_compass` / `iteration_refs`。
- **Prepare · clarify**（主文 **`mstar-phase-gates` SKILL.md**）：`clarify` 核心纪律 — 共享理解、设计决策树逐枝、先探索、每问推荐答案、收口摘要。

### 文档

- **README.md** / **README_CN.md**：扩展核心 skill 表；说明 `.harness/` 为 gitignore 的维护工作区（spec/plan，非发布用 skill 树）。
- **AGENTS.md**：`.harness/` 维护约定；专题 skill 路由表。

### 版本对齐

- monorepo 根、`@mstar-harness/opencode`、Cursor / Codex 插件 manifest：**0.3.2 → 0.4.0**。**`@mstar-harness/cli` 保持 0.3.1**。

## [0.3.1] - 2026-05-15

### Harness（skills / agents）

- **Plan / Git 对齐**（`mstar-plan-conventions`、`mstar-harness-core`）：多 Plan 共用一条 **Spec**（`primary_spec`）时，约定 **Spec 集成分支** 与各 **Plan 实现分支**；各 Plan 完成后将变更 **merge 回 Spec 集成分支**；再合入 `main` / 默认保护分支时 **必须走 PR**（或等价受控合入；`Branch policy` 窄例外不变）。补充 `spec_integration_branch`、澄清 `merge_target`（`references/status-and-residuals.md`），在 `references/plan-files-and-reports.md` 中衔接 worktree/QC 叙述，并在 `references/branch-and-worktree.md` 增加交叉引用。

### 版本对齐

- npm workspace（`morning-star`、`@mstar-harness/cli`、`@mstar-harness/opencode`）与 Cursor / Codex 插件 manifest：**0.3.0 → 0.3.1**。

## [0.3.0] - 2026-05-14

### Harness（skills / agents）

- **PM 角色**：将 `project-manager` 细则拆到 `skills/mstar-roles/references/project-manager/*.md`，壳文件保持精简编排入口。
- **角色正文**：`mstar-roles` 角色 reference 与总线英文化；宿主适配器用技能名（`mstar-host-opencode`、`mstar-host-cursor`）引用，避免在角色文中写包内路径。
- **AGENTS.md**：宿主适配器说明改为技能名 + 仓库内源路径（Cursor：`skills-cursor/mstar-host`）。
- **PM 路由**：阶段切换前短 pre-flight；OpenCode 上 **前提回合 vs 派发回合** 与防「只粘贴 Assignment、无 invoke」说明写入 `mstar-harness-opencode`。
- **OpenViking（可选）**：新增 `mstar-harness-core/references/openviking-memory-plugin.md`，仅在存在 **`memsearch`** 工具时适用；在 `mstar-harness-core` SKILL 中设入口。
- **加载契约**：明确 `mstar-coding-behavior` 面向实现/审查/QA/运维等承接方，**不要求**纯编排的 `project-manager` 必读。

### 文档

- 从 `README.md` / `README_CN.md` 中删减已被当前流程替代的 plan 引导模板段落。

### 版本对齐

- npm workspace（`morning-star`、`@mstar-harness/cli`、`@mstar-harness/opencode`）**0.2.0 → 0.3.0**。
- Cursor / Codex 插件 manifest **0.1.0 → 0.3.0**，与 monorepo 发布线一致。

## [0.2.0] - 此前

`@mstar-harness/cli` 的 0.2.0 说明见 [packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)。OpenCode 打包、`skills/` + `agents/` 随 postinstall 同步等与 0.2.0 同期变更见根目录英文 CHANGELOG 中 0.2.0 一节。
