# Git 功能分支、同仓并发与 Worktree 对齐（Morning Star）

本 reference 合并了原 `docs/agents/harness-loop.md` 的 Git 相关节与 `docs/agents/branch-collaboration.md` 全文。涵盖：功能分支门禁、分支协作契约、同仓并发写入、多 worktree 并行开发与 QC/QA 衔接、plan 集成分支推荐编排。

## Git 功能分支门禁（业务仓库）

适用于 cwd 为 **Git 托管的业务/应用仓库** 且本轮会产生**仓库内可合并 diff** 的任务（代码、业务向测试与 fixture、影响构建或运行时的配置等）。**不**用于约束 `~/.config/opencode/` 全局配置目录（该目录对 agent 只读；落盘仅由用户执行）。

### 默认规则

- 不得在**默认保护分支**（常见名：`main`、`master`；以项目约定为准）上直接实现功能改动，除非 Assignment 含显式例外。
- 例外须在 Assignment 中写明一行：**`Branch policy: direct on <branch> — <reason>`**（典型：团队约定的热修直接打默认分支）。

### `<base>` 与叠分支（stacked branches）

- 门禁的目标是**不在未授权的默认分支上直接提交**，不是「只能从 `main` 开新分支」。
- 当需要**从已有功能分支继续拆新分支**时，Assignment 应写清**祖先分支** `<base>`，例如：`create feature/foo-part2 from feature/foo`。
- **`<base>` 可取**：`main` / `master`（或项目默认分支名）、任意已存在的 `feature/*` / `fix/*`、远程跟踪分支名、或 **`current`**（表示以执行者检出时的 `HEAD` 为祖先，用于「就在当前分支上再拉一枝」）。
- 若只写 **`Working branch`: `feature/foo`且无「create … from …」**：表示**沿用 / 切到**该已存在分支上开发，不要求新建。
- 若写新建但未写 `<base>`：实现侧应**停下问** `@project-manager`（或按项目 `AGENTS.md` 的默认 base）；**禁止**擅自假设「一定是 `main`」。

### 角色职责

- **`@project-manager`（唯一分支决策入口）**：向 `@product-manager`（向项目仓库提交产品文档时）、`@architect`（向项目仓库提交技术/架构/契约类文档时）、`@fullstack-dev` / `@frontend-dev` / `@fullstack-dev-2`、以及会向仓库提交工件的 `@qa-engineer`、会改仓库内文件的 `@ops-engineer`、对**项目仓库**落盘的 `@prompt-engineer` 分派前，核对分支策略；在 Assignment 中写明 **`Working branch`**（沿用已有分支名，或 `create <new-branch> from <base>`，其中 `<base>` 遵守上一节）。若用户已指定分支/祖先，照抄进 Assignment。**只有 `@project-manager` 可以决定是否新开分支、从哪个 `<base>` 开分支。**
- **实现 / QA / 运维 / prompt / product-manager / architect（项目侧）**：在**首次**编辑仓库内文件或执行 `git commit` 前，核对当前分支与 Assignment，并在回报中明确"正在哪个分支上工作"。**禁止自行决定新开分支、禁止自行切回 `main`/`master` 重开分支。**若未授权 `Branch policy` 且当前在默认分支，则仅可按 PM 已写明的 `Working branch` 执行切换/开枝；若 Assignment 未写清或与现场分支不一致，先回报 `@project-manager`，不得擅自处理。

## 分支协作契约（Branch Collaboration Contract）

### 适用范围

- 当任务会在项目 Git 仓库产生可合并 diff 时适用。
- 适用于 `@project-manager`、`@product-manager`、`@architect`、`@fullstack-dev`、`@frontend-dev`、`@fullstack-dev-2`、`@qa-engineer`、`@ops-engineer`、`@prompt-engineer`（项目侧写入）。

### 唯一分支决策者

- 只有 `@project-manager` 可以决定分支策略：
  - 继续在现有分支开发，或
  - 使用 `create <new-branch> from <base>` 新开分支，或
  - 使用 `Branch policy: direct on <branch> — <reason>`。
- 其他可写角色不得自行决定开分支。

### PM 必须先与用户确认

在派发实现任务前，PM 必须先检查当前分支；若已在非默认开发分支（如 `feature/*`、`fix/*`），必须先与用户确认。

未获得用户明确确认前，PM 不得切回 `main`/`master` 并新开分支。

#### PM 确认话术模板

面向用户沟通时，使用以下结构：

```markdown
当前检测到在分支：`<current-branch>`。
请确认本次任务是：
1) 继续在 `<<current-branch>>` 上开发
2) 新开分支：`<new-branch>`，基于 `<base-branch>`

未确认前，我不会切回 `main`/`master` 或新开分支。
```

