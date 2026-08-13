# @mstar-harness/dsh

[English](README.md) | 中文

让 [Morning Star](https://github.com/btspoony/mstar-harness) 成为一等公民的 dsh（DeepSeek Harness）宿主——一个 cordis 函数插件，将 mstar engine 进程内挂载，实现 engine `HostAdapter`（`host: 'dsh'`），守护 `{HARNESS_DIR}/status.json` 写入（校验 + 咨询；hard 下按修复逃生放行），在 `Enforcement: hard` 开启时阻止被禁止的 subagent 派发，对挂载技能根下的 `SKILL.md` 写入执行技能撰写 lint，通过 dsh skill-filesystem 提供者挂载 mstar `skills/` 镜像（单一规范挂载），并向每个组合后的 agent 步骤追加一条持久化的 `mstar-engine-status` catalog 行。随 dsh Loader 应用启动；一切均通过 seam 的拒绝/咨询通道行使职责，从不改动工具本身。

## Usage

dsh 应用如何使用本插件——安装路径、配置、挂载时发生什么、强制执行语义。

### Install paths

本包以 workspace 包形式发布（`workspaces: ["packages/*"]`），构建时把 engine 打进 `dist/`（`bun run build`；dist 已被 gitignore）。安装途径是 **profile bundle**，装进现成的 `web` profile（`dsh --profile web`——开箱即用的 web 应用 profile，即 `dsh web`），经 `dsh.bundle.patch` 清单——一个叠在 dsh-base 默认层之上的补丁层：

**（a）registry 安装（发布形态）**——npm 包自带构建好的 `dist/`（安装时无需构建）：

```sh
dsh plugin --profile web add @mstar-harness/dsh
```

**（b）local checkout 安装（开发）**——包检出本身，用于迭代插件：

```sh
cd <repo>/packages/dsh
dsh plugin --profile web add .
```

`dsh plugin --profile <name> add <spec>` 首次使用时初始化 profile（`web` 从出厂模板起步：`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`），把 `<spec>` 转发给 profile 目录中的 pnpm，并按已安装状态对账 `dsh.profile.bundles` 层列表：任何 package.json 声明 `dsh.bundle` 的依赖都会加入层栈。相对 spec（`.`、`file:`/`link:`）锚定调用目录，因此 `add .` 须在包检出目录内执行；pnpm 须在 PATH 上。local checkout 需要先执行过 `bun run build`（本包**不使用** `prepare` 脚本——monorepo 与 cli/opencode 一致，显式构建各包）。细节、层位置与出厂默认见 [`bundle/README.md`](bundle/README.md)——registry 与 local checkout 形态均走同一 pnpm + reconcile 机制。`cordis` 与 `@deepseek-ai/dsh-*` 各 seam 均为 peerDependencies——由组合后的 dsh 应用提供。

### Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `harnessDir` | `string` | 按会话工作区探测（`.mstar/` → `.agents/` → `.plans/` → `plans/`，从会话工作区根目录开始——**绝不从启动 cwd**） | 显式 harness 根目录；优先于 engine 探测。**harness 根不在探测名列表中的仓库必须配置**——例如本 mstar-workflow 仓库自身用 `.harness/`（维护根，刻意不探测）；探测从会话工作区根开始（绝不从启动 cwd）并在那里**停止**——永不越过会话工作区向上，因此其上方的 harness 目录（如全局 `~/.mstar`）永远不会被采纳。 |
| `enforcement` | `'hard' \| 'soft'` | compass，否则仅告警 | 按部署覆盖。优先级：Config 优先；否则取 Assignment 自身的 `**Enforcement**: hard` 头字段（仅派发闸门）；否则取迭代 compass frontmatter；否则仅告警。Config `soft` 是唯一的本地回滚——Assignment 级 `soft` 不能覆盖 hard compass。 |
| `dispatchTools` | `string[]` | `['subagent']` | 派发闸门匹配的委派工具名（dsh subagent 工具的 `toolName` 可重命名实例）。 |
| `dispatchBinding` | `string` | 未设置（跳过预检） | 派发方 agent 自身的 harness 角色；Assignment 的 `Execute as` 等于它即自我递归。 |
| `skillRoots` | `string[]` | 未设置（不注册自定义根） | 向 dsh skill-filesystem 提供者注册的额外技能根（`customSkillDirs` 语义——先于用户根扫描）。开发期：镜像 `<repo-root>/skills` 的绝对路径。 |
| `bundledSkillDir` | `string` | 打包的 `harness-skills/` 镜像（包相对路径） | 向 dsh skill-filesystem 提供者注册的打包技能根（`bundledSkillDir` 语义——最后扫描、受信任）。默认取包内自带的 `harness-skills/` 镜像（`bundle-assets` 同步；gitignore）——包相对路径，**非** cwd 锚定。显式值优先。 |
| `catalogTtlMs` | `number` | `60000` | pre-step catalog 缓存刷新间隔（毫秒）：按工作区缓存的统一 `mstar-engine-status` 行（水印 + 迭代闸门 + 工作区摘要）多久重读一次 `status.json` / compass / 知识索引。刷新间隔之间热路径只是时间戳比较 + Map 命中；会话中 plan/compass/residual 的变化会在一个间隔内落地。 |

`bundledSkillDir` 默认取包内自带的 `harness-skills/` 镜像（见 Skills mount）——显式 Config 值仍然优先。相对覆盖仍是 **cwd 锚定**（skill-filesystem 以 `join()` 语义相对 dsh **进程 cwd** 解析），因此覆盖默认的部署应在 **profile 层传绝对路径**（见 `bundle/README.md`）。

### 组合后的行集合

profile bundle 组合出以下行——注册表行来自 `@deepseek-ai/dsh-base` 层，本 bundle 的补丁在其上插入 `mstar` 行并携带中性默认（即全应用 e2e fixture 启动的行集合）：

```yaml
- name: '@deepseek-ai/dsh-skill'   # skill 注册表（ctx.skills）——dsh-base 行
- name: '@deepseek-ai/dsh-tools'   # tool 注册表（ctx.tools）——dsh-base 行
- name: '@deepseek-ai/dsh-commands' # command 注册表（ctx.commands）——dsh-base 行
- name: '@mstar-harness/dsh'       # 本 bundle 补丁插入（config: {}——插件默认生效）
```

注册表行先于插件挂载，使 mstar 各闸门、seam 工具与 bundled 命令注册时 `ctx.skills` / `ctx.tools` / `ctx.commands` 已存在。

### What the plugin does when mounted

- **状态闸门**——`fs/write-intent` + `fs/edit-intent` 监听器校验 `{HARNESS_DIR}/status.json` 写入（对写入前文档运行 engine `validateStatus` + 按 plan 的 `findingsCleanupGate`）。
- **派发闸门**——`tools/pre-execute` 监听器作用于委派工具，通过 engine 的单一 `composeDispatchGate` 组合（字段闸门、反递归预检、默认分支闸门——与 opencode/omp/CLI 对齐，违规码按构造即相同）校验 subagent Assignment 文本，外加 dsh 租约闸门与 worktree L1/L2 检查。
- **技能撰写 lint**——已配置技能根下的 `SKILL.md` 写入运行 engine 技能撰写 lint（`lintFrontmatter` + `lintFiveQuestion`）。
- **seam lint**——harness 下 `DESIGN.md` / audit plan / 知识文档 / roles 目录的写入运行各自的 artifact 级 engine lint。
- **模型可见工具**——`mstar_sdd_workspace`、`mstar_sdd_task_brief`、`mstar_iteration_gate`、`mstar_design_md_validate`、`mstar_audit_validate`、`mstar_compound_validate`、`mstar_roles_validate` 注册到 `ctx.tools`。
- **bundled 命令**——向 `ctx.commands` 注册 `/iteration-start`、`/iteration-drive`、`/iteration-loop`、`/codebase-audit`（来自打包的 `harness-commands/` 镜像；每条声明 frontmatter `input` hint，使 web 客户端 claim `/name ` 并等待用户后续输入而非立即执行；handler 把命令正文 + 用户输入 steer 进接收 agent）。
- **pre-step catalog 行**——每个组合后的 agent 步骤都会追加**一条**统一的 `mstar-engine-status` catalog 消息：水印（统一 mstar 版本、harness 目录、enforcement）、迭代相位闸门段（解析到 steering compass 时）与工作区状态摘要段（工作区有 `status.json` 时：plan 注册表、open residual、分支/政策锚点、活跃 lease、知识摘要、compass 方向）。该行是 digest 门控的（每 turn 注入一次、变化时才重发），并共享一次按工作区 TTL 缓存的构建（`catalogTtlMs`，默认 60 秒）。

### Enforcement semantics

默认仅告警：闸门违规记录日志并发出咨询事件（`mstar/status-gate`、`mstar/dispatch-gate`、`mstar/skill-lint` 及各 seam 咨询），动作照常继续。`Enforcement: hard`——来自迭代 compass frontmatter、Assignment 头字段或插件 Config（`enforcement: hard`）——把违规升级为经 cordis 拒绝通道的**真实否决/拒绝**：subagent 派发在**不调用** `next()` 的情况下返回 `PreToolDecision { kind: 'deny', reason }`；状态/技能 lint 写入因 intent 瀑布链内容盲而从不硬否决——对**已非法**的文档按**修复逃生**放行（`hard: true, repair: true` 咨询），让修复性写入能落地。Config `soft` 是唯一的本地回滚；hard 闸门绝非全局默认。

## Gates

### Status gate

`fs/write-intent` + `fs/edit-intent` 监听器（以 `prepend` 注册，确保先于 dsh-fs-policy 执行）对 `{HARNESS_DIR}/status.json` 的写入把关：基于当前磁盘文档运行 `validateStatus` + 按 plan 的 `findingsCleanupGate`（文档只解析一次——无 TOCTOU 双重读取）。闸门**从不抛出**：每次决策都以 `mstar/status-gate` 咨询事件呈现，并通过 `next()` 委托 intent 瀑布链。告警模式（默认）在有违规时记录日志并发出事件。hard 模式对**已非法**的文档按**修复逃生（repair escape）**放行（error 级日志 + `hard: true, repair: true` 咨询）——intent 瀑布链不携带写入内容，若对非法文档硬否决，反而会卡死修复性写入本身。意外内部错误在两种模式下都降级为放行并发出 `degraded: true` 咨询（错误隔离包络）；首次破坏文档的写入本身无法在此 seam 上被否决（见 Known Limitations）。

### Dispatch gate

`tools/pre-execute` 监听器作用于委派工具：解析载荷中的 Assignment 文本，在头区域上运行 engine 的**单一**派发闸门组合（`composeDispatchGate`——形状守卫、`validateAssignmentFields`、`antiRecursionPrecheck`、默认分支闸门、头区域强制执行；opencode/omp/CLI 绑定使用同一组合，违规码按构造即相同），外加 dsh 侧 worktree L1/L2 检查与租约闸门。拒绝通道为**不调用** `next()` 而返回 `PreToolDecision { kind: 'deny', reason }`；告警模式记录日志、发出 `mstar/dispatch-gate` 并委托。非 Assignment 提示与非委派工具保持惰性。两种模式下 engine 故障都降级为放行，且降级**可观测**：catch 路径发出 `degraded: true` 的插件自有咨询 + error 日志，使 hard 部署能察觉控制失效而非静默放行。以 `prepend` 注册，防止更早挂载的决策监听器把本闸门短路在不可达处。

### Lease gate

在 opencode 字段集之上新增：对声明 `Execution mode: sdd` 或 plan 行为 `InProgress` 的可写派发，对照 `{HARNESS_DIR}/status.json` 运行 `verifyPlanExecutionLease` 与派发上下文比对（`holder`、`worktree_path`、`working_branch`）。违规使用 dsh 侧 `lease.dispatch.*` 命名空间；只读角色完全跳过该检查。**缺失** `status.json` 对 sdd 派发不再是静默放行：发出 `lease.dispatch.unverifiable`（告警模式下为 advisory，hard 下为 deny）——没有状态文件就无法确认 execution_lease。非 SDD 派发保持降级放行（无租约义务）。所有 Assignment 字段读取都限定在 engine `assignmentHeaderRegion` 内（正文中引用的示例不会泄漏进头字段）。

### Skill lint gate

作用于已配置技能根下 `SKILL.md` 文件的 `fs/write-intent` 监听器，对写入前的磁盘文档运行 engine 技能撰写 lint（`lintFrontmatter` + `lintFiveQuestion`——与 CLI `mstar skill lint` 组合一致）。该槽位**内容盲**（intent 瀑布链只携带 `(target, actor)`）：文件缺失 = 首次创建 = 放行；磁盘文档干净 = 静默放行；告警模式下有违规 = 咨询 + 委托；hard 模式下有违规 = **修复逃生**——文档**已经**非法，本次写入可能就是修复本身（error 级日志 + `hard: true, repair: true` 咨询，携带强制执行后的 `hardBlocked` 判定）。强制执行解析方式与其他闸门相同（Config 覆盖优先，否则取迭代 compass，否则仅告警）。闸门从不抛出；读取失败与意外错误降级为放行并发出 `degraded: true` 咨询。类型化 hard 否决（`SkillLintVetoError`，码 `skill-lint.veto`）位于传入文档分支（`lintSkillWrite`）——当前接线见 Known Limitations。

## Service

`apply` 构造 `ctx.dshMstar`（engine 支撑：`validateStatus`、`validateResidual`、`findingsCleanupGate`、`resolveCompassEnforcement`、`resolveHarnessDir`、`readHarnessVersion`、`applyEnforcement`）。分层：P1 各闸门是本包内与 engine 同置的包装器，直接导入 engine（同一插件，构建时打包 engine）；`ctx.dshMstar` 是供 inject 消费者使用的组合/测试外观；宿主适配器（下节）是面向宿主的门面。两条路径共用 engine 这唯一语法源。伴随入口 `@mstar-harness/dsh/invariant` 以文档化的空安装器保留包所有权。

## Host adapter

插件以 `DshHostAdapter` 实现 engine `HostAdapter` 契约（`host: 'dsh'`），并以 `ctx.dshHostAdapter` 服务暴露。检测：engine `detectHost` 将 dsh 委派工具名——`ToolSignal` **`subagent`**（模型可见的 dsh subagent 工具）——映射为 `'dsh'`，在 omp 之后、kimi/zcode/codex 之前求值；混合会话按固定顺序让位于更早的行。适配器与插件内闸门共用同一套校验核心（单一代码路径）：`beforeStatusWrite(path, doc)` 在宿主提供文档时校验传入文档，否则走磁盘文档回退（文件缺失 = 首次创建 = 放行）；`beforeDispatch(assignment)` 运行字段 + 分支 + 反递归闸门并携带强制执行后的 `hardBlocked` 判定（租约闸门留在监听器侧——它绑定该钩子不携带的 ToolExecution 会话上下文）；`beforeMerge(lease)` 是 engine `validateIntegrationMergeLease` 的薄包装（向 `status.json` 的预留写入是 P3 seam）。`log` 默认路由到 dsh ctx 日志器 `mstar/host-adapter`。

dsh 的冻结技能根形态（engine `resolveSkillRoot('dsh', …)`）为 **`$DSH_BUNDLED_SKILL_DIR/<name>[/<rel>]`**——解析器只定义技能相对路径解析器（`resolveAssetPath`）所用的规范形态；它**不**挂载目录。挂载由插件负责（下一节）。

## Skills mount

mstar 技能通过 dsh skill-filesystem 提供者以**单一规范挂载**接入：插件把配置的根注册为**一个**提供者（`providerName: 'mstar'`、`includeDefaultRoots: false`——隔离，绝不看到宿主应用自身的项目/用户技能），上文的 engine 形态是共享的技能根契约。两条 Config 路径填充它：

| 路径 | 机制 | 时机 |
| --- | --- | --- |
| Bundled 默认 | `bundledSkillDir` 默认取包内自带的 `harness-skills/` 镜像——仓库根 `skills/`（19 个 `mstar-*` + `pm`）由 `bundle-assets` 在构建/postinstall 时同步（gitignore），按**包相对路径**解析（非 cwd 锚定——任意启动 cwd 都可用） | 发布包 / 无覆盖的任何部署 |
| 自定义根 | `skillRoots` / 显式 `bundledSkillDir` → skill-filesystem `customSkillDirs` / `bundledSkillDir` 条目（显式值优先） | 本地开发 / 测试 / 使用不同镜像的部署 |

打包镜像是**单一规范挂载**：技能内容只在仓库根 `skills/` 镜像中存一份并同步进包（与 opencode 的 `harness-skills/` 相同），mstar 技能在任何地方都保持可独立使用。不重复加载：opencode 插件在自己的包里携带同一批技能，因此 dsh 只能通过这条 skill-filesystem 路径挂载它们。

开发期现实：`@deepseek-ai/dsh-skill-filesystem` 运行时是 peer stub（契约镜像的注册，无文件 watcher），因此挂载通过真实组合（stub + 实际镜像 `skills/` 的 frontmatter，用 engine `lintSkillFrontmatter` 校验）验证；真实运行时组合（真实 seam 包、watcher、`$DSH_BUNDLED_SKILL_DIR` 环境变量流）是部署目标，不在本包测试套件覆盖内。

## Commands

插件把 bundled 的 mstar 命令（omp/opencode 对齐面）注册到 `ctx.commands`：`harness-commands/*.md`——仓库根 `commands/` 镜像（`iteration-start`、`iteration-drive`、`iteration-loop`、`codebase-audit`）由 `bundle-assets` 在构建/postinstall 时同步（gitignore）。每条注册读取命令的 `name`/`description`/`input` frontmatter；声明了 `input` hint 的注册会将其作为 `input.hint` 公布，使 dsh web 客户端的决策表从「脱离式裸执行」翻转为 leadingInput **claim**——菜单点选后把 `/name ` 插入输入框（命令色 token + ghost hint），按 Enter 才提交，用户可以键入后续参数（与 `/plan`、`/goal`、`/advisor` 相同的交互）。handler 把**命令正文以 USER source 消息 steer 进接收 agent**（dsh-plan-mode 命令先例——`source: { kind: 'user' }`，模型把正文当作要执行的任务而非注入上下文；即 dsh-commands 的「经接收 Agent 显式调度模型可见工作」路径），用户键入的参数以 `## User input` 小节追加在正文后，返回成功结果。注册以 `ctx.inject(['commands'], …)` 延迟进行——与工具注册相同的可选单元模式——插件在无 commands 服务时也能启动；镜像缺失（未跑 `bundle-assets`）则不注册任何命令。

## Engine seam mapping

每个 engine 模块都挂到一条 dsh 表面——除 lint 模块的 plan/tdd fs 闸门外均已交付（延后项；见 Known Limitations）：

| Engine 模块 | dsh seam | 状态 |
|---|---|---|
| core（applyEnforcement、GateResult/Severity） | 跨切面否决/拒绝 | 已交付（P1） |
| path（resolveHarnessDir） | harness 目录探测 + `{HARNESS_DIR}/status.json` 目标匹配 | 已交付（P1） |
| status（validateStatus、validateResidual、findingsCleanupGate） | status.json 的 `fs/write-intent` + `fs/edit-intent` | 已交付（P1） |
| lease（verifyPlanExecutionLease、validateIntegrationMergeLease） | exec 租约：`tools/pre-execute`（派发闸门内）；merge 租约：`HostAdapter.beforeMerge` | 已交付（P1 exec / P3 merge） |
| dispatch（composeDispatchGate、isReadOnlyAssignmentRole、parseAssignmentFields） | 作用于 subagent 工具的 `tools/pre-execute`（`PreToolDecision.deny` 阻断）；`agent/pre-step` 咨询 | 已交付（P1） |
| host（resolveSkillRoot、HostAdapter） | engine host.ts 检测行 + 插件适配器（`host: 'dsh'`） | 已交付（P2） |
| skill-authoring（lintFrontmatter、lintFiveQuestion） | skill-filesystem 根 + 对 SKILL.md 的 `fs/write-intent` | 已交付（P2） |
| lint（lintSkillFrontmatter、planQualityBar、assertSddTddTriple） | 未接线——plan/tdd 的 fs 闸门为延后项；`lintSkillFrontmatter` 仅运行于 skills-mount 测试套件 | 延后 |
| agent catalog | MessageSourceMap `mstar-engine-status`（模型可见 ⟺ 已记录） | 已交付（P2） |
| sdd（sddWorkspace、taskBrief） | 注册在 `ctx.tools` 上的 `defineTool` 包装 | 已交付（P3） |
| iteration（evaluatePhaseGate、parseCompassFrontmatter） | `agent/pre-step` + iteration 闸门 | 已交付（P3） |
| worktree（l1PreDispatchCheck、l2PreDispatchCheck） | `tools/pre-execute` L1/L2（派发闸门内） | 已交付（P3） |
| design-md / audit / compound / roles | `fs/write-intent` + 注册在 `ctx.tools` 上的 `defineTool` 包装 | 已交付（P3） |

## Engine-status catalog

一个咨询式 `agent/pre-step` 瀑布监听器向每个组合后的步骤追加**一条** **`mstar-engine-status`** catalog MessageSource（`kind`/`form: 'catalog'` 契约，镜像 dsh tool-skill 先例）：模型可见的 `<mstar_engine_status>` 块渲染水印字段——**mstar 版本**（插件自身清单；单一版本不变量把打包的 engine 钉在同一版本）、**harness 目录**（解析后的 `{HARNESS_DIR}`，缺失为 `none`）、**enforcement**（compass 模式，`soft` / `hard (compass)`）——以及 **迭代相位闸门段**（当 steering compass + `status.json` 可解析时：迭代 id、transition、all-plans-done、闸门判定 + 违规码——即 `mstar iteration gate` 工具结果形态）与 **工作区状态摘要段**（当工作区有 `status.json` 时）：**plans**（`id(status)` 注册表）、**residuals**（按 severity 的 open 计数）、**branch**（base → target、spec 集成）、**policy**（push 政策、worktree 模式、control 根）、**leases**（活跃 plan 执行租约：持有者 + worktree）、**knowledge**（知识索引文档数与分类）与 **direction**（steering compass 的 problem statement 一句话）。监听器先调用 `next()` 并基于委托后的决策追加——从不否决步骤、从不替换已组合的消息。模型可见 ⟺ 已记录：持久化的 `catalog` 形态 source 在模型面向的散文旁记录了其发布的事实，会话日志无需重新解析该块即可重建该行（dsh packages/AGENTS.md）。fiber 销毁即移除监听器（HMR 安全）。

该行是 **digest 门控**的：按 agent+workspace，每个 turn 只注入一次，仅当渲染文本变化时重新注入——20 步的 turn 只显示一次 catalog，而不是 20 次。source 共享**同一**按工作区缓存条目：显式 `harnessDir` 时在 boot 构建（否则在工作区首次 pre-step 构建），并按 TTL 刷新（`catalogTtlMs`，默认 60 秒）——刷新间隔之间热路径只是时间戳比较 + Map 命中，会话中 plan/compass/residual 的变化在一个间隔内落地。

## Web 客户端插件（工作流面板）

本包为 dsh **web** profile 提供浏览器客户端半体，在**已安装的 `mstar` bundle 行**上被自动发现（package.json 的 `dsh.client` 声明 + `exports["./client"]` → `dist/client.js`——上游 web `dsh.client` 发现逻辑扫描 loader entries，并把每个客户端的 `exports["./client"]` 解析进 boot 图）——**无需独立 profile 层或安装步骤**（spec §6.1）。web 应用在 `/plugins/@mstar-harness/dsh/client.js` 提供该 bundle，并经 closure-factory loader 握手加载（`window.__ModuleLoader__.load({ id, factory })`）。

客户端入口在 **`conversation.view`** view ring 注册一个 tab（`id: 'mstar-workflow'`、`order: 20`——trajectory 先例形态），经 `mstar-panel` locale 命名空间命名为 **"MStar 工作流"**（zh）/ **"MStar Workflow"**（en）。面板即 **MStar 工作流布局**：右侧固定 300px sidebar——计划（≤5 时间倒序 + `+N more`）、未决残留 findings（≤10、severity chip、溢出提示）、策略（**enforcement 首位** + push / worktree / control worktree）、租约、知识、方向——其下为**底部 fixed 小面板**（版本 + harness 目录；小字号 muted、不随 sidebar digest 滚动；原 header 行已移除），主体为 **HTML/CSS zone dashboard**，外加新鲜度 footer（`last-updated HH:MM:SS` + catalog 重发刷新说明）。branches 区块已移出 sidebar 迁入迭代区（plan `20260810-panel-canvas-zones`）。860px 以下 sidebar 堆叠到主区下方。

canvas 区是会话日志中最新一条 `mstar-engine-status` catalog 行的纯渲染（数据来自 `useSession` 快照——刷新跟随快照，不轮询）：页面**撑满 Tab**（无整页滚动——zone 容器是唯一滚动主体），**zone dashboard**（替代 react-flow 循环图，plan `20260810-panel-canvas-zones`）排布三区——**迭代区**（Step 1–5 竖排 stepper + `Step N/5` 徽标、激活高亮 / 未激活暗淡态；steps 为**四态状态机**——`current` / `next` / `done` / `idle`（plan `20260812-panel-f5-iteration-zone-fix` Task 1）：current 之前的步骤投影为 `done`「已完成」（已完成的 Step 1 不得在 Step 2 current 时显示为待命 idle），`next` 为唯一前向目标，`idle` 仅为 schema 余项——分支面板：迭代 base / 目标分支 / spec 集成分支，仅激活时渲染；展开态头部为**左右分栏**——分支（左小半，**宽度受约束**——`flex: 0 1 260px` + `max-width: 280px`，不再随容器撑宽；<860px 竖排时重置为内容高度）+ Steps（右大半，`flex: 1 1 0` 吸收剩余宽度），经 `data-iteration-head-split`，窄宽回退堆叠，无激活迭代时无分支面板；当前步跟随 steering compass：`compassStatus: 'active'`（Phase 1 进行中）→ Step 1（iteration-start）为**当前步**且 verdict 为 `unknown`——无 PASS/FAIL 徽标——plan `20260811-panel-f4-iteration-zone`）；**迭代信息 Section 由任务迭代与代理执行两 tab 共用**（plan `20260812-panel-f5-design-system` Task 8，用户第 4 轮决策 #4——单一 `IterationInfoSection` 组件，两 tab 渲染同一 `view.iteration` 块：摘要 + steps + 分支）；**任务区**（**5 列 kanban**：Todo / InProgress / InReview / Done / `blocked-unknown`——Blocked 与原有 unknown 兜底**合并为单列**，标题「受阻/未知」/「Blocked / Unknown」，plan `20260813-panel-quick-fixes` Task 1——带计数徽标；每列渲染行数统一以 `PLAN_CAP` 封顶，超限显示可点击的「更多」/「收起」展开按钮（`data-kanban-more` 锚点）展开全量——投影保留全部 plan 行，封顶只是渲染关注点、绝不丢弃）与**代理执行区**（四个 EXPECTED_ROLE_FLOW stage/phase 列——review-edit-chain → sdd-implement → qc-tri → qa-gate（终点阶段；原 `sdd-task-review` 阶段已删除，其 SDD L2 审查者现为管线内角色 `code-reviewer`，v2.1.1）——**严格四列布局、无独立 unknown 列**（plan `20260812-panel-f5-design-system` Task 5，用户 2026-08-12 第二轮决策——原 plan `20260812-panel-f5-agent-layout` 的最右 unknown 列被取代）：`general` 桶**下沉至 `qa-gate` 列底部 unknown 子分区**（`data-sub-bucket="unknown"` 标题行「unknown / 未匹配角色」，位于末张 qa-gate 卡之后，其下排布 general 卡；独立 on-demand 列已于 agent-layout plan 移除）；`explore` 已移除——无卡无列。`sdd-implement` 列按投影 `entity.bucket` 拆为**子桶**（绝非渲染猜测）：上方 **implementor 分区**——按 stage 原始顺序的 flow 角色（fullstack-dev / fullstack-dev-2 / frontend-dev），随后是 on-demand 角色（ops-engineer / prompt-engineer，带 **按需徽标**——无独立 on-demand 列）——与下方 **sdd-reviewer 分区**（code-reviewer，SDD L2 task reviewer），带 implementor / sdd-reviewer 标题标签；`zone: 'on-demand'` 实体位于 implementor 分区内，`zone: 'general'` 实体渲染于 qa-gate 列底部 unknown 子分区。画布按**两个左右并排的 Phase 分组**排布（plan `20260812-panel-f5-design-system` Task 8，用户第 4 轮决策 #2；左右排列 per plan `20260813-panel-agent-canvas-legend-layout` Task 2）：**左：Phase 1 组**（review-edit-chain——顺序完成的 Review & Edit 链：product-manager → architect → writing-specialist）+ **右：Phase 2 组**（sdd-implement → qc-tri → qa-gate——循环迭代 plans），顶部对齐（各组标签行共享同一 `y = PAD_Y`），各带组标签行；**Phase 2 组标签标注当前 plan**（`data-canvas-group-plan` = 投影 `activePlanId` = `state.plans[]` 中首个 InProgress plan_id；多个进行中 → `+N more` 诚实计数；无 → 灰字「无进行中 plan」）。subagent **实体卡**按 **role 聚合**：同一角色跨 session 合并为一张卡 ×N，所有 off-roster 派发（原 `generalPurpose` SDD 审查者、`scout`、匿名 `role === ''`）归入唯一 `general` 桶实体——卡以 **role 为标题**（role id）；agent session id / 任务标签（`planId#taskId`）走在记录行上、不作卡标题——卡片显示 role chip / 状态点 / ×N 计数；执行中实体带 business glow-pulse 高亮（施加于**圆角 `.card-body`**——卡片为唯一圆角元素，无方形外轮廓叠加，plan `20260812-panel-f5-design-system` Task 5），无证据 stage 渲染虚线「待执行」占位（含预期 role chips），无证据 KNOWN_AGENTS 成员渲染虚线 idle 卡（14 角色 roster 永不隐藏），头部显示 `N 执行中 · M 待执行` 摘要；卡片携带投影 **透明度分级**（plan `20260812-panel-f5-design-system` Task 4，design doc §3）：`emphasis: 'current' | 'next' | 'off' | null`——迭代当前阶段角色 **100%** chrome 全强度、后续阶段预期角色 **75%**、已过阶段 / 无阶段角色（on-demand、general）**45%**，`null`（无迭代 / transition 不可解析）**不覆盖**——恒为 chrome **alpha 混合**（`--mstar-canvas-emphasis-*` token；绝不整卡 `opacity`，状态点与 running 辉光保持不透明）。已结算实体带**独立绿色完成框 + 绿 ✓**（plan `20260812-panel-f5-design-system` Task 8，用户第 4 轮决策 #1/#3：`data-agent-done="true"`——圆角卡片体 success 边框 + 1px ring + 状态点绿 ✓，全强度 evidence 态）——**仅当 `emphasis ≠ 'off'`**；off 档角色（已过阶段 / 无阶段 on-demand + general）显示灰字圆点、**绝不显示完成标记**（第 4 轮 #3：已完成状态不出现在无阶段角色上）。画布只投影**当前迭代**的派发证据（plan `20260813-panel-quick-fixes` Task 2）：steering compass `iterationId` 活跃时取之，否则经 catalog `plans[].iterationRefs` 推导最近迭代（8 位日期前缀 + doneAt 最大的 plan 的 refs）；可证明跨迭代的事件不产生实体/连线（roster 常驻 idle 卡），无 plan / 未知 plan / 独立 plan 的派发绝不隐藏。状态诚实（Task 2）：`advisory` **不再终态**——软执法派发落到配对 settle（有 settle 绿 ✓ 已完成、无 settle 显示执行中），`denied` 仍为终态；advisory verdict 仍在事件记录页呈现。画布图例位于**视口下方**（Task 3，自上方移下，用户 2026-08-13 反馈）。连线（plan `20260812-panel-f5-design-system` Task 5，design doc §2）：`expected` 阶段骨架箭头与**带动画的 next 边**（原 `@keyframes agent-dash-flow` dash-flow 箭头，plan `20260810-panel-agent-flow-zone`）**已移除**——流转顺序由固定列序 + 列标签暗示、当前位置由 running 辉光 + 状态点承担——仅余两类语义线：证据驱动的 **`actual` 交接线**（同 plan ts 相邻派发实体键对、过滤 general 端点、同对实体键至多 1 条）以 **bezier `C` 曲线**绘制，锚定卡片 **4 端口**（上/下/左/右四边中点；静止不可见、hover 显示为小圆点），箭头尖端退让至端口外 **10px standoff**——箭头沿线在锚点处的局部切线（**H1**），任何线的描边/箭头不穿过文字（**H2**：standoff + 侧隙路由，design doc §2.0/§2.5/§2.6；plan `20260813-panel-quick-fixes` Task 3 收紧——同列纵向流的中线会穿过中间卡片体时改走列**左侧隙带**（正向与反向；如 fullstack-dev → frontend-dev 跳过 idle 的 fullstack-dev-2），反向水平 bezier 保持**方向感知**控制点位于端点**之间**、不再向相邻列鼓包）——外加**双向监督线**（plan `20260812-panel-f5-agent-layout` Task 1/2）——`sdd-implement` 列内一条静态设计知识子桶边（implementor ↔ sdd-reviewer——mstar-sdd 相互监督契约），现锚定于**列外侧隙垂直锚点**（`x = 卡片右缘 + 18px`，垂直 bezier 流，箭头沿垂直切线——design doc §2.5/§2.7）；默认 dim 虚线，投影 `evidenced` 为真时亮起 business **实线**（证据驱动点亮，绝不伪造激活））——agent 流转事件条迁入**「事件记录」tab 日志页**（spec F1.5，plan `20260811-panel-event-log`）：非 canvas 日志页——**Agent 流转事件** / **违规记录** 两个分区，每条可展开原生 `<details>` 呈现完整 catalog 字段（缺失字段显示「—」，绝不捏造），空态 muted；两个分区在**锁定高度的左右两列** grid（`repeat(2, minmax(0, 1fr))`）中并排——页面整体不再滚动，各分区固定标题、列表内部滚动（plan `20260813-panel-quick-fixes` Task 4 修复根因——面板根节点接入宿主 `data-conversation-composer-overlay` 全高 opt-in，使 `height:100%` 真正解析、`.rowList` 的 `overflow-y: auto` 在分区内部滚动、宿主页面不再整页滚动，底部按宿主发布 `--dsh-composer-height` 预留悬浮 composer 间隙）——1200px 以下回退为两个 50/50 锁定行（`data-event-log-*` 锚点族不变，plan `20260811-panel-f3-agent-general`）；**canvas 左下角 fixed `AgentEventDock`** 与底部 fixed footer 条随页面落地而**移除**（无双份日志，spec §5）。空分支（spec §2，plan `20260812-panel-f5-agent-layout` Task 3）：waiting 保留 muted hint；无 harness 时渲染**居中未激活态卡片**——文件夹图标 + 「未检测到 Morning Star harness」标题 + hint 文案（详细面板保持未激活——无 tab、无 sidebar——检测到 harness 后自动呈现；`data-mstar-empty="no-harness"` 锚点保留在标题上，`data-mstar-graph` 在主容器上）。1200px 以下三区纵向堆叠。投影为纯函数 `projectGraph(source)`（schema 常量与 catalog 证据严格分离；永不 throw；缺失字段显式降级为空态/最后已知态——muted 空态，绝无橙色 warn 框），产出纯数据 `ZoneView`；`WorkflowCanvas` 以纯 HTML/CSS 渲染。

**依赖**：zone dashboard **不携带任何图库**——`@xyflow/react` devDependency（此前构建期内联进 `dist/client.js`）随 react-flow 渲染层一并移除（plan `20260810-panel-canvas-zones`），唯一消费者是 `@xyflow/react/dist/style.css` 的 plain-`.css` text loader 也已删除（`CLIENT_EXTERNALS` 不变——react / react-dom 与 `@deepseek-ai/dsh-client-*` 平台模块保持外部）。构建脚本端到端断言移除成立：产物**不得含 `xyflow`/`reactflow` 标记**、`@deepseek-ai/*` 值导入为 0、**无 `import.meta` / ESM 语句**——web loader 以**经典 `<script>`** 执行插件 bundle，字面 `import.meta` 是 parse-time SyntaxError（zustand v4 的 `import.meta.env` 读取已在构建期 define 消除；见本迭代 install-verification guide §6）。本 plan 收口时的体积：**145,159 B raw / 29,460 B gzip**（以各迭代 install-verification guide 为重新测量 SSOT——react-flow 移除后缩至约 85 KB，代理执行区实体渲染落地后回升，F5 透明度分级 + 连线重构后再度增长）。

安装 / 验证（客户端半体与服务器半体走同一条 bundle 行安装）：

```sh
cd <repo>/packages/dsh
bun run build               # dist/client.js（closure-factory CJS）+ dist/client.d.ts
# corepack 机器（仓库根声明 packageManager: bun）：命令前加 COREPACK_ENABLE_PROJECT_SPEC=0
dsh plugin --profile web add <abs packages/dsh path>   # 同一 profile bundle 安装
dsh web                     # 启动 → 服务 /plugins/@mstar-harness/dsh/client.js
```

本地已验证（install-verification guide）：boot 图包含客户端 entry（`@mstar-harness/dsh` 携声明的 inject 面）、`/plugins/<id>/client.js` 路由服务的正是构建产物（rev = 内容 sha1）、浏览器握手 materialize 出插件入口（`inject` + `apply` + CSS 注入，经典脚本语义）——见 `.mstar/iterations/iter-20260809-mstar-panel-beautify/guides/install-verification.md`。

**Known Limitations**（本迭代）：迭代 stepper 的 Step 1（iteration-start）在 steering compass `status: active`（Phase 1 进行中——catalog `compassStatus` 字段）时为**当前步**，且不携带 PASS/FAIL 徽标（Phase 1 无 gate 判定）；Step 5（merge-ready）**永远不会是当前步**——engine 相位门只评估 Phase 2→3→4（merge-ready 从不是 gate transition）；仅当 Step 4（pr-delivery）为当前步时渲染 `next`，其余为 idle；当前步跟随 TTL 刷新的 `compassStatus`——会话中途 `active`→`locked` 翻转后最多落后一个 catalog 间隔（60 秒）（有界、已记录的陈旧；绝不给出错误判定）；代理实体状态按**精确配对**派生（paired settle 携带的 `(agent, role, planId, taskId)` 标识精确配对到对应派发——QC tri N=3 并发下各卡各自结算；未配对派发保持 running，绝不捏造）；无 steering compass 时的「当前迭代」过滤按 plan id（8 位日期前缀）+ doneAt 推导迭代——确定性、已记录的启发式，且只丢弃可证明跨迭代的事件）；不回溯 resumed 长日志的历史行（服务端每 turn 首步必重发，digest 门控）；无自定义顶层槽位（不改 dsh-private 布局的前提下，`conversation.view` tab 是唯一的会话级面板位——spec §1）。面板验收为双轨：in-loop 浏览器 harness 验证（对重建 bundle，见迭代 guides `iter-20260810-panel-zones/guides/`）+ 用户重启后 GUI 终验——重跑步骤见 install-verification guide §8。R1（浏览器观察）已于 2026-08-10 关闭归档。

## Development

命令（在 `packages/dsh` 下执行）：覆盖率门禁为 `src/` 逐文件 100%（dsh 测试策略）；构建命令把 src 条目 bun 打包进 `dist/`（内联 engine 与 schemastery；`@deepseek-ai/cordis` 与运行时 seam 导入——`@deepseek-ai/dsh-skill-filesystem`、`@deepseek-ai/dsh-tools`（`defineTool`）、`@deepseek-ai/dsh-llm`——保持外部），运行 `build-client`（`scripts/build-client-bundle.ts`——按 spec §6.2 产出的 closure-factory CJS 浏览器 bundle `dist/client.js`）并输出 tsc 声明。

```sh
bun test --coverage
bunx tsc --noEmit
bun run build
```

`bun run test` 会先构建客户端 bundle（`pretest` 钩子执行 `build-client`——manifest-contract 套件断言 `dist/client.js` 存在）；fresh checkout 下直接 `bun test` 会以 `bun run build` 提示失败而非裸断言。

开发期 seam 表面（类型、事件形态、运行时）是来自公开 npm registry（`registry.npmjs.org`，无需根 `.npmrc`）的**真实** `@deepseek-ai/dsh-*` 包（bun 默认自动安装 peer）。

## Model Experience

### Request surface and condition

#### What the model sees

每个组合后的步骤携带一条 `mstar-engine-status` catalog 用户消息（`<mstar_engine_status>` 水印块——见 Engine-status catalog 一节）。闸门决策额外添加：派发否决以注册表物化的 `PreToolDecision { kind: 'deny', reason }` 错误呈现；状态闸门以 `mstar/status-gate` 咨询呈现（告警放行、hard 修复逃生或降级放行）；派发闸门以 `mstar/dispatch-gate` 咨询呈现（告警放行或降级）；技能 lint 闸门以 `mstar/skill-lint` 咨询呈现（告警放行、hard 修复逃生或降级放行）。每条模型可见的行都能从会话日志重建（catalog 形态 source + 咨询事件）。

**Leaf 交付纪律（PM 2026-08-12）**：leaf 子代理在**最终（closing）消息**中交回完成报告，**不**通过 `report` 工具交付——dsh tool-subagent-report 默认 `reportDelivery: quiet` 会把报告投递到父代理的 next-step 队列，父代理 turn 结束（无 step 边界）后报告会滞留队列。closing 消息是可靠交付通道；`report` 保留给「中途发现、需要父代理改变下一步」的发现（SSOT：`skills/mstar-host/references/dsh.md` → PM dispatch）。

#### Token effect

catalog 向每个组合后的步骤追加一条固定、稳定的用户消息（小的常量块——除每步一行外不随会话长度增长；按会话摘要去重是 P3 项）。否决与咨询文本仅在闸门触发时存在。

#### KV Cache effect

catalog 行在委托之后追加到组合步骤消息的**末尾**——请求前缀（system prompt 与先前消息）不受影响，因此插件既不创建也不失效前缀缓存状态；尾部行跨步骤逐字节相同。工具错误文本随违规变化，但从不参与请求前缀。

## Known Limitations and Deferred Work

- **开发期 seam 从 npm registry 解析** —— `@deepseek-ai/dsh-*` 各 seam 仅为 peerDependencies（运行时由宿主提供）；开发期 typecheck/测试/构建从公开 npm registry（`registry.npmjs.org`，无需根 `.npmrc`）解析（bun 默认自动安装 peer）。**全部运行时 seam 导入在构建时外部化**（`--external @deepseek-ai/cordis / @deepseek-ai/dsh-skill-filesystem / @deepseek-ai/dsh-tools / @deepseek-ai/dsh-llm`——发布的 `dist/` 导入它们而非内联占位代码）；闸门通过真实注册表/fs 工具执行的同一 `ctx.waterfall` 派发来验证。本包套件直接运行来自 npm registry 的**真实** seam 包——不再有提交的 `peer-stubs/` 占位、不再有本地 link farm。
- **反递归绑定为 Config 声明** —— dsh 在工具执行上下文上不暴露每 agent 角色，故 `dispatchBinding` 声明单一部署级角色；`Execute as` 不同的 Assignment 无法被识别为自我递归，多角色派发方需要按实例拆分插件。
- **租约闸门有意与 opencode 分叉** —— opencode 的 `beforeDispatch` 不运行租约检查；dsh 租约闸门是新增的（`lease.dispatch.*` 码），且仅对可写 SDD/InProgress 派发触发，故对齐覆盖字段集而非租约面。
- **已采纳 engine 共享组合** —— 派发闸门核心即 engine 的单一 `composeDispatchGate`（与 opencode/omp/CLI 对齐，字段/分支/反递归违规码按构造即相同），compass frontmatter 解析器即 engine 的共享 `parseCompassFrontmatter`（本地 dsh 镜像与 CLI 副本均已删除——不再有可漂移的分叉）。两者都运行在 dsh 头区域切片上；租约 + worktree L1/L2 检查仍为叠加上去的 dsh 侧扩展。
- **engine 单一版本钉定** —— `@mstar-harness/engine` 为精确 `2.1.1` devDependency，构建时打入 `dist/`（绝非运行时依赖）；`readHarnessVersion()` 读取 bundle 旁的 dsh 包清单 —— `2.1.1`，按单一版本不变量与钉定的 engine 相等。
- **Schemastery 空数组物化** —— 省略的可选 ARRAY Config 键会物化为 `[]`；派发键通过 `.default(undefined)` 保留省略语义，未来任何可选数组键都必须同样处理。
- **载荷边界** —— 派发闸门校验委派载荷（Assignment 文本），而非子代理的运行时行为；如需向模型可见的子活动建面，事后经 `subagent/start` 观察仍为可选项。
- **状态闸门因 seam 设计而内容盲**——`fs/write-intent`/`fs/edit-intent` 瀑布链只携带 `(target, actor)`，从不携带写入内容，因此**首次**把合法 `status.json` 写坏的写入在两种模式下都会通过（闸门只校验写入前的磁盘文档）。hard 模式因此从不否决状态写入：对已非法文档按**修复逃生**放行（error 级咨询，`hard: true, repair: true`），让修复性写入能落地。恢复路径：就地修复文档（闸门允许）或删除 `status.json` 让 harness 重建；hard 部署应监控 `repair: true` 咨询。
- **缺失 `status.json` 的租约行为**——sdd 可写派发遇到缺失状态文件会发出 `lease.dispatch.unverifiable`（告警下 advisory，hard 下 deny）；非 SDD 派发无租约义务，保持静默降级放行。
- **闸门匹配跟随 `displayPath`**——状态闸门按 fs target 的解析后 `displayPath` 匹配。后端报告工作区相对路径、harness 目录为符号链接、或远程/URI target 时永不匹配，闸门对其惰性（无误报）；受守护的 harness 写入请使用绝对本地路径。
- **design-md seam 作用域为全局 basename 匹配**——`isSeamTarget('design-md')` 匹配文件系统上任意 `DESIGN.md` / `DESIGN.dark.md`，无论解析出的 `{HARNESS_DIR}` / 仓库根是什么。因此对不遵循 mstar token 格式的外部项目 DESIGN.md 的写入，在 hard 模式下会在 harness 之外记录 error 级修复逃生咨询（`hard: true, repair: true`）——一个嘈杂的误报面（写入从不被阻断）。有意为之（「工件即文件本身，无论设计位于何处」）；在 harness 目录可解析时把作用域收窄到仓库根是可能的后续项。
- **audit seam 作用域匹配任意深度上的任意 `plans/audit-*` 段**——`isAuditPlanTarget` 扫描所有路径段，因此与 mstar 无关的目录树（例如带有 `plans/audit-*` 布局的依赖或兄弟项目）在写入时会收到 mstar audit 状态块 + 秘密 lint。与 design-md 作用域同类（仅咨询，从不阻断）；该布局是 mstar-audit 文档化的 Phase 4 形态，因此匹配是有意为之。
- **`<root>/mstar-roles/SKILL.md` 上 skill-lint × roles seam 双重触发**——当某个已配置技能根包含 `mstar-roles` 目录（开发期的仓库根镜像情形，以及发布形态的打包镜像）时，对 `mstar-roles/SKILL.md` 的一次写入会同时触发技能撰写 lint 闸门与 roles seam 闸门（hard 下两条咨询 / 两条修复逃生日志）。两个校验器都合理适用——双重 lint 仅为咨询，并非正确性破坏；「作用域互不重叠」的性质只在四个 seam 之间成立，不跨技能闸门。
- **内容盲的 skill-lint 盲区**——`fs/write-intent` 槽位只携带 `(target, actor)`：首次创建的传入内容不被 lint，合法→非法覆盖在监听器路径上无法检出（它只 lint 写入前的磁盘文档）。告警/hard 咨询只呈现**已存在**的磁盘违规——与状态闸门同类限制。
- **显式相对 `bundledSkillDir` 覆盖锚定 cwd**——skill-filesystem 对相对打包根按普通 `join()` 语义解析到 dsh **进程 cwd**。插件的**默认**打包根是包内自带的 `harness-skills/` 镜像，按包相对路径解析（**非** cwd 锚定——任意启动 cwd 都可用）；只有显式的**相对**覆盖继承 cwd 锚定，因此覆盖默认的部署应在 **profile 层传绝对路径**（见 `bundle/README.md`）。
- **Bundled 镜像是构建期同步**——`harness-skills/` + `harness-commands/` 由 `bundle-assets` 在构建/postinstall 时产出（仓库根 `skills/` + `commands/` 镜像；gitignore）。未跑 `bundle-assets` 的检出不挂载 bundled 技能、不注册命令（默认挂载惰性，而非报错）。
- **profile-bundle 安装到 `web` profile：registry 与 local checkout**——`dsh plugin --profile web add @mstar-harness/dsh`（registry）与 `add <本地检出>` 为受支持途径，均走同一 pnpm + reconcile 机制（reconcile 步骤把 `@mstar-harness/dsh` 并入 `dsh.profile.bundles`）。local checkout 需要先执行 `bun run build`——本包没有 `prepare` 脚本（monorepo 显式构建各包），未构建的检出会装入空的 `dist/`。
- **`lintSkillWrite` 类型化否决尚未接入生产**——传入文档分支的 hard 否决（`SkillLintVetoError`，码 `skill-lint.veto`）已导出并测试覆盖，但尚无生产调用方：engine `HostAdapter` 没有携带内容的技能写入钩子（只有 `beforeStatusWrite`/`beforeDispatch`/`beforeMerge`），且 fs intent 槽位内容盲。接线随未来携带内容的钩子落地；在此之前监听器路径只通过修复逃生咨询执行（从不否决）。
- **CLI `HOST_SIGNALS` 缺少 `subagent` token**——engine `ToolSignal` 联合已包含它且 `detectHost` 能处理，但 `packages/cli` 的 `HOST_SIGNALS` 尚未更新，`mstar host detect --signals subagent` 会拒绝，直到上游化时更新 CLI 列表。
- **入口是 `src/gates/*` 之上的模块索引**——拆分已交付：`src/index.ts`（371 行）从各 gate 模块（`_shared` / `status` / `skill-lint` / `seams` / `dispatch` / `catalog` / `tools` / `adapter`）原样 re-export 冻结的 27 名导出面，并保留插件 manifest、单一 cordis augmentation 点、命令注册与 `apply()` 启动接线。导出面（17 值导出 + 10 type-only 名；`Config` 计一次）由 `tests/export-surface.spec.ts` 冻结——运行时值导出集 + `typecheck:tests`（`bunx tsc --noEmit -p tests/tsconfig.json`）下的值命名空间恒等与逐名类型探测。
- **engine dsh 行待上游化**——engine `host.ts` 的 dsh 改动（`DetectResult`、`ToolSignal`、`resolveSkillRoot`）位于 mstar-workflow engine 镜像，计划经用户授权的上游 PR 合入 mstar-harness；`mstar-host` 技能镜像（§ Detect / § Resolve loaded skill root / `references/dsh.md`）随之一并更新。
- **迭代 stepper：Step 1 为 compass 驱动，Step 5 为 schema 驱动**——zone dashboard 的 Step 1（iteration-start）在 steering compass `status: active`（Phase 1 进行中）时为当前步（无 gate 判定 → 无 PASS/FAIL 徽标）；Step 5（merge-ready）是 engine 闸门永不点亮为当前的 schema 常量（transition 只覆盖 Phase 2→3→4，merge-ready 从不是 gate transition）；仅当 Step 4 为当前步时作为 `next` 渲染，其余为 idle——已记录于迭代 guide，非缺陷。完整面板限制清单见 Web 客户端插件一节。
