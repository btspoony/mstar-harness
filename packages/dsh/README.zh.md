# @mstar-harness/dsh

[English](README.md) | 中文

![dsh](https://img.shields.io/badge/dsh-0.1.5--rc.2-4B32C3.svg)

让 [Morning Star](https://github.com/btspoony/mstar-harness) 成为一等公民的 dsh（DeepSeek Harness）宿主——一个 cordis 函数插件，将 mstar engine 进程内挂载，实现 engine `HostAdapter`（`host: 'dsh'`），守护 `{HARNESS_DIR}/status.json` 写入（校验 + 咨询；hard 下按修复逃生放行），在 `Enforcement: hard` 开启时阻止被禁止的 subagent 派发，对挂载技能根下的 `SKILL.md` 写入执行技能撰写 lint，通过 dsh skill-filesystem 提供者挂载 mstar `skills/` 镜像（单一规范挂载），并向每个组合后的 agent 步骤追加一条持久化的 `mstar-engine` catalog 行（持久化日志的读取方也接受旧标识 `mstar-engine-status`）。随 dsh Loader 应用启动；一切均通过 seam 的拒绝/咨询通道行使职责，从不改动工具本身。

## Usage

dsh 应用如何使用本插件——安装路径、配置、挂载时发生什么、强制执行语义。

### Install paths

本包以 workspace 包形式发布（`workspaces: ["packages/*"]`），构建时把 engine 打进 `dist/`（`bun run build`；dist 已被 gitignore）。安装途径是 **profile bundle**，装进现成的 `web` profile（`dsh --profile web`——开箱即用的 web 应用 profile，即 `dsh web`），经 `dsh.bundle.patch` 清单——一个叠在 dsh-base 默认层之上的补丁层：

**一条命令的 CLI 入口（推荐）**——`npx @mstar-harness/cli init --target dsh` 一次性装齐全量能力：它按序运行下面两条 `dsh plugin --profile web add` 安装（先 mstar bundle，再 `dsh-llm-fallbacks`），并可用 `npx @mstar-harness/cli doctor --target dsh` 逐行报告 `uninstalled` / `disabled` / `mounted`。它编排的仍是同一条双命令安装；`--no-fallbacks` 跳过第二行（连带跳过 seeded 角色——见下文「零配置获得什么」）。

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

**（c）可选能力：`dsh-llm-fallbacks`（第二条命令）**——基于角色的 subagent 配置能力（见 LLM fallbacks integration）是**独立的插件行**，须以单独命令安装：

```sh
dsh plugin --profile web add dsh-llm-fallbacks
```

**双命令安装即契约**——把 `dsh-llm-fallbacks` 行折叠进本 bundle 的补丁**明确否决**（roadmap §8.3 F4）：loader 没有 insert-if-absent 语义，因此同 `id` 插入是 `duplicate loader entry id` 启动失败（整个 dsh 会话无法启动）；异 `id` 插入则插件被挂载两次——对同时直接安装该包的人，会出现两次 `apply()` 与分裂的 fallback 状态（各自独立的 state store、双份监听器、配置覆盖抽签）。层序为 reconcile 追加序：`dsh-llm-fallbacks` 落在 **`dsh-base`/`llm-retry` 之后**（其硬性排序要求）并位于 mstar 行之后。单命令多激活是上游功能缺口（reconcile 去重或 insert-if-absent 补丁语义），本仓库无法实施。

**零配置获得什么**——两条行都装上后（经 CLI 入口或上面两条命令），mstar 插件在 boot 时把 13 个 `mode: subagent` 的 mstar 角色种子（从打包的 `harness-agents/` 镜像派生，排除 `project-manager`）声明进 fallbacks taxonomy：每个 seeded 角色的 persona 默认取其镜像 `description` 外加一行强制角色加载引导；seeded 状态保持可 revert（`fallbacks/revert-seed` 网关 / settings 回滚按钮）；运行时 advisory 报告缺失 id 与 persona 覆盖。该 seeds 机制即 B4——installed-deployment e2e（`tests/install-e2e.spec.ts`）本轮把验证闭环：真实 `init --target dsh` 安装进临时 `DSH_HOME`、从安装产物 boot，断言 13 个 id 全部出现在 effective taxonomy 且 persona 非空。不含模型路由、不含 automatch 派发、不含 dsh-tui。

> **fresh publish 年龄窗口提示**：pnpm 的 `minimumReleaseAge` 门禁可能让 `dsh plugin add <spec>` 的 range 解析在全新发布后约 24h 内选中旧版本（不含 seeds surface）——窗口过后重跑 `npx @mstar-harness/cli init --target dsh`（或显式 pin 版本）即可收敛到最新 surface。

### Headless profile（一次性运行）

本插件并非 web 专属：它同样可以挂载进 dsh **headless** profile（`dsh --profile headless "<task>"`——一次性、无 GUI/无端口模式）。安装路径完全一致，一条命令：

```sh
dsh plugin --profile headless add @mstar-harness/dsh
```

出厂 headless 模板在首次使用时自动初始化（`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-headless`），reconcile 步骤把 mstar 行追加进 bundle 层栈（`dsh-base → dsh-headless → @mstar-harness/dsh`）。插件的所有能力都落在 headless 继承的 `dsh-base` seam 上——status/dispatch/lease/worktree 闸门、技能挂载、engine-status catalog、harness-rules system-prompt 注入、7 个模型面工具——因此在一次性运行中 harness 完整生效。**必须从仓库工作目录启动**（runner 写入 `meta.cwd = process.cwd()`，按工作区的 harness 目录探测从这里开始）。浏览器客户端半体仅属于 web profile，headless 下自然不加载。

**Headless 使用注意事项**（已在 dsh 0.1.0-rc.6 上验证）：

- **一次性 turn 模型**——runner 把任务作为一条 user message 提交，agent 转入 idle（`whenIdle()`）后即退出；它**不会**等待 `run_in_background` 子任务。前台 subagent 派发可用（创建子会话、结果回到父会话）；后台 QC-tri 式并行在进程内不会完成——要么前台派发 QC 席（串行墙钟时间），要么让 agent 在结束 turn **之前**用 `tool-subagent-control` 收集完后台结果。
- **无交互通道**——`ask_user_question` 与审批提示 fail-closed（没有应答者）。无人值守运行用 `DSH_PERMISSION_MODE=danger-full-access`（sandbox `danger-full-access` + approval `never`）；交互式 Prepare 流程（grill-me）属于 web profile。
- **默认模型解析**——headless 不组合 fallbacks 行，因此 settings 里 `agent-default-model` 钉在 `FallbacksChain` 会以 `NO_ADAPTER` 失败（web profile 的产物）。把默认模型指向真实 provider，或同样把 `dsh-llm-fallbacks` 装进 headless profile（注意：已发布的 dsh 0.1.0-rc.6 上，fallbacks 的 settings 集成早于 `SettingsProvider.installSection` API，虚拟适配器不会注册——随 dsh ≥ 0.1.2-alpha 解决）。

### Configuration

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `harnessDir` | `string` | 仓库 `.mstarc` `[config] harness_dir`，否则按会话工作区探测（`.mstar/` → `.agents/` → `.plans/` → `plans/`，从会话工作区根目录开始——**绝不从启动 cwd**） | 显式 harness 根目录；优先于 engine 探测。**harness 根不在探测名列表中的仓库必须配置**；探测从会话工作区根开始（绝不从启动 cwd）并在那里**停止**——永不越过会话工作区向上，因此其上方的 harness 目录（如全局 `~/.mstar`）永远不会被采纳。 |
| `enforcement` | `'hard' \| 'soft'` | compass，否则仅告警 | 按部署覆盖。优先级：Config 优先；否则取 Assignment 自身的 `**Enforcement**: hard` 头字段（仅派发闸门）；否则取仓库 `.mstarc` `[config] enforcement`；否则取迭代 compass frontmatter；否则仅告警。Config / `.mstarc` `soft` 是仅有的本地回滚——Assignment 级 `soft` 不能覆盖 hard compass。 |
| `dispatchTools` | `string[]` | `['subagent', 'subagent_fork']` | 派发闸门匹配的委派工具名——dsh preset 的**两个**委派工具：`subagent` 及其 fork 兄弟 `subagent_fork`（两者都携带 Assignment 形态的 `{ description, prompt }` 参数；`toolName` 配置可重命名实例）。 |
| `dispatchBinding` | `string` | 未设置 → hard 下 fail-closed `empty-binding` | 派发方 agent 自身的 harness 角色（反递归 caller）；Assignment 的 `Execute as` 等于它即自我递归。 |
| `roleMap` | `Record<string, string>` | 未设置 | mstar 角色 id（`Execute as`）→ dsh-llm-fallbacks 角色 id。**仅**作日志与未来规则驱动互操作的分类桥——persona 通道从不读取它（见 LLM fallbacks integration）。 |
| `rolePersonas` | `Record<string, string>` | 未设置（打包镜像默认） | mstar 角色 id（`Execute as`）→ persona 文本；原生 subagent persona 通道的**覆盖**来源——角色匹配的 start（一次性 `start` 或可选的 continuable `startContinuable`）会把 persona 合入原生请求的 `persona` 槽（子会话体现角色 persona 而**非**部署 persona；持久化并在 resume 时重放）。合并次序：请求自身已携带 `persona` 时**原样生效**（调用方意图绝不被覆盖——不做角色合并）；否则非空条目优先于打包的 `harness-agents/` 镜像默认值，**空字符串**条目视为未设置并回落到镜像默认值，无条目时使用镜像默认值（见 LLM fallbacks integration）。 |
| `skillRoots` | `string[]` | 未设置（不注册自定义根） | 向 dsh skill-filesystem 提供者注册的额外技能根（`customSkillDirs` 语义——先于用户根扫描）。开发期：镜像 `<repo-root>/skills` 的绝对路径。 |
| `bundledSkillDir` | `string` | 打包的 `harness-skills/` 镜像（包相对路径） | 向 dsh skill-filesystem 提供者注册的打包技能根（`bundledSkillDir` 语义——最后扫描、受信任）。默认取包内自带的 `harness-skills/` 镜像（`bundle-assets` 同步；gitignore）——包相对路径，**非** cwd 锚定。显式值优先。 |
| `catalogTtlMs` | `number` | `60000` | pre-step catalog 缓存刷新间隔（毫秒）：按工作区缓存的统一 `mstar-engine` 行（水印 + 迭代闸门 + 工作区摘要）多久重读一次 `status.json` / compass / 知识索引。刷新间隔之间热路径只是时间戳比较 + Map 命中；会话中 plan/compass/residual 的变化会在一个间隔内落地。 |
| `workflowGate` | `'off' \| 'warn' \| 'ask' \| 'hard'` | `'warn'` | workflow/ralph 闸门模式（见 Gates → Workflow / ralph gate）。`off` = 直通且不产生 verdict 行；`warn` = 仅咨询；`ask` = 首见名字走审批瀑布（P-c）；`hard` = 策略违规在任何子进程启动前否决。默认 `warn` 不改任何 hard 行为——除非部署显式选入 `ask`/`hard`，闸门仅咨询。 |
| `workflowNames` | `string[]` | 未设置 | workflow 名字白名单（P-a）：被闸门视为 KNOWN 的 `meta.name` 值。为空或缺省 ⇒ **每个**名字都 unknown（有文档——闸门**绝不**因缺省而"全放行"）。ralph 调用不携带 `meta.name`——P-a 对其永不适用。mstar 只读扇出路径推荐值：`['mstar-qc-tri', 'mstar-audit-fanout', 'mstar-pr-seats']`。 |

**推荐的 operator 覆盖层。** 上表三个推荐 `workflowNames` 覆盖 mstar 只读扇出路径（plan QC tri、大型仓库 `/codebase-audit`、`/amazing-pr-review deep`）；写入它们是 profile 层的操作者覆盖，绝非 mstar 默认。出厂空列表下每个名字都是 *unknown*，在默认 `workflowGate: 'warn'` 下这只是运行会存活的一条 `workflow.name.unknown` 咨询。生产部署若还要否决 unknown 名字，可设置 `workflowGate: 'hard'`；出厂默认仍为 `'warn'`。

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

- **状态闸门**——`fs/write-intent` + `fs/edit-intent` 监听器校验 v3 协调文档目标集——v2 根 `{HARNESS_DIR}/status.json`、`workflows/<id>/snapshot.json` 与 `projects/<id>/residuals.json`——各自使用匹配的 engine 校验器（`validateStatus` = v2 根 / `validateWorkflowSnapshot` / `validateProjectRegister`，即 P2 修复的 `harnessDocKindOfTarget` 形态），外加快照目标的 `findingsCleanupGate` 扩展（按配置模式的计划行，从项目注册表读取残留）。
- **派发闸门**——`tools/pre-execute` 监听器作用于委派工具，通过 engine 的单一 `composeDispatchGate` 组合（字段闸门、反递归预检、默认分支闸门——与 opencode/omp/CLI 对齐，违规码按构造即相同）校验 subagent Assignment 文本，外加 dsh 租约闸门与 worktree L1/L2 检查。
- **技能撰写 lint**——已配置技能根下的 `SKILL.md` 写入运行 engine 技能撰写 lint（`lintFrontmatter` + `lintFiveQuestion`）。
- **seam lint**——harness 下 `DESIGN.md` / audit plan / 知识文档 / roles 目录的写入运行各自的 artifact 级 engine lint。
- **模型可见工具**——`mstar_sdd_workspace`、`mstar_sdd_task_brief`、`mstar_iteration_gate`、`mstar_design_md_validate`、`mstar_audit_validate`、`mstar_compound_validate`、`mstar_roles_validate` 注册到 `ctx.tools`。`mstar_iteration_gate` 镜像改用 v3 输入 `snapshot_path`（`{HARNESS_DIR}/workflows/<id>/snapshot.json`——镜像 `mstar iteration gate --workflow <id>`；旧的根 `status_path` 输入随 v1 读取路径移除）。
- **bundled 命令**——向 `ctx.commands` 注册 `/iteration-start`、`/iteration-drive`、`/iteration-loop`、`/codebase-audit`（来自打包的 `harness-commands/` 镜像；每条声明 frontmatter `input` hint，使 web 客户端 claim `/name ` 并等待用户后续输入而非立即执行；handler 把命令正文 + 用户输入 steer 进接收 agent）。
- **pre-step catalog 行**——每个组合后的 agent 步骤都会追加**一条**统一的 `mstar-engine` catalog 消息：水印（统一 mstar 版本、harness 目录、enforcement）、迭代相位闸门段（解析到 steering compass 时）与工作区状态摘要段（工作区有 `status.json` 时：plan 注册表、open residual、分支/政策锚点、活跃 lease、知识摘要、compass 方向）。该行是 digest 门控的（每 turn 注入一次、变化时才重发），并共享一次按工作区 TTL 缓存的构建（`catalogTtlMs`，默认 60 秒）。

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

### Workflow / ralph gate

`tools/pre-execute` 的一个分支（位于 subagent prompt 分支**之前**）把关 **`workflow`** 与 **`ralph`** 工具调用——这是剩余的不携带 Assignment 文本、模型可达的扇出路径。它匹配**固定**工具名（`workflow` / `ralph`）；重命名后的 `workflow` 实例不在范围（名字守卫是固定默认）。非 workflow 工具不受影响——subagent 分支照旧拥有它们，语义不变。

**四级模式**（Config `workflowGate`，默认 `warn`）：`off`（直通，无 verdict 行）、`warn`（仅咨询）、`ask`（首见名字走 dsh 审批瀑布——`{kind:'ask'}`，上游 fail-closed；本闸门不自造应答器）、`hard`（策略违规在任何子进程启动前否决）。策略是**单一**决策点——P-b 租约归属**最先**运行并抢占 P-a/P-c，然后才是 P-a 名字白名单，最后 P-c 首见 ask。

| 策略 | `off` | `warn`（默认） | `ask` | `hard` |
| --- | --- | --- | --- | --- |
| **P-b**：调用工作区存在 `InProgress` 且无 `execution_lease` 覆盖的 plan | allow（闸门短路 `off`） | **warn**——放行 + 咨询（`workflow.lease.uncovered`）+ 一条 warn | **warn**——放行 + 咨询 + 一条 warn（ask 通道只服务首见**名字**，绝不替代工作区红线） | **deny**——在任何子进程启动前否决（`workflow.lease.uncovered`），reason 引用 plan id |
| **P-a**：workflow 名字 ∈ `workflowNames`（非空列表） | allow（短路） | allow——无咨询（P-a 在任何模式下都放行） | allow——无 ask | allow |
| **P-a**：workflow 名字 unknown（空/缺省列表 ⇒ **每个**名字都 unknown） | allow（短路） | **warn**——放行 + 咨询（`workflow.name.unknown`）+ 一条 warn | **ask**（首见）→ `{kind:'ask'}`；之后复用缓存决策（allow/deny）——已解析名字**绝不**再 ask | **deny**——在任何子进程启动前否决（`workflow.name.unknown`），reason 点名该名字 |
| **ralph**（无 `meta.name`——无白名单身份） | allow（短路） | allow——P-a/P-c 永不适用 | allow——P-a/P-c 永不适用 | allow——P-a/P-c 永不适用；P-b 仍适用（uncovered 时 deny） |

**默认 `warn` 的理由。** 默认 `warn` 使闸门**绝不**让部署意外吃硬阻断：除非操作者显式选入 `ask`（人工 ask 通道）或 `hard`（否决），闸门仅咨询。`workflowNames` 空/缺省使每个名字都 unknown——闸门**绝不**因缺省而"全放行"，但默认模式把这一点变成咨询而非阻断。

**与 `Enforcement: hard` 的交互。** workflow 闸门的模式是它**自己**的 Config 旋钮——跨切面的 `Enforcement: hard` 解析（compass / Assignment 头字段 / Config `enforcement`）**不会**升级 `workflowGate`。hard-enforcement 部署仍按已配置模式运行 workflow 闸门（默认 `warn` = 仅咨询），除非同时设置 `workflowGate: 'ask'` 或 `'hard'`；反之 `workflowGate: 'hard'` 与跨切面解析无关地否决。二者不可混淆：workflow 闸门**只在部署把模式选入**时才关闭 "Enforcement: hard 下的未把关扇出" 缺口。

**Fail-open 边缘（有文档，绝不崩溃合规调用）。**（1）畸形参数——`workflow` 调用缺少非空字符串 `meta.name`（控制字符归一化之后），或 `ralph` 调用缺少字符串 `objective` → 在**每个**模式下（hard 亦然）直通 + 一条 warn，且**无** verdict 行（未产生策略判定）。只含控制字符的名字归一化为空 → 视为畸形。（2）`status.json` 不可读——经含容解析器路径的 P-b 状态读取抛出 → 仅本次调用的 P-b 降级 + 一条 warn；P-a/P-c（基于名字，无状态依赖）照常运行。闸门**从不抛出**：每次读取都是结构化的。

**Verdict 账本行。** 每个被把关的调用都在 agent-flow 账本记录**一条**持久化 `workflow-verdict` 行（P2 账本 plan 的记录路径，完全含容——账本写入失败绝不波及闸门）：`tool`（`workflow` \| `ralph`）、`workflow`（归一化后的 `meta.name`）或 `objective`、`mode`（绝不为 `off`——off 在策略前短路）、判定词汇 **`ok` / `advisory` / `denied` / `ask`**（`ask` 判定是本次扩展：首见 ask 本身也是被把关的调用，其行携带 `ask` 直到审批瀑布解析——"每次被把关的调用一行"）。违规码来自判定、绝不猜测：`workflow.name.unknown`（P-a）vs `workflow.lease.uncovered`（P-b）。fail-open 路径（畸形参数 / 状态不可读）不记录；未解析出 harness 目录的调用跳过该行（与派发记录路径相同的静默 no-op）。

**P-c 答案观测 seam。** 闸门无法观测 ask 结果——工具注册表的 `serviceAsk` 在内部消费审批结果。**run-start 观测就是答案 seam**：被 ALLOW 的 ask 执行调用 → 持久化 `tool-workflow/run-start` 会话事件落入父会话日志 → workflow-ledger 消费者记录 W-B2 `workflow-run` 行**并**把 `allow` 按运行名缓存进 apply 作用域的 `WorkflowAskCache`。被 DENY 的答案不产生运行 → 无观测 → `ask` 模式下下一次同名调用**重新 ask**（fail-closed——无授权证据，绝不发明 allow）。缓存键在两个 seam 都是**归一化**（剥离 ASCII 控制字符）**不截断**的名字——闸门合成 `meta.name` 与观测记录 `runName` 都走同一个 `normalizeWorkflowName`，因此含控制字符的名字（`au\u0000dit`）永远无法卡死缓存（ask 一次、同一键观测），>1024 字符的名字仍以完整名字为键（账本行的展示名字单独截断；身份轴从不截断）。缓存是 apply 作用域的——新 apply（HMR 重载）从空开始，因此未解析的首见名字每次调用都会重新 ask，直到一次观测（或显式 `record()`）落地。缓存记录抛错时观测降级为一条 warn——账本行已追加，运行不受影响。

**P-b 抢占。** 租约红线最先运行：调用工作区存在 uncovered 的 `InProgress` plan 意味着在 plan 恢复前**不应**启动任何可写扇出子进程——与 workflow 名字无关（与 Assignment 键控的租约闸门同一条红线），对 ralph 同样适用。`warn`/`ask` 下仅咨询（放行 + 一条 warn）；ask 通道绝不替代工作区红线。

## LLM fallbacks integration

可选的 `dsh-llm-fallbacks` 插件（以第二条命令安装——见 Install paths）驱动**基于角色的 subagent 配置**——角色种子与采纳建议；角色 persona 交付本身走 dsh 原生 subagent persona 通道（与 fallbacks 无关，见下文）。mstar 插件对该包携带**零运行时与零类型引用**——`src/` 无任何导入（运行时或类型）；被消费的服务面由 `src/gates/fallbacks-structural.ts` 的本地结构类型镜像，该包仅是 mstar 插件的**开发期依赖**（类型镜像 + 真实包测试 harness）。`dist/` 仅在 1 处字符串字面量中命名该包——探测的 loader 条目匹配——绝非导入或类型引用；互操作是决策点**能力探测**，绝不读取其他插件的模块内部。

### 能力探测

挂载状态的两个视图（决策点即时读取，无缓存——loader 并发挂载条目）：

- `fallbacksService(ctx)`——插件被 apply 期间命名的 cordis 服务（`ctx.get('llm-fallbacks')`）；HMR/纤程切换窗口内即使 loader 条目仍在，服务也为 `undefined`（条目是声明式的，比纤程活得久）。
- `fallbacksMounted(ctx)`——能力视图，**服务优先 + loader 条目回退**：名为 `dsh-llm-fallbacks` 的 loader 条目存在、启用（尊重 `entry.disabled` 与 group 行）且纤程存活。

状态区分：**mounted**（服务已 apply——完整能力）、**unmounted**（无条目：未安装 fallbacks 插件——mstar 能力降级，绝不中断）、**disabled**（条目存在但禁用/分组——能力关闭），以及 HMR 窗口（条目在、服务缺——loader 回退覆盖）。

### 角色 persona 交付（原生 subagent persona 通道）

persona 交付走 dsh 原生的 `SubagentStartRequest.persona` 槽（`@deepseek-ai/dsh-subagent`）：插件经 cordis `internal/get` waterfall——框架文档化的服务读取拦截钩子——拦截 `ctx.subagents` 的服务读取并包装运行时值，使角色匹配的 start 在子会话组装之前把 persona 合入请求——**同时覆盖两个启动面**：一次性 `start` 与可选的 continuable `startContinuable`（tool-subagent `backgroundMode: 'continuable'`；其 `ContinuableStartSpec.request` 携带同一个 `persona` 槽）。底层 `SubagentRuntime` 对象绝不被改动（无 monkey-patching），包装监听器归 apply fiber 所有（HMR 重挂载会先卸载再恢复，并重新绑定新 Config）。原生语义：请求 persona 会以作用域化的 `deployment:persona` 段（order 0）注册到子会话上，对该子会话**遮蔽**部署 persona——子会话**体现**角色 persona 而非与其共存——并持久化进子会话描述符、在 resume 时重放。角色身份使用与派发闸门相同的 engine Assignment 头语法。persona 查找是单一 `personaFor` 链——`rolePersonas[executeAs]` → 打包镜像默认 → 跳过——**从不以 `roleMap` 或 fallbacks 挂载状态为前提**（persona 交付与 fallbacks 无关）。显式的请求 persona（tool-subagent 自身的 `Config.persona`）优先于角色 persona——绝不覆盖调用方意图。

**能力闸门（按启动面）**：一次性 `SubagentRuntime.start` 会对不具备原生 `persona` 能力的提供者直接拒绝 persona 请求（fail loud、绝不静默降级——进程外提供者即无此能力），因此该启动面通道先检查 `getProvider(name).capabilities.persona`。continuable 启动面改按**原生 continuable 契约**闸门——`SubagentCapabilities` 文档仅限一次性路径，continuable 子会话由延续管理器自行组装、以 `provider.prepareContinuable` 为闸门；通道检查该字段，对不支持 continuable 的提供者跳过合并（原生 start 会自行 fail loud——绝不会在会被拒绝的 start 上把 persona 记为已交付）。两种情况都以一条受控 debug 日志跳过合并、启动原样继续——通道绝不因此使派发失败。

**零配置默认值**：当 `rolePersonas` 未为某角色配置条目时，persona 取自打包的 `harness-agents/` 镜像——构建时由 `bundle-assets` 从仓库根 `agents/` 同步（随发布 tarball 携带；包相对路径解析，任意启动 cwd 均可用）。镜像文件名主干即角色 id；默认值为其 frontmatter `description` 块标量。镜像 shell 在 frontmatter `mode` 缺失或为 `subagent` 时才有资格——`primary` shell（`project-manager`）绝不作为 subagent persona 默认值。默认值 description 若含插值风险（配对的 `{{`/`}}`）则在提取时告警并跳过（绝非启动抛错）；shell 改动（mtime 变化）会在下一次决策点读取时重新提取。镜像缺失（未运行 `bundle-assets`）时查找仅走配置，配置也未命中时每次 apply 记一条 debug。

**Seam 探针（fail-loud）**：通道每次 apply 对 cordis `internal/get` seam 探测一次（临时 canary 监听器 + 一次受控代理式 `ctx.subagents` 读取——绝不 `ctx.get`）；seam 缺失或未被识别时记录恰一条 warn——`role persona channel not installed — cordis 'internal/get' seam missing or unrecognized (rolePersonas will not be merged into subagent starts)` + ` (reason: seam-absent | wrap-skipped)`——而非静默失败。健康 boot 不产生任何 warn（锁定的判定表）：在今天的组合形态下 apply ctx 不解析 `subagents`，因此每次 apply 发出一条无 warn 的 `service-absent` debug——cordis 在 dispatch 作用域解析该服务，读取在那时逐次被拦截；探针内部错误按 fail-open 降级（一条 debug）。`wrap-skipped` 已被钉死但无法从当前发布的 apply 布线触达——它只在 apply 时即可解析 `subagents` 的场景触发，该路径由 harness pins 覆盖。seam 名由专用探针家族 `tests/persona-seam-probe.spec.ts` 钉死（经导出的 `PERSONA_SEAM_EVENT` 常量）；安装产物断言在携带探针的版本发布后自动启用（`tests/install-e2e.spec.ts` 的 surface-vintage guard）。

### 角色 seeds 与采纳建议（Adoption advisory）

当可选的 `dsh-llm-fallbacks` 能力**已挂载**（第二条安装命令——见 Install paths）时，mstar 插件会向 fallbacks seed registry **零配置声明 13 个 `mode: subagent` mstar 角色 seed**：persona = `harness-agents/` 镜像 `description`（原样）+ 一行强制加载引导（`Load mstar-roles (references/<role-id>.md) first — identity comes before skills; load topic skills only when the Assignment activates them via its Skill presets field.`）；含 `{{...}}` 插值风险的 persona 跳过并告警，绝不声明。声明会**合并保留 readback 中当前已 seeded 的非 mstar id**——例如上游包在其自身 apply 时自声明的 5 个上游 preset 角色：上游 `declare` **全量替换** registry，若不保留，mstar-only 批会摘掉 preset id 的 seeded 注记（行仍在，仅失去 seeded）。声明在每次 fallbacks（重新）apply（HMR/纤程切换）时幂等重放——绝不用一次性 latch——因此两种 boot 顺序（presets 先或 mstar 先）都收敛到同一 18-id 全 seeded registry。boot 时收敛经 bounded retry（有界重试）：上游的 seed 写通道在其 apply 之后一个 macrotask 才绑定，因此 apply 窗口内首次尝试被 `seeds: settings service is unavailable` 拒绝时会重试（跨上游 apply 窗口的 3 次尝试），暂时性拒绝自行收敛；仅当所有尝试最终失败时，声明才记录恰好一条终态错误，同时 advisory 的决策点 re-declare 仍可用作 retry 路径。**无需手动编辑 `roles.list`。**

一条只告警的采纳建议通道（日志器 `mstar/fallbacks-advisory`）**每次 apply 只跑一遍**——apply 时先尝试一次；当 fallbacks 行在 `dsh` 之后挂载（loader 并发挂载条目）时，改在首个 `subagent/start` 决策点只跑一遍。服务存在时，通道**先 await 幂等 re-declare**（闭合 boot 竞争窗口）再读取**有效状态**（`getEffectiveRoles`），并按**每类至多一条告警**有界报告：

- **缺失 mstar 角色**——无有效行的 mstar id（一条告警列出全部；id 集合派生自 `harness-agents/` 镜像——绝不硬编码；无镜像 → 检查跳过并记一条 debug）；
- **persona 覆盖**——行 persona 与 seed 默认值不同的 mstar 角色（一条告警点名 + revert 入口：`fallbacks/revert-seed` gateway / fallbacks 设置卡片回滚按钮——操作者覆盖在 revert 前保留）；
- **空 persona**——`persona` 缺失/空白的行，仅限非 seeded 或 overridden-empty（一条告警点名）；
- **遗留键**——`chains`、`roles.default`、`roles.list[].label`/`.description`、悬空 `roles.rules[].role` 引用，经已应用服务自带的 `detectLegacyKeys`（一条告警引用其语义）；
- **declare 跳过/冲突**——本地跳过（`interpolation` / `no-persona`）+ 上游跳过/冲突（码 `persona-source`——操作者覆盖保留）合并为**一条**告警；默认已 seeded 静默（一条 debug 点名）。

loader 回退路径（无服务）保留结构化 `roles.list` 读取（缺失 id / 空 persona；无 revert 入口——无 seeds 面；遗留键检查跳过——绝不重新实现）。行配置缺失或非对象、或 `roles.list` 不可读 → 跳过并记一条 debug。该建议**绝不写入** fallbacks 配置——唯一写路径是经已发布 seeds 面的幂等 seeds re-declare（无差异 → 上游零设置写入）——绝不抛出，且 **fallbacks 未挂载时不调用**：它是信号，不是闸门。

### 配置面

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `roleMap` | `Record<string, string>` | 未设置 | mstar 角色 id → fallbacks 角色 id。**仅**作日志与未来规则驱动互操作的分类桥——persona 通道按设计不使用（persona 交付以 `rolePersonas`/镜像为源）。 |
| `rolePersonas` | `Record<string, string>` | 未设置（打包镜像默认） | mstar 角色 id → persona 文本；persona 通道的**覆盖**来源——某角色无条目时使用镜像默认值。 |

## Service

`apply` 构造 `ctx.dshMstar`（engine 支撑：`validateStatus`、`validateResidual`、`findingsCleanupGate`、`resolveCompassEnforcement`、`resolveHarnessDir`、`readHarnessVersion`、`applyEnforcement`）。分层：P1 各闸门是本包内与 engine 同置的包装器，直接导入 engine（同一插件，构建时打包 engine）；`ctx.dshMstar` 是供 inject 消费者使用的组合/测试外观；宿主适配器（下节）是面向宿主的门面。两条路径共用 engine 这唯一语法源。伴随入口 `@mstar-harness/dsh/invariant` 以文档化的空安装器保留包所有权。

## Host adapter

插件以 `DshHostAdapter` 实现 engine `HostAdapter` 契约（`host: 'dsh'`），并以 `ctx.dshHostAdapter` 服务暴露。检测：engine `detectHost` 将 dsh 委派工具名——`ToolSignal` **`subagent`**（模型可见的 dsh subagent 工具）——映射为 `'dsh'`，在 omp 之后、kimi/zcode/codex 之前求值；混合会话按固定顺序让位于更早的行。适配器与插件内闸门共用同一套校验核心（单一代码路径）：`beforeStatusWrite(path, doc)` 在宿主提供文档时校验传入文档，否则走磁盘文档回退（文件缺失 = 首次创建 = 放行）；`beforeDispatch(assignment)` 运行字段 + 分支 + 反递归闸门并携带强制执行后的 `hardBlocked` 判定（租约闸门留在监听器侧——它绑定该钩子不携带的 ToolExecution 会话上下文）；`beforeMerge(lease)` 是 engine `validateIntegrationMergeLease` 的薄包装（向 `status.json` 的预留写入是 P3 seam）。`log` 默认路由到 dsh ctx 日志器 `mstar/host-adapter`。

dsh 的冻结技能根形态（engine `resolveSkillRoot('dsh', …)`）为 **`$DSH_BUNDLED_SKILL_DIR/<name>[/<rel>]`**——解析器只定义技能相对路径解析器（`resolveAssetPath`）所用的规范形态；它**不**挂载目录。挂载由插件负责（下一节）。

## Skills mount

mstar 技能通过 dsh skill-filesystem 提供者以**单一规范挂载**接入：插件把配置的根注册为**一个**提供者（`providerName: 'mstar'`、`includeDefaultRoots: false`——隔离，绝不看到宿主应用自身的项目/用户技能），上文的 engine 形态是共享的技能根契约。两条 Config 路径填充它：

| 路径 | 机制 | 时机 |
| --- | --- | --- |
| Bundled 默认 | `bundledSkillDir` 默认取包内自带的 `harness-skills/` 镜像——仓库根 `skills/`（19 个 `mstar-*` + `pm`）由 `bundle-assets` 在构建时同步（gitignore），按**包相对路径**解析（非 cwd 锚定——任意启动 cwd 都可用） | 发布包 / 无覆盖的任何部署 |
| 自定义根 | `skillRoots` / 显式 `bundledSkillDir` → skill-filesystem `customSkillDirs` / `bundledSkillDir` 条目（显式值优先） | 本地开发 / 测试 / 使用不同镜像的部署 |

打包镜像是**单一规范挂载**：技能内容只在仓库根 `skills/` 镜像中存一份并同步进包（与 opencode 的 `harness-skills/` 相同），mstar 技能在任何地方都保持可独立使用。不重复加载：opencode 插件在自己的包里携带同一批技能，因此 dsh 只能通过这条 skill-filesystem 路径挂载它们。

开发期现实：`@deepseek-ai/dsh-skill-filesystem` 运行时是 peer stub（契约镜像的注册，无文件 watcher），因此挂载通过真实组合（stub + 实际镜像 `skills/` 的 frontmatter，用 engine `lintSkillFrontmatter` 校验）验证；真实运行时组合（真实 seam 包、watcher、`$DSH_BUNDLED_SKILL_DIR` 环境变量流）是部署目标，不在本包测试套件覆盖内。

## Commands

插件把 bundled 的 mstar 命令（omp/opencode 对齐面）注册到 `ctx.commands`：`harness-commands/*.md`——仓库根 `commands/` 镜像（`iteration-start`、`iteration-drive`、`iteration-loop`、`codebase-audit`）由 `bundle-assets` 在构建时同步（gitignore）。每条注册读取命令的 `name`/`description`/`input` frontmatter；声明了 `input` hint 的注册会将其作为 `input.hint` 公布，使 dsh web 客户端的决策表从「脱离式裸执行」翻转为 leadingInput **claim**——菜单点选后把 `/name ` 插入输入框（命令色 token + ghost hint），按 Enter 才提交，用户可以键入后续参数（与 `/plan`、`/goal`、`/advisor` 相同的交互）。handler 把**命令正文以 USER source 消息 steer 进接收 agent**（dsh-plan-mode 命令先例——`source: { kind: 'user' }`，模型把正文当作要执行的任务而非注入上下文；即 dsh-commands 的「经接收 Agent 显式调度模型可见工作」路径），用户键入的参数以 `## User input` 小节追加在正文后，返回成功结果。注册以 `ctx.inject(['commands'], …)` 延迟进行——与工具注册相同的可选单元模式——插件在无 commands 服务时也能启动；镜像缺失（未跑 `bundle-assets`）则不注册任何命令。

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
| agent catalog | 一方 `plugin` catalog source（锚点）+ `/api/mstar/engineStatus` 快照读取（模型可见 ⟺ 已记录） | 已交付（P2） |
| sdd（sddWorkspace、taskBrief） | 注册在 `ctx.tools` 上的 `defineTool` 包装 | 已交付（P3） |
| iteration（evaluatePhaseGate、parseCompassFrontmatter） | `agent/pre-step` + iteration 闸门 | 已交付（P3） |
| worktree（l1PreDispatchCheck、l2PreDispatchCheck） | `tools/pre-execute` L1/L2（派发闸门内） | 已交付（P3） |
| design-md / audit / compound / roles | `fs/write-intent` + 注册在 `ctx.tools` 上的 `defineTool` 包装 | 已交付（P3） |

## Engine-status catalog

一个咨询式 `agent/pre-step` 瀑布监听器向每个组合后的步骤追加**一条** **`mstar-engine`** catalog MessageSource——一方 `plugin` 臂，即恰好 `{ kind: 'plugin', plugin: 'mstar-engine', form: 'catalog' }`、**不含任何其它成员**（镜像 dsh tool-skill 先例）：模型可见的 `<mstar_engine_status>` 块渲染水印字段——**mstar 版本**（插件自身清单；单一版本不变量把打包的 engine 钉在同一版本）、**harness 目录**（解析后的 `{HARNESS_DIR}`，缺失为 `none`）、**enforcement**（compass 模式，`soft` / `hard (compass)`）——以及 **迭代相位闸门段**（当 steering compass + `status.json` 可解析时：迭代 id、transition、all-plans-done、闸门判定 + 违规码——即 `mstar iteration gate` 工具结果形态）与 **工作区状态摘要段**（当工作区有 `status.json` 时）：**plans**（`id(status)` 注册表）、**residuals**（按 severity 的 open 计数）、**branch**（base → target、spec 集成）、**policy**（push 政策、worktree 模式、control 根）、**leases**（活跃 plan 执行租约：持有者 + worktree）、**knowledge**（知识索引文档数与分类）与 **direction**（steering compass 的 problem statement 一句话）。监听器先调用 `next()` 并基于委托后的决策追加——从不否决步骤、从不替换已组合的消息。模型可见 ⟺ 已记录：持久化的 source 不携带任何事实——该行是持久化的**锚点**，其**实际发出**的 payload 在同一次 digest 门控发射时按会话快照到 `{HARNESS_DIR}/snapshots/engine-status.json`，因此「会话日志 + 该存储」无需重新解析该块即可重建该行（dsh packages/AGENTS.md）。任何已发布的会话格式边界都不接受 message source 上的多余成员，故 `source` 上永远只写 `plugin` 臂。**锚点标识（更名，带读兼容）**：发出的 `plugin` 值为 `mstar-engine`（原 `mstar-engine-status`）；更名前已发布构建发出的行在已写入的会话日志中持久化旧标识，面板的锚点读取方把 `mstar-engine` 与 `mstar-engine-status` **都**视作本插件的一方臂——任何其它 `plugin` 值都不是锚点，会话降级为显式 `waiting` 态（绝不猜测数据）。工作流面板通过宿主共享的 `/api` typert 网关按需读取该快照：**路由由宿主网关持有**（插件无法注册路由；`connection.rpc.handle` 的普通信道会经由调用 fiber 上的 `webServer` 挂载、并使本行的 boot 挂起——本包刻意不走该机制），本包只经可选 `ctx.typert.register(...)` 子单元贡献 `mstar/engineStatus` 端点描述符。浏览器半体调用 `connection.rpc.call('/api', 'mstar/engineStatus', { args: { sessionId, cwd } })`，得到该会话自己的已存快照，或带原因的显式 `unavailable`（绝不返回其它会话的数据、绝不静默空字段）。**信任边界，如实说明：**该端点自身不做任何鉴权——传输层围栏（host/origin + 浏览器鉴权）只证明调用方是本宿主自己服务的页面，因此*持有 `(sessionId, cwd)` 组合 + 能访问本机 `/api` 网关即为能力*。应答按**请求**限定：查询以被断言的 id 为键，存储记录的 `cwd` 必须同时等于断言值与服务端解析出的会话 `cwd`，客户端在渲染前还会复核回显的 id 与工作区——因此一个会话的请求绝不会被返回另一个会话的记录。payload 是工作区摘要（版本、harness 目录、enforcement、plan/residual/lease 计数），面板自身的会话记录本就暴露这些信息；它不被当作机密，而不同的 `unavailable` 原因会让该端点对已持有 id 的调用方成为一个弱的「会话是否存在」探针。fiber 销毁即移除监听器（HMR 安全）。

该行是 **digest 门控**的：按 agent+workspace，每个 turn 只注入一次，仅当渲染文本变化时重新注入——20 步的 turn 只显示一次 catalog，而不是 20 次。source 共享**同一**按工作区缓存条目：显式 `harnessDir` 时在 boot 构建（否则在工作区首次 pre-step 构建），并按 TTL 刷新（`catalogTtlMs`，默认 60 秒）——刷新间隔之间热路径只是时间戳比较 + Map 命中，会话中 plan/compass/residual 的变化在一个间隔内落地。

## Agent-flow ledger（workflow 行）

agent-flow 账本——`{HARNESS_DIR}/agent-flow.jsonl`，即 catalog 的 `state.agentFlow` 证据所读的同一 JSONL——同样记录 **workflow / ralph 扇出运行**：一个会话事件消费者（日志器 `mstar/workflow-ledger`，apply 时注册）把四个持久化的 `tool-workflow/*` 会话事件映射为三种新账本类型。事实来源是**持久化会话事件**——追加进**调用方父会话**的日志（仅顶层运行；嵌套 transport 调用上游不记录任何东西），而**不是**内存中的 `workflow/*` emits（roadmap §10.4 N4）：会话日志才是可回放的事实，因此消费者以 **apply 时冷扫描**（构造期种子事件从不进 firehose——`firstLiveSeq`）加实时 **`session/event` firehose** 监听覆盖它，按**持久化逐会话水位线**（会话日志 `seq` 位置）去重——水位线持久化到 `{HARNESS_DIR}/workflow-ledger-cursors.json`（账本旁的小型有界 sidecar，temp 文件 + rename 原子写入）。

| `tool-workflow/*` 事件 | 账本行 | 字段 |
| --- | --- | --- |
| `run-start` | `workflow-run` | `runId`、`name`、`agent?`（承载的父会话 id） |
| `agent-start` | `workflow-agent` | `runId`、`seq`（1 起始的成员序号）、`label`、`phase?`、`childId` |
| `run-end` | `workflow-run-end` | `runId`、`stopReason`（`completed` / `cancelled` / `error`） |

`tool-workflow/agent-end` 是上游成员簿记，**没有账本类型**（成员 `outcome` 有意不持久化），被过滤掉。可选字段（`agent` / `phase`）缺席时从序列化行省略（lossless-JSON 纪律）；三种类型共用账本的 `AGENT_FLOW_MAX_EVENTS` 截断 + 大小门禁，畸形行读取时收敛为 `undefined`（绝不重序列化）。展示字段（`name` / `label` / `phase`）在边界确定性限长（`WORKFLOW_LEDGER_MAX_NAME_LENGTH` 1024、`WORKFLOW_LEDGER_MAX_LABEL_LENGTH` 512——超长值以 `…` 标记截断）；id 尺寸字段（`runId` / `childId`，上限 512）超长时**整行跳过**——绝不截断成碰撞。

**第四种类型 `workflow-verdict`** 由 workflow/ralph 闸门（而非本消费者）写入——每个被把关的调用一行（`tool`、`workflow`/`objective`、`mode`、判定 `ok`/`advisory`/`denied`/`ask`、违规 `code`）——见 Gates → Workflow / ralph gate。展示身份字段（`workflow` / `objective`）同样带 1024 字符上限；判定的违规码绝不猜测（P-a `workflow.name.unknown` vs P-b `workflow.lease.uncovered`）。

**去重与回放范围。** 持久化水位线即去重机制：**冷热重叠**以及**插件重应用/重启**（重注册读取持久化水位线而非从空游标开始）下每个 `(runId, kind, seq)` 只产一行。**apply 之后创建**、带构造期种子日志（恢复/分叉会话——其种子从不进 firehose）的会话会在上游 `session/created` 事件上**冷扫描一次**，水位线同样保证该回填幂等。**分叉**会话的扫描从其 `inheritedEventCount` 开始：继承来的前缀属于父会话的历史，因此子会话只记录**自己**的事件——绝不会把父会话的行以子会话身份再记一份。水位线 sidecar 有界（每 harness 会话数上限，驱逐优先已不在线的会话）且完全受控：水位线不可读/不可写时降级为仅内存并告警一次——重启后会重录（诚实的去重欠录，绝不丢数据、绝不阻塞）。

**childId 关联 + 成员计数。** `workflow-agent` 行保留已发布成员的 `childId`（子会话 id）；运行的展示 `name` 只存在于 `workflow-run` 行，面板为 agent/end 行经窗口查找解析（同一 `runId`——成员行本身不带名称）。面板把成员 COUNT 挂到 `workflow-run` 行（窗口内该 `runId` 的 `workflow-agent` 行数；窗口有界——被 ≤50 事件窗口截掉的成员如实缺席，绝不猜 0）。

**深度咨询（观察时）。** `agent-start` 时，消费者经 `sessions.get(childId)` 解析子会话，当其 `header.delegationDepth` ≥ 2 时告警——每个运行**至多一次**（per-runId 闩锁），日志器 `mstar/workflow-ledger`。仅观察时，**绝不是拒绝通道**：子会话读取抛出只降级咨询本身，绝不影响行或运行。

**零行为变更保证。** 消费者仅观察：**零门禁**——每次读取与追加都 try/catch 包裹；账本写入失败绝不崩溃或改变 workflow 运行；会话读取抛出只记一条 warn 并继续。`sessions` 服务经 `ctx.get('sessions')` **结构化**读取——对 `@deepseek-ai/dsh-session` 无运行时依赖。

**挂载顺序说明。** 消费者只在 apply 时 `sessions` 服务可用时激活——**dsh-session 行必须先于 mstar 行挂载**（标准 `web` profile 顺序即如此）。dsh-session 后于插件挂载（或缺失）的组合**静默**降级：一条 debug 日志（`sessions service absent — workflow-ledger consumer disabled`）且不记录任何行——绝不是错误，绝不是运行损坏。

**面板可见性。** 三种 workflow 行经现有事件行样式（无重设计）渲染在 **事件记录（Event Log）tab** 的 Agent 流转事件分区：摘要身份是运行 NAME（agent/end 行经窗口查找解析；回退 runId → 「未知」），详情体新增四个 workflow 字段——run-id / name / members / stop-reason（缺失 → 「—」）——expected/settled 席位渲染「—」（workflow 行不是角色派发——不存在 settle 配对，与 settle 行同先例）。未知 kind 字符串渲染为**通用行**（kind 原文、无 workflow 字段）——绝不丢弃、绝不猜测。catalog 摘要把 workflow 行计为**独立** `workflow` 桶（模型行 `by role: workflow N`）——绝不并入派发角色计数。

## Web 客户端插件（工作流面板）

本包为 dsh **web** profile 提供浏览器客户端半体，在**已安装的 `mstar` bundle 行**上被自动发现（package.json 的 `dsh.client` 声明 + `exports["./client"]` → `dist/client.js`——上游 web `dsh.client` 发现逻辑扫描 loader entries，并把每个客户端的 `exports["./client"]` 解析进 boot 图）——**无需独立 profile 层或安装步骤**（spec §6.1）。web 应用在 `/plugins/@mstar-harness/dsh/client.js` 提供该 bundle，并经 closure-factory loader 握手加载（`window.__ModuleLoader__.load({ id, factory })`）。

客户端入口经公开的两段式席位契约把面板注册为**右 Sidebar 页签类型**：`ctx.sidebarRightTabs.register(definition)`——`id: '@mstar-harness/dsh'`、`kind: 'mstar-workflow'`（页类型——无 `patterns`/`canOpen`/`priority`，按 kind 打开）、跟随 locale 的 `title()` thunk，以及**恰好一个引导页 capsule**（`order: 20`，描述 + MStar glyph 图标）——点选 capsule 会在该 pane 的槽位打开面板（替换引导页签、展开侧栏），再次点选聚焦既有页签（宿主页去重规则）——不自动打开、不重复表面。旧 **`conversation.view`** view-ring 页签**已移除**（迁移，而非第二表面）：sidebar 页签取代会话区页签。面板体与其 chip 标题在同一 id 下注册为 keyed 席位（`sidebar.right.pane.tab` + `sidebar.right.pane.tab.title`；chip 为 glyph + 打开时捕获的标题——不跟随会话中途的语言切换）。`tab.visible === false`（列折叠或同 pane 其它页签激活）时面板体**不渲染任何内容**（无投影、无 DOM），选中分区存放在按页签记录键控的 entry slot store 中，因此能在 docked 面板体卸载后存活。文案来自 `mstar-panel` locale 命名空间：**"启明星工作流"**（zh）/ **"Morning Star Workflow"**（en）。

面板是最新 catalog 快照（取自宿主 `/api/mstar/engineStatus` 端点——刷新跟随拉取，不轮询）的纯渲染：**窄列布局**为绑定 sidebar pane 确定高度的单列 flex，恰好三个分区——**分区导航**（任务迭代 / 代理执行 / 事件记录，flex: none）、面板自有的**唯一滚动主体**（`[data-mstar-scroll]`——面板内**唯一** `overflow-y` 元素；任何元素都不横向滚动；`data-mstar-graph` 随其上）、钉住的 **meta 小面板**（版本 + harness 目录；永不滚动）。工作区状态摘要（计划 ≤5 时间倒序 + `+N more`、未决残留 findings ≤10 带 severity chip、策略 **enforcement 首位** + push / worktree / control worktree、租约、知识、方向）以流内内容位于滚动主体末尾——固定 300px 兄弟列及其嵌套滚动器已删除——新鲜度 footer（`last-updated HH:MM:SS` + turn）收尾滚动主体。宿主 composer-overlay opt-in 不再需要（sidebar pane 体本就是确定高度盒），过时的视口媒体查询已删除：壳层携带 `container-type: inline-size`，宽度规则为**容器查询**——容器宽 480px 以下内距与分组间距收紧（300px 下限的紧凑节奏）；≥720px 共享分组网格铺开为两列（`repeat(auto-fit, minmax(280px, 1fr))`）——这是任何宽度带来的**唯一**结构变化（一份 DOM、一棵树；无 JS 布局测量）。缺失字段显式降级为空态/最后已知态（muted，绝无橙色 warn 框）；`waiting` 保留 muted hint；无 harness 时渲染居中未激活态卡片，检测到后自动呈现。

三个分区在唯一滚动主体内堆叠。**任务迭代**渲染迭代头部（未激活时为折叠摘要）+ **竖直** 5 步 stepper（每步一行——徽标 · 相位 · chip · 预留 verdict 席位；保留四态 `current` / `next` / `done` / `idle` 状态机：current 之前的步骤投影为 `done`「已完成」，`next` 为唯一前向目标，`idle` 仅为 schema 余项；steering compass 为 `status: active` 时 Step 1 即当前步——无 PASS/FAIL 徽标——Step 5 永远不会是当前步）+ 分支面板（迭代 base / 目标 / spec 集成分支，仅激活时渲染）+ 计划板为**五个竖排状态组**（恒定顺序——Todo / InProgress / InReview / Done / 合并的「受阻/未知」/「Blocked / Unknown」列），每 `data-kanban-column` / `data-kanban-arrow` / `data-kanban-count` 锚点全保留；每组渲染行数以 `PLAN_CAP` 封顶，超限显示可点击「更多」/「收起」展开按钮（`data-kanban-more`）展开全量（投影保留全部 plan 行——封顶只是渲染关注点，绝不丢弃）——随后是项目 rollup。**事件记录**把两个分区（Agent 流转事件 / 违规记录）渲染为流内容——每条可展开原生 `<details>` 呈现完整 catalog 字段（缺失显示「—」，绝不捏造；workflow 行保留 name / 成员数 / stop-reason 字段），无分区自有滚动器。**代理执行**把 agents 渲染为**竖直分组列表**——绝对定位画布连同 SVG 连线层、卡片端口与指针 pan **已删除**：两个 Phase 组恒定顺序，Phase 1（`iteration-start`——顺序完成的 Review & Edit 链：product-manager → architect → writing-specialist）在上，Phase 2（`autonomous-execute`——循环迭代 plans；其组标签标注**当前 plan**：投影 `activePlanId`（`data-agent-group-plan`），多个进行中 → `+N more`（`data-agent-group-plan-more`），无 → 灰字「无进行中 plan」（`data-agent-group-no-plan`））在下；每个 Phase 组竖排其 stage 组——`sdd-implement` 拆为上方 **implementor** 分区（flow 角色 fullstack-dev / fullstack-dev-2 / frontend-dev 按 flow 序，随后 on-demand 角色 ops-engineer / prompt-engineer，带虚线**按需徽标**）与下方 **reviewer** 分区（code-reviewer），`general` 桶下沉到最后一个 stage 组底部的 `unknown` 子桶、仅有成员时渲染；每个 stage 组把完整 14 角色 roster 渲染为**全宽流行（flow row）**（idle 行虚线 muted——roster 永不隐藏），带 role chip / 状态点 / `×N` 计数 / 记录行（session id · 任务标签——辅助字段，绝不作标题），头部为 `N 执行中 · M 待执行` 摘要（`data-agent-summary-*`），三态图例以流内形式位于列表下方。行携带投影**透明度分级**：`emphasis: 'current' | 'next' | 'off' | null`——当前阶段角色 **100%** chrome 强度、后续阶段预期角色 **75%**、已过阶段 / 无阶段角色（on-demand、general）**45%**，`null`（无迭代 / transition 不可解析）**不覆盖**——恒为 chrome **alpha 混合**（`--mstar-canvas-emphasis-*` token；绝不整行 `opacity`，状态点与 running 辉光保持不透明）。已结算实体带**独立绿色完成框 + 绿 ✓**（`data-agent-done="true"`——圆角行体 success 边框 + 1px ring + 状态点绿 ✓，全强度 evidence 态）——**仅当 `emphasis ≠ 'off'`**；off 档角色显示灰字圆点、**绝不显示完成标记**。代理执行页含**零** `<svg>` 元素、零 `data-agent-port` / `data-canvas-*` 锚点、无 pan 变换。派发证据仍只投影**当前迭代的 plans**（steering compass `iterationId` 活跃时取之，否则经 catalog `plans[].iterationRefs` 推导最近迭代）；可证明跨迭代的事件不产生实体——roster 常驻 idle 卡，无 plan / 未知 plan / 独立 plan 的派发绝不隐藏。状态诚实：`advisory` **不再终态**——软执法派发落到配对 settle（有 settle 绿 ✓ 已完成、无 settle 显示执行中），`denied` 仍为终态，advisory verdict 仍在事件记录页呈现。**迭代信息 Section 由任务迭代与代理执行两页共用**——单一 `IterationInfoSection` 组件，两页渲染同一 `view.iteration` 块（摘要 + steps + 分支）。投影为纯函数 `projectGraph(source)`（schema 常量与 catalog 证据严格分离；永不 throw）。

**依赖**：面板客户端 bundle **不携带任何图库**——`@xyflow/react` devDependency（此前构建期内联进 `dist/client.js`）随 react-flow 渲染层一并移除，唯一消费者是 `@xyflow/react/dist/style.css` 的 plain-`.css` text loader 也已删除（`CLIENT_EXTERNALS` 不变——react / react-dom 与 `@deepseek-ai/dsh-client-*` 平台模块保持外部）。构建脚本端到端断言移除成立：产物**不得含 `xyflow`/`reactflow` 标记**、`@deepseek-ai/*` 值导入为 0、**无 `import.meta` / ESM 语句**——web loader 以**经典 `<script>`** 执行插件 bundle，字面 `import.meta` 是 parse-time SyntaxError（zustand v4 的 `import.meta.env` 读取已在构建期 define 消除；见本迭代 install-verification guide §6）。当前 bundle 体积：**145,159 B raw / 29,460 B gzip**（以各迭代 install-verification guide 为重新测量 SSOT——react-flow 移除后缩至约 85 KB，代理执行页实体渲染落地后回升，透明度分级样式后再度增长）。

安装 / 验证（客户端半体与服务器半体走同一条 bundle 行安装）：

```sh
cd <repo>/packages/dsh
bun run build               # dist/client.js（closure-factory CJS）+ dist/client.d.ts
# corepack 机器（仓库根声明 packageManager: bun）：命令前加 COREPACK_ENABLE_PROJECT_SPEC=0
dsh plugin --profile web add <abs packages/dsh path>   # 同一 profile bundle 安装
dsh web                     # 启动 → 服务 /plugins/@mstar-harness/dsh/client.js
```

本地已验证（install-verification guide）：boot 图包含客户端 entry（`@mstar-harness/dsh` 携声明的 inject 面）、`/plugins/<id>/client.js` 路由服务的正是构建产物（rev = 内容 sha1）、浏览器握手 materialize 出插件入口（`inject` + `apply` + CSS 注入，经典脚本语义）——见 panel-beautify 迭代的 `install-verification.md` guide（本地 harness root）。

**Known Limitations**（本迭代）：迭代 stepper 的 Step 1（iteration-start）在 steering compass `status: active`（Phase 1 进行中——catalog `compassStatus` 字段）时为**当前步**，且不携带 PASS/FAIL 徽标（Phase 1 无 gate 判定）；Step 5（merge-ready）**永远不会是当前步**——engine 相位门只评估 Phase 2→3→4（merge-ready 从不是 gate transition）；仅当 Step 4（pr-delivery）为当前步时渲染 `next`，其余为 idle；当前步跟随 TTL 刷新的 `compassStatus`——会话中途 `active`→`locked` 翻转后最多落后一个 catalog 间隔（60 秒）（有界、已记录的陈旧；绝不给出错误判定）；代理实体状态按**精确配对**派生（paired settle 携带的 `(agent, role, planId, taskId)` 标识精确配对到对应派发——QC tri N=3 并发下各卡各自结算；未配对派发保持 running，绝不捏造）；无 steering compass 时的「当前迭代」过滤按 plan id（8 位日期前缀）+ doneAt 推导迭代——确定性、已记录的启发式，且只丢弃可证明跨迭代的事件）；不回溯 resumed 长日志的历史行（服务端每 turn 首步必重发，digest 门控）；sidebar chip 标题在打开时捕获（会话中途切换语言不会翻转它——为与一方 chip 的 glyph 形态对齐而接受）；列折叠或同 pane 其它页签激活时（`tab.visible === false`）面板体不渲染任何内容（无投影、无 DOM、隐藏期零快照开销）。面板验收为双轨：in-loop 浏览器 harness 验证（对重建 bundle）+ 用户重启后 GUI 终验——重跑步骤见 install-verification guide §8。

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

每个组合后的步骤携带一条 `mstar-engine` catalog 用户消息（`<mstar_engine_status>` 水印块——见 Engine-status catalog 一节）。闸门决策额外添加：派发否决以注册表物化的 `PreToolDecision { kind: 'deny', reason }` 错误呈现；状态闸门以 `mstar/status-gate` 咨询呈现（告警放行、hard 修复逃生或降级放行）；派发闸门以 `mstar/dispatch-gate` 咨询呈现（告警放行或降级）；技能 lint 闸门以 `mstar/skill-lint` 咨询呈现（告警放行、hard 修复逃生或降级放行）。每条模型可见的行都能从会话日志重建（catalog 形态 source + 咨询事件）。

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
- **Bundled 镜像是构建期同步**——`harness-skills/` + `harness-commands/` 由 `bundle-assets` 在构建时产出（仓库根 `skills/` + `commands/` 镜像；gitignore）。未跑 `bundle-assets` 的检出不挂载 bundled 技能、不注册命令（默认挂载惰性，而非报错）。
- **profile-bundle 安装到 `web` profile：registry 与 local checkout**——`dsh plugin --profile web add @mstar-harness/dsh`（registry）与 `add <本地检出>` 为受支持途径，均走同一 pnpm + reconcile 机制（reconcile 步骤把 `@mstar-harness/dsh` 并入 `dsh.profile.bundles`）。local checkout 需要先执行 `bun run build`——本包没有 `prepare` 脚本（monorepo 显式构建各包），未构建的检出会装入空的 `dist/`。
- **`lintSkillWrite` 类型化否决尚未接入生产**——传入文档分支的 hard 否决（`SkillLintVetoError`，码 `skill-lint.veto`）已导出并测试覆盖，但尚无生产调用方：engine `HostAdapter` 没有携带内容的技能写入钩子（只有 `beforeStatusWrite`/`beforeDispatch`/`beforeMerge`），且 fs intent 槽位内容盲。接线随未来携带内容的钩子落地；在此之前监听器路径只通过修复逃生咨询执行（从不否决）。
- **CLI `HOST_SIGNALS` 缺少 `subagent` token**——engine `ToolSignal` 联合已包含它且 `detectHost` 能处理，但 `packages/cli` 的 `HOST_SIGNALS` 尚未更新，`mstar host detect --signals subagent` 会拒绝，直到上游化时更新 CLI 列表。
- **入口是 `src/gates/*` 之上的模块索引**——拆分已交付：`src/index.ts` 从各 gate 模块（`_shared` / `status` / `skill-lint` / `seams` / `dispatch` / `catalog` / `tools` / `adapter`）原样 re-export 冻结的 56 名导出面（31 值导出 + 25 type-only 名；`Config` 计一次），并保留插件 manifest、单一 cordis augmentation 点、命令注册与 `apply()` 启动接线。导出面由 `tests/export-surface.spec.ts` 冻结——运行时值导出集 + `typecheck:tests`（`bunx tsc --noEmit -p tests/tsconfig.json`）下的值命名空间恒等与逐名类型探测。
- **engine dsh 行待上游化**——engine `host.ts` 的 dsh 改动（`DetectResult`、`ToolSignal`、`resolveSkillRoot`）位于 mstar-workflow engine 镜像，计划经用户授权的上游 PR 合入 mstar-harness；`mstar-host` 技能镜像（§ Detect / § Resolve loaded skill root / `references/dsh.md`）随之一并更新。
- **迭代 stepper：Step 1 为 compass 驱动，Step 5 为 schema 驱动**——工作流面板的 Step 1（iteration-start）在 steering compass `status: active`（Phase 1 进行中）时为当前步（无 gate 判定 → 无 PASS/FAIL 徽标）；Step 5（merge-ready）是 engine 闸门永不点亮为当前的 schema 常量（transition 只覆盖 Phase 2→3→4，merge-ready 从不是 gate transition）；仅当 Step 4 为当前步时作为 `next` 渲染，其余为 idle——已记录于迭代 guide，非缺陷。完整面板限制清单见 Web 客户端插件一节。
- **`dsh-llm-fallbacks` 为可选的开发期依赖**——dsh 原生覆盖 subagent 定制，fallbacks 因此严格可选：`src/` 对其零导入（运行时与类型——被消费面是本地结构镜像 `fallbacks-structural.ts`，由探测的 exact-keys 漂移闸门 + `typecheck:tests` 的 real → view 可赋值检查保持同步），`package.json` 仅在 `devDependencies` 携带它（类型镜像 + 真实包测试 harness），`dist/` 无导入也无类型引用（仅 1 处命名该包的字符串字面量——探测的 loader 条目匹配；建议日志写作 `fallbacks`）。激活是**单独显式安装**（双命令契约），绝不传递；不再有 `--external` 护栏——未来的值导入必须按设计重新加入运行时依赖。
- **本批次未交付角色→模型覆盖**——把角色路由到 fallbacks `model`（或经 fallbacks 规则路由 persona）需要改写启动请求上的子会话 `agentOptions`，但启动请求选项由调用方控制（tool-subagent 自己的 Config；调用参数仅为 `description`/`prompt`/`run_in_background`，且深度冻结）。等待上游 `fallbacks-explicit-role-tool` 或 N-B1 systemPrompt 采纳（roadmap §10.4）。
- **persona 交付为 dsh 原生——不再有附加段**——角色 persona 合入 `SubagentStartRequest.persona`（一次性 `start` 与可选的 continuable `startContinuable` 两个启动面），对角色匹配的子会话**遮蔽**部署 persona（子会话体现角色；持久化并在 resume 时重放）。`mstar:role-persona` system-prompt 段已不复存在。
- **persona 注入与 fallbacks 无关**——`dsh-llm-fallbacks` 只路由 LLM 失败；persona 交付从不依赖它。未挂载 → 同一 persona 经原生通道交付，仅一条交付 debug 日志（AC-4）。一次性 start 中不具备原生 `persona` 能力的提供者（进程外）以一条受控 debug 日志跳过 persona；continuable start 中不具备 `prepareContinuable` 的提供者同样跳过（原生 start 会自行 fail loud）——通道绝不因两者使 start 失败。
- **fork 门禁仅默认开启；显式 `dispatchTools` 可省略 `subagent_fork`**——自定义 `dispatchTools` 列表整体覆盖默认（既有重命名模式），因此自行声明列表的部署须包含 `subagent_fork` 才能继续门禁 fork 派发。
- **persona 值绝不能包含 `{{...}}`**——dsh system-prompt 以严格 `{{variable}}` 插值渲染 persona 文本，对与后文 `}}` 配对的 `{{`（未知/畸形/未定义引用）直接抛错，会破坏每一次角色匹配派发的子会话提示组装。Config schema 在插件挂载时以清晰报错拒绝此类 `rolePersonas` 值；转义规则是改用单花括号或改写措辞（不带后续 `}}` 的孤立 `{{` 按字面散文渲染）。
- **fallbacks HMR 重挂后的 seeds 再收敛受 seeded-only preservation 设计边界限制**——seed registry 是每次 apply 的内存态，纤程切换（HMR / 设置编辑）会丢弃它并让双方 declarer 从头重放。mstar re-declare 只合并保留**已 seeded** 的 id（seeded-only，设计使然），因此在 preset-last 提交顺序下，preset 行的 seeded 注记不会被 re-declare 恢复——它们在下一次 fallbacks apply 时恢复（上游 preset 自声明重新播种）。`llm-fallbacks` 服务消失时 advisory 一次性 latch 会重新武装（inject teardown），因此下一个决策点会重新收敛 mstar 侧；preset 侧是 seeded-only preservation 设计的有文档说明的暂时现象。
- **咨询跳过原因 `no-persona` 亦涵盖 extraction 失败**——在 extraction 期被拒绝的镜像默认（例如含 `{{...}}` 插值风险）会在合并的 declare-outcome 行中以 `no-persona` 呈现（extraction 在风险门之前就返回无可用的 persona）；逐 id 的 extraction 诊断保留在 debug 通道（`mstar/fallbacks-advisory` / `mstar/fallbacks-seeds`）。