### Assignment 要求（PM）

每个可写 Assignment 必须且只能包含以下之一：

- `Working branch: <existing-branch>`
- `Working branch: create <new-branch> from <base>`
- `Branch policy: direct on <branch> — <reason>`

若是新开分支但缺少 `<base>`，必须暂停并向用户澄清，不能猜测。

### 可写角色执行规则

在首次写仓库或 `commit` 之前：

1. 校验当前分支与 Assignment 是否一致。
2. 只能执行 PM 在 Assignment 中定义的分支策略。
3. 禁止自行切回 `main`/`master` 再重开分支流程。
4. 若 Assignment 含糊或与本地分支状态冲突，先停下并回报 PM。

### 回报要求

可写角色在 Completion Report 中必须明确当前工作分支，例如：

- `Working branch used: <branch-name>`

## 同仓并发写入与 Git worktree（强制）

**首要场景是开发阶段**：多条可写流 **并发** 改 **同一仓库** 时，用 worktree 做 **写入侧目录隔离**。下列规则针对该类开发并发；**QC / QA 阶段的检出约定**见下一小节。

当 **`@project-manager` 在同一调度轮次内并发启动多个** subagent（含宿主侧「并行 Task / 并行 subagent」），且 **≥2 个承接方**可能对 **同一 Git 仓库的同一工作区（同一 cwd 检出目录）**产生写文件或 `git commit` 级改动时：

- **必须**为每条并发写流使用 **独立检出目录**：以 **`git worktree`** 隔离（流程与目录安全要求见 Superpowers **`using-git-worktrees`**；未安装插件时仍须达到同等隔离效果，可 Read 该技能文件并按 `git worktree` 手册执行）。
- **必须**与既有分支门禁一致：每个可写承接方的 Assignment 仍须含 PM 已批准的 **`Working branch`** / **`Branch policy`**；在某一 worktree 内 **不得**擅自 `checkout` 到未授权分支或私自新建分支。
- **PM 须在 Assignment 中写清**各并发写流的 **检出约定**（例如预期 **`Worktree path`** / 命名规则，或「由承接方按 `using-git-worktrees` 创建并在 Completion Report 回报路径」），避免多代理默认共享同一目录导致互相覆盖、冲突或半写入状态。
- **同仓、同一 plan、≥2 可写并行轨**：**推荐**在首次向各轨下发实现 Assignment **之前**，先由 PM 与用户确认 **`Branch policy`**，并 **明确 plan 集成分支与各轨 topic 分支的关系**（见下节 **「推荐默认编排：先建 plan 集成分支，再挂各 worktree」**），再为各轨约定 **`git worktree`**。这样 QC 前可把各轨 **自然归并**到同一条 **`HEAD`**，减少「多头分支、无合并靶」导致的误派。

**可不强制新开 worktree** 的情形包括：并发流 **全部为只读**；各写入者针对 **不同 Git 仓库根**；或写入 **串行**（同一时刻仅一个代理持有该仓工作区）。

### 并发 subagent 与同仓工作树（对齐）

当多个可写 subagent **并发**修改 **同一仓库** 时，**不得**共用同一检出目录作为写入 cwd。PM 在分派前应规划 **`git worktree`** 隔离（Superpowers **`using-git-worktrees`**），并在各承接方 Assignment 中写明 **`Working branch`** / **`Branch policy`** 及 **检出路径约定**（或要求回报实际 worktree 路径）。单分支决策权仍仅属 PM；worktree 只解决「目录与工作区隔离」，不替代分支授权。

**同仓、同一 plan、多可写并行轨（推荐）**：在挂齐各轨 `git worktree` **之前**，先与用户确认并写明 **plan 集成分支**（从商定 `<base>` 创建）及各轨 **topic 分支** 如何从该线分出或如何 **merge 回** 该线；QC 前再将待一并验收的提交 **全部归并**到 PM 指定为 QC **`Working branch`** 的那条分支的 **`HEAD`**。分步说明与示例命名边界见下节 **「推荐默认编排：先建 plan 集成分支，再挂各 worktree」**。

**QC / QA 与 feature**：开发常在 **feature 分支的 worktree** 中完成；进入 **QC 三审**与随后的 **QA 验证**时，PM 须在 Assignment 中写明 **`Review cwd` / `Worktree path`**、**`Working branch`**、**`plan_id`**（无 plan 流程时 `N/A` + 不可歧义 **Feature / scope label**）与 **`Review range` / `Diff basis`**；**三份 QC Assignment 与 QA Assignment 中 `plan_id` 与 `Review range` / `Diff basis` 须逐字相同**，保证三票审 **同一 plan/feature 与同一 diff 范围**。

## 多 worktree 并行开发与 QC / QA 的门禁衔接（强制；避免误派）

- **语义区分（必须理解）**：开发阶段可以存在 **多个** `Worktree path`（每条约流一条检出目录）；**一轮**正式 QC 三审及与之 **逐字对齐** 的 QA 验证，在 harness 中仍只对应 **一套** `Review cwd` / `Worktree path` + **`Working branch`** + **`Review range` / `Diff basis`**（三票 QC 与 QA **共用且逐字相同**）。**不要**把「多个开发 worktree」误解成「QC 应轮流进多个目录各审一半」。
- **推荐默认编排：先建 plan 集成分支，再挂各 worktree（PM；强推荐）**：在 **同仓**、**同一 plan** 且 **≥2 条可写并行轨** 时，按下列顺序编排可最大幅度降低 QC/QA 误用单一开发目录的风险。**此为推荐套路，不是唯一合法 Git 拓扑**；若采用其它拓扑，仍须满足本节下文 **强制**条款（派 QC 前 **单一**待审 `HEAD` + 一套对齐字段）。
  1. **先起集成分支（再挂 worktree）**：在派发各轨 **实现** Assignment 之前，PM 与用户确认 **`Branch policy`**，并建立 **plan 集成分支**（Assignment 使用 **`Working branch: create <plan-integration-branch> from <base>`** 或等价明确写法；`<base>` 通常为 `origin/main` 或团队既定主线，**不得**未授权假设）。**分支名由 PM 指定**；下文 **`feature/<plan-id>-integrate`**、**`integrate/<plan-id>`** 仅为命名示例，**非强制**。
  2. **再挂各轨 worktree**：为每条并行轨分配 **独立** `git worktree` + **`Worktree path`**；各轨 **`Working branch`** 一般为 **从集成分支出** 的 topic 分支（`create <topic-i> from <plan-integration-branch>`）或 PM 书面约定的等价结构（例如从同一 `<base>` 出 topic、但 **书面指定** 合并时 **以集成分支为靶**）。**禁止**承接方擅自把未授权功能提交直接堆在 `main`/`master`。
  3. **进 QC 之前**：将全部 **须同一轮三审覆盖** 的提交 **merge / rebase / cherry-pick**（以 PM 指定的团队方式）**归并**到 **同一条** PM 将作为 QC **`Working branch`** 的分支的 **`HEAD`**（**通常即 plan 集成分支**；若 PM 已将集成分支重命名或快进为最终 `feature/*`，以 Assignment 为准）。**在此**解决冲突；**勿**在 QC Assignment 仍指向「只含部分轨」的旧 `HEAD` 时派三审。
  4. **QC / QA 的 `Working branch` 与合并主线**：派发 QC 三审与对齐的 QA 时，**`Working branch`** **即为**上一步 **已含全部待审提交** 的那条分支（常见为 plan 集成分支）。**`Review range` / `Diff basis`** 通常相对 **尚未合并 feature 的** 主线参照（例如 `merge-base: origin/main` + `tip: HEAD`），审查的是 **「feature 线 vs 主线」** 的差异；**默认不要求**在 QC **通过前** 已把该分支 merge 进 `main`（除非 **`Branch policy`** 或用户明确约定 trunk 式例外）。
  5. **本推荐不适用时**：单轨、多仓库、或 plan 已 **拆 scope / 多轮增量三审**（见 `mstar-plan-conventions`）— 仍须 **逐轮**满足 **强制**条款：每轮 QC 对应 **一条**快照、**一套**逐字相同的 `plan_id` + `Review range` / `Diff basis`。
- **单一待审 Git 快照（派 QC 前置条件）**：若本 plan 下曾有多条 **可写** 并行轨落在 **同一业务仓** 且其成果分布在 **不同分支**、或 **未互相合并进同一条分支的 `HEAD`**，则在派发 **QC 三审**（及同范围的 QA）**之前**，**必须**先在 Git 中完成 **归并**（merge / rebase / 按团队约定的集成方式），使 **全部**待审提交都出现在 **同一条** PM 指定的 **`Working branch`** 的 **`HEAD`** 上；**然后**再填写 **一个** `Review cwd`（可为该分支上新开的只读审查 worktree）与 **一个** 可复现的 **`Review range` / `Diff basis`**。**禁止**仅填写并行轨 **A** 的开发用 `Worktree path` 作为 `Review cwd`，却期望审查覆盖仍只存在于并行轨 **B** 的分支或提交上的变更（在该变更 **未进入** 轨 A 所检出分支的 `HEAD` 时，这在 Git 上不可复现，属 **Assignment 错误**）。
- **不应合并为一次审时的做法**：若两轨 **有意**保持独立可合并单元（例如两条独立 PR），**不得**共用 **同一套** `plan_id` + **`Review range` / `Diff basis`** 假装「一轮三审覆盖全部」。应 **拆分 scope**：分轮次审查、不同 **`Feature / scope label`**、不同 `plan_id`、或按 `mstar-plan-conventions` 写明的 **显式增量三审** 例外，使每轮 QC 各对应 **一条**分支快照与 **一套**对齐字段。
- **同分支多目录的例外**：若所有并行轨 **始终**在同一条已授权的 **`Working branch`** 上协作（每流仅目录不同、提交已互相 `pull`/推送收敛），则任一该分支的检出目录在 **更新到含全部提交的 `HEAD`** 后，均可作为 `Review cwd`；**不得**使用仍停留在旧提交的 worktree 路径。

## QC 三审、QA 验证与 feature 检出上下文（强制）

开发在 **feature 分支**上完成（往往在 **独立 worktree** 中实现）后，**QC 审查与 QA 验证针对的都是这份 feature**，而不是 `main` 或任意未对齐的默认 cwd。

- **`@project-manager`** 分派 **QC** 时须在 Assignment 写明与待审实现一致的 **`Working branch`**，并写明 **`Review cwd` / `Worktree path`**：**优先**沿用开发 **Completion Report** 中回报的业务仓 **实现检出路径**（即「该 feature 的 worktree」）**当且仅当**该路径上的检出分支 **`HEAD` 已包含本轮待审的全部提交**（含曾发生在其他并行 worktree、现已归并到该分支的变更）。否则 **必须**改用 **集成完成后的** `Working branch` 与对应检出路径（或按 **`using-git-worktrees`** 在该分支上 **另开** 审查专用目录）。若开发未用 worktree，则写明单一明确的业务仓根路径。若审查需与开发目录 **物理分离** 但仍审 **同一分支**，可指示按 **`using-git-worktrees`** 在 **`Working branch`** 上 **另加** 一个 worktree 专供审查（只读使用业务仓）。**多流并行开发**时的前置归并、**推荐默认编排（plan 集成分支先行）** 与误派禁令见上一小节。
- **三票审同一功能（强制对齐）**：分派 **QC 三审**时，除上述字段外，**必须**在 **三份 Assignment 中逐字写入相同**的 **`plan_id`** 与 **`Review range` / `Diff basis`**：
  - **`plan_id`**：与 `{PLAN_DIR}/reports/<plan-id>/` 及主 **Plan Path** 一致；无 `{PLAN_DIR}` 流程时写 **`plan_id: N/A`**，并另给一行 **`Feature / scope label`**（不可歧义，足以与并行其它 feature 区分）。
  - **`Review range` / `Diff basis`**：明确本次审查所针对的 **diff/提交范围**（例如 `merge-base: origin/main` + `tip: HEAD`；或 `rev-range: <full-40>..<full-40>`；或一句 `equivalent to: git diff <merge-base>...HEAD`，以团队可复现为准）。**三名 reviewer 的 Assignment 间该字段必须完全一致**；**@qa-engineer** 验证同一 feature 时 **复用同一 `plan_id` 与同一 `Review range` / `Diff basis`**。**热修 / QC 单审**路径也须含 **同一组字段**，仅承接方份数为 1。
- **三审并行**时，三名 reviewer **共用同一组 `Review cwd` / `Worktree path` + `Working branch` + `plan_id` + `Review range` / `Diff basis`**（对业务仓只读分析）；**一般不必**为每位 reviewer 各开一个 worktree，除非宿主或执行环境要求进程级隔离。
- QC 的 **报告落盘**仍仅限 `{PLAN_DIR}/reports/`；上述约定保证 `git diff`、`git log`、lint 与所读文件与 **待合并 feature** 一致。
- **`@project-manager`** 分派 **`@qa-engineer`** 做 **本 feature 的验证**（跑测试、复现、可观察取证、或向业务仓提交测试/配置）时，须在 Assignment 中写明 **同一套** **`Review cwd` / `Worktree path`**、**`Working branch`**、**`plan_id`** 与 **`Review range` / `Diff basis`**（与 QC 三审 **逐字相同**；若 QC 已写清，QA **照抄**）。**@qa-engineer** 在执行业务仓命令前须核对当前目录与分支与 Assignment 一致；**Report-only**、且本轮 **不涉及** 业务仓内命令/路径依赖时，若 Assignment 未写 `Review cwd`，须在回报中说明验证所基于的检出或环境，缺失则 `Blocked` 并请 PM 补全。
- 若 **QA 与同仓其他可写角色并发**提交测试代码，仍须遵守上文「同仓并发写入」的 **worktree** 规则（可为 QA 单开一条写入 worktree，**同一 `Working branch`**，由 PM 在 Assignment 写明）。
