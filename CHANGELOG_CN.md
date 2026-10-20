# 更新日志

本仓库 harness 各发布面版本一致，详见 [CHANGELOG.md](CHANGELOG.md)。

各包独立日志：[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)、[packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md)、[packages/engine/CHANGELOG.md](packages/engine/CHANGELOG.md)。

## [Unreleased]

## [4.0.4] - 2026-10-20

### Harness

- **跨 harness bind 的消费者解析 bind 所选的 harness。** workflow-ledger 归因与原生 `mstar_execution_clear` 工具不再从 workspace 反推 harness：两者都解析会话被选定的 root（bind 采纳时记录的 root），点名另一个 control root 的 bind 从该 root 归因、在该 root 清除，workspace root 全程零写入；ledger target 自带 harness dir，扫描水位与事件追加作用于绑定所在的 store。选定 root 在 workspace 探测之前解析：先读采纳回执，只有从未选择显式 root 的会话才回退到 workspace 探测，因此从完全不声明 harness 的 workspace 绑定到另一个 control root 时归因与清除依然成立（workspace 优先的顺序在那里返回 null，会丢掉有效绑定的所有行并拒绝清除）。相对的显式 `harness` 按共享命令相同的基准、相对会话 workspace 解析为绝对路径，因此存储的 `harnessRoot`、回执与 ledger target 都指向引擎实际绑定的绝对 root。若 bind 在引擎已提交后采纳失败，拒绝信封自身携带引擎铸造的 session reference（`data.resumeRef`，连同 workflow id 与目标 `harness` root）并说明席位仍处于绑定状态——该路径正是持久槽位从未写入之处；clear 在绑定不可达时的 `no-binding` 拒绝同时点名跨 root 情形（绑定被采纳进另一个 control root，其进程内回执随 host 重启或插件重载丢失）与在清除前重新记录选定 root 的 resume 重跑路径（原始 reference + 相同 `harness`），并保留从未采纳过跨 root 绑定的无需操作情形。
- **`--identity-env` 文档对齐身份锁定。** `bundle/README.md` 与 `bundle/cordis.patch.yml` 不再把声明的身份描述为可被按调覆盖的默认值：声明的通道若变量解析出可用的 session id——按引擎规则即单个安全路径组件——即锁定连接（不发布 session selector、调用方提供的 sessionId 被剥离），每调用者身份是每个 mount 的事实；未设置、空白或不安全的声明解析不出身份，连接保持通用，并由启动时的一行警告指明变量名、成因与恢复方式。
- **workflow ledger 在 bind 所选的 harness 内自守门。** 绑定可读性守卫与排除水位此前仍从 workspace harness 解析，而追加已改用采纳回执的 root：跨 harness bind（workspace A、bind 到 B）时 B 的行被 A 的守卫与水位过滤——A 的绑定存储不可读会让有效的 B 绑定暂停归因，A 的水位可能丢掉或放进 B 的行。现在守卫、水位、扫描边界与追加解析同一个选定 root；fork 截断与拒绝语义不变。回执丢失的恢复指引（模块注记 + 采纳拒绝文本）改为指向真正可行的路径——以原始 session reference 和相同 `harness` 以 resume 方式重跑 bind——而不再宣传引擎会拒绝的普通 re-execution bind（live holder 的行永不因 bind 被替换）。
- **dsh 编排技能文本改为通道中立。** 派发、SDD、QC、迭代与 PM 角色指引不再假设 `subagent` 是唯一委派通道：按工作形态选择传输——一次性 Assignment → `subagent`；多席位 / 角色持续 / 多轮工作 → Agent Teams（`spawn_teammate` + 任务板 + `wait_agent` + `send_message`）；只读 N≥3 扇出 → `workflow`——容量与唤醒语义归 `mstar-host/references/dsh-agent-teams.md` 所有，各技能只链接不复述。SDD 实现/评审派发、三审 QC 席位与 Phase 2 循环均在活动通道上运行；sticky 会话在 Agent Teams 模式下映射为按名续接的持久 teammate。
- **唤醒纪律成为 `mstar-iteration` 硬规则。** dsh Agent Teams 上就绪绝不启动归属者：blocker 完成不会启动它，Lead 必须 `send_message`（或 `reassign` + 一条消息）启动下一席位，且 inactive 不是完成——记录 done 前先读 plan 行证据。Phase 2 推进在 native-workflow 路线上跟随子任务 settle 通知，不再假设 goal-round 循环。
- **dsh 委派通道改为能力判定，不再只看 `subagent`。** Engine `ToolSignal` 词表与 CLI `host.detect` token 列表在 `subagent`/`subagent_fork` 之外接受官方 Agent Teams 载体（`spawn_teammate`、`team_task_create`），`detectHost` 对其中任一 token 返回 `dsh`。检测顺序不变（cursor → opencode → omp → dsh → kimi → zcode → codex）；dsh 行只新增可接受 token，其它行判定完全不变。
- **派发门禁覆盖 Agent Teams 工具。** 独立 `TEAM_DISPATCH_TOOLS` 映射（固定名，不新增 Config 键）解析各载体的 Assignment 文本——`spawn_teammate.prompt`、`team_task_create.description`、`team_task_update.description`、`send_message.message`——并进入与 `subagent` 完全相同的门禁核心（形态守卫、一次 hard 解析、advisory/veto 词表、lease + worktree + 反递归检查）。`DEFAULT_DISPATCH_TOOLS` 仍严格为 `['subagent','subagent_fork']`。team 分支对其拥有的名字是终态：即使部署把 team 名也加进 `Config.dispatchTools`，一次调用也只产生一个决策、一条台账行。非 Assignment 的协作文本、缺失载体（仅状态的 `team_task_update`）以及非字符串/空载体一律静默放行。改名后的 team 工具在把固定名加进映射前不可达（与 `DEFAULT_DISPATCH_TOOLS` 对改名实例的既有说明相同）。
- **agent-flow 台账记录 team 派发且绝不虚假结算。** 已经产生 dispatch 行的 team 载体绝不在工具返回时结算：`spawn_teammate` 在成员创建完成时即返回，`send_message` 只代表 inbox 接受，任务板写入根本不是委派完成。成员自身的 turn 才是完成：roster 读取把面向模型的成员名解析为其子会话，经验证的 `subagent/end` 结算按映射记录结果（`completed → ok`，`aborted`/`refusal → denied`，`error`/`max-tokens → error`）。其余形态改为写入显式的 `kind: 'continuation'`、`state: 'unresolved'` 持久标记，而不是伪造的 `ok`。call 配对键现同时携带工具名与会话，因此后续未过门禁、per-message id 相撞的调用绝不可能结算 team 派发；每次 team post-execute 都消费自己的条目（状态有界），成员-子会话映射有容量上限并在淘汰时写显式标记，team 调用不再占用 call-window catalog 槽位。实验性 team 服务缺席时，team 工具完全不记录且不抛错。
- **文档**：`skills/mstar-host/references/dsh.md` 现描述各委派通道形态并修正并发段落（不再要求 `run_in_background`）；新增 `skills/mstar-host/references/dsh-agent-teams.md` 记录 team 协议（roster 命名、plan 行 ⇄ team 任务镜像、唤醒纪律、容量、创建失败处理）。
- **升级说明**：无 Config、状态或 session 格式变更；未挂载实验性 Agent Teams bundle 的安装行为与之前完全一致（team 专属路径均为可选且降级为 no-op），`subagent` 门禁/台账路径不变。未解析续接标记只是持久台账行——本次变更中面板与模型视图保持既有事件种类。无额外恢复步骤：本次变更是纯增量能力覆盖，旧会话与旧台账行保持可读。
- **dsh 获得原生可写 mstar 命令工具。** 具名可写集合——`mstar_plan_bind`、`mstar_plan_prepare`、`mstar_plan_progress`、`mstar_plan_complete`、`mstar_workflow_register`、`mstar_issue_add`、`mstar_issue_close`——注册为 dsh 工具：每个工具经程序化入口在进程内调用共享的 `@mstar-harness/commands` 实现（与 CLI 相同的准入 + 执行路径），从 `exec.agent.id` 注入调用者身份（session id 参数在准入前被剥离，身份永远不可由模型选择），并原样透出引擎拒绝 envelope。路径中无任何 shell：`executeCommand` 进程内运行，注入的 effects 均为拒绝桩，因此需要进程/仪表盘/浏览器的命令按构造拒绝。
- **成功的原生 `plan bind` 自动采纳持久执行绑定。** 两个 bind 臂都会持久化规范 binding 槽位（引用必须点名承载会话、引擎 resume 先于任何写入成功、伪造/复制/过期引用以引擎自身 code 原样拒绝），workflow 台账归因因此无需任何斜杠命令；用户的 workflow 选择与排除下限保持不变。
- **dsh 每个 agent 一个 scoped MCP 挂载。** 每个非叶 agent 获得自己的 scoped `@deepseek-ai/dsh-mcp-client` 实例，其 stdio 子进程携带 `MSTAR_HOST_SESSION_ID = agent.id`，因此每个 agent 的 MCP 工具调用都归因到它自己的 session id，subagent 永远不会继承父级 id。身份归因的代价是每个非叶 agent 一个 stdio 子进程（随并发非叶 agent 线性增长，HMR 重载时全部重启）；叶席位与未安装 MCP client 的部署零成本，后者继续使用单一共享 bundle 行。挂载基线按行自身的身份选取部署的 MStar 行——bundle 行 id，否则配置中的 MStar 服务器身份（`serverName`，或 `@mstar-harness/cli … mcp` 启动参数）——绝不仅凭 MCP client 包名选取，因为 profile 可能在其之前为另一个服务器启用另一条 `dsh-mcp-client` 行；若没有任何行可识别为 MStar 行，则使用内置行镜像，绝不采用另一个服务器的行。
- **`/mstar-execution` 斜杠命令移除——原生路径取代它。** 操作者用原生 `mstar_plan_bind` 工具绑定（成功即自动采纳），用新的 `mstar_execution_clear` 工具清除——后者不带任何参数、身份取自 `exec.agent.id`、保留用户选择，无可清除绑定时以命名错误 `no clearable execution binding` 拒绝。被移除命令的 `run` 臂本次没有原生替代：coordinator 会话改经引擎自己的 `session run` 路径启动。
- **身份锁定的 MCP 连接拒绝身份覆盖。** 以 `--identity-env` 启动的服务器（scoped per-agent 挂载）不再在工具上发布 session selector，并在准入前剥离调用方提供的 `sessionId`，因此每次调用都以 launcher 声明的连接身份运行——调用方无法再传入一个有效的外来 session id 并在该身份的权限内操作。通用未绑定连接保留文档化的 per-call `sessionId` 选择器。锁定的连接一定有已解析的身份：声明的通道若变量未设置或为空白，解析不出 session id，该连接保持通用（per-call 选择器仍是其身份通道），并在启动时输出一行指明变量名、成因与两种恢复方式，而不是锁定一个根本没有身份的连接。声明值若被引擎的 safe-session-id 规则拒绝——不是单个安全路径组件 `[A-Za-z0-9._-]+`，不是 `""`、`.`、`..` 或含 `/`、`\` 的值，或超过引擎的 `SESSION_ID_MAX_LENGTH` 上限——同样解析不出身份：连接保持未锁定并给出警告，而不是锁定一个任何身份消费调用都用不了的身份；该启动行说明这一规则，以及「改正变量，或去掉 `--identity-env` 并重新启动」的恢复方式，且不回显被拒绝的值。声明的身份在连接创建时解析一次，因此锁定既不会比它所锁的身份活得更久，也不会在连接已变为通用之后再出现。锁定连接的已发布工具元数据同样处处省略 session selector——输入 properties、`x-mstar-requirements`、渲染出的 `CLI:` 用法 token 与 caller-supplied 段——因此 agent 读到的契约绝不要求一个工具根本不发布且会静默剥离的参数；通用连接仍然发布它。
- **`MSTAR_HARNESS_DIR` 恢复路径在拒绝消息提及的每种场景下都可用。** 引擎的 harness 根解析在 linked-checkout 拒绝之前先读取非空白的 `MSTAR_HARNESS_DIR`，因此 MCP control-root 拒绝所宣告的恢复方式，在主 worktree 不可读的 linked checkout 上同样生效。
- **PR review 现定义了同一目标的 re-review。** `mstar-audit` → `references/pr-review.md` 新增 § Re-review：当目标已有上一轮报告时，该报告是**输入**而非范围。覆盖型路径（上一轮已 settled 且其 head 仍是新 head 的祖先）下，复核每条既有 accepted finding 与 `- unverified:` 项为 `fixed` / `still present` / `regressed` / `not verifiable`，随后只审增量；其它情况完整审 `base...<new-head>`，同样逐条复核旧 findings。
- **tally 描述当前状态。** `fixed` 的 finding 退出 tally，避免同一缺陷被扣两次分、也让结论有改善空间；`still present` 与 `regressed` 按**当前** merge class 判据重新分类，原 class 只作参考——如今可达数据丢失或鉴权绕过的缺陷一律 `must-fix`；新 finding 只来自受审范围（覆盖型即增量）与修复点。上一轮 `Considered & rejected` 清单顺延，没有新证据不重追已驳回的候选。
- **覆盖必须以 settled 的上一轮报告为前提。** 上一轮 `verdict: incomplete`（diff basis 不可读或席位从未打开）不能使其 hunk 视为已覆盖——仅列出其 `unscanned` 范围并不能补回未审内容——因此本轮完整审 `base...<new-head>`。任意 diff 目标没有稳定身份（`<date>-diff-<short-head-sha>` 内嵌 head），其 re-review 必须显式给出上一轮报告。
- **增量是 two-endpoint diff，重写历史不算增量。** 基准为 `git diff <prior-head>..<new-head>`，仅当上一轮 head 是新 head 的祖先时成立——此处不使用 three-dot，因为 rebase 后它会重放上一轮已判过的内容。祖先判定失败（rebase / force-push）时没有任何 hunk 可视为已覆盖：完整审 `base...<new-head>`，并在 `- notes:` 声明该回退。patch 等价配对从不能作为覆盖依据，也不存在部分覆盖捷径：`- notes:` 无法限定 verdict。
- **席位拿到的是增量包，不是 setup snapshot。** 覆盖型 re-review 由主检出把 `increment-<prior7>-<new7>.diff` 写入该目标 run 目录，并作为 `--diff-file` 传给每个席位，避免完整 `base...<new-head>` snapshot 把已审 hunk 重新摆到席位面前；完整审路径则传完整 diff。席位同时拿到 prior report 路径与分配给它的待复核 findings。setup 的 sidecar 与 snapshot 保持原职责，仅用于解析 base 与发布坐标。
- **席位与 tier 跟随受审范围**，沿用同一分级带：覆盖型按增量，完整审按完整 `base...<new-head>` diff。安全敏感增量不论大小保持 `deep`，既未被受审范围触及也无需复核的领域不派席位。
- **报告与发布。** 发布的 review 正文新增 `### Revalidated findings` 小节（首次 review 写 `none`），frontmatter 增加可选的 `supersedes:` 指向上一轮报告；同目录轮次递增为下一个 `report-r<N>.md` 修订，跨日则新建 run 目录，两者都发布新的 `COMMENT` review，绝不改写或 resolve 既有线程。已捕获 issue 的复核状态在报告中披露——重复出现则追加 occurrence，`fixed` 的关闭仍属 issue 权威的独立授权动作。
- **入口面一致。** `/amazing-pr-review` 第 1 步与 `mstar-audit` 变体表把同一目标的再次运行路由到 § Re-review，而不是重跑整个 diff。
- **PR-review 的 `incomplete` 由 run 事实决定，不再由 wall clock 决定。** 该 token 不再因 tier 预算耗尽而触发：它只在三种情况下触发——run 在综合之前被中止、必需领域席位从未打开、已解析的 diff basis 不可读——超时但覆盖完整的 run 仍视为 settled，发布由 tally 推导的结论（`ship it` / `needs fixes` / `blocked`），并在 `- notes:` 中声明超时。
- **单一权威，各处引用。** 触发清单的唯一出处是 `mstar-audit` → `references/pr-review.md` § Verdict synthesis；tier Budget 列、降级阶梯、席位监督规则与 tally override invariant 各用一句话指向它，入口面（命令 `description` 与启动正文、`docs/commands.md`、两个 README）陈述同样的三种情况。
- **载体不变。** `incomplete` 的 envelope／报告 frontmatter、显示块与 tier 预算数值均未改动；engine 常量注释与边界 fixture 现在记录「耗时不是结算事实」。
- **`tally` 入参被替换。** 自由文本的 `--incomplete-reason` 原因与 `--unscanned` 范围已移除：CLI 改为接收 run 自身的事实——必需的 `--required-domains`、`--opened-domains`（显式空值表示没有打开任何领域）与 `--diff-basis readable|unreadable`，外加可选的 `--stopped`。三个必需事实中任一被省略时会被拒绝，并与其它字段诊断一起在同一次响应中报告，绝不推断。
- **按席位计数，而非领域归属。** `--required-domains` / `--opened-domains` 按多重集处理：每个 required 条目消费一个匹配的 opened 条目，`default` tier 在同一领域中的第二个席位（普通席位加同领域 security lens 席位）不会被兄弟席位的证据满足，未被代表的席位会让 run 保持 `incomplete`。 `--help` 文案与机器可读 constraint 现在陈述同一契约：每个必需席位一条，同一领域两个席位就出现两次，两者都返回时需要两条匹配的 `--opened-domains`。
- **截断的席位范围进入 `unscanned`。** 新增可选 `--partial-scope <scope...>`（engine 事实 `partialSeatScopes`），按席位在 payload 尾部声明的截断覆盖逐项重复；这些条目在 stopped 或缺失席位的 run 中并入派生 `unscanned`（去重，排在缺失席位与不可读 basis 之后），因此「覆盖完整但存在截断」不再显示为 `unscanned: none`。三条件触发清单不变——该选项只扩展 stopped/缺失 run 的范围，绝不产生触发条件。 当 run 反而 settled 时，声明的范围以 `declaredScopes` 形式（去重，保持输入顺序）机器可读地回显——settled run 没有 `unscanned`，报告把截断记在 `- unverified:` / `- notes:` 之下，回显保证它不被丢弃；`declaredScopes` 只是供给报告 `- unverified:` / `- notes:` 的 tally 输出事实，不属于 `mstar.review/v1`，也不是报告 frontmatter 的已声明字段，因此把它复制进任一载体都超出契约（envelope 静默容忍未知键，frontmatter 解析器接受任意标量键——容忍不等于许可）；两行 settled header 保持逐字节不变。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/opencode-v2`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 4.0.4**。

## [4.0.3] - 2026-10-18

### Harness

- **`dsh-llm-fallbacks` 固定版本由 `0.6.6` 升至 `0.6.7`**：两处手写字面量同步移动——`@mstar-harness/dsh` 开发依赖（`packages/dsh/package.json`）与 CLI 安装 spec 常量（`packages/cli/package.json` → `mstar.dshLlmFallbacks`，由 `init` / `doctor --target dsh` 读取）——lock 将该行重新解析为 `0.6.7`，并记录该版本在 registry 上的 integrity。`0.6.7` 的 peer 集合与 `0.6.6` 相同（`^0.2.1-rc.2` 的 dsh 走廊、`@deepseek-ai/cordis` `^4.0.5`、`@deepseek-ai/schemastery` `^3.18.5`、`react` `^18.2.0`），因此工作区 peer 线本就匹配；其服务面变化仅为追加式（一个 dispatch-role getter 与 role-projection 导出），mstar 均未消费——结构镜像及其 real → view 类型门禁无需改动。不会升级任何已安装宿主：在 `init --target dsh` 按新 pin 重新 add 之前，`doctor --target dsh` 会把旧行报为 `drifted`。工作区验证：`tests/peer-deps.spec.ts` 7 项通过，`fallbacks-*` 套件 53 项通过（限定 7 文件集合共 60 项、零跳过），两个类型门禁（`typecheck:src` 与 `typecheck:tests`）均干净退出。

### Changed

- **`init` 现为纯安装**：不再读取、创建或追加项目 `.gitignore`，各宿主安装路径（`.cursor/plugins/morning-star-harness`、`.codex/agents/*.toml`、`.agents/skills/<name>`、`.zcode/plugin-checkout`）保持未跟踪即可。
- 移除随之失效的 `doctor` 检查：`cursor`、`codex`、`zcode` 的项目级忽略项检查，以及 omp 侧已不可达的忽略清单。
- `mstar-harness harness scaffold` 行为不变，仍输出规范 `.gitignore` 片段；需要忽略 harness 产物时运行它或自行添加条目。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/opencode-v2`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 4.0.3**。

## [4.0.2] - 2026-10-18

### Harness

- **`dsh-llm-fallbacks` 固定版本由 `0.6.5` 升至 `0.6.6`**：两处手写字面量同步移动——`@mstar-harness/dsh` 开发依赖（`packages/dsh/package.json`）与 CLI 安装 spec 常量（`packages/cli/package.json` → `mstar.dshLlmFallbacks`，由 `init` / `doctor --target dsh` 读取），lock 将该行重新解析为 `0.6.6`。`0.6.6` 要求 `^0.2.1-rc.2` 宿主，因此该 pin 只在带上这一走廊时才完整：lock 仍携带旧的传递依赖 `@deepseek-ai/dsh-client-ui-plugin-manager@0.2.0-rc.2` 副本（其下嵌套 `dsh-timeout` / `dsh-typert-protocol` / `dsh-brand` 的 `0.2.0-rc.2`），因为 `packages/dsh` 未对该包声明直接 peer。不会升级任何已安装宿主：在 `init --target dsh` 按新 pin 重新 add 之前，`doctor --target dsh` 会把旧行报为 `drifted`。工作区验证覆盖的是直接固定行与 peer/类型门禁：`tests/peer-deps.spec.ts` 7 项通过，`fallbacks-*` 套件 53 项通过，两个 `typecheck` 门禁（`typecheck:src` 与 `typecheck:tests`）均干净退出。
- `@deepseek-ai/dsh-*` peer 依赖整组升级到 `^0.2.1-rc.1`（走廊 `dsh-v0.2.0-rc.2` → `dsh-v0.2.1-rc.1`，rollup alpha.1–alpha.5：自定义插件索引、「让 Agent 创建插件」、官方组合包按需安装、实验性 Mods／DevTools／思考链翻译／worktree、密钥脱敏、Web DeepSeek 登录、`engines.dsh` 兼容优先、Slot `conversation.input.model.label`；移除已下线 `@deepseek-ai/dsh-invariants` peer，新增 `@deepseek-ai/dsh-agent-preset-registry`）。Session 格式仍为 v4。
- **dsh 插件——角色身份改由 agent preset 交付**：dsh 0.2.1 移除了 `SubagentStartRequest.persona` 与 `start`/`startContinuable` 对（`startActivation` 成为唯一启动面；`tool-subagent` 直接拒绝 `persona` 配置并指向 preset）。因此角色匹配的派发改为**选择**已部署的 agent preset（`SubagentStartRequest.agentPreset`）——`Config.rolePersonas`（角色 → persona 文本）由 `Config.rolePresets`（角色 → preset id）取代，且由部署方为每个角色声明一份完整 preset（内含 `@deepseek-ai/dsh-persona` 承载身份），因为 preset 拥有子代理的整份组合。选择受能力闸门约束（仅限支持独立选择的提供者），组合未挂载 `agentPresets` registry 时跳过并记一条 debug 日志；配置的 id 每次 apply 校验一次。
- `@mstar-harness/dsh/invariant` 伴随入口保持为文档化的 no-op：上游已移除 `invariants` 服务与 `./invariant` 约定，该入口现为可加载的 no-op，不依赖任何宿主服务。
- `@deepseek-ai/dsh-*` peer 依赖整组升级到 `^0.2.1-rc.2`（走廊 `dsh-v0.2.1-rc.1` → `dsh-v0.2.1-rc.2`：DeepSeek Search/Fetch Web Search 设置 UI；Flash-1017 临时候选标徽章包；RC 钉死）。Session 格式仍为 v4。
- **plan workflow 的交付分支改名为 `branch.work`，并新增 `branch.base`。** plan 形状此前把*交付*分支记作 `branch.source` —— 这个名字读起来是「从哪来」，而 iteration 形状里那个含义叫 `branch.base`。按 `main → worktree → main` 的字面理解注册 `main` 作为交付分支的 operator，会让 `plan complete` 永远无法通过。现在同时记录 `branch.base`（该 workflow 由哪个分支创建）。**此前注册的行继续可用**：读取解析 `branch.work ?? branch.source`，写入只写 `branch.work`，无需迁移。CLI 同步：`workflow register` / `workflow delivery-anchors` 使用 `--branch-work` / `--branch-base` / `--branch-target`，`--branch-source` 仍作为 `--branch-work` 的已弃别名被接受。
- 新增 **`mstar workflow delivery-anchors`**：在 workflow CAS token 之下，受守卫、可重复地修正 workflow 已登记的投递锚点（`branch.work` / `branch.target`，以及 `branch.base`）。三个锚点 flag 各自可选（未提供的保留已登记值），`--reason` 必填并进入该操作的意图指纹；写入**合并**进已存 `branch` 对象，因此未被点名的成员（例如 iteration workflow 的 `base` / `integration`）会被保留。这补上了「锚点登记错误即导致 plan 永远无法完成、且没有任何受支持修复路径」的缺口。
- `mstar workflow register` 现在会在 `development` 注册的 `--branch-work` 与 `--branch-target` 取值相同时给出**非阻断提示**（ok envelope 的 `data.warnings`）；各分支锚点的选项帮助也说明了其含义。
- **拒绝信息现在说明原因与恢复路径**（此前止于通用文案）：`plan complete` 的投递锚点不匹配会列出两个分支值，并由 envelope 的 `recovery` 给出修复路径；`store execution export` 的 control-root 拒绝会说明解析到的目标与被准入的调用方式；`plan progress` 的恢复文案不再把 payload 误述为裸状态。
- **`mstar lint --type plan` 不再误报 plan 自身的 YAML frontmatter**：跳过前导 `---` 块，因此 `status: Todo` 不再被判为占位符，正文中的占位符仍照常报告。
- **`mstar schema --command plan.progress` 现在发布 `PlanProgress` payload 形状**（`status` / `summary` / `evidence_paths` / 可选 `track_branches`），不再是开放对象。
- **交付锚点必须属于被寻址生命周期的类型。** `mstar workflow delivery-anchors` 现在会拒绝被寻址 workflow 自身类型不携带的成员：iteration（其锚点为 `branch.base` / `branch.integration` / `branch.target`）会拒绝 `--branch-work`，拒绝信息给出类型、被拒绝的成员以及该类型允许的成员，一次重试即可改正。该类型确实携带的成员依旧照常可修，`branch.integration` 对两种类型仍不可写。
- **迭代 Phase 1 调研与 Phase 3 收口改为从项目 store 读取 roadmap 与 milestone**（`mstar roadmap show --project <id>`、`mstar milestone list --project <id>`、`mstar milestone status`），不再从 legacy `roadmap.md` Markdown 推导路线范围。项目缺少 roadmap 或 milestone 记录时明确记录为已知 absence；项目文件、README 索引行与 catalog 路径仅作历史/transport，绝不作为读取回退。迭代 compass 的 `## Milestones` 表明确为迭代交付节点，区别于 store 的 `project_milestones`，两者互不替代。
- **`mstar-engine-legacy` 现为 inbound-only 归档，由 load-order lint 强制。** `lintLoadOrder` 按精确名豁免其 core-first（与 standalone `mstar-coding-behavior` 同列），并新增 `roles.loadorder.legacy.archive.reference` 违规：归档文本一旦点名已发布 corpus 中的其它 `mstar-*` topic 即失败。候选名单取自被 lint 的 corpus key，因此关于 `mstar` CLI、`mstar-*` 通配与 `@mstar-harness/engine` 包名的历史散文不构成引用。归档的交叉引用改写为中性描述（"the runtime dispatch rules" / "the current field reference" / "the host references"），字段、安全与 QC 座次事实逐条保留；运行时 core 的加载契约已列出该豁免与 inbound-only 规则。
- **PR review 现在可以报告 `incomplete`，而不必失败或谎称通过**（issue #503 提出）。`PR_VERDICTS` 增加这个中性的第四个 token，`computePrTally` 接受可选的 `incomplete: { reason, unscanned }`：提供后 `verdict` 变为 `incomplete`，而 `scorePct`、`band` 与四个计数保持由计数推导的值，聊天头部变为四行 —— `incomplete · <score>% (<band>, partial)` + 不变的 tally 行 + `cause: <reason>` + `unscanned: <csv|none>`。它既不是通过也不是失败，且**永不**授权合并；未声明时，既有运行保持逐字节不变（verdict、分数、band 与两行头部）。
- **两个已发布表面都强制该声明。** `mstar.review/v1` envelope 仅在 `verdict` 为 `incomplete` 时要求 `incomplete`，并在其他 verdict 上拒绝它（`review.missing-incomplete` / `review.incomplete-malformed` / `review.incomplete-unexpected`，且 `tally.verdict` 仍须等于顶层 verdict）；Markdown 报告在该 verdict 下要求 `incomplete_reason` + `unscanned` frontmatter 组合、其他 verdict 下拒绝（`prreview.report.missing-incomplete_reason` / `invalid-incomplete-reason` / `missing-unscanned` / `invalid-unscanned` / `incomplete-unexpected`），并仅对该 token 跳过 tally 不一致检查，`score_pct` 重算仍照常执行。`mstar pr-review tally` 新增 `--incomplete-reason <text> --unscanned <csv>`（须成对提供），并一次性拒绝全部非法 tally 字段 —— findings payload（文件缺失、无法解析、非数组、`mergeClass` 非法或缺失）、这两个 flag 与三个 count flag；单独的 `--unscanned none`（大小写不敏感）声明 engine 的空 scope，而不再被当作字面条目 `none`；`mstar schema` 发布新的可选 envelope 字段，且畸形 fact 现与生产端共用同一条单行规则（cause 或 unscanned 条目含 CR/LF 即被拒绝）。
- 更新 `mstar-audit` 的 pr-review 参考 —— verdict 列表、唯一的 `incomplete` 触发清单与 settled/declared 规则（**settled** run 指无中断完成、必需领域全部打开且已解析的 diff basis 可读且完整（模式产生快照时即 pinned snapshot，否则为已解析的 `--diff` / `--working-tree` 输入），因此已取消或超时的 run 即使这些资源已打开也永不 settled；时间预算与 Stage 3 改为指向它）、partial 展示、envelope/报告承载字段、override 不变式，以及一行明确标注的 override 示例 —— 同时各入口表面（`commands/amazing-pr-review.md`、`docs/commands.md`、`README.md`、`README_CN.md`）列出全部四个 token 与该规则（沿用同一 settled 限定语）。锁定的扣分表、band 与既有展示契约保持不变。
- 精简 README **Install** 节为各宿主的 CLI + 原生两条安装命令；`init` / scope / `doctor` / 二进制别名等细节只保留在 `INSTALL.md`（双语对应修改同步落地）。
- 评审产出迁入专用 **`{REVIEW_DIR}`** 目录树（默认 `{HARNESS_DIR}/reviews/`，受 `.mstarc` `review_dir` 控制），run 目录名固定：`<date>-codebase-<level>-<round>`、`<date>-pr<N>`、`<date>-branch-<slug>`、`<date>-diff-<short-sha>`；导出 `reviewRunDirName` / `resolveReviewRunDir` / `resolveReviewDir`，`harness scaffold` 创建 `reviews/`。
- **代码库审计产出 review report 而非 plan**：`scaffoldAuditReport` 写入 `<reviewsDir>/<date>-codebase-<level>-<round>/README.md`（findings 门禁不变；README 去掉 plan 执行顺序块）。`mstar audit scaffold` 新增 `--level` / `--round` / `--reviews-dir` / `--dir`，并**移除** `mstar audit` 家族的 `promote` 动词（连同 `scaffoldAuditPlan`、plan Status block 校验与 plan 列表辅助函数）。审计 seam 现扫描 `{REVIEW_DIR}` 下的 markdown，且只保留凭据扫描这一项校验。
- **PR review 报告与证据迁至 `{REVIEW_DIR}/<date>-pr<N>/`**：`prReviewReportPath` 选项由 `reportsDir` 改为 `reviewsDir`；`mstar pr-review report-path` 增加可选 `--reviews-dir`，默认取解析后的 `{REVIEW_DIR}`；dsh `mstar-pr-seats` 的 `reportsDir` 参数即同一 review run 目录。
- 同步更新审计/评审技能、斜杠命令、`docs/commands.md` 与 `docs/runtime-reference.md`、以及 plan 生命周期参考：评审面不再产出 plan 文件、不存在 promotion producer、不再引用 `plan-quality-bar`。
- `mstar path resolve` 同时输出 `reviewDir`；约定技能记录：声明在 `{HARNESS_DIR}` 之外的目录键（如 `review_dir=process/reviews`）不在 canonical ignore 片段的覆盖范围内。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/opencode-v2`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 4.0.2**。

## [4.0.1] - 2026-10-16

### Fixed

- **发布的 CLI 重新以 Node 作为入口运行时。** `dist/mstar-harness.js` 之前带的 shebang 指向本仓库的开发运行时，因此每次直接运行 `mstar-harness` 或 `npx @mstar-harness/cli` 都跑在 PATH 上碰巧存在的那个运行时上——即使在已有受支持 Node 的机器上，即使包运行器本就用本机 Node 安装。现在 bin 带 Node shebang（`#!/usr/bin/env node`），且 `@mstar-harness/cli` 只声明一个运行时要求（`node >=24.18.0`）。
- **面向用户的运行时文本只提一个运行时。** `store.runtime-unsupported` 的拒绝、`status validate` 的 recovery、`doctor` 的运行时下限提示，都只指明 Node 下限（`>=24.18.0`，原生 `node:sqlite`）与实际执行该入口的运行时，不再把第二个运行时写成要求。store 的 recovery 也不再拿"修正操作者输入"这类通用文本回应运行时拒绝，而是列出全部 store verb **各自必需的选项**（`store init`、`store backup --out <path>`、`store migrate --manifest <path> --apply`、`store activate --manifest <path> --attestation <absolute-json>`、`store retire --manifest <path>`、`store upgrade --operator <name> --harness <control-root>`），并要求带上相同选项重跑实际调用的那个，而不是被改指 `store upgrade`。SDD 证据记录真正执行 supervisor 的运行时，因此从源码运行的捕获能识别自己的运行器，而不会把该运行器模拟的 Node 版本当成入口运行时。
- **文档随入口对齐。** `INSTALL.md`（前置要求、CLI 安装、MCP 启动、doctor 说明）、`README.md`/`README_CN.md` 与 `docs/runtime-reference.md` 只把 Node 下限写成启动要求；从 checkout 的步骤改为指向拥有这些开发工具链命令的维护者文档，不再直接写出命令。宿主插件 README 把运行时下限归因于加载它的宿主。
- **doctor 改为探测其启动真正会用的 `node`。** 每个宿主 MCP 配置都以 `npx` 启动，而 `npx` 用 PATH 上的 `node` 执行 CLI——doctor 现在探测该可执行文件自身的版本，而不再报告 doctor 进程碰巧暴露的版本（从源码运行时那是该运行器模拟出的 Node 版本，并非本机 Node 安装）。探测失败时，该目标以 **unverified** 的 Node 下限报为 mismatch，而不是把无法启动的配置报成 aligned。
- **`status validate` 的运行时 recovery 不再给出无效重试建议。** 它指明入口的 Node 下限，并说明"不改变执行运行时的重试会复现该拒绝"，让处于不支持运行时的操作者去换运行时，而不是重跑同一条命令。
- 两条都补了回归：低于下限的 CLI 用例断言 store recovery 指出被调用的 verb（upgrade 带其选项、`store init` 作为自身命令），且 `status validate` 的 recovery 含"未改变则复现"这一事实；doctor 套件断言未探测到的启动运行时为 mismatch；SDD 证据套件断言记录的工具指纹标明真正执行捕获的运行时。
- **对未变更的 legacy 源重复执行 `store upgrade` 重新成为普通成功。** 执行导入器此前唯一的 replay 路径是按调用方 operation id 匹配，而 CLI 每次调用都新生成 `randomUUID()` 且从不回传，因此对已导入过的树再次升级必然落入 native-id 冲突拒绝，并要求为每个已导入 id 传 `--ack-skip-workflow`。现在导入器还会读取 store **自己留存的导入收据**：每次已提交的导入本就会写一行 `store_operations`，其 `result_json` 携带本次消费的 `sourceDigest` 与已提交的 `importedIds`，而该表从不被裁剪。**与本次完全相同源字节**的收据已列出的冲突 id 即 **proven replay**——该次运行不导入任何行、不需要任何确认，并在 `dispositions` 中逐个说明该 id 已由 native authority 从这些确切字节的导入中持有。这正是本次变更确立的来源政策：只有当留存来源证明同一来源时，同 ID 匹配才算 replay。
- **未证明的冲突行为不变。** 仅仅是 id 相同的不相关 workflow，或记录导入之后字节已变化（`sourceDigest` 不同）的 legacy 源，仍然拒绝 `execution.migration-conflict` 并指明 `--ack-skip-workflow <该 id>`，其未匹配确认的用法错误（exit 2）也保持不变。候选收据在 JS 中做形状校验（`sourceDigest` 字符串等于当前 digest + `importedIds` 字符串数组），而不是因为 JSON 恰好提到该 digest 就采信；查询也绝不按调用方 operation id 索引。守卫顺序保持不变：未匹配确认 → 不安全源拒绝 → 冲突处理。
- **replay 现在还必须证明“塑造行内容的输入”，而不只是字节。** `sourceDigest` 只覆盖本次读取的 legacy 字节，而 `--delivery` 声明与 `--ack-skip-compass` 确认会在不改动这些字节的前提下改变转换产物——因此此前对未变更字节的重复执行可能接受一份**不同**的声明并静默丢弃它，native 行仍保持此前那次导入留下的状态。收据因此额外记录一个 `inputDigest`，覆盖规范化后的声明（按 lift id 排序、固定键序）与 compass 确认（排序）。**两者都不携带**的运行仍仅凭字节证明即可 replay，故此字段出现之前写入的收据继续有效；**携带任一者**的运行则要求收据记录相同的 `inputDigest`，否则该 id 仍是未证明冲突。该拒绝现在只陈述证据支持的内容——留存收据并不能证明此前的导入消费了本次输入，因此本次运行不把该 id 当作已证明的 replay，并保持 native 行不变——并同时在既有 `--ack-skip-workflow <id>` 恢复路径旁给出。不新增拒绝码、表、迁移或 flag。
- **`MinimalImportResult.verdict` 拓宽为 `"upgraded" | "nothing-to-import"`**（增量），与 DSH 导入器既有的词汇一致：提交了行的运行仍报 `upgraded` 及其 `imported` 计数，而未提交任何行但证明至少一次 replay 的运行则报告当前已是最新状态。`docs/commands.md` § Store CLI upgrade and recovery 描述了 proven-replay 结果，并为未证明的冲突保留 `--ack-skip-workflow`。

### Harness

- **`@mstar-harness/commands` 现为严格内部包。** 它标记为 `private`，作为 workspace `devDependency` 消费并内联进 CLI bundle，因此 Release workflow 不再发布它（该发布步骤永远无法成功：该包从未存在于 npm，且 OIDC 可信发布无法创建新包）。
- **根 manifest 完全不再引用 commands。** 它已从 `dependencies` 和 `devDependencies` 中一并删除——根包即 git 安装入口（`omp plugin install github:btspoony/mstar-harness`、`bun add github:…`），而 `workspace:` 协议在工作区之外无法解析，会安装 devDependencies 的 git 安装将因此失败。workspace 内各包仍直接 link commands，`release:prepare` 仍让它的版本与发布同步。
- **已在 registry 上的版本，其发布步骤会被报告为跳过而非失败。** 发布前检查把每个可发布包分类为 `publish` 或 `skip`（已在 registry 上），并在任何 registry 状态未知时拒绝，因此每个发布步骤要么发布、要么明确说明该版本已存在。它只检查 manifest 可发布性与 registry 状态——无法验证 npm 可信发布者/OIDC 授权，那只能由真实发布尝试证明。CI 还会断言 workflow 的发布集合与非 private 的 workspace 包一致。
- `init` 不再把失败的宿主安装当作成功：link / install / build 任一步被拒都会以非零退出结束，并给出原因与恢复路径。
- omp 安装对已存在的插件树改为确定性处理（先经支持的路径移除陈旧条目再 link，并校验实际安装版本），也不再向会忽略它的 install 路径传 scope。
- omp coordinator 工具的 session 参数改用双参 `record` 形式，使工具 schema 在已验证的各宿主 shim 下都能构造成功。
- dsh 的版本不兼容拒绝现在会给出运行时、插件 spec 与 dsh 自身的 `allow-version` 恢复命令，而不只是转发拒绝信息。
- 版本值一律在运行时从 `package.json` 读取；Bun 版本门禁与版本比较测试已删除。
- 当已发布的最新版比正在运行的版本更新时，`init` 会把该最新版 `@mstar-harness/cli` 全局装上，并在版本不同时打印两者：否则 `npx` 的缓存解析可能让较旧的 CLI 运行，而 `init` 的每一步（包括全局安装）都会跟随那个旧版本。registry 探测有超时上限、`--dry-run` 下跳过、离线时静默，因此既不会阻塞也不会让 init 失败。
- README 的 **Install** 章节改为按宿主的列表：每个宿主把 `init` 命令与原生命令分行给出，`init` 被阻塞时不再卡住 onboarding。同时在 `INSTALL.md` 补齐原先缺失的原生路径（OpenCode 的 `opencode.json` 槽位、Cursor 插件 checkout、Codex marketplace 注册）。
- **Release workflow 不再有手动入口。** `workflow_dispatch` 及其 `commit` 输入已移除：发布任务持有 `id-token: write` + `contents: write`，而手动派发会选定一个 ref，仓库写入者可先修改该 ref 上的 workflow 副本再运行，因此发布路径现在只能经已合并的 `release vX.Y.Z` PR 到达。已在 registry 上的版本仍被报告为跳过；发布过程中部分包已发布而失败的 release，恢复方式是准备下一个 patch 版本，由新版本发布其余包。
- **release 预检套件不再钉死发布版本。** `scripts/release-preflight.test.ts` 断言真实 workspace manifest 携带字面量 `"4.0.0"`，于是 `release:prepare` 把所有 manifest bump 到下一个版本后，release 分支上 CI 必红（`lint-scripts-hooks` → `Test scripts`），而 `main` 保持全绿——这是一个普通 PR 无法暴露的、会阻塞发布的失败。期望版本改为从根 manifest（发布版本自身的来源）读取，断言仍能捕获 bump 时有 publishable 包被遗漏。
- **`AGENTS.md` 现在写明这条被违反的规则：** 测试须从权威来源派生易变仓库事实（发布版本、包/角色/skill 清单或数量、检出路径），字面量只能作为不与现实比较的合成 fixture 输入。

### Added

- **PR review 席位 prompt 现在带上强度与共享时间预算。** `mstar pr-review seat-prompt` 在每个席位的 `## Budget` 块开头给出已解析 tier、**整场 review** 的墙钟软上限（`PR_REVIEW_TIER_BUDGETS[tier].wallClockMinutes`），并在提供时给出派发时刻这只共享时钟的剩余分钟（`--remaining-minutes <n>`，负值渲染为已超出分钟数）。席位不再各自获得一份新额度；软上限条目约定到点返回部分结果并在 payload 尾部声明截断，而不是硬停。
- **席位运行期间的监督。** 新增 engine 常量 `PR_REVIEW_NUDGE_CADENCE`（`normalSeconds` / `overrunSeconds`），由 `mstar pr-review budget` 与 tier 表一并打印，为主 agent 提供统一节奏向仍在运行的席位催办剩余预算——共享上限过后切换到更快节奏。措辞（派发、催办、返回即停、超时不等于硬停，以及席位无法中途投递消息的 host 差异——dsh 的 `mstar-pr-seats` 脚本现在要求显式 `budgetLine`，缺失即拒绝并给出恢复文本）位于 `mstar-audit` `references/pr-review.md` 的 **§ Seat supervision (progress nudges)**；`commands/amazing-pr-review.md` 在 Execute 步骤中要求执行该循环。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/opencode-v2`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 4.0.1**。

## [4.0.0] - 2026-10-15

### Fix

- **终态采纳为其终结的 header 写入全新的生命周期时间戳。** 当 `adoptTerminalWorkflow` 结算一个从未关闭的未注册 header 时，采纳时刻现同时成为 `ended_at` 与快照自身的 `updated_at`，而不再复用导入的非终态快照可能仍携带的 `ended_at`、也不再让 `updated_at` 停留在导入时刻。投影与审计不再读到早于后续已记录活动的结束时间。已处于终态的 header 仍逐字节保持其记录的 `status`、`ended_at` 与 `updated_at`。
- 从共享角色 agent 壳中移除 OpenCode 风格的 `tools:` 映射（`write`/`edit`/`bash: true`）：omp 将 agent 的 `tools` 解析为工具名列表，映射形态在 omp 上无效并导致当前 omp 加载 agents 失败。`mode:` 与 `permission:` 未变，因此没有任何宿主丧失席位限制，各宿主回退到自身默认工具面。
- **影子 pack 身份确定性**：来源排序现在使用不受 locale 影响的 code-unit 比较，因此相同的冻结输入无论 locale 行为如何都会生成相同的 `packId`。
- **统一 residual severity 词汇**：文档与引擎使用同一词汇 `critical`、`high`、`medium`、`low` 和 `nit`；枚举外的值会被拒绝，并列出可接受值。
- **唯一 severity 词汇：`critical | high | medium | low | nit`。** 错误的 `info` 已渗入 residual/issue 的 severity 轴 —— 引擎 SSOT、residual 校验、CLI payload 与汇总计数、dsh view/schema，以及 `mstar-artifacts` 参考文档 —— 现在每个 severity 站点重新使用 `nit`，`info` 作为枚举外取值被拒绝。
- **已存储的 severity 由新增 schema 迁移转换**，而非手工改数据：该迁移重建 `issues` 表并使用 `nit` CHECK，在拷贝时将已存的 `info` 改写为 `nit`，保留全部行。更早的迁移语句与 `warning → low` 的 legacy 读取归一化保持不变。

### Harness

- 加固 **opencode-v2 写门**的符号链接别名防护：落点解析器现在沿链接链解析真实落点（8 跳上限，环形/越界以 `write.symlink-resolution-refused` fail-close 拒绝），堵住可经外部别名写入 harness 权威文件（`store.db-wal`）的悬空链接绕过 (#438)。
- 加固 **ZCode git-guard 钩子**的强推检测：对 push argv 做角色分类（选项白名单来自 `git push -h`、值选项消费、首个位置参数为仓库），拒绝 `+refspec` 强推，未知选项形式 fail-close 并指名 token——堵住 `+main:main` 与 `--repo=origin +main:main` 两处绕过 (#439)。
- MCP 与 CLI 的 **spawn 助手可在子进程提前退出时存活**：`child.stdin` 流错误（EPIPE）由助手接管，不再以未处理异常击穿整个进程 (#441)。
- **根 `hooks/` 纳入 CI 覆盖**：CI 运行守卫行为测试与 `node --check`；`hooks/session-context.mjs` 在引擎不可解析时 fail-soft 降级（stderr 诊断 + 不可用权威上下文）而非崩溃 (#445，#446 部分)。
- **status 写锁拒绝信息可诊断**陈旧锁状态（持有者存活 / 确认已死附验证后的移除步骤 / pid 文件缺失），替代裸手改提示；自动接管仍待原子原语后启用 (#447 部分)。
- 精简清理：移除不可达的 CLI target 交互提示与 `@inquirer/prompts` 依赖，删除死导出 `homeRelativeSourcePath`，统一 judgment shadow 的 digest 助手，修正过时的发布脚本注释 (#453 部分)。
- **omp 门钩子现在 fail-close**：门内未预期错误返回显式 deny 信封（门名 + 错误摘要）而非被宿主解读为放行的 `undefined`；deny 信封构造失败则重新抛出 (#443)。
- **dsh `workflow-policy` 获得直接决策测试**：允许清单规范化/边界、各模式行为、未知名称处理、ask 缓存命中/未命中与键规范化、未覆盖计划优先级，附变异咬合证明 (#444)。
- **codex agent 安装器限制备份保留**：每个目标仅保留最新 3 个（按 mtime 排序、尽力而为的清理不会导致安装失败）(#448，部分——engine 回执/台账保留仍开放)。
- **projection 读路径在无变化时跳过重写**：代次指纹未变且已发布行完好时不产生 SQL 写；输入变化时渲染字节等同的旧版输出；已发布行被删/损坏时重建 (#449)。
- **回环 dashboard 现要求每次启动的随机令牌**：CLI 启动时打印带令牌的 URL，有效令牌设置 HttpOnly SameSite=Strict cookie 供页内请求使用，缺失/错误令牌返回无状态泄露的 403；Host/Origin 校验保持不变 (#450)。
- **安装器现在拒绝破坏用户文件**：符号链接/非常规配置目标会被拒绝并给出恢复指引而非静默替换；不完整的 `~/.mstar/harness` 克隆可自愈（保留为 `.broken-<timestamp>` 并重试一次克隆）而非永久阻塞后续安装；成对的 ZCode marketplace 写入失败时恢复两个文件的先前内容 (#452)。
- **发布的命令 schema 如实陈述引擎强制约束**：issue closure 载荷按生效 disposition 发布 `requiredWhen` 分支（`anyOf` 派生自引擎 `ClosureEvidence` 注册表，含 disposition 覆盖），`plan.complete` 发布并校验其声明的完成证据结构——按发布 schema 组装调用的客户端不再撞上不可见的拒绝 (#451)。
- **issue 动作词汇单源化**：engine 导出 `ISSUE_ACTIONS`/`ISSUE_ACTION_NAMES`（每个动作的 payload、read、CAS 与 closure disposition 事实）；CLI 的动词表改为从其派生，替代四份手工清单——漂移现为编译错误，发布 id 由一致性测试钉住。令牌集与行为不变 (#453 余量)。
- **移除了死命令 `judgment review-advice`**（注册、命令族、CLI 适配器/测试、文档、技能路由全链路）。它从未可能成功——唯一的生产调用传了 null evaluator channel，而运行时在读任何输入前就拒绝 null。`packages/judgment` 的影子评估路径不受影响；沙箱校准 worker（scripts/evaluate.ts）已从被删的 CLI spawn 迁移：现导入构建好的 judgment API bundle 并经 connectEvaluatorChannel 提交，沙箱/supervisor 流程不变 (#440)。
- **`hooks/session-context.mjs` 现为打包产物**：源码移至 `hooks/src/session-context.ts`，经 ZCode hooks builder 构建（内联 engine），SessionStart 钩子可在无 `node_modules` 时独立运行；fail-soft 不可用权威诊断保留并有裸拷贝冒烟测试覆盖 (#446)。
- **门路径解析在 engine 单源化**（`host-gate-paths.ts`）并由全部五个执行点采用（opencode v1、opencode-v2、omp、dsh、ZCode 写门）：符号链接链被解析到真实落点并带 8 跳 fail-close 上限——v1/omp/dsh/ZCode 从一跳解析升级，关闭批次 1 在 opencode-v2 修复过的别名绕过类。各宿主保留自己的拒绝信封 (#442)。
- 新增 `/amazing-test-audit` 入口（含 Codex/dsh 项目级命令安装）与 `mstar-audit` 测试套件深度方法 `references/test-audit.md` —— 价值门槛、撰写门禁、junk 模式扫描、保留门槛、逐候选证据字段、发现泳道，以及整子系统 campaign（逐测试 R/F/C/D 台账）；并接入 SKILL.md 变体分发、playbook § 4 与 full-audit 范围变体。
- 新增四个规范 audit 命令定义，保留有界 scaffold/promote 写入效果及现有 secret、supply-chain 扫描器。
- 将 audit CLI 身份接入共享命令定义，并新增基于真实夹具的家族行为覆盖。
- **测试编写审计检查：**代码库、测试套件及 PR 审查现在须报告偶然性、源码形状、接线或环境常量断言，并给出“删除，或替换为产品行为断言”的结论。实现与审查契约同步纳入 PR #280 的四个反例，同时保留产品行为断言与修复前先失败的回归防线；被拒绝的断言不得改名或重新固定期望值。
- **PR 审查分数改为递减扣分制并引入分数档位。** `computePrTally` 按类内逐条发现递减扣分——must-fix 首条 45、此后每条 15；should-fix `max(12 − 3·(n−1), 2)` → 12,9,6,3,2,2…；nit 首条 2、此后每条 1（类上限 8）；unverified 每条 5（类上限 15）——`score_pct` 下限为 0，并为结果标注**分数档位**：`mergeable` ≥ 90 · `good` 80–89 · `pass` 60–79 · `fail` < 60。verdict 推导不变（按计数、三个 token），分数与档位永不覆盖 verdict。engine 新增导出 `PrScoreBand` / `PR_SCORE_BANDS` / `scoreBand()`；`PrTallyResult` 新增 `band`。
- chat 显示首行现为 `{verdict} · {score_pct}% ({band})`，GitHub 报告结论标题现为 `· Score <score_pct>% (<band>)`——该推导值标注为 **Score**（每条发现证据字段中的 `- **Confidence**:` 属另一概念，保持不变）。
- `mstar pr-review validate-report` 依据同一套锁定扣分表重算 `score_pct`（不存在第二套公式）；`mstar.review/v1` 信封接受可选的 `tally.band`——缺省仍合法，存在时必须是合法档位 token。信封 payload schema/帮助文本现已列出这些档位 token，且 `MstarReviewV1.tally` 采用 band 可选的 envelope tally 形状（`MstarReviewTally`），使缺少 band 的历史信封仍可通过类型检查。
- 更新 `mstar-audit/references/pr-review.md`（扣分表、档位定义、worked-example 校验表、显示契约）、`commands/amazing-pr-review.md` 与 `docs/commands.md`。
- 将 CI `test-cli` 任务 —— 在 run 37018503961 实测 **594s**、次慢任务 249s —— 拆为四个独立并行任务，使 CI 墙钟等于最慢分片而非总和：`test-cli-coordination`（`test/plan-coordination.test.ts`，163.6s）、`test-cli-ops`（次重的 8 个文件，合计约 190.4s）、`test-cli-web`（`web/` view-model 批次），以及 `test-cli-suite`（动态余量）。
- 余量分片在运行时自行计算文件清单 —— 在包根递归 `find`，匹配 `bun test` 的四类文档化文件名（`*.test.*`、`*_test.*`、`*.spec.*`、`*_spec.*`，任意扩展名），并剪除 `node_modules`/`dist`/`.git` 与 `web`，再排除 9 个显式路径 —— 新加入的测试文件会自动归入该分片，无需分片清单登记表，也无需守护脚本。发现过程为失败即停：余量为空时会命中显式守卫，以退出码 1 终止并打印自解释错误，绝不退化为裸 `bun test` 而把其他分片静默重跑一遍；`web/` 批次采用同样的发现方式，为空时打印提示并以通过结束。
- 各分片原样保留原任务的 setup 链，并显式构建 CLI（`bun run cli:build`，等价于旧命令 `bun run --cwd packages/cli test` 自行执行的包 `build` 脚本），已在 workflow 头部注释中说明。
- 将 CLI 测试分片从 4 个 job 拆为 6 个（`test-cli-ops` → `test-cli-ops-a` + `test-cli-ops-b`；`test-cli-suite` → `test-cli-suite-a` + `test-cli-suite-b`，动态剩余按 `LC_ALL=C` 排序后的奇偶行对半分配），在两个分片漂移到 5 分钟以上后将 CI 墙钟时间压回约 3 分钟；全量覆盖与空集 fail-closed 守卫语义不变。
- 按**命令属主组织 CLI 子进程测试**，退役历史 `slice4-cli.test.ts` 容器，同时保留全部分组、参数行、断言和夹具内容。迁入分组复用 CLI spawn harness 与包内断言/内容支持模块；既有 skill、lease、worktree 覆盖与各自独立的 sibling 分组并存。
- 提高 `CLI init --target dsh` 适配器用例的超时：每个用例都会 spawn `bun run src/index.ts`（冷启动 TypeScript + 适配器自身的子进程工作），默认 5s 预算与 CI runner 的实际开销过于接近，单次启动偏慢即导致套件失败。
- 从 `packages/engine/test/coordination.test.ts` 移除重新引入的重复 `binding` 测试组（420 行字节级相同副本）；八个 binding 契约继续由 `packages/engine/test/coordination-bind.test.ts` 独家持有，生产 coordination 代码与共享 fixtures 均不变。
- **隔离 actor-only CLI 回归：** 将 close、triage、supersede 和 link 分别放入独立的 active-store 夹具，避免多条独立子进程工作流共用一个测试的超时预算；保留全部状态断言及默认超时，不改变 CLI 行为。
- **完成三类 lint 积压整改**，覆盖约 480 个位置：Rule #341 拒绝恢复、帮助可达性，以及冻结不变量 hash-gate 结构。
- **使门禁真正生效：** refusal-quality 与 help-reachability 现以空 allowlist 通过；hash-gates CI 步骤现会阻断违规。hash-gates 将 3 个已授权门禁和 11 个允许重放的位置与违规项分别报告。
- **明确标记语义：** `// reachability: manual — <reason>` 仅在理由非空时标记该单一位置的人工恢复；`// hash-gate: authorized — <reason>` 仅在理由非空时授权相邻的不变量门禁。标记只分类其自身位置，不会屏蔽相邻位置的发现。
- 跟踪内容未加入任何机器本地 store 标识符。
- 新增**过度设计 lint 家族**在 CI 强制执行 #341/#365 冻结契约：`lint:refusal-quality`（结构化拒绝通道的 cause/recovery 存在性）与 `lint:help-reachability`（恢复文本必须指向可达动词/旗标），并入已接线的 `lint:hash-gates`（`continue-on-error`，待既有 main 违规分诊后翻阻断）；有界豁免清单均以真实跟踪 issue 为凭。
- 新增 **QC 判例透镜**（`overdesign-judge.md`，engine/commands diff 必读）：承载 AST 无法判定的规则——门限对运行模型的必要性、门限与契约一致性、自写记录重验、协议尺度——设计为 advisory，判例席自身不得成为新的过度门禁。
- 新增**已知答案回测套件**，证明该家族能抓住 #340/#341 的历史实例类，未覆盖类如实标注并转入判例审查。
- **Agent 优先的 CLI 可操作性（#393）：** `--help`、`schema` 与准入校验统一由共享注册契约派生（运行时 `tools/list` 实测 118 个命令）；缺失输入以单次聚合拒绝呈现全部缺失字段（path/code/expected/received）、最小必填集、安全默认、条件/备选事实、`helpRoute` 与 `recovery`，CLI 与 MCP 一致。
- **错误保真（本计划触及的族：session、milestone、pr-review、audit、dashboard、status、workflow）：** 本计划触及的拒绝路径上引擎创作的 `code`/`message`/`details` 原样透传。畸形 attestation/proof/evidence/policy 的解析原因经过消毒：真实解析器语法与解析器上报位置保留，提交的操作数与秘密形状内容被隐藏——以真实 Bun 1.4.0 与 Node 24 畸形输入按运行时分别验证，非普遍声明。schema 不兼容拒绝以三个独立机器事实报告最高已应用 schema、支持上限与首个未知 migration。
- **公共操作：** `workflow-note.append`/`workflow-note.coverage` 以 CLI 与 MCP 进入规范注册表；环境 `MSTAR_HOST_SESSION_ID` 或 launcher-minted 身份可在不带 `--session-id` 时满足调用者上下文要求（built bundle 实测），显式选择器优先级保留，无身份/畸形选择器拒绝且不写入。`issue.*` 变更发布数字版本 CAS、拒绝空白 replay id、并在回执返回生成 id。`workflow.evidence` 发布按交付类型的文件内容契约，保留记录时可修订与关闭时冻结。
- **终态恢复与 native coordinator：** `workflow.adopt-terminal` 通过可选操作者证明结算未登记的 ACTIVE 会话，要求目标完备并按操作保留文件恢复指引（保留 POSIX 错误码）；只读 store 打开可跨越 Bun writer 关闭窗口收敛（有界重试，持久损坏仍拒绝）。注册的 `mstar_coordinator` 契约以宿主派生身份绑定/恢复 ACTIVE schema-9 权威，聚合拒绝并携带真实 loadedEntry 溯源——仅在 SDK 18.3 adapter 路由上取证；不替换运行中宿主的缓存注册，其指引不再承诺 reload 式替换。
- 命令准入现在返回**分组结构化诊断**：每条 schema 违规都在 `details.diagnostics` 中携带安全字段路径、稳定 issue code、消息与数组索引，一次调用即可报告全部缺失或畸形字段，而非仅拼接消息。
- **CLI 解析错误指名字段**：缺失参数与选项值在可确定时标明输入字段与叶子帮助路由（`mstar <path> --help`）；未知旗标保留诚实的解析诊断，不猜测字段。usage 响应保持 `usage`/exit 2，与引擎拒绝相区分。
- Plan 写入在已获取身份的 workflow coordinator 下使用明确 plan 地址。稀疏 own-context 推导保留实际 scope、身份、token 与状态冲突的结构化诊断。停止身份恢复仅点名 workflow coordinator 与真实停止见证，不再逐行替换。
- schema 拒绝的 usage 消息构造现在**有界**：当被拒输入产生超过 20 条 issue 时，首行消息携带前 20 条原因加明确的 `…and N more issues` 指针，`details.diagnostics` 保留全部诊断（不设上限，沿用已有的 secret-shape 脱敏）。`rejected` 摘要字段只报告首条 cause 的 flag/expected/received 事实；逐条完整事实在 `details.diagnostics`。
- CLI 与 commands 顶层拒绝共用同一信封，提供帮助路由和恢复指引；输入 schema 错误经过集中校验，根级联合约束指引得以保留，schema discovery 会发布准确的协调者和计划恢复 token 类型。
- 新增运行时 payload schema 与 `mstar-harness schema <TypeName>` 输出；issue 与 plan payload 帮助文本现指向对应 schema。
- 聚合 issue 与已覆盖 plan payload 的校验，使单次拒绝指出全部无效及缺失字段。
- **CLI 命令面**：除安装器以外的命令现由规范的 `@mstar-harness/commands` 定义生成。`mstar init` 仍是安装器。解析失败返回 version-1 用法信封并退出 2；命令结果保留已记录的退出码，包括 SDD task 的 3 以及子进程的 124/127/128+n。
- **运行时会话选择器与生成包**：`plan.bind` 使用调用上下文运行时身份而非请求字段，CLI 声明的会话选择器会传递至处理器上下文（包括 `workflow recover-coordinator --stopped` 多值列表），`packages/commands/dist` 由本地构建生成而不再跟踪。
- 保留结构化引擎错误详情并派生拒绝响应帮助元数据；覆盖省略参数时的 usage/refused 默认行为。
- 未知 MCP 工具调用现在会在适用时返回相近工具名称建议，并引导调用者使用 `tools/list`。
- **提交身份策略**：写仓库的 agent 使用已配置的 Git 作者／提交者身份，禁止编造或逐次提交覆盖。提交前检查 `git config --get user.name` / `git config --get user.email`：空值即 Blocked，防止使用 Git 自动合成的身份；由操作者配置用户身份或改用已配置的检出。完成报告须提供显示作者的 `git log -1 --format='%h %an <%ae>'` 证据。
- **提交入口覆盖**：分支／worktree 指引、首次及 sticky SDD 提示与文件交接、共享及 Cursor 计划模式桥接与规则、迭代收口与知识初始化配方、PM 派发报告均指向共享 leaf Git 规则这一唯一权威。执行消费者测试 fixture 改用中性测试身份；engine、CLI 与 hook 行为不变。
- 新增 coordinator-only `mstar session run --workflow W --role coordinator [--harness H] -- <argv>`：子进程本地身份替换伪造/legacy 输入，继承 stdio 并传播退出码/信号。Session recover 在独立获取身份与停止见证下替换明确停止的 workflow coordinator。
- Plan 文件/ACTIVE 传输保持互斥。普通动作可推导当前 coordinator context；显式 session reference/token/operation 仍作为约束。混合权威或数值 ACTIVE expectation 在 payload IO 前拒绝。
- `mstar workflow register` / `iteration register` 经原子 DB 注册发布，`workflow evidence` 记录 delivery 转换，`status workflow-close` 执行终态 lifecycle 转换——active 路由上不再有文件 close、不再有 unregister 步骤、不再重写 `--ended-at`。闭合的 `phase`/`lifecycle`/`execution-policy`/`integration-worktree` 语法并入既有 `mstar workflow` 组。
- `store execution restore-preview` 与 `restore` 使用普通 `store backup` 镜像执行灾难恢复；`export` 报告 live execution state。staged execution migration 动词（`preview`、`apply`、`activate`、`retire`、`abort`）已删除。`store activate` 仅保留 issue/catalog migration 步骤。
- `status validate` 报告 active 写入作为 CAS 消费的根级与逐 workflow 执行令牌，因此调用方从一次读取取得 `--expect`，而不是自己编一个。
- **带显式 operation id 的 coordinator bind 重试现在就是已记录的回放。** `bindExecutionSession` 的 `expected` 变为可选，并在写事务内从 workflow 自身 header 解析当前令牌；bind 请求指纹携带"省略新鲜度"的标记而非新推导的令牌，因此首次提交推进 revision 之后，未变更的 `{workflowId, operationId}` 重试会作为回放返回，而不是 `execution.operation-conflict`。显式提供的令牌仍保持严格 CAS 语义：过期值仍以 `execution.stale-token` 拒绝，同一 operation id 携带不同的显式令牌仍是操作冲突。
- 宿主自有的 `mstar_coordinator` ACTIVE `bind` 在调用方省略 `expected` 时按省略转发（由引擎解析），并在未提供 operation id 时自行铸造；其 `recover` 分支仍从被寻址的权威读取当前令牌，因为 `recoverExecutionCoordinator` 要求显式令牌。注册工具描述、参数广告与 `mstar-host` 的 OMP 参考已陈述同一契约。
- **不兼容 store 的 FILE 恢复保留引擎事实与已加载模块来源。** stored-target reader 的 §4.3 权威否决现在携带原始抛出的 `StoreError`，FILE 恢复边界通过共享的 engine-refusal 路径投影它，因此 `store.schema-unsupported` 拒绝会连同三个 schema 版本事实、`loadedEntry` 与不兼容已加载构建的指引一起抵达调用方——与 bind / show-recovery / ACTIVE-recovery 分支既有的保真度一致。
- **协调者身份必须显式获取，不再生成。** 新的协调者绑定必须显式提供 session id：引擎在写入前以 `coordination.identity-missing` 拒绝缺失身份，而不是生成 UUID；`plan bind --coordinator` 不再把继承的 `MSTAR_HOST_SESSION_ID` 当作授权。本地操作者显式传入 `--session-id`；托管宿主会话使用新的宿主工具。
- **新增仅适配器使用的 `ExecutionIdentity` 类型**（`packages/engine/src/session-identity.ts`）：`(规范 harness 根, workflowId, role, planId, sessionId)` 元组与 `validateExecutionIdentity`，供引擎、CLI 与宿主适配器共用，避免各自声明第二份形状。
- **新增宿主自有工具 `mstar_coordinator`（`bind`）**：扩展从宿主取得原生 session id、从宿主 cwd 推导规范控制根，拒绝 leaf/scoped-plan 调用者，且不接受 session id、root、调用者角色、授权标志或凭据路径。
- **移除对裸 `bash` 的环境变量注入。** 通过 `bash`/`functions.bash` 发起的托管 `plan bind --coordinator` 会在执行前被拦截并重定向到 `mstar_coordinator`；无关 shell 调用保持不变，缺失或不支持的 `env` 字段不再产生输入修订。
- 新增受审计的 **JSON Prepare coordinator 恢复**（`showPrepareCoordinatorRecovery` / `recoverPrepareCoordinator`，前置契约 §3.3）：当被记录的属主已无法通过授权时替换该工作流的 coordinator 绑定——即宿主 handoff 被取消后留下的状态。它刻意比既有的 active-DB 恢复（`execution-workflow.ts`）更窄：后者继续保留完整 execution token 与 stop 证明路径，本入口不做 prepared-plan 接管、不做 lease 转移、不重写原始 session、也没有 force 开关。
- 写入只在快照写锁内被准入，并要求：文件权威（active execution authority 下直接拒绝并指向既有 DB 恢复动词）、本规范根下已注册且 running 的迭代、已提交的注册、仍能认证**精确**被记录 coordinator 的先前信封、指向该工作流 coordinator 席位的全新获取身份、显式 reason + 授权引用 + 指名该持有者的停止声明、两份新鲜字节版本、以及覆盖**全部行**的原始 `prepareAdmission`。所有语义拒绝都发生在创建任何文件之前。
- 被接受的效果仅为：通过既有独占创建生成一个按角色区分的信封、替换顶层 coordinator 绑定、追加一条不可变的 `coordination.identity_recoveries` 审计记录（operation id、请求摘要、两个公开 session id、授权引用、reason、停止声明、两份版本、时间——绝不含凭据或信封正文）、刷新 `updated_at`。行、分支锚点、证据与兄弟工作流保持逐字节不变；旧信封字节作为历史保留，因绑定已移动而不再授权。
- 快照 schema owner（`coordination-write.ts`）对审计做严格校验，普通写入者会将其钉住（通过通用快照写入删除、改写或伪造审计条目一律以 `coordination.direct-write-refused` 拒绝）。独占信封创建与快照提交之间发生崩溃时只报告失败——绝不返回成功回执——并且只回收该操作自身创建的那个信封；精确重试返回已记录回执且不产生版本churn，而变更请求、过期令牌或已被取代的绑定一律拒绝。
- 新增传输：`mstar workflow recover-coordinator`（显式运维路径，用法错误 exit 2、拒绝 exit 1）以及宿主自有的 `mstar_coordinator` 工具的 `show-recovery` / `recover` 操作；两者都从宿主/引擎事实推导原生 session id、规范控制根与被记录的先前持有者，绝不接受调用方提供的值。公开投影严格限于 §3.3 所列字段：coordinator 信封/凭据路径仍留在 coordinator 自有传输中，CLI 的 JSON 与诊断永不打印它；停止声明的每个条目在参与哈希、存储或回显之前，都必须是公开 session id（单一安全路径组件、长度受限）。
- 三处接缝的已复核令牌完整性均已闭合：恢复在提交前立即重读 compass（window 内并发编辑 compass 会以 `stale` 拒绝，且只回收本次操作的信封）、崩溃清理仅在文件字节仍等于本次操作写入的字节时才删除遗留信封（路径已被替换则原样保留）、create-only 的通用快照写入一律不得携带 `coordination.identity_recoveries`——恢复历史属于来源证明，而非形状校验。
- **identity-missing 拒绝信息逐字写明供给路径。** 所有因缺少会话身份而拒绝的 active 路由——各种形态的 `plan bind`（coordinator、identity session、稀疏、resume）、`plan show`、稀疏 plan 操作、workflow transitions/evidence/recovery——现在都在拒绝文本中写明供给方式：CLI `--session-id`（或 `MSTAR_HOST_SESSION_ID`），MCP：宿主每次调用传 `sessionId`。ACTIVE 注册拒绝文本随"creator 可选"契约重塑：只有 `expect` 和 `operation` 可能缺失，并说明未设置身份时将注册 NULL creator、由首个 coordinator bind 收养。
- **`mstar doctor --target omp` 现报告真实的插件对齐状态。** doctor 的 `pluginVersionNote` 改由新增的 `detectPluginVersion` 效应提供（CLI 侧复用既有按宿主发现逻辑；omp 走 `omp plugin list`），因此"CLI X 比已安装插件 Y 新——请更新插件：omp plugin install @mstar-harness/omp"的过期插件指引与未安装提示都基于实际探测到的版本，而不是永远声称未找到插件。
- **ACTIVE 注册不再强制会话身份（issue #383c）。** `workflow register` / `iteration.register` 在 ACTIVE DB 路径上接受无会话身份的调用者并写入 NULL `creator_session_id`；传输层提供了显式 id 时仍照常记录为归属。信任边界不变且有端到端回归：首个 coordinator bind 独家收养 NULL-creator 工作流，存在任何 coordinator 记录后再次收养被拒，creator fence 与 duplicate-holder/holder 匹配门禁原样保留。
- `validateExecutionIdentity` 新增仅限注册的显式放宽（`allowUnsetSessionId`）：归一化后的空字符串在创建路径上视为"未设置"，其余所有调用方仍遵守"身份必须显式获取"的规则。
- 改写注册拒绝信息，披露状态及受支持的下一步操作。
- **MCP 会话身份：** MCP 解析路径已移除 `MSTAR_HOST_SESSION_ID` 环境变量回退。`session.recover` 等消费身份的命令仅通过其显式单次调用 `sessionId` 输入（既有的 CLI `--session-id` 标志 / MCP schema 字段对等）获取主对话会话 ID；缺少该参数时现有的安全拒绝行为保持不变。MCP 侧身份测试现已固化身份门专属拒绝、错误会话所有权拒绝与真实 CLI 解析路由。
- **环境变量带入的 ambient identity 不再阻止 legacy `mstar plan bind --resume`**；该路由忽略 ambient 环境身份，并拒绝已声明的身份（`--session-id` 或宿主提供的身份）。
- 所有已注册 plan 指针统一走 **唯一** 路径解析器（前置契约 §4）：引擎 barrel 在 `planDeclaredHeaders` 之外导出 `resolveRegisteredPlanFile` / `PlanPathError`，注册、Prepare append 与后续 readiness 共用同一解析器，不再各自复述 `{PLAN_DIR}/<plan-id>.md` 约定。
- `mstar iteration register` 现在把 **规范化绝对路径** 写入 snapshot，而不再原样复制调用方拼写；catalog 注册预检会在第一条 `prepared` journal 行之前解析并拒绝 iteration 行指针——仓库相对拼写 `.mstar/plans/<id>.md` 会带着（收到的形式、base、期望的规范目标、允许的形式）被拒绝，且不产生 root、snapshot 或 journal 写入；被规范化的请求才是参与哈希、入库并交给 producer 的表示，且 shipped 入口的默认 operation id 也由同一份规范化 workflow 推导，同一目标的等价拼写共享同一 operation 身份。
- Prepare `appendPlans` 的指针校验改用同一解析器（其私有 fence-aware 解析器已删除）；`invalid-plan` 拒绝词汇与错误码保持不变，并附带解析器的类型化路径详情；缺失或非字符串的 append 指针会返回该错误码，而不再以原生路径 `TypeError` 逃逸。standalone/audit 的 catalog 位置 schema 不变。
- 解析器在**任何**路径 API 接触之前先确定指针的**形状**：因此持有导出契约的调用方（JavaScript 调用方或解码出的负载）若缺少 `file`、传入 `null`、数字或对象，会以 `plan-path.invalid-pointer` 被拒绝——只说明收到的类型、绝不回显被拒绝的值——而不再抛出无法映射到自身领域拒绝的原生 Node `TypeError`。
- 为受守卫的 **Prepare workflow 修订入口**（`amendPrepareWorkflow` / `mstar workflow amend-prepare`）新增可选 `correctPlanFiles` 列表（前置契约 §4.1）：每个条目以该行**当前持有的精确指针**（`expectedFile`）和该行自身的规范 plan 文件（`file`）定位一条既有 Todo 行，从而在无需手工改快照的前提下修复畸形的仓库相对指针。`appendPlans` 仍然存在——仅做修正的调用传空数组。
- 修正只移动被指向行的 `file`（以及常规 `updated_at`）；其余行字段、根注册表与 review 文档全部按值保留。未知行或指向有歧义的行、行指针与 `expectedFile` 不一致、旧指针并不指向同一 plan、不产生变化的指针、与 append 冲突或重复的 id、以及被共享解析器 `resolveRegisteredPlanFile` 拒绝的新指针，一律零写入拒绝；coordinator 身份、Prepare/no-execution admission、双重字节版本 CAS、compass plan-id 集合与最后一次 compass 复检保持不变。
- 旧指针只接受两种形式：共享解析器接受的形式（规范绝对路径或规范化 harness 相对路径），或由本控制根已配置的 plan 目录与拥有它的仓库根推导出的**精确**仓库相对拼写。越界绝对路径、同名猜测、无关目录前缀、以及带有匹配 header 的复制文档一律拒绝；常规注册与 readiness 仍不接受该拼写。
- Phase-1 就绪检查现在消费**共享**前置接口，而不再使用自己的路径/基准逻辑（前置契约 §4/§5）：每个已注册计划行的指针都经唯一的 `resolveRegisteredPlanFile` 解析器解析（与注册及受保护的 Prepare 修正同一解析器，包含 `.mstarc` 声明或外部 `{PLAN_DIR}`），coordinator 身份判定则读取引擎自有的只读 `showPrepareCoordinatorRecovery` 视图。
- 拒绝仍保留调用方依赖的冻结宽码（`binding-invalid`、`prepare-not-locked` 等），并新增类型化 **diagnostic**：指明 §5 子原因、主体、安全的身份来源标签、已在场的公开 id、计划指针的规范 base/target 以及下一步受支持操作。身份细因区分 `identity-missing`、`identity-mismatch`、`foreign-owner`、`recovery-not-prepare`、`recovery-stale`、`recovery-unauthorized`；路径细因区分 `plan-pointer-invalid`、`plan-identity-mismatch` 与真正未锁的 `prepare-unlocked`。
- 因此过期存储指针（契约前的 `.mstar/plans/<id>.md` 拼写）绝不会被渲染为“未锁指南针”：它保留自己的路径细因，且就绪检查从不规范化或修复该行——受保护的 Prepare 计划文件修正仍是唯一的修复操作。
- 已注册的 model-handoff 工具把这些 diagnostics 原样转发进 `not-ready` details，并在拒绝文本中点明类型化原因与下一步受支持操作。diagnostics 只渲染公开 id、代码与规范计划指针：绝不包含信封路径、凭据、session JSON 或环境负载。因此被拒绝的计划指针只按其**接收形态**（规范绝对路径或 harness 相对路径）分类，而不携带其持有的值；receipt 与行不一致时也只报告规范期望值——畸形存储行不再可能泄露任意绝对路径。
- 批量开发依赖更新，将 dependabot PR #455–#460 合并为一次变更：GitHub Actions 版本提升、@types/node 26、js-yaml 5、vitest 5、katex 0.19、shiki/@shikijs/langs 4.5、`@modelcontextprotocol/client` 2.3.1、simple-icons 16.34、`use-sync-external-store` 1.7，以及 `dsh-llm-fallbacks` 0.6.5 pin 与 engine 常量同步。
- 类型检查与声明产物改用 TypeScript 7（tsgo）；四个基于 AST 的 lint 扫描器在 tsgo 提供 `createSourceFile` 级解析 API 之前，继续通过新增的 `typescript5` 别名使用 TypeScript 5 解析。
- 中文品牌文案统一重命名为 **晨星**（文档、skill description、宿主参考、marketplace `zh-CN` 显示名与 dsh 面板 locale 值）。
- 移除英文语境中的中文括注：插件 `longDescription` 与各包 README 直接写 `Morning Star …`，不替换为 `（晨星）`。根 README 双语对保留品牌行 `Morning Star (晨星)`，使两种语言在同一变更集内同步。
- **面向 runtime 用户的 README。** README.md 与 README_CN.md 重写为给使用 AI 编程工具做开发的人阅读：直白的定位与适用场景、覆盖七个宿主的精简安装/校验说明、三种入口形态（单任务、迭代、审计/Review/验证）、以每语言一张 Mermaid 图呈现的交付流程，以及以 help 为主的 CLI 说明（`--help` 列出命令期望的输入，包括 issue payload 字段的必填性与类型；用法被拒绝时给出问题、help 路径与恢复方式）。
- **产品标识恢复。** 两份 README 恢复原副标题（`Harness Workflow Engine · Agent Plugin`）与完整 badge 组合 —— CI、license、version、last commit、dshfind、Greptile 以及四个 npm 下载徽章。
- **保留角色概览。** 两份 README 保留原角色表格，表后简要说明 PM 如何派发工作；移除关于修改 Markdown 来适配团队习惯的措辞。
- **工作流图。** 编号式流程清单替换为每份 README 一张 Mermaid 图：计划 → 实现 → 独立审查 → 含返工回路的验收 → 迭代重复 → PR 检查与审查修正 → merge-ready → 显式授权后合并 → 核实合并并收尾；另附 hotfix/inline 与 report-only 路线的范围说明。
- **Dashboard 与 MCP 小节。** 两份 README 新增独立的 Dashboard 与 MCP 小节 —— 用户能看到或能做什么，以及最小启动示例 —— 并以此取代命令行小节中重复的 dashboard/MCP 条目。
- **参考文档拆分。** 组件、存储、CLI 契约、report 与 enforcement 细节从首页迁入新增的 docs/runtime-reference.md —— 角色与技能的详细参考、MCP 宿主集成说明也在该页，首页保留角色概览与面向用户的简短 MCP 介绍 —— INSTALL.md 的 report 链接改指其 Offline report draft 锚点。
- **安装事实修正。** omp 需要先安装其 CLI；`init` 默认 `--scope project`，各宿主表现不同（dsh 的 profile 是机器全局的；Codex 的 global scope 不安装命令 skill）；runtime 参考文档记录七个宿主的 MCP 启动配置，含随包提供、经 `@deepseek-ai/dsh-mcp-client` 桥接插件加载的 dsh Cordis 行；迭代措辞改为 Phase 2–6 生命周期。
- **精简 README 安装入口。** 中英文安装章节直接从宿主表格开始；新增 **Node.js 24+** badge，链接到 `INSTALL.md` 中的完整前置要求。保留现有 badges，并将 MCP 的前置要求链接指向同一参考。运行时要求不变。
- 在 `AGENTS.md` 记录本仓库的 CLI 使用规则：运行本检出自己的构建（`bun run --cwd packages/cli build`，随后 `packages/cli/dist/mstar-harness.js`），而不是全局安装的 `mstar`/`mstar-harness`。全局安装是给其他项目用的已发布包——把本检出 link 进去会让那些项目跑到未发布代码，而在这里调用全局副本则是用已发布 CLI 去操作未发布的引擎行为。
- 在 `mstar-compound` 的知识文档质量门新增两条**正文卫生规则**：durable 正文陈述规则与结论，不写撰写日期（时间信息属于 frontmatter 的 `date` / `last_updated` schema 字段）；引用使用 repo-relative 路径或 `{HARNESS_DIR}` 等符号，不写机器专属绝对路径。
- 把 `CONCEPTS.md` 既有的「no status/date/owner fields」规则落到 compound 写入路径。
- 新增 **Guard 8**，校验已跟踪 Markdown 中的链接与标题锚点，并使用规范的 `github-slugger` 行为解析标题片段。
- 同文件片段链接（如 `#section-name`）会针对其源文档进行校验。
- **`drift-lint` 门禁清零**：dashboard 文件头注释改写为纯行为描述——跟踪文本不再包含本地 plan/iteration id（清除 14 处出处引用，扫描报告 0）。
- 两个 README 的大标题恢复为产品名 `Morning Star`（原为 `Morning Star (晨星)`）。中文品牌名保留在中文版首句，两处单行改动保持 README 双语对的尺寸镜像。
- 在仓库根忽略瞬时 **Bun 缓存输出**（`/Library/Caches/bun/`），会话环境落下的缓存目录不再弄脏 worktree `git status` 或阻塞干净工作树门禁。
- **`validate` 门禁修复**：engine 重新可构建、可类型检查——根导出 `Severity` 重复（core 与 issue 两套词表）收敛为规范的 core 路径，引擎测试与 `initializeStore` 中的 undefined 收窄 / 匹配器重载错误已修复，运行时语义不变。`packages/cli` 的 `typecheck:src` 现在先生成被 gitignore 的 dashboard 资产模块（`scripts/build-web.ts`；确定性、往返校验），全新检出无需完整构建即可通过类型检查。
- 移除未被使用的根 `specs/` 跟踪目录：`{SPECS_DIR}` 解析始终优先选中 `{HARNESS_DIR}/specs/`，该根目录副本从未被解析、不随任何包发布、亦无任何引用。
- **哈希仅作溯源，不作门禁。** 删除已准备文档、已提交证据、workflow/catalog/roadmap 操作、迁移/覆盖/激活、恢复及存储 schema 记录中的内容哈希与规范序列化相等拒绝。普通文档编辑不再要求恢复字节、收养、重封或重签；已有摘要保留为历史信息。
- **保留真实约束。** 同一 operation-id 的不同请求仍触发 replay 冲突；当前语义 scope/owner/QA/state/path、数字 revision 与 execution-token 约束及真实 Git 交付事实仍有效。删除过时的字节版本、manifest/coverage 哈希及恢复 loss 摘要准入输入，不新增 bypass 或替代封印协议。
- 对齐 canonical CLI/workflow/evidence 指引，并新增四个含语义负对照的定向路由场景；生成宿主资产继续由 canonical 源派生。
- 接受语义等价的 session reference 与 execution-token key JSON，不再要求字节规范化。保留中断的 ledger 尾部而非截断或拒绝；仅清退已审查的 index 行，保留后增行与正文内容。
- 新增有界架构检查，识别哈希、原始字节及规范序列化相等的拒绝/断言；每个 replay 例外均须有 operation-id 查询关联证据。
- 删除 persist --expect-version、Prepare recovery/amendment 字节版本输入及 store execution restore --accept-loss-digest。额外 primary 启动准入移除，不以另一种 seal 替代。
- Restore 比较已授权损失的行身份/revision 与 operation ID，盘点并安装同一份私有备份副本，保留即时恢复前安全备份。仅新增待丢失工作或权威世代变化需要重新预览，不因摘要变化要求重签。
- Legacy 迁移在根锁内派生当前 source，保留 workflow/plan 成员与当前 coordinator 归属。已删除启动 reservation 无 replay/repair 后继。
- 在 help 中明确 `persist write` 的整文档覆盖语义，迁移消费者测试中的过时 hash/CAS 期望，并转义代码字面量中的非 ASCII 字符以适配 bundled CLI。
- 在暂存副本前校验 recovery-point 路径，缺失/不可读备份返回类型化拒绝及公开 backup/preview 恢复指引；由当前 engine 重建已提交的 ZCode hook bundle。
- ledger 在 commit 前保留原文件描述符，避免 inode 复用掩盖目标替换；迁移刷新删除失效的 `ended_at` 并保留作者注释。actor-only mutation 场景保持独立隔离，不再把十三次 CLI 调用集中到一个超时预算下。
- **面向恢复的引擎接口。** 导出的生命周期操作接受**稀疏意图**（可省略冗余选择器、修订号、会话投影与复制的元数据），依据调用者可信根、持久关联与已记录声明完成解析；事务内实际输入仍严格。已发布解析器：`resolveIntentRoot`、`resolveIntentTarget`、`resolveCurrentAuthority`。
- **每个结果都带同一份恢复副载。** 成功值携带 `recovery`，拒绝则在 `error.details.recovery` 下携带同一对象（`outcome`、`applied`、`unresolved`、`resolvedFrom`、`warnings`、`commitState`）——部分应用的复合意图绝不报告为「未发生变更的拒绝」。
- **以语义重放取代传输时效。** 重复意图即当前成功，不推进修订号、不产生回执或字节抖动；意图未变而修订号变化只是漂移告警而非拒绝；载荷或目标确实不同仍会拒绝。
- **注册自行派生身份。** `derivePlanRegistration` 与 `deriveLifecyclePhase` 以所选文档为权威派生 plan 身份与迭代 phase；被中断的注册在重试时补齐缺失环节，缺 phase 的迭代在读取时派生。
- **Prepare 修订按组件提交。** 独立组件落地，被扣留组件各给出一个最小决定，使用稳定词汇 `append plan <id>` / `correct-plan-file <id>` / `integration-worktree <path>` / `execution-policy <value>`；两条权威路线各给出一次部分回执，重放绝不二次应用。
- **每个已声明的生命周期状态在两条路线上都有写入者。** 行 `Done` 前记录证据可完成 report-only 尾段；`closeFileWorkflow` 是文件权威唯一的 close 动词，DB 路线在同一 handle 上组合；显式 `failed`/`stopped` 终态两条路线均可记录，仅结算本生命周期拥有且持有者已不活跃的占用，保留首个 `ended_at`。
- **仅做增量导出。** 新增 `closeFileWorkflow`、意图解析器、phase 常量、`CloseWorkflowOutcome` 及解析/派生/close 类型；没有任何导出被改名或删除。
- **CLI 与 MCP 恢复传输。** CLI 与 stdio MCP 共用命令注册表，恢复相关命令返回一致的版本化结果信封；MCP 工具 schema 暴露注册表载荷契约；烟雾探针使用隔离的文件与 SQLite 根目录。
- **`roadmap replace` 明确声明自身比较基准。** `--expect-project` 与 `--expect-roadmap` 均为不可推导的调用方声明；省略即为一次聚合 usage 拒绝并同时点出两个 flag，过期声明以 `roadmap.revision-conflict` 拒绝且不写入（守卫不再权威自比）。
- **MCP 工具 schema 不再暴露处理器不读取的字段**；声明的 string-or-null 载荷字段（`IssueTriage.owner`）保持其类型，不再退化为 `z.unknown()`。
- **仪表板启动期间取消会停止其创建的监听器**，不再泄漏 connection 作用域服务；已被其他调用持有的句柄复用并保持运行。
- **`plan issue-add` 为每条发现推导计划所属项目**，并在开始捕获前按数组索引汇总独立无效项；DB 捕获与计划关联仍在同一事务中完成，occurrence key 作为稳定事件身份。
- **声明按 kind 区分的 `persist.write` payload schema**；persist 命令聚合呈现 status 校验错误，保留协调式替换与版本冲突处理。
- **移除 `judgment review-advice` 命令路由**；历史 `judgment submit` 意图不再注册命令。ReviewDecisionPack 契约字段自动补全与多个缺失 pack 路径聚合诊断仅保留在 judgment API 中。
- **补充 `mstar-harness schema` 查询指引**（issue 捕获/复现/分诊/关闭/关联及 plan progress 载荷）；按处置类型预先核对字段，不再逐项试错。
- **测试语料清理。** 所有登记在册的包语料（engine、cli、commands、omp、opencode、judgment）按同一条书面保留/删除规则完成清扫：仅固定源码形态、措辞/帮助文案、转发回声、重复注册表副本、导出元数或环境常量的断言一律删除而非重新固化；面向使用者的行为、边界、原子性、授权、重放与可操作诊断均予保留。
- **开发验收保持隔离。** 验收语言对齐隔离的产品行为证据，不要求真实供应商、已认证宿主、已安装产物或设备收据；另行授权的运维验证保持独立。
- **原生模型交接偏好关闭即成功形态无操作**，direction-lock 与 phase-1-lock 均返回中性通知；开启时仍校验协调者身份与真实就绪条件。
- 活跃 workflow 修改与关闭允许稀疏调用：省略时从当前作用域派生令牌并生成一次操作 ID；显式会话引用和令牌仍作为约束校验。
- ACTIVE 清理读取权威 store；启动时铸造的 coordinator 身份优先于环境身份，不因此授予其他 workflow 权限。
- 执行权威位于 store.db：普通 primary coordinator prepare/progress/complete 与 workflow 转换使用原子 SQLite 事务、CAS 和收据；逐行 PM 身份/转交/execution lease 准入已移除。
- 注册原子发布 catalog delta、普通 workflow/row metadata、根成员关系与收据。Catalog 编辑不静默移动登记的 plan 指针；不要求 sealed Assignment。
- 新增权威执行读取路由：workflow/plan 状态在一个读事务内取自 store；权威缺失、处于 staged、损坏或繁忙时以 `execution.consumer-not-ready` 拒绝，而**不**降级到残留的 root/snapshot JSON、猜测最新 workflow 或看板投影。权威 active 时，已退役的文件写入在每个入口边界被拒绝。
- 将分段执行迁移的 preview/apply/activate/retire/abort 协议替换为唯一静态 `mstar store upgrade --operator <name>` 路径：一次打开或创建 store、导入已停止工作区中可识别的状态并激活权威，让跳过的源字节留在原处。独立备份冻结 SQLite 副本不携带的文件原生正文（ledger、身份索引、游标、历史分片、选择正文）及其已接受记录身份。
- 完成态以 **sealed Git proof** 见证（checkout/git/common-dir 身份、`HEAD` 及其 ref、index、每条 tracked 路径的内容与模式、新 untracked 文件会改变的目录条目、merge/rebase 哨兵、对象清单），并在完成事务前**仅从文件系统**重读（无子进程、无 await）：该窗口内工作树、index、untracked 或对象库的任何变化都会拒绝，不产生 `Done`、回执或租约释放。
- 新增执行覆盖基底：18 个 surface 的闭合清单与逐 surface 字节 codec，以及**从留存字节重算**覆盖的校验器（对每个命名 witness 重新哈希、据字节内容推导 result hash）——伪造结果、字节变更、借用或未 pin 的 witness、外来 workflow 身份、错标能力，均以 `execution.coverage-incomplete` 拒绝。
- 经 `setArtifactStore` / `--store` / `MSTAR_STORE_MODULE` 注入的 `ArtifactStore` 由门禁包装：当规范化控制根的执行权威为 active 时，其 `put`/`get`/`delete` 拒绝根 register、workflow snapshot 及二者的 `json` 别名；该控制根从进程侧解析，绝不采信注入方自述的 root。
- 更新 `mstar-artifacts` `references/status-and-residuals.md`：transport 划分（active DB 权威 vs pre-activation 文件路线）现已在 v2 文件形状、lease 字段与 lockdir 正文的引入处说明，而非只出现在后文协调节——其余 snapshot 权威表述均限定在 pre-activation transport 或 legacy 历史。
- 活跃 workflow 注册时将 catalog plan 路径规范为相对 plans 根目录的路径，并接受规范绝对路径；不改变执行解析器的输入形式。
- 协调者恢复是显式的存证引导：必须命名前任持有者，只接管由撤销该持有者而孤儿化的所有权，且绝不复活旧 epoch 的租约。
- 源码就绪不切换已安装消费方、不推进版本面，也不声称 live 激活或发布。已提交的 ZCode hook bundle `hooks/mstar-write-gate.mjs` 从当前 engine 重建；已安装隔离与消费方刷新仍属于独立运维工作。
- 保留独立备份恢复（`store backup`、`store execution restore-preview`、`store execution restore`）与 live-state 导出（`store execution export`），不与 upgrade 路径耦合。
- 新增全库恢复（`previewExecutionRestore` / `restoreExecutionBackup` / `exportExecutionState`）：备份包含已提交的 WAL 可见工作，恢复在内部核对已授权损失的行身份/revision 与 operation ID 并保留即时安全备份，诊断导出为惰性且不含凭据；不要求调用方提供 CLI loss-digest 标志。
- CLI/session/host 写入使用独立获取的 workflow coordinator 身份、明确 plan 地址和显式约束或推导的当前传输 context。不再保留逐行 PM 身份或子级转交。
- 文件形态仅保留在显式标注的 pre-activation 章节，并同处声明 active 权威会拒绝它们；不再有任何 active 指令让读者手改 snapshot 或把 legacy 信封当作现行路由。
- 会话引用是**查找**而非持有凭据：它只命名一行已存记录，缺少引擎在自己事务内比对的调用方则不授予任何东西；引用、期望值与 operation id 绝不转发进子交接。resume ≠ recovery——已停止的持有者只能由 active 权威上的显式恢复动词替换，或在文件路由上由受守卫的 Prepare 恢复替换。
- 宿主细节移入其归属的 host reference，并以已评审实现为准；DSh README 双语对在 ledger 身份/去重权威、持久游标与归档显示尾部上重新对齐。
- 向 `CONCEPTS.md` 补入两个词条：**Consulted header set**（按标签解析计划时只咨询一个封闭且精确匹配的标签集合，绝不前缀匹配，因此 `Working branch policy` 这类描述性兄弟标签不会别名成被咨询字段）与 **Maintenance exclusion**（引擎生命周期操作持有的最外层单一锁，使任何包的协作写者都无法在其窗口内追加；它是协作纪律，不是权限）。
- 在技能正文中记录已交付的 coordinator 身份路径：宿主自有入口 `mstar_coordinator`（`bind`、`show-recovery`、`recover`）、本地 `plan bind --coordinator --session-id` 形态、`mstar workflow recover-coordinator` 动词，以及注册 plan 的指针形式。正文把激活前路线与 active-store DB 恢复（完整 execution token + stop 证明）及原生一次性模型交接区分开（`mstar-host/references/omp.md`、`mstar-use-cli/references/plan-and-workflow.md`、`mstar-use-cli/references/preconditions.md`）。
- 注册 plan 的指针记录为**规范绝对路径** `{PLAN_DIR}/<plan-id>.md`——接受规范绝对路径或规范化 harness 相对路径，仓库相对拼写 `.mstar/plans/<id>.md` 在第一条 journal／snapshot／根写入之前即被拒绝；受守卫的 `correctPlanFiles` 修正是同行修复手段，在既有 Prepare 准入与当前语义/revision 约束下只改动 `row.file` 与 `updated_at`，不再使用过时的字节版本输入（`mstar-artifacts/references/status-and-residuals.md`、`mstar-iteration/references/phase-1-prepare.md`）。
- Workflow coordinator 身份必须明确获取；公开恢复输出只含安全事实，不含 envelope 路径/正文。Assignment 或逐行身份不构成 bind 输入。
- 文档对齐本身不改源码行为、标志或拒绝码，也不声称已安装代次、已发布动词可用性或真实 handoff。
- 从 engine `compoundRefreshScope` 允许列表移除 `status.json`（ACTIVE 文件路由守卫本就拒绝该路径）；回归覆盖断言收窄后的 scope，并经真实写入端口验证 ACTIVE 拒绝。
- 向冻结的 plan-workflow lifecycle 契约追加 `Amendment 2026-10-06 — ACTIVE store execution authority`：store 注册/关闭 seam 为主，文件路由降为激活前/无引擎回退。
- knowledge_refs 载体决策收口于 catalog relations（`mstar catalog link`）；snapshot `plans[].metadata.knowledge_refs` 在 artifacts/compound/compound-refresh 三技能统一标注为 legacy 只读。
- `status validate` 新增 execution authority 状态与受支持的升级入口；明确按路由区分的 token 和计划文件路径。
- `mstar store upgrade --operator <name>` 是唯一默认执行状态升级路径：一次命令打开或创建 store、导入可识别记录、激活 authority，并返回包含跳过项的一行结果。未知与无法解析的源文件保留在原路径；无需 attestation、inventory、staged manifest、coverage gate、激活屏障或命令自带恢复点。
- 删除 `store safe-upgrade` 及 staged execution 的 `preview`、`apply`、`activate`、`retire`、`abort` 动词。独立 `store backup` 保留；execution 的 `restore-preview`、`restore` 与 `export` 作为独立备份/灾难恢复及 live-state 报告工具保留。
- **Canonical store 管理入口：** CLI 和 MCP 的 store 操作现在支持通过 `--harness` 显式选择或正常项目发现定位 canonical control root。备份校验、维护锁及迁移/激活 attestation 守卫保持生效；命令帮助明确说明支持的目标。
- Store 升级迁移退休现在要求当前快照或根执行记录作为证据；仅有陈旧日志历史不再符合条件。
- 新增 `workflow adopt-terminal`，为未注册的 workflow header 记录接管收据，并通过 revision CAS 与状态读面如实呈现。
- 将 `mstar persist` 家族限制为 `review` 和 `json`；engine 的 `status` 与 `snapshot` kind 仍仅用于迁移路径，其永久调用方为 `migrate.ts`。
- 退役 coordinated artifact 读取/替换链及其公共导出。coordinated purge-entry veto 仍延期至 T21 terminal sweep 处理。
- 注册重放不再对**终态生命周期快照**作出"已注册且活跃"的应答：close 窗口内（磁盘快照已终态、root 登记仍在）已提交的注册以 `catalog.registration-terminal-lifecycle` 拒绝；已提交的 reconcile 重放也应用相同守卫。让正在执行的 close 完成；若 close 中断，则运行 `mstar status workflow-close --workflow <workflow-id> --harness '<harness-root>'` 完成注销后重试注册。普通 plan 行进度重放仍照常返回已提交回执（#323）。
- **Dashboard 视图：** 工作流和迭代视图现在会在 ACTIVE harness 上从执行权威读取数据，不再拒绝请求。修复 #354。
- **ACTIVE projection：**移除不可达的合成 plan 校验和冗余 lease 查询；保留 released lease 的已完成计划仍可见，且不展示历史归属。
- 新增文件原生 workflow notes ledger（`appendWorkflowNote`）：每条 note 追加一行规范记录，位于执行维护排除与逐 workflow 状态锁之下，同步的当前会话断言是 fsync 字节写入前的最后一步。迁移过来的 legacy 行与内联 plan notes 逐字节保留——不重写、不重排、不压缩已留存 ledger，也不把任何 note 变成 DB 事件。
- note 的身份就是调用方的稳定 id：同 id 同正文重放而不追加，同 id 正文改变则拒绝，已被别处记录的 id 也拒绝而非任选一个。被崩溃截断的「正在写入记录」的不完整行会被修复为恰好一条已接受行；跟在记录自身已接受行之后的不完整前缀只通过删除该前缀治愈；不属于该记录前缀的未终止尾部则拒绝，且所有留存字节原地保留。
- 留存叶的可信判定**就是它的打开方式**：`O_NOFOLLOW` 加上对同一描述符的 device/inode **与字节**复核——因此读与提交之间被换成符号链接、被替换或被删除的叶会被拒绝，而不是被跟随、截断或写入。
- 持久化写入会**写满短写**（受容量限制的描述符可能只接受少于给定长度的字节），并对「一个字节都不接受」的写入拒绝——ledger 追加与原子替换助手都如此。
- DSh agent-flow ledger 现在从**已核验的原生事实**派生每一行的身份（日志的已核验化身 + 承载会话与 call id），把已接受身份索引作为去重权威、把游标副文件降为逐化身的扫描边界，并把追加、身份提交与扫描边界推进放在同一个共享锁临界区内。显示压缩是记录在瞬时日志中的单个事务（尾部前后哈希 + 精确归档区间），被淘汰行在显示尾部重写之前按字节原样归档进密封历史分片。
- 两条 agent-flow 写路径在各自锁之前先取与引擎 activation/restore/migration 相同的执行维护排除，因此该窗口内的插件写入会以有界建议被拒绝，而不会落进正被重写的目录。
- 从 engine 包入口导出了 lifecycle branch fact 类型，供 commands consumer 使用。
- 删除了已退役的 file-route Prepare recovery suite 和 `lease.verify-integration` setup verb 测试；保留的 L1 lease 覆盖由 `worktree check` 提供。
- ACTIVE iteration registration 现在会将 compass reference 规范化为相对于 harness 的路径，并拒绝越出 harness 的路径（包括经由符号链接越界）。
- 将已退役的恢复指引替换为 ACTIVE 状态/令牌读取、协调者恢复，以及缺少交付类型时可执行的失败关闭并重新注册路径。
- `mstar worktree check --entry` 的准入改为按工作流类型区分：standalone plan 工作流只要求其注册可记录的 source/target anchor（主 worktree 驻留校验使用 `target`）；iteration 工作流仍要求 base/target/integration anchor 与集成检出校验。缺失 anchor 的拒绝文案按类型给出可执行的恢复指引。
- audit-promote CLI 测试改为断言 ACTIVE 执行图（单次 store 初始化 + 读取已激活 token），不再断言已退役的 snapshot / `status.json` 投影。
- 将状态写入门禁切换为仅使用执行权限路由，并重新生成打包钩子。
- 从 MCP 身份测试中移除了已退役的 lease verify-integration 断言，并保留现行 worktree check 接口。
- 为 `milestone.assign` 注入已获取的会话身份，同时保留可选的会话引用校验约束。
- 移除了已退役的空状态模板夹具及其验证用例。
- **OMP**：`mstar_coordinator` 新增 active 形态的 `bind` / `recover`，在宿主派生的执行身份下直接调用 DB 动词；`show-recovery` 在 active root 上从 DB 应答，在文件路由上保持未变的 Prepare 视图。路由取自被寻址的 control root，绝不由 tool 参数选择：混用或不全的字段、在 pre-activation root 上用 active 形态、在 active root 上用 Prepare 形态，都在任何 IO 之前拒绝。
- **OMP**：`mstar_phase2 {operation:"bind"}` 不再接受调用方提供的 session path，而是采用被寻址 root 自身的权威（active 路由取 DB 协调者绑定，文件路由取 workflow 自身记录的 envelope）。持久记录为 version 2；更早记录仅作 legacy 历史可读、绝不升级为 DB 绑定；active 绑定永远优先。
- **OMP**：新增只读的 hidden-history 读取/导出：按精确的 hidden entry 类型分类单个 session ledger，逐条原样保留 payload 及其摘要，且只解码已核验 producer schema 允许的内容。producer 未知或 payload 无法接受的 entry 会完整保留并给出诊断，而不是被猜成某个 session 或另一种类型；导出器在证据缺失时拒绝导出。
- **DSh**：会话选择与排除下限独立于可重建的 engine-status 输出持久化；只存储规范执行绑定见证，陈旧、被撤销、缺失、损坏或 scope 不匹配的权威一律拒绝，**不**回退到根 register 或最新 workflow。legacy 目标路由仅在没有 active 权威时保留。
- **DSh**：新增 plugin-owned `/mstar-execution` 人类命令（闭合 JSON `adopt | clear | run`）——身份来自承载的原生会话，已知 leaf/subagent 席位在任何解析或 harness 探测之前拒绝，`run` 启动无 shell 子进程并覆盖执行身份传输、移除所有伪装与 legacy 键。
- **OpenCode**：执行身份由原生 hook session id 加独立获取的 scope 派生，会话自身引用从其 CLI 流量习得并带入真实共享 CLI 调用；两个 legacy 键都被移除，根只来自显式旗标或子进程工作目录。
- omp 为符合条件的 Morning Star MCP 调用注入宿主原生会话身份，并在 ACTIVE workflow 身份注入路径缺失时给出诊断指引。
- **omp 现按调用为 Morning Star MCP `sessionId` 供给原生会话 id（issue #383a）。** 新增 `mcp-identity` 扩展（注册进 `omp.extensions`），把符合条件的 `mcp__morning_star_mstar_*` `tool_call` 输入修订为 `{ ...input, sessionId: <原生 id> }`，使独立 plan 工作流链路——`workflow register -> coordinator bind -> plan prepare -> progress`——无需 agent 手工传 id 即可携带调用方身份。资格判定是 schema 感知的：仅当工具声明的 `ToolInfo.parameters` schema 声明了 `sessionId` 才注入（宿主会按 schema 复检修订后的输入，未声明的键会被宿主侧拒绝）；名称前缀只是预过滤。注入仅做增量：不覆盖显式传入的 id，绝不设置 `block`，且每次事件从 `ctx.sessionManager.getSessionId()` 读取，叶子会话携带自己的 id。
- 恢复 shell 命令中的宿主会话身份注入并加入幂等保护，避免重复修订堆叠 `MSTAR_HOST_SESSION_ID` 导出语句，同时不修改 `env` 输入。
- 调整协调者可见的 OMP 通知**标题栏类型**为共享类型：phase-2 诊断通知与 model-handoff 通知现发送 `customType` `mstar:notice`，有界 phase-2 advisory 发送 `mstar:advisory`（原为 `mstar:phase2-notice` / `mstar:model-handoff-notice` / `mstar:phase2-advisory`）。标题栏打印所发送的类型，因此可见标题现在与共享的 Morning Star 通知族一致。
- 保持不变：隐藏的持久账本标识 `mstar:phase2` / `mstar:model-handoff`、其恢复与去重标识、正文观察到的 workflow id/status/fallback、投递/续接选项以及全部机器拒绝码（含 `phase2.workflow-terminal`）。可见标题改名不是账本或拒绝码变更。
- 仅改动所发送的值与其对应的 host 参考段落；正文只陈述自身 workflow 状态一次。本条目不声称任何已安装 UI、渲染器注册、已打包宿主副本或发布。
- 移除 omp 校验器工具的死源码（`src/tools/`：`mstar_iteration_gate`、`mstar_worktree_check`、`mstar_status_validate`、`mstar_lease_verify`、`mstar_path_resolve`、`mstar_dispatch_validate`）。自 MCP stdio 服务器并入 CLI 起，构建不再编译和发布它们；同等能力由 `npx @mstar-harness/cli mcp` 经包内 `mcp.json` 提供（`iteration.gate`、`worktree.check`、`status.validate`、`lease.verify`、`path.resolve`、`dispatch.validate`）。范围说明：CLI `path.resolve` 命令解析四个顶层目录符号（`{HARNESS_DIR}` / `{SPECS_DIR}` / `{WORKFLOW_DIR}` / `{PROJECT_DIR}`）；per-plan 的 `{PLAN_DIR}` / `{SDD_DIR}` 与 `{ITERATION_DIR}` / `{KNOWLEDGE_DIR}` 符号遵循自 `{HARNESS_DIR}` 出发的既定解析约定（engine `resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir`；SSOT `mstar-conventions`）。同步删除钉住这些工具的 omp 侧测试臂（`execution-read` 校验器套件、`worktree-check`、`store-cutover` 的工具路由、bundle-smoke 的 custom-tool 探针）以及 `packages/cli/test/tools-v2-smoke.test.ts` 中的跨包测试臂；omp `tool_call` pre-hook 覆盖不变。
- 将可选宿主 peer 放宽为 `@oh-my-pi/pi-coding-agent@^18.3.0`（任意 18.x 宿主），并把 `devDependencies` 中的开发基线升至 `18.3.0`，使测试套件在用户实际运行的宿主上验证。精确的 `18.2.1` pin 早已与现实漂移：omp 18.3.0 线宿主会拒绝任何输入携带 `env` 但缺少服务名 `name` 的 `bash` 工具调用（`ready and env require a service name.`），本包的 shell 传输代码必须遵守这一参数面契约。
- `@deepseek-ai/dsh-*` peer 依赖整组升级到 `^0.2.0-rc.2`（走廊 `dsh-v0.2.0-rc.1` → `dsh-v0.2.0-rc.2`：桌面菜单栏 bundled dsh 安装、实验性异步问答、模型选择器模糊搜索、体验/桌面修复、pi-ai → 0.87.1；等 npm 发布 0.2.0-rc.2 后补做）。Session 格式仍为 v4。
- `@deepseek-ai/dsh-*` peer 包更名：`dsh-agent-presets` → `dsh-agent-preset`、`dsh-code-runtime` → `dsh-ptc-runtime`。
- planMode bridge 从 `agent/session-start` 迁移到串行 `agent/created`。
- `dsh-llm-fallbacks` 开发依赖 `0.5.2` → `0.6.4`（首个与 `0.2.0-rc.1` peer 走廊匹配的 fallbacks 代次），engine 侧 `DSH_LLM_FALLBACKS_VERSION` 锁定值同步跟进。
- 活动工作流选择器改走 ACTIVE 执行状态：派发台账目标缺失时安全失败（fail closed），保留按分支形态的 lease 匹配，并在派发门禁与记录之间复用同一次 ACTIVE workflow 读取。
- 记录 issue/catalog SQLite 路径 `{HARNESS_DIR}/store.db` 及其与执行 JSON（`ArtifactStore`）的权威分界。
- 索引 `mstar issue …` CLI 族（动词以 `--help` 为准；技能文不复述标志）。
- 按入口记录 CLI 运行时下限：shebang 为 Bun `>=1.4.0`，显式 `node` 跑 CLI bundle 为 Node `>=24.18.0`——不是要求两套运行时都装。
- 新增 **catalog 权威**（`{HARNESS_DIR}/store.db`，migration 2）：project/iteration/plan/document 的身份、路径、归属、spec/knowledge 关系与 catalog 生命周期是 DB 行；正文仍是文件，执行路由、lease 与冻结输入仍是 JSON。
- 把需维护的 Markdown 索引义务（迭代 README 行、package Documents 表、specs/knowledge 索引表）替换为 **catalog discover / import / register / query** 职责；完整性改为 DB 查询，README 缺失不再是失败。
- 新增 `mstar catalog` 动词族（list、show、register、update、link、discover、import、export、reconcile）——动词与标志以 `--help` 为准。
- 新增 **registration journal**：snapshot/根 entry 写入与 catalog delta 经同一个可恢复操作发布（`catalog.registration-pending`，用 `mstar catalog reconcile` 收口），且 prepare 的 plan 把执行输入 pin 到某个 catalog revision。
- 新增 **可丢弃的执行/roadmap 投影**（migration 3），诚实报告新鲜度与诊断；新增 `withStoreRead` 读边界与 dashboard DTO。
- 记录跨 clone 限制：`store.db` 本地且默认 gitignored，仅凭 tracked 正文无法重建本地 catalog 历史，discovery 以显式 unknowns 报告。live 索引退役与激活归 cutover plan。
- 按 compass D18 落地 **capture duty**：确认的 finding 在确认当刻落为 `{HARNESS_DIR}/store.db` 的 issue —— 捕获只记证据，处置是独立的授权动作；同一 finding 再次出现追加 occurrence，而不是新开第二个 issue。
- **`mstar-project-governance`「Issue capture」成为唯一权威**（issue contract §6 逐字）：确认其结论的席位负责捕获 —— PM 席位，以及 PR-review 轮次 Stage 3 的 main agent；leaf audit/QC/QA 席位只回证据、不写 store。其余五处只做指针落点。
- `mstar-artifacts` 家族（`SKILL.md` + `references/status-and-residuals.md`）、`mstar-audit`（含 PR-review 参考）与 `mstar-review-qc` 的 residual register 表述改为指向 issue store，并在 `mstar-harness-core` 补最小交付循环句：register 是**迁移历史**，open item 是 store 的 **issue**，`mstar status tech-debt` / `mstar status findings-cleanup` 读 store。已退役的 register 写入动词（`mstar status backlog-register` / `backlog-close`）拒绝并指向 issue 动词；技能文不复述标志。
- Plan issue 变更仅使用已记录的 workflow coordinator envelope 或 ACTIVE coordinator reference，加上已获取身份和明确 plan 地址。已删除逐行身份及其历史 envelope alias 不授予权限。
- **Dashboard 行按所属 workflow 取数**（PR #266 评审 RV-1）：projection 的 plan/lease 行改用表自身的 `(workflow_id, plan_id)` 键匹配——同一 plan id 同时存在于 plan workflow 与 iteration workflow 时，workflows 视图与 iteration 执行 overlay 不再附着另一个 workflow 的 lease、状态、进度或 pin revision。
- **拒绝符号链接跨 harness 的 register 写入**（PR #266 评审 RV-2）：pre-activation register 经符号链接落到另一 harness 的 active/不可读 issue authority 时，由落点上下文拒绝（`project.register.retired` / `store.authority-unavailable`），三份执行副本（ZCode hook、omp gate、dsh store-authority）语义一致；双方都 pre-activation 时保留 §7 legacy register 路径。
- **目录导入不再留下静默前缀**（PR #266 评审 RV-3）：`importCatalog` 中途失败改以 `catalog.import-partial` 显式抛出，携带已应用的 receipt 与恢复指引——已应用部分是持久化的 journal 进度，用同一 operationId 重跑同一评审 plan 即可幂等收敛到完整 plan、恰好一次。
- **OpenCode 插件声明 Node 版本下限**（PR #266 评审 RV-4）：`@mstar-harness/opencode` 的 `engines` 在 Bun 之外新增 `node >=24.18.0`（`node:sqlite`），包内 INSTALL/README 同步写明该下限。
- 新增本地只读治理面板的 **DESIGN.md**：定义浅色主题令牌、四视图导航、证据与历史展示、可访问性，以及明确的空数据、过期和错误状态。
- 新增离线 `mstar report` 草稿生成器：仅使用调用方明确提供的字段，应用有限的 secret 脱敏模式，并要求用户检查；不会收集本地数据或提交 issue。
- 补充 CLI 与 MCP 报告用法、`absent`/`unknown` 值，以及脱敏计数的含义与局限。
- **Issue 写入改为仅基于 actor：**所有非 plan-scoped issue 写动词（包括 `link`）均直接记录到 store，不再要求 session envelope 或 workflow。
- Plan issue-add/issue-close 使用 workflow 的唯一 primary coordinator 与明确 plan 地址；plan/iteration 链接目标仍为标签，不构成独立权限校验。
- **工作流创建者信息保真。** 导入时保留工作流创建者身份；首次绑定仅允许创建者为 NULL 的工作流采用。
- **Plan provenance 按来源隔离：**只有 plan-scoped 写入能建立 scoped 成员关系；actor-only 链接保持 unscoped，历史 provenance 保持 plan-scoped。
- 依赖 origin 的 issue 读取会拒绝旧 schema，并提示使用公开的 `mstar store upgrade --operator <name>` 恢复入口。
- 移除过时的 `triageIssueExecution`、`closeIssueExecution`、`linkIssueExecution` engine 导出。
- 公开的 `IssueProvenance` 类型通过 `"scoped" | "unscoped"` 声明 `origin`，供类型化调用方使用。
- **Issue revision 冲突**现在会提供保留原命令的 `--operation-id`、`--actor` 与 payload、仅替换 `--expect <current-revision>` 的恢复说明；CAS 帮助仅对引擎实际执行 revision CAS 的 issue 动词显示（triage、close、waive、duplicate、supersede、reopen、link）。
- 新增带 revision 守卫的 `issue reopen`，可凭可审计原因重新打开终态 issue，并通过操作收据保证幂等。
- `mstar issue <verb> --help` 现在逐字段列出 payload 字段名、类型与条件必填性，直接派生自 `ISSUE_PAYLOAD_SCHEMAS`（如 `references (requiredWhen: resolved)`），取代含糊的 `Payload fields: payload`（#420）。
- Closure payload 的必填性现全程跟随**实际 disposition**：`--disposition` 覆写在解码层选择必填字段，静态传输 schema 将 disposition 条件字段保持可选，使 MCP/CLI 组合准入与 `assertClosureAuthority` 一致（#420）。
- **迭代登记现在写入 `phase-1-prepare` 并存储仓库相对的 `compass_ref`**：生产者把根内绝对路径规范化为契约形式，拒绝逃逸 harness 根的指针（含符号链接），新登记的 workflow 天然可修订。
- **Prepare 命令对遗留快照自愈而非死路**：`workflow show-prepare` 在阶段标签缺失或指南针指针为根内绝对路径时报告 `derived`，下一条普通 `workflow amend-prepare` 在既有锁内写中一并采纳——已存在的非 Prepare 阶段仍然拒绝且绝不改写，真实执行事实（lease、非 `Todo` 行）依旧先行拒绝。
- **Phase 1 的写入全部落在 gitignored 迭代 package**：§2.3 integration-worktree checklist step 7（经 `iteration-start` §6 进入）现在只 push 新建的 `spec_integration_branch`（`git push -u`；分支 tip 停留在记录的 base，从而满足 `phase-1-lock` 就绪检查——已 push 的 remote tip 等于 live integration HEAD，由 omp model-handoff 运行时校验）。Phase 1 角色写入 compass / plans / `<iteration-id>/` package（specs 在 `<iteration-id>/specs/`）——均为默认 gitignored 的本地工件；全局 `{SPECS_DIR}` 在 Phase 3 iteration-close 提升时写入，随 close commit 进入 integration 分支（Phase 3 §3.2 现承载显式 specs 提升步骤：compound 结构化重写**直接写入 integration worktree 中 tracked 的 `{SPECS_DIR}`**——`{KNOWLEDGE_DIR}` 提升同为 integration worktree 直写，主 checkout 只承载 gitignored 进程产物——由 §3.5 close commit 进入 integration 分支；同步骤补齐既有登记面：package `Promoted to:` 标注、plan `primary_spec` / `spec_refs` 与 compass 引用、catalog `register` / `link`）。`iteration-start` / `iteration-loop` 的 pre-commit checklist 更名 pre-integration checklist（loop 的 `phase-1-autonomous-start` todo 现以 compass lock + integration 分支已 push 收口），§1.6 链条与 writing-specialist corpus hygiene 收敛到迭代 package（`iteration-artifact-boundaries.md` / `iteration-corpus-hygiene.md` 同步同一边界），并删除各 plan-mode bridge（`_shared/plan-mode-bridge-core.md` 门禁 + 反模式行、`cursor.md` Phase 1 Plan-mode 门禁、`cursor-`/`omp-`/`kimi-`/`zcode-plan-mode-bridge.md`）中过时的 Phase 1 "commit"。
- **原型先行准备：** 交互式 Phase 1 反复更新留存的人话与图形 HTML 原型，当前设计明确确认后才编写正式产物；显式自主模式保留适合的 HTML/Markdown/JSON 原型供规划与追溯，不索取例行人类确认。
- **按需专业审查：** PM 复用原型阶段贡献，按剩余缺口选择 product-manager/architect；选中的审查角色真实串行执行，writing-specialist 最后必经，OMP readiness 按其有序完成收据验收。
- **移除失效的 `judgment review-advice` 命令路由**；judgment runtime 与 shadow-supervisor API 保持可用。
- 导出 judgment runtime、审计、评估器通道与 shadow supervisor API；通过 `@mstar-harness/judgment/shadow` 提供 shadow runner。
- **`@mstar-harness/judgment`**：新增分片级作者派发前隔离门（`author-gate.ts`、`author-sink.ts`、`scripts/author-gate.ts`），复用 shadow supervisor Docker 启动边界——在 Q2 分片派发前配置无工具作者输入、执行禁止路径拒绝探测、校验仅创建输出 sink，并记录监督方访问 transcript。
- **`@mstar-harness/judgment`**：新增座位级标注派发前隔离门（`annotation-seat-gate.ts`、`annotation-sink.ts`、`scripts/annotation-seat-gate.ts`），复用作者门 Docker 探测启动器——配置无工具座位输入（brief + 投影分片视图）、对禁止的 qualification 路径执行拒绝探测（另一座位、crosswalk、gold、sources、authoring、协议工件、tuner、模型输出）、校验仅创建标注 sink，并在座位不可达处记录监督方访问 transcript。
- **Judgment runtime：**在输入收集期间观察到 `jev_mode=off` 时会中止正在进行的文件和标准输入读取、阻止后续收集，并丢弃迟到的读取结果。
- **Judgment**：拒绝响应模型与请求的原生模型不匹配的 TypeSafe 响应。
- **修复校准 shadow 暂存**：引用文件、清单标识符和受限只读运行时资产现与 supervisor 契约一致。
- 注释投影测试改用生成的本地 fixture，不再依赖维护者专属的 qualification 证据。
- **修复 shadow receipt reconciliation**：强制核对必需回执，同时将冻结清单中遗漏的工作保留为未完成；不再拒绝有效取消处置，也不再将零工作运行误判为未完成。
- 在 PR 审查合成阶段记录**可选、有限的 A05 影子步骤**；评估关闭或不可用时，原有核证、语义去重、否决记录、计数和发布职责保持不变。
- 补充无账户组件演练指引和仅限合成数据的证据边界；组件收据不授予 Jev 工作量，也不能替代具名宿主/W5 验证。
- 修复 judgment 包中的严格 TypeScript 错误，并将声明输出根目录对齐到其 engine 导入路径。
- 修复新注册的 `test-judgment` / `test-commands` 任务首轮红榜：shadow-supervisor 禁闭用例探测其声明环境（Linux 平台、可列出 `/proc`、可写 `/mnt/output`——CI 任务预置 runner 可写目录），能力守卫在 CI 缺失能力时以点名原因红榜而非静默跳过见证；study 闭环用例改经 supervisor 公开受控 provider 输入与真实 mailbox 协议全平台执行（live provider 见证仍为显式记录缺口），并修复其中两个从未被执行到的断言缺陷（缺失评估证据字段、receipt 记账不平衡）；synthesis-pack 测试改为断言 `validatePack` 内容相等（`toEqual`），因为校验有意返回规范化的派生副本而非同一引用。study 闭环用例原先行使的容器/挂载隔离语义在本重写中不被行使（该测试任务未配置容器 worker 镜像/namespace 启动路径）；仍然验证的是宿主侧能力探测与响亮守卫，以及 supervisor 对有效请求的 mailbox 闭环和对失败或 run 身份不匹配 study 结果的 assessor 拒绝。受控邮箱集成测试放宽其 worker 轮询预算（1s→6s）、child 上限（2s→pilot 的 10s 上限）与测试超时：高负载 CI runner 的往返实测 1.1s 会超出旧预算，其见证的生命周期契约不变。
- **开发校准**将真正全新的冻结资格根目录识别为首次运行，并从最新的单次运行目录加载先前的清单和请求哈希，同时保留冻结身份校验。
- **冻结校验**现在会拒绝存在标注但缺少 gold 行的语料变体，不再静默排除其标签覆盖检查。
- **安全性：**移除基于调用方可控环境变量和文件系统形状的 worker CLI 认证。shadow runtime 仍会在收集 pilot/pack 前拒绝未经认证的 evaluator channel；在提供认证启动适配器前，worker 侧提交不可用。
- 新增 **`commands` 与 `judgment` 包的 CI 测试路由**：两个包清单现在声明 `test: "bun test"`，CI 以独立的 `test-commands` / `test-judgment` 任务运行这两个测试面，与现有按包任务并列。
- 修正包发布面、托管安装依赖规格、CLI 选项类型解码、宿主已安装 MCP doctor 路径、请求级 store 选择、子进程 stdin 策略与 dashboard 生命周期清理；CI 命令清单改为读取规范命令定义。
- 将 stdio MCP server 整合进 `@mstar-harness/cli`，以 `mstar mcp` 启动；宿主配置改为运行 `npx @mstar-harness/cli mcp`，并移除独立 MCP 包、宿主专属 bundles 和原生桥接。
- **MCP 健康检查改为校验宿主真实配置。** `mstar doctor` 的 MCP 检查现在验证各宿主实际的 MCP 配置文件及其 `npx @mstar-harness/cli mcp` 启动项（从 `command`/`args` 数组解析服务条目），取代已删除的 `build-info.json`/`stdio.js` bundle 探测，并拒绝低于各打包目标原生最低版本的运行时。`evidence.verify` 对不合格证据改为返回 `ok` 数据并附 `assessmentPassed` 标记，而非 `refused` envelope。
- **DSH 获得 Cordis MCP client 行。** dsh bundle patch 在插件行旁插入 `mstar-mcp` 行（`@deepseek-ai/dsh-mcp-client`，stdio `npx @mstar-harness/cli mcp`，serverName `mstar`）；`mstar-harness doctor --target dsh` 结构化解析 profile 的 Cordis 源（不受注释干扰），仅在桥接插件已安装时报 aligned。`spawnProcess` 将 ENOENT 规范为确定性的 `executable not found in $PATH` 错误；dev 命令相对路径参数按 `MSTAR_CLI_PROJECT_ROOT` 解析。
- 补充六个 JSON 宿主与 OpenCode 插件动态配置的 CLI MCP 启动路径，并记录 DSH Cordis YAML 后续接入；说明运行时前置条件、doctor 状态含义、host/session 边界及独立的已安装宿主验证边界。
- 记录 OpenCode V1 `@opencode-ai/plugin` 1.4.8 pin，并说明已移除全局 CLI 回退。
- 新增 `consumer-v1` 源/包清单生产者（`scripts/execution-consumer-manifest.ts`）：对每个消费者（engine、CLI、DSh、OMP、OpenCode、ZCode）记录规范构建输入闭包、生成输出闭包、入口点、确切的运行时 target 与下限、声明的能力，以及各包从仓库根 `skills/`、`commands/`、`agents/`、`assets/` 语料复制的指令树——复用既有构建布局，不引入第二套构建系统。`--write` 产出清单；`--check` 在不写入任何字节的前提下对照磁盘字节复核每一份清单。
- 生产者同时发布由聚合清单派生的逐消费者证据文档，使交接形态不可能与面向操作者的制品不一致。
- 装配包 Node 回归驱动构建 CLI 的 coordinator 注册、绑定、普通 source/configuration/progress 与精确重试，比较公开/store 事实、当前 consumer manifest 和已提交 ZCode hook 的 stdin/退出行为，不启动逐行 PM。
- 该回归明确写出它**不是**什么：没有原生宿主进程、没有已安装二进制、不 import TypeScript 源码。宿主入口点由生成清单一致性加一个「OMP 形状的 populated 数据库夹具」在已构建引擎世代上运行来覆盖。
- 已声明任一 harness 根规则（`.mstar` 或 `.agents`，含前导斜杠、否定或部分规则）的 `.gitignore` 属**作者所有**：scaffold、安装围栏与 `doctor` 完全不做改动——不追加、不重排、不去重、不规范化，文件字节保持作者原样。无关路径与单独出现的 `.mstarc` 条目不构成声明；自定义布局跳过行为不变。
- 在 engine path 模块新增导出谓词 `hasHarnessRootDeclaration(content)`：机械、只读的逐行扫描，可识别两种布局的根规则（含前导斜杠、否定与部分声明），且不引入 glob、转义或优先级语义。
- `validateGitignore` 现在对已声明文件在任何缺失条目计算之前返回 `gitignore.author-declared`，且不提出任何重写；文件缺失仍为 `gitignore.missing`，未声明文件仍报告其缺少的 canonical 条目。canonical 完整性成功分支已因不可达而退役——canonical 内容本身就是一种声明。
- **最小完整实现：**将 Ponytail 的受影响消费者与数据风险范围、首个完整可用方案的复用阶梯、易读最小解、保护措施保留、实际检查与未验证风险简报提炼到 `mstar-coding-behavior`，开发及运维角色仅补充 API/数据、项目组件与恢复方面的小职责；现有 preset 和 `simplify:` 约定保持不变。
- **证据驱动审计与审查：**在 `mstar-audit` 中强化预期负载与真实调用流推理、可达发现案例、有价值的回归测试缺口、按职责划分的最小修复，不改只读边界、范围预算、严重性或报告 schema。全库审计 prompt 传递权威预期负载与发现报告规则及发现模板；生成的 PR 席位 prompt 传递共享调查规则与关注透镜。`ATTRIBUTION.md` 记录三个钉选来源 skill、目标文件及完整上游 MIT 声明；不增加外部运行时 skill 或命令族。
- **执行回执载荷瘦身**：graph 级回执（workflow 创建、生命周期转换、terminal adoption）不再持久化完整 root graph，改为瘦身 envelope —— `{slim, token, storeId, epoch, operationRecovery?}`；这些行的 replay 改从 live data/token 对重新提供。单行体积变为小常量（由 bounded-size 测试固定），不再随项目 graph 增长；plan 动词、bind/recovery 与 catalog 回执保持字节原样，供解析它们的消费者使用。
- **混合回执形态已声明**：`result_json` 载荷按写入时版本化 —— 瘦身前写入的行保持完整形态并从存储字节 replay，瘦身后的行携带 envelope；`store execution restore-preview` 的三个面（engine 模块头、CLI 帮助、`docs/commands.md`）已声明该事实，混合形态造成的 inventory 差异是显式的。版本化仅向前兼容：旧引擎读到瘦身行会拒绝 `store.corrupt`，需恢复匹配构建。
- **执行回执保留**：terminal close 与 adoption 现在在同一事务内清理已关闭 workflow 的 `execution_operations` 回执；epoch-bump 清理语句固化"原地 epoch 推进不残留 replay 死行"的不变量。RUNNING workflow 保留全部回执（replay 与恢复证据不受影响）；单 workflow 累积按设计线性增长，由 #466 跟踪。
- **恢复预览声明回执差异**：`store execution restore-preview` 帮助、engine 模块契约与 `docs/commands.md` 现在声明回执保留是 backup-only `execution` operation 行的预期来源（restore 保留旧 epoch 回执行；replay 仅限当前 epoch），清理后的备份差异是显式声明的，不再无声。
- **notes 账本预期文档化**：`workflow-note append`/`coverage` 帮助与 engine 账本头部现在写明 append-only 增长模型与整文件读取成本（id 去重扫描、全文件 coverage 哈希）属契约行为。
- **发布工作流现在会把内联的 changelog 段落裁剪到平台正文上限。** `scripts/extract-changelog-section.ts` 新增 `--max-bytes <n>`：`Release prep` 传 `60000`（GitHub 拒绝超过 65536 字符的 PR 正文），`Release` 传 `120000`（Release 正文上限 125000）。4.0.0 规模发布行约 133 KB，因此 `gh pr create` 报 `Body is too long` 失败，Release 发布也会以同样方式失败。
- 裁剪落在行边界——绝不截断行或码点——并追加 `> Truncated at <n> bytes to fit the platform body limit. Full section: \`CHANGELOG.md\`.`；不传 `--max-bytes` 时输出与旧脚本逐字节一致。不可用的上限会被拒绝，并指明越界值与确切补救方式：非整数或非正值会报出收到的输入；若上限小到连它必须携带的截断提示都放不下，则会被拒绝并报出最小可用值——该提示是操作者指向完整 `CHANGELOG.md` 段落的指引。
- **`release:prepare` 现在拒绝 registry 已发布的版本。** 该检查位于版本选择点、任何 changelog 或清单被改写之前：目标版本若已存在于任一已发布 surface 上，则带恢复指引拒绝（换一个版本后重跑）；registry 不可读时打印明确的跳过行——读取有超时上限、并行探测共用一个截止时间，registry 挂起会退化为该声明而不会卡住发布。`release:validate` 的离线 tag 门禁仍不发网络请求。
- **`env-injection-seams-removed` 碎片现声明 `packages: engine`**（中文块置于标记之后），因此引擎变更被装配进 `packages/engine/CHANGELOG.md`，不再进入根 changelog。
- **`INSTALL.md` 新增 3.x → 4.x 升级章节**：plan-PM 产品路线移除（唯一 workflow coordinator 通过普通 prepare/progress/issue/complete 推进行）、无参数的 `/iteration-drive`，以及逐宿主刷新表——插件安装器会复用已有 checkout、marketplace 或 linked 树，因此各宿主的 3.x 副本须显式更换（Codex 需拉取共享 checkout、执行 `codex plugin marketplace upgrade` 并重新复制 agent 文件；omp 需先重建共享 checkout 再重新 link；dsh 与 Kimi 经各自插件管理器重装）——并以发布版 CHANGELOG 条目为完整清单。
- **Release prep 与 Release 改为经一条自准备命令做类型检查。** `bun run typecheck` 现在自行构建其解析所需的 workspace 声明产物（`typecheck:prepare`：engine → judgment → commands），不再依赖各调用方自己维护的步骤顺序——该顺序在 CLI command-adapter 切换后漏改，导致 `Release prep` 一直因 `Cannot find module '@mstar-harness/commands'` 失败。
- 删除 `ci.yml`、`release.yml`、`release-prep.yml` 中重复的声明构建步骤；前置链现在只有一处实现。
- **完整移除应用层文件/目录互斥锁**，不引入替代互斥协议。保留 SQLite 原生事务/CAS、授权及真实 workflow integration ownership；普通笔记与文档不成为权威。
- **Workflow notes 改为普通追加日志**：重复 ID/提交再次追加，一次带 LF 边界的 `O_APPEND` 写入在失败时保留其他写者字节，容错读取越过不完整记录，回执仅返回笔记 ID，不承诺 accepted-operation 回放。已获准追加可在之后 session 撤销后完成；记录不代表当前执行权威。原生设备/inode 观察在追加期间发现目标替换时拒绝；这不是互斥，也不阻止之后的外部轮转。
- **生产 note、catalog purge 与 execution restore 不再读取已删除的测试控制环境值**：工作目录中的 `.env` 无法执行测试脚本、截断无关文件、暂停生产操作或选择 recovery 故障注入。失败及交错写入的注入仅存在于测试套件。
- **Dsh host 状态使用现有 control-root 数据库**保存事件、已接受来源身份、扫描下界、绑定与最新状态发射，不再使用 JSONL tail/index/cursor/cache 权威或文件压缩。Dispatch、settle 与 workflow-verdict 证据遵循选中的逻辑 workflow ID，绝不使用目标目录 basename。ACTIVE 权威建立前原生会话日志继续记录，持久化不可用如实提供 init/upgrade 恢复；engine-status 读取保留原生拒绝原因，并区分真实定址无记录与 authority 缺失、staged、损坏和 schema 拒绝。旧绑定导入拒绝已绑定其他 cwd 的同一 session，同时保留同一配对的回放和现有显式跳过恢复。
- **旧 Dsh 导入保留仅存于 tail 的回放身份**，并通过 no-follow 文件描述符读取来源文件；相同原生回放保留原事件，身份相同但字节冲突时拒绝，被替换为符号链接的文件不被跟随。
- **旧执行状态经 `store upgrade` 直接导入**，保留原始 v1/v2 来源字节；退役独立 `mstar migrate` staging 与内部 status/snapshot writer，引擎 `ArtifactKind` 仅保留 `review | json`。Active standalone v1 lift 必须按原 workflow ID 各提供一个定址 `--delivery` JSON 对象，支持同一来源重试时声明不同交付意图，在执行登记前验证；kind 不推断，不适用的声明明确拒绝。声明拒绝时 store 初始化可能已提交。现有 Dsh 跳过确认可恢复未登记且使用符号链接的 Dsh 来源，包括以 `--ack-skip-dsh dsh-workflows` 跳过整个 `workflows/` 根，不跟随链接也不修改链接/目标字节；已登记的执行来源继续执行 containment/no-follow 检查，不允许由 Dsh 跳过确认丢弃。数据库备份生成一致原生镜像；restore 在同一 live 数据库内以事务替换全部权威域并提交新 epoch，不冻结或回滚普通文件。已提交的 restore 不因可选文件回执副本写入失败而误报失败，而是返回 `recoveryReceiptPath: null`；仅在原生 store generation 证明未提交时清理本次自己的安全镜像，权威已变代或无法读取时保留镜像。新建 store 的失败区分未发布的文件系统故障与已发布但无法打开句柄的 store，并提供各阶段对应的公共恢复路径。
- **不安全的已登记来源与原生 ID 冲突有明确导入恢复路径**：可选 `--ack-skip-workflow <id...>` 仅跳过点名且被拒绝的执行导入，与 Dsh 数据丢弃分别确认；保留来源、链接、目标字节及现有原生行。未知或不构成冲突的确认 ID 优先于已登记不安全来源报 usage 错误。回执明确列出失去的导入；默认 no-follow 与普通路径的真实 containment 保留，不伪造恢复运行。
- **嵌套执行来源的拒绝沿用同一 workflow 确认恢复**，包括符号链接或非普通文件的 snapshot。旧 status、snapshot 及 session 字节通过 no-follow 且身份校验过的描述符读取；session 验证使用已读字节，不重新打开路径。已 checkpoint 权威的回归验证不再等待垃圾回收，也不把 SQLite 清理时机当成断言。
- **旧来源叶子改为非阻塞打开**：登记叶子若为 FIFO 等特殊文件，按类型拒绝并给出恢复路径，而不是挂住命令；同一次运行中可判定的同源来源仍然正常导入。v1 的 `iterations/<id>/delivery-compass.md` 叶子同样走这条有界、带类型检查且不跟随链接的读取，否则该路径上的特殊文件仍会挂住命令。
- **v1 转换消费已校验的 register 字节**，不再按路径二次读取 `status.json`，因此分类与转换出的行来自同一次描述符校验过的读取。
- **store upgrade 回执绑定被导入的来源**：来源摘要纳入请求身份，因此同一 `operationId` 配上改动过的旧字节会冲突，而不是用一份描述本次从未导入字节的回执作答；输入未变时仍回放保留的回执。
- **已确认跳过的 disposition 只描述被拒来源、不推断原因**：嵌套来源跳过不再声称其（真实且在根内的）所属目录不安全；具体原因由逐项 reason 承载。
- **两处来源摘要一律按码点排序，绝不受进程 locale 影响**：同一批旧字节在不同机器、locale 与 ICU 版本下保持同一身份，同输入重试不再被误判为 `execution.operation-conflict`。
- **v1 compass 拒绝给出三条受支持出口**，且竞态换入的链接与静态链接同样按名拒绝：替换为普通文件（保留该 iteration 归组）、移除它（那些 plan 转为 standalone 行），或显式选择不导入任何旧来源（`store init --harness <new-empty-control-root>`，既有数据不动）。描述符还会与探测结果校验身份，换入的普通文件无法贡献其字节。
- **发布竞态下 upgrade 重试仍然有效**：输掉 `initializeStore` create-only 发布竞态的 upgrade 会被指回 `store upgrade`（其旧数据导入可能未完成），而不是收到本应属于 `store init` 的「不要初始化或迁移现有 store」提示。
- **已枚举的历史 chunk 消失即拒绝**：DSH 导入不再把该 `ENOENT` 当作「该 workflow 没有保留历史」，因此消失 chunk 中的身份不会被静默跳过；历史目录确实缺失时保持原行为。
- **probe 之后发生变化的 v1 compass 即拒绝**：类型探测已观察到该 compass 后，若它在读取前消失或被替换为链接，按名拒绝而不是当作缺失（否则会静默改变该 iteration 的 plan 归组）；非普通 compass 的拒绝同时给出两条受支持修复：替换为普通文件，或移除它并把那些 plan 转为 standalone 行。
- **畸形的 v1 plan 行可按 id 跳过**：某个 v1 lifecycle 的行无法导入时，以该 lifecycle 自身作为被拒来源，可用 `--ack-skip-workflow <原 id>` 跳过，与畸形 v2 snapshot 一致；一处 agent 写的坏行不再阻塞其他有效 workflow。
- **根 `status.json` 的 `residual_findings` 如实披露而非丢弃**：v1 转换给出确切条数与受支持路径（项目 register 文档 `projects/<id>/residuals.json`，或 issue 动词），旧字段原样保留。
- **upgrade 的恢复文本与帮助列出完整跳过词汇**：面向机器的 DSH 恢复同时给出 `--ack-skip-workflow`（针对本次已提交的 id），命令描述列出该确认接受的每一类来源。
- **被拒的旧来源始终可按其 id 跳过**：已登记 snapshot 的 plan 行缺失、重复或无法转换时，改为以该 workflow 自身作为被拒来源（默认拒绝文本给出 `--ack-skip-workflow`），因此一处畸形行不再中止整次 upgrade，也不阻塞其他健康来源导入。
- **不承载任何来源的 `workflows/` 条目按缺失处理**，不再是冲突：根下没有登记项时，普通文件（或其他非目录）不再中止 upgrade；根下有登记项时仍保留原有按来源拒绝。
- **upgrade 回执绑定它实际消费的字节**：每个来源哈希取自产出该行的那一次描述符读取（v1 的 compass 读取同样在读取处记录），摘要不再二次打开同一路径；执行导入已提交后发生的 DSH 拒绝，会同时列出其宣称重试所需的两个确认。
- 退役的 `mstar migrate` 现识别原 delivery/branch 参数后返回明确的无写入拒绝。旧状态与 Dsh workflow 选择诊断现指向 `mstar store upgrade --operator <name> --harness <control-root>`。
- **catalog purge-registration 仅结算原生执行 journal**，不读取、不哈希、不改写记录的 snapshot：失败 producer 的来源字节原样保留，编辑过的文档不再阻塞 journal 清理。记录摘要仅作为 receipt 的历史失败证据，绝非对当前文件的重新认证；身份、generation、catalog revision、ACTIVE 与已记录 receipt 回放守卫均保留。
- **新的 store 发布先同步父目录**，再删除 fallback 镜像。同步失败如实报告已发布的部分结果，保留可读数据及 fallback，并支持通过同一公共 upgrade 入口恢复。
- **里程碑机制**落进项目存储：`mstar milestone add|update|assign` 在 store revision CAS 下写 milestone 元数据与唯一的 issue 关联；只读 `list`/`status` 提供 open / resolved / other-retired rollup。交付是显式状态变更，要求至少一个关联 issue 且零 open。
- **组合式路线图面**：`mstar roadmap export`（JSON v2 / 分组 Markdown）与 roadmap 仪表盘在保留 Direction 的同时渲染 milestone（目标、状态、关联 issue、计数）；无 Markdown 正文也可用，且从不修改 milestone 记录。
- **治理措辞**改为引用 milestone：Durable Roadmap Gate 接受 milestone ID + 关联 issue 的 acceptance / owner / dependency / trigger 证据；退役的 `roadmap.md` stub 仅作历史 / 导入传输。
- **项目路线图权威**现为项目存储记录，而非实时 `roadmap.md`：CLI、仪表盘和 dsh 读取同一正文；已知项目无路线图时明确报告缺失。
- **路线图编写**采用只读导入预览与审核后应用、受版本保护的整份替换，以及 Markdown/JSON 传输导出。初始化仅登记 `_default`，不写路线图 Markdown；遗留文件仅作导入候选或历史。
- **迭代收口**读取存储中的路线图，导出独立候选并按已观察版本替换，不再编辑实时项目路线图文件。运行时指引统一指向项目治理规则。
- 修复路线图 CLI 发现、导入预览往返、仪表板缺失状态处理及旧版路线图迁移披露，且未创建第二内容权威。
- 当忽略文件可能丢失时拒绝清理 worktree；刷新已提交的 hook bundle 及迁移/脚手架预期。
- 修正路线图仪表板与项目汇总的缺失提示，并更新迁移 6 的测试预期。
- dsh 从 store 权威读取项目路线图里程碑，并在面板中披露缺失、部分与不可用的路线图覆盖。
- 恢复路线图视图中的目录事实，修正空项目汇总提示，并在成功的 JSON 迁移输出中保留步骤列表。
- 新增只读本地看板：`mstar dashboard` 仅在 `127.0.0.1` 上（仅回环绑定，无 bind 选项）提供 issue 列表/详情（含真实记录历史）、workflow / iteration / roadmap 视图，以及一张累计捕获 vs 退役的 issue-flow 图表；数据源为 issue store 与惰性刷新的执行/roadmap 投影。看板不做任何变更；未知历史日期会被披露并单独计数，store 之前的桶标记为 register history，issue-flow 图表附带可访问的数据表格。
- **Dashboard roadmap 改为里程碑看板**：roadmap 页面按 store 的 ordinal 顺序为每个里程碑渲染一列，列内即该里程碑已关联的 issue 条目（mono id、disposition 徽标、存储标题），取代原先的纵向卡片列表。项目的未分配 issue 以显式命名的尾列呈现；在没有里程碑的分支上也会写出计数，不会静默丢弃。
- **Direction 降级到看板下方**：内容权威的 Direction 与存储的历史文档改为看板下方的折叠区块，各自保留标题与原有“内容权威 ≠ 里程碑数据”的措辞。Catalog 事实与 store/projection 新鲜度区块保持不变；roadmap 读取被拒绝时仍渲染其通知——既不渲染空看板，也不进入"无里程碑"状态。
- **Dashboard roadmap 入口改为 projects-first**：不带 `?project=` 打开 `#roadmap` 时列出全部 catalog 项目（标题、id、生命周期、open issue 数），每项链接进入该项目的只读 roadmap，取代原先"手动改 URL"的死路。
- **新增 `projects` dashboard 读视图**（端到端）：engine `DashboardView` + `ProjectListDTO`/`ProjectListItem`（对 catalog 表的完整、刻意不分页读取，含 open issue 计数）、零查询参数的 `/api/projects` 传输路由，以及重新生成的离线 dashboard 资产包。
- **门禁路径解析在引擎里单源化**：`@mstar-harness/engine` 现在拥有落点解析器（`landedPathOf`，链式形式）与大小写折叠的权威命名/分类，OpenCode v1、OpenCode v2、omp、dsh 与 ZCode 写门改为导入它，不再各自保留手工副本。这些副本已经漂移——四份只跟随一跳符号链接，而 v2 跟随整条链——因此两跳别名链指向 harness 权威文件（`store.db` / `-wal` / `-shm`）时能绕过门禁。现在所有门禁都解析完整链接链（8 跳上限，环形/越界以 `write.symlink-resolution-refused` fail-close 拒绝），大小写变体权威名在各宿主分类一致；各宿主保留自己的拒绝外形 (#442)。
- 历史 R3（3 次调用，通过）和中间 R4（initialize 基础设施错误，0 次调用）证据仍分别保留在各自运行目录；R4 发生在 initialize 响应修复之前。
- 已在完整 SHA `3c0f0eea8c9f6298d701e472da81f2a8ffd8de73` 上，将当前验收证据刷新到 `eval/r5-guess-path/`：本地构建 CLI 的 stdio MCP 猜测路径记录 3 次调用（近似错误工具名、目录恢复、修正后的调用），判定通过，run/report 退出码均为 0。
- 使评估驱动可在任意检出中运行：从 `import.meta.url` 推导仓库根目录，支持 `MSTAR_SKILL_EVAL_REPO_ROOT` 和 `MSTAR_SKILL_EVAL_DURABLE_DIR`，并记录当前完整 SHA 与已构建 CLI 身份 / 帮助哈希。克隆后运行 `bun run --cwd packages/cli build && bun scripts/skill-eval/run-bounded-resolution-real.ts`。
- **模型遵循情况仍未验证（脚本化客户端，未调用 LLM）**。
- 将 skill-eval 闭包清单重新冻结到可达的 `origin/main`（`c42c16b4`）：此前 BASE 版本在历史改写后已不可达。BASE 树文件哈希现与该可达版本一致，当前字节哈希继续固定。对于在此 BASE 中已不存在的锚点，检查用于防止重新引入，而非证明其历史删除。当前文件包含 35 个测试；历史上的 37 个测试数不是修复后门禁的要求。由于 CI 不执行 `scripts/skill-eval`，此闭包检查仅通过手动本地运行执行；漂移或重新引入只会在本地运行时被发现（#357）。
- 在 `AGENTS.md` 新增**容错与可发现性优先**工作规则：agent 执笔的修改必须可经公开操作修正；除最小 required 集外参数一律可选且带安全默认；能力必须可从 `--help` 与拒绝文案发现。原则锚点：#365。
- 新增维护策略：任何面向用户的拒绝都必须说明**实际原因**，并给出可通过**受支持且已文档化**的接口执行的确切恢复步骤。没有配套恢复的门禁、让操作者无事可做的拒绝、以及用通用"blocked"文案掩盖已知原因的写法，均属缺陷；新增硬性限制必须同一次变更带上恢复方案与测试。
- 新增**架构师的消融式设计最小化纪律**：若移除候选组件不会破坏已确认且明确具名的需求（含已批准的长期目标态或已记录的非功能约束），则删除该组件；为每个非显然必要的保留组件记录一行证据。最小设计仍须对齐长期目标状态，而非临时补丁。
- 授权**裁剪架构输出模板**：在 Prepare & Plan 和 Architecture Spec 两类输出中，将不适用于当前任务规模的章节标记为 `N/A — <one-line reason>`，不编造填充内容；实现层操作指引引用 `mstar-coding-behavior` § Decision Rules。
- **独立编码行为技能：** 将 `mstar-coding-behavior` 压缩为围绕原始用户目标、第一性原理、奥卡姆剃刀/YAGNI、根因修复及定向证据的工作流；移除强制 harness 加载、重复模板与引擎预检，保留精简的依赖论证、受限解法标记及按需工作流权威引用。
- **Agent 产品设计：** 优先保证命令与恢复路径可发现、必要输入最少且默认安全、公开操作可修订、错误与部分结果保真；禁止臆测功能和门禁，同时保留必要安全护栏。
- **精确加载例外：** 仅豁免名称完全匹配的 `mstar-coding-behavior` 的强制 Load Order/core-first 校验；其它专题及角色 hub 校验保持不变，将既有加载文案对齐精确身份例外，补充行为回归并同步 Cursor PM 路由场景。
- **行为导向的漂移检查：** 删除会把正常技能精简误判为失败的全仓文档数量及加载文案锁定测试；保留无效命令回归、真实加载顺序行为检查和实际语料校验，不重新锁定偶然的数量或措辞。
- Plan 模板采用三种直接 coordinator 完成路由：迭代证明实际串行集成；standalone development 证明登记 source 并保留交付尾段；standalone report-only 在 Done 前记录匹配策略履行，不虚构 Git/PR。
- 更新 `mstar-artifacts/templates/plan.main.md`（Engine lifecycle 块）与 `mstar-artifacts/references/plan-quality-bar.md`（第 8 条 Engine lifecycle ownership）以与权威契约保持一致。
- 稀疏意图动作在无歧义时推导已获取身份的 coordinator 自身 context。显式 scope/token/operation 约束仍校验；缺少 source 事实使用可修订 prepare，不逐行 bind/claim 或强制通用修复链。
- 用动作局部语义替换 `mstar-use-cli` 中"拒绝即无变更"的决策规则：拒绝的提交状态以回执为准——引擎协调的 plan 路由拒绝是事务性的（不写任何行、回执或计数器），动作局部部分回执保留已提交的组件，且只重放文档记载的剩余动作；过期显式令牌通过重读后以新令牌重试恢复。
- 删除了"参数解析器可能因缺失必需参数而退出码 1"的过期决策规则：对当前构建 CLI 的探测表明，缺失位置参数会以 usage 信封（`command.invalid-input`，退出码 2）应答。
- 将 `mstar-use-cli/references/preconditions.md` 的活跃路由身份与令牌指导对齐到已验证传输：CLI/MCP 传输不携带环境身份，独立获取的调用方身份以动词自身的 `--session-id`/`sessionId` 按调用提供（绝不读自会话文件，绝不由会话引用携带或推导）；plan 变更仅在显式约束时提供执行令牌——省略时引擎从计划自身的读取推导当前令牌——而全新活跃绑定与 workflow 级活跃写入（registration、evidence）须自行提供完整执行令牌：前者连同独立获取的会话身份、workflow 与调用方自有的 operation id，后者连同显式 expectation、operation 与主会话身份（evidence 另须其 session reference）。
- 将 `mstar-use-cli/references/plan-and-workflow.md` 对齐到同一传输：plan 变更仅在显式约束时提供执行令牌（省略时引擎推导），workflow 级写入与全新活跃绑定仍以 `--expect` 提供完整执行令牌（预激活绑定保持免令牌）；每次活跃调用都提供独立获取的 `--session-id`/`sessionId`，因此 plan 变更省略 `--expect` 与活跃路由携带 `--session-id` 不再是 usage 错误，"拒绝即无变更"的笼统声明改为动作局部提交状态语义。
- 使其余 `mstar-use-cli` 参考与探测行为一致：`checks-and-lints.md` 删除解析器退出码 1 的附注（缺失必需参数以 `command.invalid-input`、退出码 2 应答），`status-and-registers.md` 的 plan 范围 capture 条目改为相同的显式约束令牌规则。
- 将 **harness 技能语料与迭代命令**对齐 ACTIVE `store.db` 执行权威：workflow/plan 行、root register、lease、session 与分支锚点均以 store 为载体；root `status.json` / workflow `snapshot.json` / `sessions/*.json` 指令仅保留为显式标注的激活前或无引擎回退。
- 用 **store issue 与 catalog 动词**（`mstar plan issue-add`、`mstar issue add`、`mstar catalog discover/import/link`）替代已退役 residual register 与 README 登记义务，保留 append-only workflow notes 与 authored plan/assignment 面，并删除 `mstar-iteration` 中重复的 lease 协议正文。
- 澄清 `mstar-conventions` / `mstar-artifacts` 中 store `init`/`upgrade`/`activate` 与激活前 bootstrap 模板的分工，补齐 `mstar-use-cli` 命令族与执行拒绝码索引，并将 findings-cleanup 语义集中到 artifacts 权威。
- 将 `.cursor/skills/mstar-routing-eval/` 门禁 fixtures 同步到该拆分：ACTIVE 用 store 事务 / execution lease 仲裁措辞，文件 flock 场景显式标注 pre-activation（case ID 与期望路由不变）。
- 让 `mstar-compound` **只拥有 compound 步骤**：`mstar-compound/references/compound-workflow.md` 顶部以一行接口边界声明"触发时机 / cwd / 写入面 / 记录面属**调用方**流程，由调用方自身声明并引用本步骤文件"。compound 侧不再复述调用方上下文（integration worktree、compass 摘要、workflow delivery 记录、PR head 时点），消除反向依赖及其第二维护面。
- `mstar-iteration` Phase 3 §3.2 改为引用步骤 SSOT，并把迭代调用面作为自身声明保留；单 plan 交付尾段在 `mstar-roles/references/project-manager/plan-management.md` 引用同一步骤文件，`mstar-harness-core` 与 `mstar-conventions` 补上指引。
- 移除 compound 侧残余的调用方注册表：接口边界句、生命周期集成段、`description` 与 package 盘点前言不再点名调用方文件或其 gate 标签。依赖保持单向 —— 调用方指向步骤文件，compound 只拥有步骤，不持有"谁调用我"的信息。
- **L1 worktree 所有权：** 检查驻留状态时忽略声明为已记录主工作树分支的计划行；真实所有权冲突会指出所属 workflow 与计划。
- **计划准备：** 禁止任何计划行使用控制检出的当前分支（包括仅报告工作流）；无法解析该分支时也会安全拒绝。
- **L1 worktree 检查**现在从 ACTIVE 执行权限图派生 workflow、plan、lease 和生命周期分支输入，不再读取已退役快照或扫描兄弟快照。
- **同级 worktree 根目录**：feature/L2 worktree 与 `pr-review worktree-setup` 的默认位置改为 checkout 外的 `<parent>/<repo>.worktrees/`。仓库根目录为 Git top-level 的 realpath；仓库内 `.worktrees/` 仍是合法的手动或覆盖位置。移除默认创建流程对 `.git/info/exclude` 的追加，因为仓库外的位置不再需要它。
- **约定对齐**：更新 skills 与 `AGENTS.md`，统一教授同级根目录约定，避免仓库扫描或编辑触及 linked checkout，并使权限指导不依赖 cwd 或未经验证的 glob 解析语义。
- 新增**承接方侧 worktree 检出门禁**：Assignment 含 `Worktree path` 时，leaf 角色须在首次仓库写入或提交前 `cd` 到该目录并用 `git rev-parse --show-toplevel` 校验检出根一致，并在 Completion Report 回报 `Worktree path used`（绝对路径）——修复 subagent 继承宿主 cwd 而误写 primary checkout 的缺口。
- 更新 `mstar-branch-worktree`（可写角色执行规则 + 回报要求）、共享块 `mstar-roles/references/_shared/leaf-executor-core.md` Git NEVER 段，以及 `frontend-dev` / `ops-engineer` 角色文件，与既有 `fullstack-dev-shared.md` 指令对齐。
- 修复停止和失败（终态取消）的注册被新注册取代后的 worktree cleanup 归属判定：终态 owner 不再导致共享 worktree/branch 被误判为 foreign。真实存储 dry-run 现在会将已合并的 worktree 规划为移除；分支删除仍须等 worktree 移除后重新规划。
- **更可靠的工作树回收归属：** 完成计划时，在释放租约后仍保留其准确的分支与工作树路径。回收也可从有效的已完成 Done 行交接记录恢复归属；可解析但无效的快照会将交接资源保留为保护性、非终态元数据，但绝不授权删除。除非显式忽略，否则无法读取的快照会阻止删除。执行回收时，在移除延后处理的集成工作树后重新规划，再删除因此解除检出的分支。归属冲突仍拒绝移除。
- **忽略文件的回收：** 仅有被忽略文件时，工作树不再被判为脏。执行符合条件的移除会删除这些文件，且 Git 不提供恢复保障；已跟踪改动和非忽略的未跟踪文件仍阻止移除，回收绝不强制执行。

### Added

- 新增 **`@mstar-harness/opencode-v2`** —— OpenCode **2.x** 原生插件包，基于锁定的 `@opencode/plugin` **2.0.26** SDK 编写。经 V2 原生 editor 接口注册同一套打包的 `mstar-*` skills、角色 agents 与 iteration commands；其 `write`/`edit`/`subagent` 门禁通过类型化 `Tool.Error` 通道**真正拒绝**（V1 包"无拒绝通道、仅告警"的限制不适用于此）。`patch`、`shell` 与 Code Mode 仍为明确的不承诺面；installed-host 行为未经验证。
- `mstar init --target opencode` / `doctor --target opencode` 现为**代际感知**：`--opencode-generation <v1|v2>` 始终优先；真实安装否则探测 `opencode --version`（主版本 ≥ 2 → `@mstar-harness/opencode-v2`，1.x → `@mstar-harness/opencode`）；探测失败以该 flag 作为恢复方式拒绝——没有静默回退到 v1；`--dry-run` 跳过探测，未解析的代际以注解如实呈现而绝不猜测。配置 markers 仅作一致性护栏。
- V2 配置写入集不触碰 V1 键并保留用户取值：复数 `plugins`（owned-slot 去重）、仅在调用方提供时写入 `agents.<role>.model`、非破坏性合并 `mcp.servers["morning-star"]`、`$schema` 只保留不发明。
- 文档：新增 `packages/opencode-v2/README.md` 与 `INSTALL.md`、OpenCode（V1）包文档的双代际指针、`mstar-host` OpenCode 参考的 V2 章节，以及根 README 安装行。

### Breaking

- **破坏变更：完整移除 plan-PM 产品路线。** 唯一 workflow primary coordinator 通过普通 `prepare`、`progress`、`issue-add`、`issue-close` 与直接 `complete` 推进行。逐行 session/role/claim/bind、sealed Assignment 准入及 handoff/accept/return/integration-start/integration-accept/reconcile/repair/release 协议删除，不留 alias 或移位转交链。保留 coordinator bootstrap/resume 与明确停止的 workflow coordinator 恢复。
- **Iteration drive 仅无参数调用。** `/iteration-drive` 在 boot 前拒绝全部非空输入；旧 scoped flags 不会静默变成整个迭代授权。OMP 移除额外 primary 设置、容量/终端传输与 launch journal；保留原生 leaf 派发、有界 bind/checkpoint/只读 history 观察器。Model-handoff 行为不变。
- **普通可修订配置。** Source branch/worktree metadata 与 QA/cleanup 经 prepare 配置，active 时仍可修订。默认 mandatory QA 与 allow-residual cleanup。有效 metadata/defaults 不要求仪式化 prepare record 或冻结 plan/Assignment 字节。保留 transaction、CAS、精确请求收据、明确授权、L1/L2 隔离、SDD、QC 三审与 QA。
- **三种完成义务仍不同。** 迭代 complete 验证已实际执行的串行双亲合并及干净登记 integration checkout，保留父级 compound/PR/核实合并/close，不建子 PR。Standalone development 验证登记 source，不走迭代集成，保留自身交付尾段。Standalone report-only 消费 Done 前明确记录的匹配策略履行，再凭证据 close，不虚构 Git/integration/compound-before-PR/PR。Complete 仅释放适用集成排他、保留归属，精确 replay 不改时间戳；不执行或重复 Git merge。
- **明确 authority 与历史切换。** 已选 store root 不再重新发现：缺失或空 `--harness` 目标不会打开另一个 ACTIVE store，拒绝后仍可经公开 store upgrade 恢复。Schema-8 退役要求完整 operator-stop attestation 并保留业务来源；导入的已完成归属使用当前 metadata/completion，不保留 plan-PM handoff 读取路线。
- **Authority、阶段与 retained track 修正。** ACTIVE authority 拒绝先于无效 plan-read 参数校验；已记录的数值 progress 参与迭代阶段推导。FILE worktree check 保留所选行的 track 归属，并公开携带明确 control root、使用已观察 revision 的普通 progress 恢复，不清除活跃 track、不放宽 checkout/identity 保护。
- **策略与宿主一致。** Canonical skills、commands、templates、routing pressure data、有界评测 dispositions 与 README pairs 在所有宿主使用同一直接路线。DSh 保留 row metadata 的真实可写 scope 检查及现有公开拒绝码，不再检查逐行 holder。退役已替代的未发布 seal/admission/stopped-plan-owner 碎片，保留无关 issue/transport/model-handoff 行为。
- **审查席位最小权限。** 删除 QC 三席及 code-reviewer 薄壳对已删除逐行 lease verifier 的精确/通配 Bash 授权，不以集成/业务变更或 build/test 权限替代；角色仍保持薄壳，既有审查边界不变。
- **Report-only 策略证据保持幂等。** 履行记录在两条传输上仍是授权 `Done` 的依据：完成后重新指向证据引用以同一稳定码拒绝，完全相同的重录则为无副作用的幂等操作；development 尾段仍只在写入期发生。
- **直接完成仍正向校验完成行的一致性。** `Done` 的 standalone 行须符合声明的完成类型及适用的 integration/无租约约束，不能用其他状态标签绕过。此前 `validateStandaloneCompletedCoherence` 的 handoff 状态漏洞可通过改写一个词绕过 integration 污染、`integration_worktree_path` / `branch.integration` 与无租约检查，让 close 在 handoff 仍为 `accepted` 时写入 `completed`/`ended_at`、注销根条目并通过 phase 6；直接路线保留完成一致性，不恢复已退役的 handoff 读取器。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/opencode-v2`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 4.0.0**。

## [3.11.2] - 2026-09-19

### Harness

- 协调者模型交接的 arm 时点前移至**方向锁定**：新迭代现于方向锁定之后、Phase 1 初稿撰写之前武装 `@slow`，不再在 workflow 登记之后 —— 因此 arm 恒走未登记保留路径，这既是新迭代的预期状态（无 register 行、无快照、无 compass），也不再是推迟该调用的理由。arm/fire 逻辑、拒绝码、权威推导与工具 schema 均未改动。
- 共享新迭代 anchor 由 `iteration-entry` 更名为 **`direction-lock`**，carrier 移至 §1.2 尾部：anchor 现于方向锁定之后、compass/plans 初稿撰写之前触发，三条 Phase 1 入口路线在该边界绑定 —— 交互路线在锁定与初稿之间以独立步骤执行，autonomous 与宿主 Plan 路线经各自 pre-commit 清单携带同一要求。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.11.2**。

## [3.11.1] - 2026-09-18

### Harness

- **OMP 上宿主会话身份现在能到达引擎**：`@mstar-harness/omp` 的 model-handoff 扩展把本会话的每次 `bash` 工具调用改写为携带 `MSTAR_HOST_SESSION_ID` —— 同名调用方取值被覆盖、仅限 `bash`、宿主会话无 id 时不注入，且无引擎／harness 写入、无通知、无状态 —— 而新绑定的 `mstar plan bind` 按 **`--session-id` → `MSTAR_HOST_SESSION_ID`（trim 后；空白视为缺失）→ 引擎生成 id** 解析身份，使引擎 session id 与宿主 session id 成为同一标识，供 readiness 与 start-authority 比较使用。生成默认值与所有比较均不变：关联缺失或属于他人时照旧拒绝（readiness 的 `binding-invalid` 码、既有 start-authority 码），`--resume` 从不重新标识 —— 会把 `--session-id` 作为用法错误拒绝。
- **`bindPlanSession` 在两种新绑定形态上采纳调用方提供的 `sessionId`**（coordinator 与 plan scope），未提供时保持 `randomUUID()`。该 id 即会话信封文件名，按角色限定为 `{WORKFLOW_DIR}/<workflow-id>/sessions/<role>-<session-id>.json`（`<role>` ∈ `coordinator` / `plan-pm`）—— 因此同一宿主会话可以在同一 id 下同时持有同一 workflow 的 coordinator 信封与 plan-pm 信封 —— 并因此按单一安全路径分量校验（非空、无分隔符、非 `.`/`..`、至多 128 字符），不合格者在任何写入之前以新增的 `coordination.invalid-session-id` 拒绝；重复使用的 id 仍由信封独占创建以既有 `coordination.session-mismatch` 拒绝。
- 更新 `skills/mstar-host/references/omp.md`，补上 anchor 侧的会话身份关联契约。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.11.1**。

## [3.11.0] - 2026-09-18

### Harness

- 全代码库审计报告现以 Coverage 表收尾：每个实质审查问题一行（表面 × 边界/不变量 × 子系统 × 类别），恰好五个最终状态——`covered` 要求给出实际读过的 `file:line`、所检查的不变量与观察结果；每个非 covered 行都必须给出具体理由，读前被阻塞或仅有先前证据的行如实呈现，而非编造证据。五个状态为 `covered`（已检查，不等于干净）、`blocked`、`deferred`、`out_of_scope`、`not_applicable`；收尾摘要只点名表中已有的缺口，不出现数字统计或聚合路径账本。Coverage 是由审查者核对的内容：`mstar audit scaffold` 重建索引时既不保留也不校验它，因此每次脚手架后须先读出先前 Coverage 再重新对账，且不得宣称存在引擎级形状校验。
- 审计脚手架的 findings 文件现在保留审计者提供的全部内容：CLI 解析器将 `description` 映射为 `impact`，保留此前被丢弃的显式 `confidence` 与 `evidence`，并接受可选的 `fingerprint`、`trace`、`severity` 元数据及结构化 `{file, line?, description}` 证据位置，缺省字段有明确默认值（confidence 为 `MED`、evidence 为 `[]`）。新增确定性引擎门禁 `validateAuditFindingGates`（指纹语法/唯一性/排序、`severity.overall ≤ severity.impact`、trace 拓扑、安全类型化路径、可见文本谓词、不透明字段凭据拒绝），在 `scaffoldAuditPlan` 写入任何文件之前执行；非法 findings 以退出码 2 终止，诊断只含字段路径、不输出部分产物。旧式字符串证据输入继续受支持。持久字段契约发布于 `skills/mstar-audit/references/finding-format.md`（§ Machine-readable findings file），`references/codebase-audit.md` 的脚手架引擎检查说明已按真实门禁及其边界更新，`mstar-audit` SKILL.md 中五状态攻击措辞收紧为其实际的四种处置。
- 确立 **Phase 1 PM 初稿契约**（`mstar-iteration` §1.3）：初稿是被派发角色从磁盘读取的上下文载体，而非来自 PM 会话，因此必须携带锁定方向、已决事项、带 owner 的未决事项、非目标理由、约束来源、acceptance seed 与 branch policy；而候选方案分析、模块/接口细节、per-task 分解与 plan 级技术设计可以合法留粗。
- 为 Prepare 阶段**只认定一种**未完成形态：带 owner 的 `TODO(owner: <role-id>)` marker —— 语法只在 §1.3 定义一次，owner 取值限定 Phase 1 链（`product-manager` / `architect` / `writing-specialist` / `PM`）。只有指向 owner 的 marker 可以代替未完成细节，且必须在 compass 到达 `status: locked` 前清除，或显式重新归属给 `PM` 并上报用户。无 owner 的 `TBD` / `...` / `etc.` 在任何阶段仍然禁止。
- compass 新增两个必需节 —— `## Decisions`（决策 + 依据 + 来源）与 `## Open Questions`（每条带 owner 与 blocking 标记；无未决项写 `None`），在模板与 §1.3 内联脚手架中均紧随 `## Scope`，并补入各自 `## Fields guide` 行。
- 为每个 Phase 1 编辑角色加上 **marker 清除义务**（§1.6 与 artifact-boundaries 表格）：角色在自身编辑轮中清除 owner 指向自己的 marker，无法清除的重新归属给 `PM`，并报出已清除/已重新归属的数量；`writing-specialist` 另承担 compass lock 之前的「无 marker 残留」收口核对。
- 在 `mstar-artifacts/references/plan-quality-bar.md` 写明 **Prepare 写作侧标准**，作为「为无上下文执行者写作」的镜像：初稿与 compass 就是上下文载体，compass lock 前不得残留角色 own 的 marker。`mstar-phase-gates` 现明确门禁时点：无 placeholder 的判定在 `plan(locked)` 执行，marker 的清除期限是 compass 的 `status: locked`；禁令本身未变。
- 要求 Phase 1 review-and-edit Assignment 的 **`Inputs`** 携带初稿路径、方向决策（或指向 compass `## Decisions` 的指针）、带 owner 的 open questions、非目标理由，以及该角色 own 的 marker 清单；并把「派发编辑角色却不给方向决策 / open questions」列入反模式清单 —— 该角色只能重推它看不到的上下文。
- 已删除 Assignment 的 **`Model tier`** 字段。该字段不可执行 —— skill 文档无法观测宿主实际运行哪个模型 —— 且没有任何机器校验它：engine 与 CLI 都不要求它，因此删除它无需运行期改动。
- 一并删除该字段的两张宿主映射表及所有生产方/消费方引用：`mstar-sdd` 的档位章节（含其「派发时必须指明模型」规则）、三份 SDD dispatch prompt 模板与 sticky session 头部行中的 `Model:` 行、`file-handoffs` 的必需字段条目、Phase 2 的 per-task 派发步骤与「禁止省略该字段」的 Assignment 字段条款、Assignment 模板字段及其 SDD NEVER 提及、routing-eval 期望字符串，以及 `mstar-host/references/cursor.md` 中的档位章节。原先点名该字段的「禁止省略」条款现只覆盖 `Execution mode` / `SDD dir`。
- 宿主原生的模型选择仍留在它原本所在之处，交由宿主与会话决定：Cursor 的 Task `model` 参数被记述为可选的宿主 slug，服务于会话自身的模型策略，不规定任何 mstar 档位；dsh `agent()` 与 omp model handoff 能力保持既有描述不变。
- 安全审查深读指南（`skills/mstar-audit/references/security-review.md`）扩展覆盖面与误报纪律：§2 新增显式严重度锚点（informational → critical）与反升级规则；§8 侦查角度补充具体 `Signal:` 信号；§9a–§9h 类别折叠新增逐条排除与新增检查项（OAuth/SAML 绑定、WebAuthn、供应链/CI 信任、基础设施/IAM、数据隔离、AI/LLM 信任）；新增三个折叠——§9i 桌面/移动/本地 IPC、§9j 内存安全与二进制（仅源码审查）、§9k 可用性与资源耗尽；§12 新增「静态证据必需」规则；新增 §13「按类别排除规则」（自我注入、已存在权限检查、加密错误分支/仅写路径校验），并以一行指针把其余误报信号类别路由到各自归属章节；新增 §14 协议/RPC/消息不变量。

### Changed

- 在 OMP 宿主参考中写明 prepared Assignment 的生产者：`reserve-launch` 准入子句与可选传输小节现命名 **`mstar plan prepare`** 为写入 `coordination.prepared` 及其固定 `coordination.prepared.assignment_path` 的协调者步骤，把传输占位符定义为该绝对路径，补充额外 primary 路线的有序摘要（已注册的 `Todo` 行 → 存在的 feature worktree → 协调者已绑定 → prepare → `reserve-launch` → 既有先记账后副作用的迁移与 pane/启动/提交序列），并写明准入窗口——行准入随 Phase 1 关闭（任何行开始准备或执行时更早关闭），而已注册的合格行仍可在 Phase 2 期间被准备。
- 在 scoped-plan PM 传输小节补充宿主无关前置条件：条件性额外 primary 启动仅适用于协调者已注册且已准备、feature worktree 已存在的 plan 行；尚不存在的行无法被启动，因为行准入随 Phase 1 关闭。
- 在 OMP 宿主参考的可选传输小节新增**六项 scoped-route 派发清单**：全新目标会话、已准备（而非仅注册）的行、交接内容在准备前定稿且 bind 仅复核 Assignment 哈希（`coordination.assignment-stale`）、初始命令仅提交一次、读回确认执行且仅在明确未执行时单键恢复、绑定后仅以 steering 补充上下文——*exactly once* 仅约束初始命令。尾随 Enter 行为仍是对本仓库不拥有的传输 CLI 的现场观察。
- 在共享派发门禁中写明**跨会话派发的受支持路径**：跨独立主会话/终端的并发只有一种受支持形式——以 prepared Assignment 作为全新会话第一条指令的 scoped route；经终端提示词下发协调者自拟的 leaf Assignment 不受支持，因为它绕过 scoped 启动、lease 归属与 handoff 交接。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.11.0**。

## [3.10.3] - 2026-09-17

### Harness

- 新增 **`mstar-use-cli`** skill，作为 CLI 的 agent 面向 SSOT：任务→命令族索引、前置条件阶梯（harness root 解析、control root 与 feature worktree、neutral cwd、session envelope、revision 与 byte token）、两条规范序列（带版本的 read-modify-write、plan 完成序列），以及退出码 `0` / `1` / `2` 的读法——含参数解析器对缺参返回 `1` 的例外。**不复述 flags**：一律以各命令自身 `--help` 为准。
- **`docs/cli.md` 退役**，内容按读者分流而非跳转：仅属安装的两节（Codex agent files、install path layout）迁入 `INSTALL.md`，其自身的安装交叉引用与 `packages/cli/AGENTS.md`、`.cursor/LOCAL-VALIDATION.md` 现由该文件的文内锚点承接。CLI 契约指针——`README` / `README_CN`、`docs/commands.md` 与各 runtime skill 引用——改向 **`mstar-use-cli`** skill。旧文件直接删除：不保留跳转页，也不留兼容层。
- **漂移守卫的 CLI inventory 扩容**：从 CLI 主入口扩展到 plan / workflow / sdd 注册模块——新增 16 条此前不可见的命令路径（含 13 个 `plan` 动词）——引用这些动词现被校验，不再静默通过。同一套校验（声明 bin 前缀 + 真实命令路径）现在也扫描新 skill 自身的 markdown，而不只覆盖 Engine-check callout。
- 该 skill 已登记进**运行时加载面**：实现、审查/QA、运维、架构、harness 文本工作与 PM，在本轮运行或解读 CLI 命令时于各自 preset / 加载表加载 `mstar-use-cli`。
- **QC 三席与 `code-reviewer`** 的 bash 白名单获得只读 CLI 校验命令（`qc validate-report`、`lint`、`dispatch validate`、`worktree qc-alignment`、`status validate`、`lease verify`），消除「skill 要求席位跑机器门禁、席位却无权限执行」的矛盾。
- **README 双语对更新了宿主支持等级**：**`dsh = omp ≥ ZCode = OpenCode = Cursor > Kimi > Codex`**。ZCode 升入与 OpenCode、Cursor 并列的档位：其插件 hooks 在工具调用时执行默认分支 commit 守卫、裸 force push 守卫与引擎背书的协调写入门禁，属与 OpenCode 同一档的运行期集成。worktree 隔离仍由 skill 指导承载，尚未由 hook 强制。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.10.3**。

## [3.10.2] - 2026-09-17

### Harness

- 引擎现于 `recordWorkflowDelivery` 写入边界**拒绝交付尾证据**（`compound`、PR 标识、`merge`），只要任一 plan 行尚未 `Done`——执行生命周期契约已声明的顺序。门禁仅作用于写入：幂等重录跳过；已携带证据的快照不受影响。
- **计划模板**、PM 必读清单与 PM 自检现包含 scoped 引擎生命周期序列与证据顺序（`compound` / PR / `merge` 仅在行 `Done` 之后记录）。
- **独立 `development` 计划**现将只读 phase-6 门禁输出声明为 merge-ready 前置条件；迭代工作流仍沿用 Phase 4/5 退出清单。
- 残留项 **R2**（独立计划无集成锚点无法到达 `Done`）仍开放——模板明确在已提交/已接受交接处诚实停止，而非伪造终态。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.10.2**。

## [3.10.1] - 2026-09-17

### Harness

- 在宿主适配 skill 中新增宿主无关的**宿主钩子锚点**契约——`iteration-entry` / `phase-1-lock` / `phase-2-entry` / `rescheduling-checkpoint`——每个锚点由共享生命周期引用中的标记承载，并按当前宿主引用解析。
- OMP 宿主引用现按锚点声明此前仅有文档、从未接线的协调器调用，协调器会话会真正执行它们。
- 清理了四个密度最高的共享文件中残留的宿主名泄漏；被迁出的逐宿主角色绑定字段与引擎作用域细节现落在宿主引用中。
- 剩余的语料清理登记为 roadmap 目标（`host-seam-corpus-cleanup`）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.10.1**。

## [3.10.0] - 2026-09-16

### Harness

- 落地四处按 register 驱动的文档修正：恢复 Phase-6 阻塞句中的 `zero-residual` 限定语、修正 Session-todos 指针措辞、将 L4 QA 残留核验输入引用改为 project register、对齐 plan 模板 `Main worktree branch` 表头与解析器文档形式。
- 正式迭代 Phase 2 的 findings-cleanup 默认值由 **zero-residual** 翻转为 **allow-residual**，并附带强制的登记与披露义务：所有未决 finding 在 QC 决议、Completion/Status 报告与 leaf/SDD 报告格式中携带 id + severity + 跟踪位置；收口面（主 plan Review Gate Summary、compass Quality Gate Summary、PR 正文）增加 blocker-defer 标记。显式 `zero-residual` 选择加入、未决 critical 阻断与 Phase-6 禁止伪造关闭的规则保持不变。
- 规范 Assignment 契约新增 **Task budget (implement / ops rounds)** 字段：SDD fresh/continuation 提示要求在任务正文标记前携带该 header，并重复超支升级指令与 `plan-quality-bar.md` 第 7 条的强制「不得缩短已指派验证」规则；上一任务的预算不得被继承。
- `NEEDS_CONTEXT` / `BLOCKED` 上的预算超支现按 plan-quality-bar 第 7 条路由至 PM 拆单重派（`mstar-sdd`）；`mstar-review-qc` 与 `mstar-dispatch-gates` 的 engine-check 注记指向同一 presence-only 要求。
- 新增**实现者任务容量判据**（`Task shape / session fit`，plan-quality-bar 第 7 条）：一个实现轮次须闭合任务的 Files 与各门禁，闭合不了必须写明拆分点；预算压力不得缩短任何已指派的定向验证。
- 判据接入 `mstar-phase-gates`（tasks 条目、自检问题、quick-check 项），主 plan 模板新增每任务 **Effort (agent-oriented)** / **Split point** 栏位；`effort-estimation.md` 的任务级估算指向第 7 条。
- 将**阶段转换 `todo` 刷新纪律**沉淀为宿主无关规则：在每个阶段/门禁转换后、下一个动作或派发前刷新会话 todos，只关闭已完成条目，保留未决门禁并播种下一阶段——todos 始终是 snapshot/plan 状态的投影，不是第二状态存储。
- 在权威 Phase 2 procedure（`mstar-iteration/references/phase-2-worktree-lease.md` §2.4）新增具名的 **`Rescheduling checkpoint`**：五个冻结 reason（`before-wait`、`result-settled`、`dependency-changed`、`ownership-changed`、`capacity-changed`）与六步决策程序 —— 在等待无关 running child 之前启动全部已授权独立 ready work，真依赖在已审 commit 进入 dependent 的 assigned base 前保持阻塞，并允许一次有理由的 native wait（无轮询、无重复提醒）。`mstar-sdd` § Ready-task scheduling 与 PM 角色新增短指针；不新增调度器、ready-state register 或 engine schema。
- 新增六个 `phase2-*` 路由回归场景（version 30 · 62 例）及其回归信号（每条指向 §2.4 home），并记录这些场景与受影响的 `plan-scope-duplicate` / `plan-scope-last-plan` / `plan-scope-leaf` 场景的 before/after 行为证据。该证据为**单样本**、且**服务模型未独立证明**，因此**既不建立 model compliance，也不建立行为收益**。
- 将**每计划交付尾部**接入常规路线（冻结契约 `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`）：承诺时注册 → 计划锁定前知识回执 → 执行/验收 → compound 处置（`created`/`updated`/有理由 `skipped`）→ 开发类 PR 提交 → merge-ready 里程碑 → 核实合并 → 终态关闭/注销。独立开发 plan 现在走同一交付生命周期；iteration 子 plan 行与 plan-scoped 会话权限不变。
- **本仓库自身不再跟踪 harness specs。** `.mstar/specs/` 在此目录恢复为仅本地存在（`.gitignore` 回到单条 `.mstar/` 规则），迭代收尾扫描不再可能把本地产物提交进 harness 源仓库历史。下游仓库不受影响：`mstar harness scaffold` 片段、coordination 写门禁与解析链仍把 `{HARNESS_DIR}/specs/` 视为可跟踪的结果。
- **plan workflow 生命周期契约迁入 skill 语料。** 其语义（交付类型声明、生命周期阶段、证据契约、engine seam 清单）现为 skill reference `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`。engine 模块注释、CLI help 文案、测试与引用它的运行时 skills 均指向该路径，而不再指向仓库本地的 harness spec。
- **两份过程 spec 留在 project 语料。** `omp-phase2-instances.md` 与 `phase2-proactive-scheduling.md` 是已有 runtime 指引（`mstar-host/references/omp.md` § Phase-2 plan instances；`mstar-iteration/references/phase-2-worktree-lease.md` §2.4）背后的过程来源，因此保留为 project reference 而不复制进 skill 语料 —— 对它们的引用改指上述 runtime home。

### Changed

- 为 `@mstar-harness/omp` 新增可选启用的 **coordinator 模型交接**：新的扩展入口（`extensions/model-handoff.js`，经 manifest `omp.extensions` 发布，engine 内联，唯一宿主 import 由运行中的宿主解析），以及原生插件设置 `modelHandoff`（默认关闭）与 `handoffTarget`（`@default` \| `@smol`）。被绑定的 coordinator 会话在**新**迭代开始时先切到 `@slow` 再做实质性 Prepare；Phase 1 完整完成后（专家回执齐备、Prepare 已冻结、独立且分支匹配的 integration checkout、必需推送已验证）仅该会话切换一次到已保存的目标角色。普通对话、leaf 会话与 plan-scoped 会话保持无动作；不写角色映射、goal 目标或 workflow 状态；等待期间的手动模型变更只取消该会话本次交接。
- 固定本包的 OMP 宿主契约：可选 peer 与开发依赖 `@oh-my-pi/pi-coding-agent@18.2.1`、Bun 下限 `>=1.3.14`，并新增 `bundle-smoke` 用例——解包已发布 tarball，在未安装 engine 包的可支配宿主根中经由宿主自身的插件发现、扩展加载器与自定义工具加载器驱动它。它取代了此前基于源码文本的 bundle 断言（符号存在、无裸 engine import）。
- 在 OMP 宿主参考与包 README 中记录原生 `/settings` → Plugins 路径、持久化及其 user-scope 限制（project-only 安装没有原生设置行）、支持的入口与模式、coordinator 绑定、完整 Phase 1 就绪条件、取消、重放与失败语义。
- 为 `@mstar-harness/omp` 新增可选启用的 **Phase-2 plan instances**：新的扩展入口（`extensions/phase2-orchestration.js`，经 manifest `omp.extensions` 发布，engine 内联，唯一宿主 import 由运行中的宿主解析），以及原生插件设置 `phase2PlanInstances`（默认关闭，**仅**为额外 primary 启动授权）与可配置的 `maxPlanInstances`（正整数安全值，默认 2、最小 1、**无上限 2**；存在但畸形的值会显式失败且不授权任何启动）。Phase-2 协调者会话对**同一观测状态**最多收到一次有界提醒——观测键在消息前落盘，未变化的相同状态不再触发，无定时器、无轮询，原生完成投递始终权威。
- 新增 `mstar_phase2` 记账工具及其本地传输意图 journal（`<workflow dir>/omp-launches.json`，version 1）：`bind`（协调者 Phase-2 首个宿主动作）、`checkpoint`（按当时采样确认共享重调度检查点，使用冻结的五个 reason），以及 `reserve-launch` / `record-launch`——严格 `reserved → starting → created → submitting → submitted` 迁移，每一步都在其 pane / OMP 启动 / prompt 副作用**之前**落盘；占用按 plan id 去重计为「自有待启动 intent ∪ 活跃 plan primary」，对照最新 cap；`refused` / `uncertain` 绝不盲目重试。编译代码只做准入与记账：不 spawn、不 merge、不重写 workflow 状态、不释放 lease。
- 在 OMP 宿主参考、包 README 与 scoped-plan PM 传输小节中记录原生 `/settings` → Plugins 路径（及其 user-scope 限制——project-only 安装没有原生设置行）、仅启动的开关语义、容量语义、显式 bind/checkpoint/intent 调用序列，以及可选、由 skill 驱动的 Herdr/tmux 传输：前置校验（skill 确实存在且已读 + CLI + 匹配的托管环境；在没有 tmux skill 时 tmux 保持不可用）、在 prepared worktree 以非聚焦方式创建 pane、原样复用返回的不透明 target、一次绝对路径 `/iteration-drive --assignment` 提交且不传递协调者凭据，以及 `agent_not_ready`、超时或提交停滞的终止处理。传输证据明确标注为模拟，而非原生 E2E。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.10.0**。

## [3.9.4] - 2026-09-15

### Harness

- 受保护的 `mstar persist` 类型（`status`、`snapshot`、`residuals`）现在只有一个写入者：`--expect-version <absent|sha256:<hex>>` 把 put 路由到引擎加锁的 `replaceCoordinatedArtifact`（同机 CAS）；协调的 `snapshot` 替换还必须带 `--session <coordinator envelope>`；注入的 `--store` 模块因无法满足该契约而被拒绝；受保护类型的裸（未加版本）`put`／`delete` 会在写入任何内容之前被拒绝。缺失／非法／混用标志在读入任何内容之前就 fail-closed（用法错误，退出码 `2`）；版本或会话不匹配是引擎拒绝（退出码 `1`），字节保持不变。
- `mstar persist get <受保护类型> --versioned` 输出 `{payload,version}`：读取到确切字节的 `sha256:` 字节版本；文档缺失时为 `absent` 令牌且 `payload` 为 `null` —— 因此读-改-写就是 `get --versioned` → `put --expect-version`，把报告的令牌回填给 `--expect-version`。
- 新增 **`mstar plan` 计划级协调传输层**：`bind`（coordinator / workflow+plan / Assignment / `--resume`）、`show`、`prepare`、`progress`、`residual-add`、`residual-close`、`handoff`、`accept`、`return`、`integration-start`、`integration-accept`、`complete`、`reconcile`；JSON 走 stdout、诊断走 stderr，退出码为 `0` 成功 / `1` 引擎拒绝 / `2` 用法错误。
- `mstar harness scaffold` 现在 await 异步且 store 路由的引擎引导，并固定其解析出的 store 根。
- 协调者转换动词现在把 **`--handoff` id 传入引擎**，由引擎在自己的锁内与行内记录核对：在 CLI 读取与变更之间被替换的 handoff，不再可能被「指名旧 handoff」的命令转换；CLI 侧的预检仅作为更早、更友好的拒绝保留。
- Git 读取在环境无法作答时以 `coordination.git-unavailable` 拒绝（携带路径、命令与原因），不再报告为集成分叉；同时加上 10 秒超时，卡住的 `git` 不再一直占住行锁、拖垮其他写入方。
- 集成证明改为**一次** `git rev-list` 读取 first-parent 路径，不再逐 commit 起子进程，繁忙集成分支上的持锁时间保持恒定。
- findings-cleanup 门在持有 register 写锁时求值（snapshot → register 锁序）；workflow merge lease 按 plan 与 source branch 比对，外来 lease 既不会被复用也不会被释放。
- 计划级动词在每次调用前把活动 `FsStore` 固定到引擎解析出的根，因此在 linked feature checkout 内运行的进程解析到的是**主 worktree** 的 harness，而不是本地 `.mstar`。
- `mstar plan` 的行级动词现在作用于该行的**实时**交接：`--handoff <id>` 会与引擎报告的交接 id 校对（传入*不同的*实时 id 时以 `coordination.handoff-mismatch` 拒绝，退出码 `1`，不写入任何内容），且 `plan show --json` 会连同行的 `state` / `attempt` 一起报告 `handoff_id`，因此崩溃的调用方丢失 id 后仍可在恢复步骤中读到它。
- `/iteration-drive` 新增 **plan 级 scoped 入口**：`--assignment <绝对 md 路径>`、`--workflow <id> --plan <id>` 与显式的 `--resume <绝对 session json 路径>` 形态在独立 primary 会话中只驱动一个已 prepare 的 plan。该会话止于一次可持久化的 **handoff**——`Done` 与两个 lease 的释放仍由 coordinator 在验证合并后完成。同一 plan 的第二次 fresh 入口以重复持有被拒绝；非空但畸形的参数 fail closed；无参数仍走整迭代路线。
- scoped 会话只拥有一个 plan 行：用 `show` 读取，只写 `progress`、`residual-add`、`residual-close` 与 `handoff`；兄弟行、生命周期锚点、根 register、共享索引、迭代 PR 与 Phase 3–6 均留给 coordinator。用户指南：`docs/commands.md`——本次变更附带的统一命令参考，scoped 会话即其中的 `/iteration-drive` 章节；CLI 标志与退出码：`docs/cli.md`。
- scoped 终端是**传输方式，不是依赖**：任意终端均可，Herdr / tmux 均为可选——所有权不读 pane 状态、TTL 或终端标签。
- PM 路由回归语料新增七个 `plan-scope-*` 场景，覆盖两种寻址形态、重复入口、未知参数、最后一个 plan 的停止、合并前标 `Done` 的拒绝、无参数路线与 leaf 边界。`mstar plan` 传输层本身记录在 `.changes/unreleased/plan-coordination.md`。
- 由于 `/iteration-drive` 现在在命令 frontmatter 中公布其参数形态，钉住每条 `input:` hint 的 dsh 客户端 claim 表（`packages/dsh/tests/commands.spec.ts`）已同步到新 hint，使输入框 ghost text 提供 scoped 形态而非直接裸执行命令。
- `mstar status workflow-close` 通过引擎加锁的 snapshot 写入器关闭工作流，并新增 `--session <绝对路径的 coordinator envelope>`：协调工作流现在拒绝由计划会话关闭（`snapshot <path> is coordinated — close requires --session <coordinator envelope>`，退出码 `1`，不写入任何内容），且该判断发生在判定计划行之前，因此"未完成行"拒绝不会再被误判为会话问题。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.9.4**。

## [3.9.3] - 2026-09-15

### Harness

- drift-lint 新增**溯源门禁**：对仓库已跟踪文本面（`.md` 全文、`.ts` 注释行——行首注释行加行尾 `//` 注释，先经共享注释掩蔽器掩蔽字符串与模板字面量再检测且不要求前置空白，`://` URL 序列除外）运行引擎溯源发现器，文本面上的带日期 plan/迭代 ID 或本地 harness 路径都会以 `file:line` 行形式使 CI 失败。遍历与 `git ls-files` 求交集，未跟踪的本地文件不会使门禁失败（`.mstar/sdd/…` 深链仍归 skill 语料的临时引用检查管辖）；已装配的发布面（`.changes/archive/`、`CHANGELOG*.md`）作为历史记录豁免。
- 把 E2E 证据边界限定在开发 plan 内：`mstar-harness-core` § 定向执行与验证边界、`mstar-phase-gates` § 最小证据要求、`mstar-artifacts` 的 plan-quality-bar 与 `plan.main.md`、以及 `mstar-e2e` 现口径一致——真实浏览器/真机/安装部署 E2E 永不是开发 plan 的 task，也不是任何 gate 的证据义务；它只存在于用户显式请求的独立 `mstar-e2e` workflow，其命名场景即该 workflow 自身的 plan rows，各层则以自身单测/集成测试自证。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.9.3**。

## [3.9.2] - 2026-09-14

### Harness

- 新增**回合边界派发门禁**：当 `Execute as` 为审查席位（`qc-specialist`、`qc-specialist-2`、`qc-specialist-3`、`code-reviewer`、`qa-engineer`）或 `Task category` 为 `audit` 时，Assignment 必须同时声明 **`Budget (review / QC seats)`** 与 **`Return shape (review / QC seats)`**。`mstar dispatch validate` 在字段缺失、为空或为 `N/A` 时报错并指出缺的是哪一个；implement / ops / docs 轮不受影响。只校验字段**是否存在** —— 字段值是散文，从不解析。
- 新增 **`validateQcReport`**（`@mstar-harness/engine`）与 **`mstar qc validate-report <report.md>`**，用于 plan-QC 席位报告。门禁检查：报告以 `---` frontmatter 开头且带 `qc` 必需字段；frontmatter `verdict` 在枚举内且与正文 verdict 行一致；`## Summary` 各项计数与对应 `## Findings` 区的条目数一致；verdict 由计数推出（存在未解决的 Critical / Warning 时不得 `Approve`；`Unconfirmed` 计数不为 0 时 verdict 必须为 `Unconfirmed`）；已声明的 `Truncated coverage:` 行不得被判为 `Unconfirmed` —— 触顶收口是范围裁剪，不是证据通道失败。无法判定的情况保持静默，不做猜测。
- 报告门禁读取**最后一条** verdict 行，且 `## Summary` 是报告**唯一的当前计数** —— 原地复审刷新 `## Summary` 与 `## Findings`，而不是追加第二份计数，因此复审后的报告按当前状态判定，所有计数规则共用同一读数。
- 两个门禁都只读 **Assignment header 区 / 报告 frontmatter 区**：派发门禁停在首个 `## Task` 标题、`---` 分隔线或单 `#` 标题处，因此在任务正文里引用的模板字段行不会满足门禁，也不会关闭门禁（正文里的 `**Execute as**: scout` 不再让可写门禁失效）；报告门禁对起始 `---` 未闭合的 frontmatter 直接报 `qcreview.report.unclosed-frontmatter`（high）—— 缺闭合行时正文会被读作 frontmatter，字段与正文规则无从判定。
- 将检查接入运行时 skills：`mstar-review-qc` § 席位预算与截断 新增唯一一条 Engine-check callout，`qc-specialist-shared.md` 与 QC 报告模板给出指针，`mstar-harness-core` § 定向执行与验证边界 的回合边界条目现点名两个必需字段。
- 未改变审计链行为、verdict 词汇、severity 语义、register schema 或既有报告契约。
- 在 `mstar-harness-core` § 定向执行与验证边界 新增**只读审查席位终止契约**：review / QC / L2 席位受默认席位预算约束，触达即停止扩展而非等到人工干预，并声明 `Truncated coverage:`——该状态与 `Unconfirmed` 保持区分。
- 规范化 Assignment 模板新增 review / QC 轮次的 **`Budget` / `Return shape` / `Severity bar` / `Input provenance`** 字段，并补充定量停止派发不变量、无界否证式验收反模式，以及两条 PM 自检规则（产物声明与 `path:line` 引用来源）。
- 将规则贯通到席位侧（`qc-specialist-shared`、`reviewer-workflow`、`report-template`、`mstar-sdd` task reviewer）与 PM 编排（`mstar-review-qc`）：截断的席位停止并声明其覆盖范围，未覆盖范围上的 gate decision 不构成批准。收紧 `mstar-artifacts` 的 residual **severity bar**：`critical` 与 `high` 现以「不安全后果在本次 merge 上是否可达」区分，与 finding 落在哪个 QC 报告 section 无关，因此可达的不安全 finding 无法借 `Approve with residuals` 过关；分级按后果而非不确定度，文档缺陷若本身会导致不安全后果则按该后果分级——并移除把非阻断文档发现升级为阻断项的 “when unsure, use `high`” 默认。
- 将 harness 的阻塞判定统一到同一条**可达性轴**：跨链词汇表（register `severity` / 审计 Merge class / plan-QC report section / L2 task review）落位到 register SSOT —— `mstar-artifacts` `references/status-and-residuals.md` §5 Cross-chain vocabulary。
- `mstar-audit` `references/pr-review.md` § Merge class 现将 `must-fix` 限定为与 register `critical` 同类（不安全**且**在本次审查变更中可达），并把 `should-fix` 置于同一轴上（不可达的不安全 / 显著技术债 / 实质性非阻塞），同时指向该表而非重述定义。
- 为 `Critical` / `Important` / `Minor` 补上缺失的定义（`mstar-roles` `references/code-reviewer.md` § Issue severity (Mode A)）：阈值对齐轴，`Critical`/`Important` 驱动 per-task 修复循环，`Minor` 交给 `## Minor (for plan QC)`；L2 派发提示词（`mstar-sdd` `references/task-reviewer-prompt.md`）指向该定义。Merge class 仍只由 Mode C（PR review）使用；Mode B（审计）沿用其自身的 finding 格式（`Impact` / `Effort` / `Risk` / `Confidence`，plan 按 `Priority` 排序）。
- 枚举、verdict 规则、tally/score 规则、tier 与 budget 机制、路由行为均未改变 —— 标签始终是同一判定的投影。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.9.2**。

## [3.9.1] - 2026-09-14

### Fixed

- `mstar worktree cleanup` 不再因**无关** workflow 的坏 snapshot 而中止，也不再丢失该 snapshot 的护栏。JSON 可解析但校验失败的 sibling 以**降级形态**进入安全集——只保留具保护性的声明（`branch.base`/`integration`/`target`、lifecycle worktree path、merge/execution lease、行 ownership 元数据），并把 lifecycle 与行状态一律强制为非终态，因此只会**增加** keep/refuse 判定。完全无法解析的 sibling 使安全集信息不完整，故默认 **withhold 全部 remove**（改判 `cleanup.refuse.unreadable-snapshot`，plan 仍完整打印），除非操作者给出 `--ignore-unreadable-snapshots` 断言。选中 snapshot 仍 fail-loud（exit 1），坏 snapshot 的字节永不被修复、改写或删除。契约见 `mstar-branch-worktree`「Worktree / branch cleanup」。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.9.1**。

## [3.9.0] - 2026-09-13

### Testing

- 在插入测试文档前生成合成 audit 密码，保留随机值的秘密检测覆盖，并避免源码扫描器将嵌套表达式误判为硬编码凭据。
- 将 evidence 输出上限测试隔离到捕获输出的 CLI 子进程中，在验证完整转发与日志截断的同时，避免大量内容涌入测试运行器的实时输出。
- 更新精确漂移回归计数，纳入已验证的 cleanup 与合并后关闭门禁引用：48 个 Engine-check callout、46 个 CLI citation。

### Fixed

- 清理命令现会重新探测延后删除的 integration worktree 所释放的本地分支，在一次 apply 中删除已合并分支，同时保留拒绝护栏及证据基准检出目录的删除顺序。
- 更新 **dsh headless 使用指导**：无人值守工作应保留受限权限、核实会话实际生效的权限，并将需要审批的操作转到 web profile，不再建议解除沙箱限制。
- 将 worktree 校验、SDD 发现与 evidence 诊断中剩余的 Unicode 字面量转义，保持运行时文案及匹配行为不变，恢复源码 ASCII 门禁。
- 将 worktree check 与 cleanup CLI 字面量中的破折号改为 Unicode 转义，在保留运行时文案的同时满足源码 ASCII 检查。
- 基于当前引擎及权威 hook 源码重新生成写入门禁 bundle，恢复构建产物同步。

### Harness

- 将 Codex 自定义角色 TOML 安装为普通文件，使已发现的角色能够加载。再次运行 init 会替换指向预期来源的旧链接，并在刷新不同内容的普通文件前备份；doctor 检测链接与来源内容漂移。同步安装及派发指导，以具名角色实际启动成功作为验证依据。
- 新增 **Phase 6 post-merge close 引擎门禁**（`evaluatePostMergeClose`）：纯函数、增量式校验本地终态（快照终态合法性、悬挂 lease、根 `status.json` 已注销），稳定码 `PHASE6_*`；`mstar iteration gate --phase 6 --workflow <id>` 无需 `--compass` 即可评估。
- Phase 6 门禁现在以完整 v2 根校验器（`validateStatusV2`，仅结构）校验根 `status.json`：畸形 registry（非 v2 版本、缺 `updated_at`、畸形 `workflows[]` 条目）一律 fail-closed 报 `PHASE6_INVALID_ROOT`，不再因 workflow id 缺席而误判 PASS；`/iteration-start` 与 README 命令表的自动推进完成定义对齐到 Phase 6 post-merge close（与 `/iteration-drive` 同一 Done 定义）。
- 安全扫描前使用冻结依赖构建真实 DSH 插件入口，保留扫描器的完整 JSON 告警，并在任务摘要中展示全部告警。
- 精简仓库维护指引：移除重复的运行时加载规则与历史发布细节，更新包职责入口，并将技能编写指引和定向验证要求对齐当前 harness 契约。
- 移除仓库维护中完整 diff 必须单独审批的门槛；agent 可继续执行已获授权的工作，无需为每份完整 diff 重复申请批准。
- 新增**带守卫的 `mstar worktree cleanup` 命令**与纯函数 `planWorktreeCleanup` 引擎规划器：默认 dry-run 逐候选打印 `verdict | kind | ref | reason`；`--apply` 先以普通 `git worktree remove`（永不 force）移除 eligible worktree，重新探测/规划后删除现已未检出的分支（`git branch -d`，永不 `-D`），远端走 expected-OID `--force-with-lease` compare-and-delete。active lease、任意检出分支与 foreign 归属一律 refuse；protected refs 一律不移除（默认分支与 `branch.base` 为 keep，非终结 owner 为 refuse）；合并证据是硬前置（squash-only 残留保留并报告，绝不强删）。
- 将两条 cleanup 时序车道接入技能语料：新增 **`mstar-branch-worktree`「Worktree / branch cleanup」** 契约本体（归属来自 snapshot 行元数据/retained track Assignments 或已验证 `--worktree` 断言——禁止命名推断）、`mstar-iteration` Phase 2 的 merge 同轮调用（父迭代仍在运行即可回收 Done plan），以及 Phase 6 §6.4 在 terminal close + PR merged 后的调用。
- worktree 脏检查现在计入 ignored 文件：含 ignored 内容的 worktree（如本地独有 `.env`）会被拒绝（`cleanup.refuse.dirty-worktree`）而不是被移除。
- `--apply` 将分支删除 cwd 宿主（通常是 terminal integration worktree）推迟到最后一轮移除：先移除其他 eligible worktree，再从 evidence-base 检出执行 `git branch -d`，最后移除被推迟的 integration worktree——仅合并进 integration 分支的 plan 分支（squash-merge 时代）现在能真正删除，而不是退回主 worktree 后 refuse。
- 统一各宿主的活跃生命周期分支校验，保留并行轨道所有权，限制 SDD Git 探测时间，并保持 integration cwd 工作流选择。
- feature worktree 豁免下仍保留独立 integration checkout，记录并行轨道保留分支，并集中说明 L1 拒绝语义。
- 工作流快照集成字段 `control_worktree_path` 更名为 **`integration_worktree_path`**：writer 只输出规范键；canonical reader 以 medium 迁移建议接受 v1 别名（仅内存归一化，绝不原地改写）；严格校验拒绝同时携带两键的文档；`mstar migrate` 完成更名迁移。
- **`mstar worktree check`** 现校验主 worktree 驻留——进程 SSOT（`status.json` / `workflows/`）从验证过的主 worktree 根解析，不再记录进快照。
- `worktree check` 旗标 `--control` 更名为 **`--integration`**；`--control` 作为弃用别名保留一个发布周期（stderr 迁移提示）。
- **dsh / omp / opencode** 宿主面（gates、tools、hooks）切换到规范写模型。
- 运行时技能语料改写为**三域 worktree 写模型**（control / feature / integration 驻留），并刷新全部打包镜像。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.9.0**。

## [3.8.3] - 2026-09-12

### Harness

- 本地验证与审查限定于改动行为，独立工作并行，常规 QA 仅使用定向单元证据；全量本地测试须用户明确授权。
- 文档和策略修改可提交明确的 `scoped-check` 证据，无需虚构测试文件；可执行逻辑变更仍须真实测试证据。
- 新增独立 `mstar-e2e` workflow 与 `/amazing-e2e-check` 入口，包含 Codex 项目命令安装，用于用户明确请求的浏览器、真机及安装部署场景。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.8.3**。

## [3.8.2] - 2026-09-12

### Changed

- **dsh 文档**：包 README 现记录 dsh 原生只读扇出路径的推荐 `workflowNames` 白名单——`mstar-qc-tri`（plan QC tri）、`mstar-audit-fanout`（大型仓库 `/codebase-audit`）、`mstar-pr-seats`（`/amazing-pr-review deep`）——并在同处给出生产覆盖层说明：出厂空名单下每个名字都是 *unknown*，默认 `workflowGate: 'warn'` 把它变成运行可存活的一条 `workflow.name.unknown` 咨询；若还要否决 unknown 名字，部署在 profile 层设置 `workflowGate: 'hard'`。默认值未变——`workflowGate` 仍为 `'warn'`、`workflowNames` 仍未设置（二者都是操作者覆盖，绝非 mstar 默认）。
- **dsh 只读扇出（文档）**：`skills/mstar-host/references/dsh.md` 新增 **Read-only fan-out via the `workflow` tool** 一节，`references/dsh-workflow-scripts.md` 提供三个名字可直接复制的 `script` + `meta` 模板；`commands/codebase-audit.md` 与 `commands/amazing-pr-review.md` 携带 dsh 条件句（斜杠命令 → 原生 `workflow` 工具 → 会话 `workflow-run` 节点，其它宿主不变），`skills/mstar-sdd/SKILL.md` 注明 plan QC tri 可走 qc-tri 脚本，而逐任务实现者仍为串行 `subagent`。

### Harness

- **dsh 宿主**：mstar 在 dsh 上的推进方式现为**原生 workflow**——workflow 快照相位、派发门禁与 subagent settle 通知；goal bridge 收敛为**纯 advisory**，人类 `/goal pause` 不再会被 mstar 自身的派发边重新 arm。`mstar-host` 的宿主无关 `/goal` 规则加入显式 dsh 例外（其他宿主保留完整流程目标规则），`mstar-host/references/dsh.md` 新增推进纪律小节（子代理占据关键路径时等待其 settle 通知，而非在同一 worktree 上再开工作单元），PM 必读增加 dsh 指引。
- **dsh 宿主**：共享 steering 辅助函数（`isRootLikeAgent`、`rootAgentOf`、`steeringCompass`）迁至 dsh 插件的 `gates/steering.ts`——planMode 行为不变。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.8.2**。

## [3.8.1] - 2026-09-11

### Harness

- **dsh 插件**：工作流面板从会话区 view ring 迁入 dsh **右 Sidebar**——面板现经 sidebar 公开的两段式席位契约注册为一等页签类型（`kind: 'mstar-workflow'`），入口为引导页 capsule（点选展开侧栏，再次点选聚焦既有页签），面板体与 chip 标题为 keyed 席位。旧 `conversation.view` 页签**移除**（迁移，而非第二表面）；chip 标题在打开时捕获、不再跟随会话中途的语言切换；列折叠或其它页签激活时面板体不渲染任何内容。
- **dsh 插件**：面板为窄停靠列重排——单列壳层、唯一滚动主体（`[data-mstar-scroll]`；各页自有滚动器与摘要嵌套滚动器退役），宽度由**容器查询**驱动（480px 以下紧凑节奏；720px 以上分组网格铺开为两列），代理执行**画布改为竖直分组列表**：SVG 连线层、卡片端口与指针 pan 删除——流转顺序由恒定 phase/stage/子桶分组标题承载，实体卡变为全宽流行，保留 role chip、状态点、×N 计数、透明度分级、完成 ✓（off 档排除）、证据/idle 占位与按需徽标；任务迭代页计划板竖排五组 + 竖直 stepper，事件记录分区改为流内容。
- **dsh 插件（行为变更）**：engine-status catalog 锚点标识更名 `mstar-engine-status` → **`mstar-engine`**（`kind: 'plugin'` / `form: 'catalog'` 的 source 形态不变）。已发布构建发出的行在会话日志中持久化旧标识，面板锚点读取方**同时**接受两种标识；任何其它 `plugin` 值都不是锚点，会话降级为显式 `waiting` 态。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.8.1**。

## [3.8.0] - 2026-09-10

### Harness

- **dsh 插件**：engine-status catalog 行的持久化 `source` 现为一方 `plugin` 臂——即恰好 `{ kind: 'plugin', plugin: 'mstar-engine-status', form: 'catalog' }`，不含任何其它成员。此前的自定义 `kind: 'mstar-engine-status'` 外加五个 payload 成员，使**每一个**跑过本插件的 pre-V3 会话日志都**无法在 Web GUI 中打开**（已发布的会话格式 V2→V3 分类器以 `cannot safely transform unclassified message source` 拒绝整份日志），而这些多余成员在任何 `plugin` 臂 source 被逐成员审计时都会被三条已发布历史边界全部拒绝。新增回归测试在真实组合行上断言该三成员 source，自定义 kind 与「顺手加一个字段」的改动都无法回归。
- **dsh 插件**：payload 不再落在消息 `source` 上。**实际发出**的 payload 会在追加该行的同一次 digest 门控发射中按会话快照到 `{HARNESS_DIR}/snapshots/engine-status.json`，工作流面板则按需从宿主共享的 `/api` typert 网关（`mstar/engineStatus`）拉取该会话自己的快照——浏览器半体 `connection.rpc.call('/api', 'mstar/engineStatus', { args: { sessionId, cwd } })`，由宿主校验被断言的会话并返回其已存记录。快照缺失、版本未知、写入中断或属于其它会话时，渲染带原因的显式 `unavailable`——面板任何字段都不会静默降级为空态。该端点不做鉴权：能访问本机 `/api` 网关**且**知道 `(sessionId, cwd)` 组合的调用方即会被服务（payload 是工作区摘要，不是机密），但每个应答都限定在请求的会话内——存储记录的 `cwd` 必须同时匹配断言值与服务端解析出的工作区，客户端在渲染前还会复核回显的 id 与工作区。
- 文档同步到新契约：`packages/dsh` README 双语对 + `bundle/README.md`、dsh 宿主参考，以及 `mstar-artifacts` residual fail-loud 交接条款（现与 `severity` 并列表述 **`decision`** 枚举，并写明 `"resolved"` 这类 lifecycle 取值会导致**整个 register 不可写**）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.8.0**。

## [3.7.3] - 2026-09-10

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.7.3**。

## [3.7.2] - 2026-09-09

### Harness

- 将 `mode: primary` 的 **`project-manager`** agent shell 从共享 `agents/` subagent 目录迁出，移至 `packages/opencode/agents/`（仅 OpenCode 使用）。各宿主插件面（ZCode / omp / Claude-plugin manifest）不再把 PM 注册为 subagent——PM 入口保持 `pm` skill；OpenCode bundle 时并入 `harness-agents/`。
- 同步更新 omp/dsh 镜像契约与宿主文档。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.7.2**。

## [3.7.1] - 2026-09-09

### Harness

- **CLI 与插件版本漂移一条命令即可发现，覆盖全部受支持宿主**：`mstar-harness doctor --target <host>` 通过各宿主本地发现（opencode 包缓存、cursor 插件检出清单、codex/omp `plugin list --json`、zcode 插件缓存、dsh 全部 profile 的 node_modules、kimi 的 `$KIMI_CODE_HOME/plugins/managed`；多个版本取最高 semver）对比运行中的 CLI 版本与已安装的 Morning Star 插件版本，并按方向给出一条提示——CLI 较新 → 各宿主的插件更新提示，插件较新 → 更新全局 CLI（`npm i -g @mstar-harness/cli@latest`）——仅为信息性 note，不会成为 doctor 错误、也不改变退出码；`mstar-harness-core` 版本漂移契约已更新为全宿主覆盖。
- `kimi` 以最小适配器加入受支持安装目标：doctor 报告解析后的 `$KIMI_CODE_HOME/plugins/managed` 位置且不要求 kimi 二进制存在；init 仅输出提示——插件安装与更新经 Kimi TUI 的 `/plugins install` 完成。
- **Marketplace 清单现在固定插件版本。** `.claude-plugin/marketplace.json` 与根 `marketplace.json` 在 `morning-star-harness` 插件条目上携带 `version`，且两份清单加入发布版本面——`release:prepare` 在 `plugins[0].version` 处提升、`release:validate` 在同一路径把关，ZCode marketplace 刷新即可检测到新版本。
- **ZCode bootstrap marketplace 条目携带 `version`。** CLI 以 CLI 发布版本作为种子；ZCode marketplace 刷新会用仓库随附清单覆盖种子。doctor 有意不按版本偏差把关——快照比已装 CLI 新或旧正是更新信号本身，而非异常状态。
- **Worktree 门禁现在区分 Git checkout 身份与物理路径嵌套。** 位于 control checkout 内的真实 linked worktree（文档化的 `.worktrees` 布局）通过 L1 预派发检查与 bound SDD 执行上下文；同一 control checkout、其普通子目录或 symlink 别名即使声明分支与 control 分支相同也被拒绝。Git 探测失败沿用既有有界超时 fail-closed。
- **control checkout 根由 git 探测推导，而非 `dirname(harness)`。** `resolveSddExecutionContext` 解析声明 harness 根的真实仓库 top-level（`git rev-parse --show-toplevel`，有界且 fail-closed），因此 `.mstarc`/override 嵌套 harness（如 `<control>/state/.mstar`）在 standalone 与 active-lease 上下文中以相同方式把关同 checkout 隔离；无法解析的根 fail-closed。
- **单一共享 checkout 身份判定。** `l1PreDispatchCheck`、`assertControlVsFeaturePath` 与 `resolveSddExecutionContext`（`sdd.context.feature-in-control` 门禁）共享 `isDistinctCheckout`（按 canonical per-worktree git dir 比较）——无 `.worktrees` 名称特判、无重复 containment 规则，control-harness-inside-feature、路径逃逸、lease 与分支保护保持不变。
- **ZCode 协调写入门禁**：新增引擎内置的 PreToolUse（`Write|Edit`）进程钩子 `hooks/mstar-write-gate.mjs` —— hard 模式仓库对 harness 协调文档（status.json、workflow 快照、项目登记）的写入以 exit 2 + 可操作的 stderr 理由拦截（stdout 恒为空）；soft 模式与非 harness 写入静默放行；可用 `MSTAR_WRITE_GATE=off` 按会话关闭。
- **编辑校验重构后的结果（ZCode 宿主）**：确定性编辑（`old_string` + `new_string` 唯一匹配，或 `replace_all`）现在校验重构后的内容而非编辑前落盘状态 —— 确定性的破坏性编辑在 hard 模式下会被拦截；歧义或不可重构的编辑保持编辑前回退。
- **超大协调文档在 ZCode 宿主上现为违规**：超过 2 MiB 校验预算的内容或落盘目标产生 `status.oversized`（hard 模式拦截并在理由中给出逃生口，而非静默放行；omp 保持默认静默放行）。
- **omp 移除钩子懒加载（版本化分歧）**：引擎在构建期内联，过期的 engine dist 现在会让 omp 构建失败而非静默降级；Gate-1 的拦截/放行判定与理由字符串不变（golden fixture 矩阵验证）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单、便携式 Agent Plugins 清单及两份 marketplace 清单：**→ 3.7.1**。

## [3.7.0] - 2026-09-08

### Harness

- 迭代技能（mstar-iteration）渐进式披露重构：主 SKILL.md 收敛为 122 行 phase 路由表（仅保留唯一路由表 + 通用不变量，重构前 408 行）；Phase 1 启动细节移至新文件 `skills/mstar-iteration/references/phase-1-prepare.md`，Phase 2 循环细节并入 `references/phase-2-worktree-lease.md`，start/drive/resume/close/PR 每条路由只命名一个 phase reference——结构性逐路由字节下降 23–56%（路由集由 37 项 closure 测试钉住；字节数据见 plan eval 证据，非观测模型加载）。
- 命令（`iteration-start/drive/loop`）、PM 角色引用与 helper-discovery 指针全部重定向到 phase reference；生命周期规则无重复（phase 路由表是唯一派发表；§2.6 作为跨阶段 SSOT 留在主文件）。
- 冻结 30 用例 skill-eval 语料（v28）新增五个对抗性 phase 边界用例（并行评审链、Phase 3 塌缩、提前开 PR、错误阶段 resume、覆盖暂停），折叠进既有用例 id 并钉住 product→architect→writing-specialist 顺序链；Cursor routing-evals 升至 v28 并新增五条对应回归用例。
- 证据：共享 30 用例语料上的 paired dev 对比已完成（candidate `cef1675c` vs 原始基线 `ec7cc1bc`：17/20 vs 17/20，失败集完全一致，零候选侧回归，0 基础设施错误）；冻结三重复 heldout **未完成（24/60）**——真实模型运行被用户配额指令封顶，剩余验证由用户按 plan eval RUNBOOK 自行执行；逐路由检查了首轮与 resume 的 trace 观测读取（合成 fixture 未物化 skill 闭包，路由加载下降保持为结构性字节结论而非因果模型加载结论）；drift/standalone 全绿。
- **根因修复**旧版 plugin-scanner 的 `SHELL_INJECTION_PATTERN` 误报，而非依赖压制：`packages/dsh` 命令 frontmatter 解析改为逐行匹配 label + 静态值正则（不再用 label 动态拼 `RegExp`）；engine 审计子进程测试改为纯字符串拼接构建脚本（`Bun.spawnSync` 附近不再出现模板字符串）。仓库根 **`.plugin-scanner.toml`** 现仅将 `UNICODE_OBFUSCATED_INSTRUCTION` 降级为 `medium`——这是仓库侧无法修复的残余：cisco 混淆指令签名正则无词边界（"readability→token"、"ready→environment"），双语文档中的普通中文文本在 awesome-ai-plugins 旧扫描栈（`plugin-scanner` 2.0.1116 + `cisco-ai-skill-scanner` 2.0.14）下必触发。我们的锁定栈（scanner 3.0.104 + cisco 2.0.12）不受影响，且自身 CI 不加载仓库配置（`trust_repository_policy: false`）；发现项保持可见，仅解除旧栈 `high` 门禁。
- 移除跟踪代码注释、测试名称与迁移夹具中的本地 harness 溯源引用（plan/迭代/QC 报告编号）。
- 深度静态安全扫描后的 CLI 路径处理加固：含 `..` 段的相对 `--output` 现在被拒绝（此前可越出项目根）；agent-plugin 安装校验要求插件根为真实目录，manifest/MCP/skill 组件路径改为字面量拼接；lint 目标收集与 tracked 文件列举对 readdir 条目名做守卫后拼接；自有 PR review 工件路径按 worktree 旁单段名构造。
- skill-eval 全面转为自动化 / 测试驱动：移除 argv CLI 分发入口（`scripts/skill-eval/index.ts` 与 `manifest.ts` 的 stage 入口），各阶段改为经导出函数（`prepareManifest`、`executeManifest`、report 构建器）程序化调用；进程 spawn 仍隔离在 `node-launch.ts` 适配模块，`manifest.cli.path` 启动前校验（绝对本地路径、拒绝 URL scheme 与控制字符）并做 realpath 规范化；`canonicalJson` 键序不再依赖数组 `sort()`，并以字节稳定性等价测试钉住。
- SDD 交接统一携带绝对目的地契约：fresh/resume/审查者提示模板写明绝对控制根、feature worktree/cwd、plan、brief/report 与 context 文件路径；原生托管子代理先观察 pwd/分支再写入，并明确声明后续主动 `chdir`、绝对路径写入或宿主原生编辑工具（`apply_patch`）不被拦截。
- 新增绑定 SDD 执行面（spec A3）：`mstar sdd exec --context <context.json> -- <argv>` 以 feature worktree 为子进程起始 cwd（无 shell，退出码 1 门禁 / 2 用法 / 127 未找到 / 128+n 信号）；`mstar sdd check-context` 门禁 `source|artifact|launch` 动作；`task-brief`/`review-package` 支持 `--context` 先校验目的地再写入并输出绝对路径。新增因果重放套件：同一相对路径写入器 raw 启动复现错写 primary、绑定启动仅改 feature（全部使用一次性 fixture）。
- Engine 新增导出：`resolveSddExecutionContext`、`checkSddAction`、`runInSddContext` —— 复用既有 lease/branch/path 机制的有界动作检查；无全局加固，不做沙箱声明。
- 新增 **仅维护用的技能评估基线工具**（`scripts/skill-eval/`）：冻结的 30 条用例语料（5 条路由 x 6，每路由 dev4/heldout2，含首跑/续跑与假通过/错检出陷阱）、零模型调用的不可变 manifest `prepare` 阶段（exit 0/2）、argv 数组子进程 `run` 阶段（真实 CLI 执行、证据留档、可恢复调度，pass/fail/unverified/infrastructure 诚实判级，exit 0/1/2），以及不重跑模型的 `report` 汇总阶段。
- 已记录真实冒烟基线：在 codex-cli 0.144.1 上验证了工具机制（闭包哨兵读取、workspace-write 隔离写入、精确 session-id 续跑）；事件流中无观测模型身份、用量归属未验证——两者均以显式 null 留档，不做任何固定模型疗效声明。
- **证据门控的热路径技能瘦身**：从四个 standard 预设热路径文件（`mstar-harness-core`、`mstar-coding-behavior`、`mstar-dispatch-gates`、`mstar-roles/_shared/leaf-executor-core.md`）移除重复规则与模型原生通用教学内容——8 个有界消融批次，主体文件集合 −8,419 字节（−14.5%）——每条移除行都在冻结的 `scripts/skill-eval/ablations.json` 清单中携带来源、移除依据、恢复记录与存活属主。
- **记录行为证据而不作断言**：每个批次仅在固定配对 dev 运行显示零新增 critical（授权 / 错误检出 / 假通过）失败且无正常成功回归（17/20 对 17/20）后才采纳；最终候选已重新冻结（基线 `c4e338a0`、候选 `4a750601`），用于 baseline/candidate/minimal 三次重复交错对比，heldout 评分留给 QA 独立裁决。token 级负载效应仍未验证（`usageBasis=unknown`）；不作任何效力或成本断言。
- **受保护语义不动**：用户政策 #109/#144/#153/#156/#167、engine-legacy 条件档案、`Skill presets: none` 下的 engine-absent 回退可达性、以及所有负向约束属主全部保留并由 `scripts/skill-eval/closure.test.ts`（24 个测试）锚定；`validation:drift` 保持 exit 0。
- **跨宿主统一的 skill lint 分类策略**：CLI `mstar skill lint`、dsh skill-lint 门禁与 drift Guard 5 改为消费共享 Engine 分类器 `classifySkillLint`（精确 `mstar-harness-core` → 五问豁免，`mstar-skill-authoring` → 严格 authoring，其余 `mstar-*` → runtime 别名表，其它一律严格 authoring）。身份取自已解析的技能目录 basename，而绝非 YAML `name`，已交付的 runtime 技能不再得到互相矛盾的 dsh/CLI 判定；frontmatter 与 ephemeral-citation 检查在所有 profile 下保持生效，dsh 内容盲修复行为不变。
- **真实语料一致性 + 漂移敏感性证据**：在已交付语料上记录修改前后真实 lint 判定（修复前 dsh 以 authoring 模式误判 15/20 个 `mstar-*` 技能；候选实现下 dsh、CLI 与 Guard 5 对 18 个 runtime 技能全部通过、0 违规），并以红探针证明：故意错配的分类或删除真实标题都会使语料守卫变红。
- 确立 **`mstar-roles` 为唯一加载选择权威**：角色 hub 拥有 `Skill presets:` 决策（身份优先；显式 `none` / 省略即 standard / 具名预设 / trivial 路由；未知预设直接拒绝而非猜测），`mstar-harness-core` 仍是生命周期/授权权威并指向 hub，不再要求所有专题无条件先读 core。
- 使 `Skill presets: none` 自洽：角色身份、共享 leaf 安全边界与角色自有 QC/QA 证据义务在不加载可选专题时依然可达；`none` 不授予委托、不豁免门禁。
- 移除各角色 reference 中重复的预设解释文字（各自仅保留成员清单），并收紧 Engine `lintLoadOrder` 契约：roles-hub bootstrap 是唯一被识别的例外——任意专题豁免仍然失败。
- ZCode 插件卡片现在显示 Morning Star **图标与显示名称**：仓库自带的两份 marketplace 清单（`.claude-plugin/marketplace.json`、根 `marketplace.json`）与 CLI `zcode` 引导快照均在 `morning-star-harness` 条目上补齐 `icon` + `displayName`。
- 内置 **ZCode 插件 hooks**（`hooks/hooks.json`）：**SessionStart** 在检测到 harness 工作区时注入一行上下文（{HARNESS_DIR} + `status.json` 摘要 + `mstar-harness-core` 加载指引；非 harness 工作区静默跳过）；**PreToolUse (Bash)** 为 `mstar-branch-worktree` 增加确定性 git 门禁——拦截默认保护分支上的直接 commit（逃生口 `MSTAR_ALLOW_DEFAULT_BRANCH_COMMIT=1`）与裸 `git push --force`（必须用 `--force-with-lease`；`MSTAR_BRANCH_GUARD=off` 可整体关闭）。
- 图标与 hooks 行为已同步写入 `INSTALL.md`（ZCode 章节）与 `mstar-host` → `references/zcode.md`。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.7.0**。

## [3.6.3] - 2026-09-06

### Harness

- 安全测试中的静态合成凭据改为本地生成的一次性值（随机 token、本地签名 JWT、内存 RSA 与 OpenSSH 密钥），无需 OpenSSH 可执行文件，全部检测与脱敏断言保留。CLI 覆盖新增断言：已跟踪 token 会被发现且输出永不回显其值。
- 引擎审计源码中的占位符掩码注释与 mstar-audit 提示注入规则改为直接陈述不变量，不再引用攻击话术；before/after 配对分类检查确认防御行为不变。
- 加固仓库贡献准备：所有 GitHub Actions 固定到不可变 commit SHA，普通 CI 限为只读权限且不保留 checkout 凭据，新增 GitHub Actions 与 Bun 工作区依赖的每周更新，并发布双语安全漏洞报告政策。发布流程的写权限与推送认证保持不变。
- Kimi 插件 interface 元数据对齐 Kimi Code 支持的展示字段，并补充项目网站链接。仅从 Kimi manifest 移除不受支持的 Codex 风格能力、启动提示与视觉元数据；skills、commands 和会话启动行为保持不变。
- 新增 advisory HOL Plugin Security Scan workflow，覆盖 PR、main 分支推送及手动触发；固定 Action 版本，显式启用 Cisco 技能分析，以 80 分及 high 严重度为阈值，未达阈值时仍保留报告，不信任仓库自带的告警豁免。
- dsh 分发包包含 MIT 许可证及统一安全漏洞报告政策的链接。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.6.3**。

## [3.6.2] - 2026-09-05

### Harness

- 为 `prReviewSeatPrompt` 新增 **`collectFolded` 席位提示选项**（仅限 Stage 2；与 Stage 1 同用即抛错）：在 `## Budget` 块后追加一条折叠要点，告知 deep 档领域席位自行收集——先读钉扎 diff 包，再开本领域变更文件，且不超预算块；现可经 CLI 新旗标 `mstar pr-review seat-prompt --collect-folded` 触达（引擎守卫以命令错误呈现）。
- Deep PR 评审**默认两波运行（存在钉扎 diff 包时）**：Stage 1 收集波折叠进 Stage 2 领域席位（`collectFolded`），仅在例外时保留收集波（无 `diffFile` 快照、PM 判断），并在报告 `- notes:` 中声明 `collect wave folded (pack)` / `collect wave kept (no pack / PM judgment: <reason>)`；独立跨领域安全席位永不折叠。
- 收紧 **pack-first 有界席位读取**：席位先读钉扎 diff 包，再在 `fileOpenCap` 内定向开本领域文件，`deep` 扇出措辞在 `mstar-audit` 文档与 `/amazing-pr-review` 命令间保持一致。
- 强化 **`collectFolded` 失败即抛守卫**（镜像 Stage-1 矛盾守卫）：`collectFolded` 现要求非空 `diffFile`（钉扎 diff 快照），与独立跨领域安全席位（永不折叠）组合即抛 `TypeError`；`prReviewSizing.collectSeats` / `mstar pr-review size` 说明补充 kept-wave 限定（仅保留收集波时才有 collect 席位），并调和 `pr-review.md` 中 deep 档措辞与折叠默认的一致性。
- PR 评审综合阶段改为**分层三向 vet**：must-fix / should-fix 走完整三向攻击（反例、更简解释、证据可验证）；nit 仅做证据核验（打开被引文件，确认 `file:line` 支撑论断）。领域席位保持完整三向攻击——分层仅作用于主代理综合阶段。
- Stage 2 领域席位现按**每条发现一块固定字段块**返回载荷——字段名与 `finding-format.md` 逐字一致，`Merge class` 紧跟 `Confidence`（lint 强制），`Fix sketch` 一行——保持与唯一校验器（`mstar lint --type finding --pr-variant` → `validateFindingDoc`）lint 兼容；预算上限截断扩展时在载荷尾部声明截断覆盖。
- 发布的评审正文新增**软上限（约 150 行）**，超出即触发时间预算阶梯的降级 ③：nit 折叠进摘要正文（仅展示层——发现绝不丢弃），并在报告 `- notes:` 中声明。
- PR 评审报告 frontmatter 新增**可选 `elapsed` 字段**：`validatePrReviewReport` 接受非负整数分钟（缺省对历史报告合法；格式非法即违规），`/amazing-pr-review` 命令在 worktree-setup 记录起始时间，并把实测墙钟分钟写入 frontmatter。
- 新增 **PR 评审时间预算体系**：engine 常量表 `PR_REVIEW_TIER_BUDGETS`（每档墙钟目标 + 席位上限）作为数字 SSOT，并在 `prReviewSeatPrompt` 席位提示中渲染预算块。
- 新增 **`mstar pr-review budget`** CLI 命令，打印 `quick`/`default`/`deep` 三档预算表，供人工查看与漂移检查。
- `mstar-audit` PR 评审文档与 `/amazing-pr-review` 命令新增 **Budget 列与时间预算降级阶梯**（①读深度 ②席位拓扑 ③展示，附永不降级清单）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.6.2**。

## [3.6.1] - 2026-09-03

### Harness

- 移除 INSTALL.md marketplace 版本锚点及其发布工具链:`release:prepare` 不再 bump INSTALL.md 中带引号的 `"version"` 字段,`release:validate` 也不再要求它——ZCode marketplace 示例与各 marketplace catalog 均无版本字段,安装时版本取自 `.zcode-plugin/plugin.json`。作为 #183/#184 的后续:该锚点唯一的用途就是被发布工具 bump,因此连同工具一起移除,而非恢复。
- 将 14 个仓库根 agent 壳文件(`agents/*.md`)的 frontmatter 统一改为**单行带引号的英文 `description`**。ZCode 的平铺 agent frontmatter 解析器不支持 `|-` 块标量——会把字面量 `|-` 解析成 description,并静默丢弃嵌套的 `tools`/`permission` 映射,导致插件 agent 条目的触发描述损坏。措辞不变(逐字复用现有英文行);`mode`/`tools`/`permission` 为 OpenCode 语义,保持原样。
- 修正 `mstar-host` 的 ZCode 宿主契约:当前 ZCode **会**把 Morning Star 角色 agents(`agents/*.md`)注册为可调用的 `subagent_type`——派发改为优先**裸角色 id**(如 `fullstack-dev`),保留 `general-purpose` 作为通用回退,且因角色壳很薄仍强制 C5b prompt + skill-load 绑定;`zcode.md` 自带 C5/C5b SSOT(共享角色绑定文档收归 Kimi 专用,ZCode 不再加载)。同时记录 ZCode frontmatter 约束(单行带引号英文 `description`;`|-` 块与嵌套 `tools`/`permission` 会被静默破坏/丢弃),以及仓库内置 `.claude-plugin/marketplace.json` 后 marketplace 可直接添加。
- 仓库内置 ZCode marketplace manifest(`.claude-plugin/marketplace.json`,根 `marketplace.json` 作回退),ZCode 刷新 `github` 源 marketplace 时可直接在仓库内发现目录——此前刷新会报 `Marketplace manifest not found in GitHub repo`。插件条目使用 `github` source 且不钉版本,安装时版本取自 `.zcode-plugin/plugin.json`。
- 对齐 `zcode` 适配器:`init` 写入的本地 marketplace 快照不再钉插件版本,`doctor` 接受无版本条目(ZCode 刷新成功后会用仓库 manifest 覆盖该快照)。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.6.1**。

## [3.6.0] - 2026-09-03

### Harness

- **新增 `@mstar-harness/omp` npm 包**：`omp plugin install @mstar-harness/omp` 现在无需任何本地构建即可工作——omp hook 与六个 `mstar_*` 工具在构建时将引擎**内联打包**（零运行时 `@mstar-harness/engine` 解析），修复第三方安装时的 `Cannot find package '@mstar-harness/engine'`。文档（`INSTALL.md`、`README.md`/`README_CN.md`、`mstar-host` omp 参考）与 CLI omp 适配器均改为优先 npm 安装路径；维护者 `omp plugin link` 路径为 `<repo>/packages/omp`（需先在检出中执行 `bun install && bun run engine:build && bun run --cwd packages/omp build`）。
- **破坏性变更（有意为之）**：仓库根 `hooks/` 与 `tools/` 移入 `packages/omp/src/`——omp hook/tools 现为 omp 专属包表面。依赖仓库根 `hooks/pre/mstar-gates.ts` / `tools/mstar_*` 路径者须改用包内路径（源码 `packages/omp/src/…`，安装后的 npm 树 `<pkg>/hooks/` + `<pkg>/tools/`）。维护者 `omp plugin link` 路径现为 `<repo>/packages/omp`（需先构建）——链接仓库根不再提供运行时门禁。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.6.0**。

## [3.6.0-alpha.4] - 2026-09-03

### Harness

- **PR review diff 快照**：`mstar pr-review worktree-setup` 现在把 review diff 基准固定为 sidecar 旁的快照文件（`<parent-of-worktree>/.<wt-dirname>.prreview.diff`，setup 输出以 `diffFile` 打印；`--diff` / `--working-tree` 模式为 `null`），使每个 Stage 1/2 seat 读取同一份固定 diff 而非重跑 git —— `mstar pr-review seat-prompt` 以 `--diff-file` 透传，prompt 增加「先读 pinned diff 快照」ingredient；cleanup 随 sidecar 一并删除快照，快照捕获纳入 worktree rollback，失败的 setup 不会遗留孤儿 worktree。
- **Worktree 约定与所有权**：review worktree 默认落在 `<repoRoot>/.worktrees/review-…`（`mstar-branch-worktree` 约定；目标仓库未忽略 `.worktrees/` 时自动写入 `.git/info/exclude`），不再用 repo 根的兄弟目录；`worktree-cleanup` 只删除身份（dev/ino/mtime、链接数）与 setup 记录一致的快照——路径上的替换文件或外来文件一律原地保留，已存在的 sidecar 会让 setup 拒绝并提示 `worktree-cleanup`，而不是删除它。
- 将 `amazing-pr-review` command 精简为瘦启动器：全部流程契约收敛到 `mstar-audit/references/pr-review.md`（tier 阶梯、三阶段流水线、worktree isolation、posting、report archive、batch），消除 command 正文中的重复规则文本。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.6.0-alpha.4**。

## [3.6.0-alpha.3] - 2026-08-31

### CLI

- Codex 安装改为仓库自带 marketplace：仓库新增 `.agents/plugins/marketplace.json`（marketplace 名 `mstar-repo`，插件根 = 仓库根），`npx @mstar-harness/cli init --target codex` 通过 `codex plugin marketplace add btspoony/mstar-harness --ref main` 注册 git marketplace（本地条目路径由 `~/.agents/plugins/marketplace.json` 迁移到仓库 marketplace）。安装命令为 `codex plugin add morning-star-harness@mstar-repo`；`codex plugin marketplace upgrade` 可刷新快照。`doctor --target codex` 通过 codex CLI 校验 marketplace 注册，旧 `personal` 条目以迁移提示展示；Codex 自定义 agent `.toml` 软链接仍来自共享 `~/.mstar/harness` checkout。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.6.0-alpha.3**。

## [3.6.0-alpha.2] - 2026-08-31

### Harness

- 修复 **iteration-close（Phase 3）递交锚点**：§3.5 close commit 现为**分支锚定 + fail-closed**——任何 `git add` 之前必须校验 `git branch --show-current` 等于 `spec_integration_branch`（来自 snapshot `branch.integration` / compass）；mismatch 即 STOP，tracked 产物（`knowledge/`、`specs/`、`CONCEPTS.md`）改在集成分支检出上重写，不再把 compound 产物递交到控制分支（如 `main`）。引擎 `iteration gate` 分支探针（`--branch` / `--integration` / `--target`）接入 §3.5 提交前校验。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.6.0-alpha.2**。

## [3.6.0-alpha.1] - 2026-08-31

### Harness

- `mstar-harness-core` 新增「核心研发守则」：七条全局工程不变量 —— 不留向后兼容层（删除废弃路径）、最简实现、拒绝投机抽象/配置/间接层、分层生长（永远在可工作产品之上叠加，不用未完成的复杂度换可工作的产品）、组件模块化且关注点分离、优先成熟维护良好的库、先复用项目内依赖再考虑新包、架构决策面向长期（不接受注定被替换的权宜之计）。注入强制入口 skill，所有角色统一加载；实现级操作细节仍在 `mstar-coding-behavior`，其 Simplicity First 节已回链守则，防止两层漂移。
- 守则出处已记入 `ATTRIBUTION.md`（来源：Marcos Hernanz 的 X 帖子）。
- 预发布版本（`X.Y.Z-suffix`，如 `3.6.0-alpha.1`）现可完整走通 `release:prepare` / `release:validate` / 发布流程：npm 以 `alpha` dist-tag 发布（绝不触碰 `latest`），GitHub Release 标记为预发布，INSTALL.md 市场示例保持在上一个稳定版本。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.6.0-alpha.1**。

## [3.5.1] - 2026-08-28

### Harness

- 修复 git/托管安装（`omp plugin install github:btspoony/mstar-harness`、`bun add github:…`）在依赖解析阶段失败的问题：根清单的 `@mstar-harness/engine` 依赖使用了仅在打包期可用的 `workspace:*` 协议，脱离 monorepo 无法解析。现改为 `^3.5.0`，托管安装从 npm 拉取；本地开发检出仍链接 workspace 成员。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.5.1**。

## [3.5.0] - 2026-08-28

### Harness

- 新增可插拔 **ArtifactStore** 用于 JSON 协调文档持久化：`status.json`、workflow snapshots 与 project residuals 现经 `ArtifactStore.put` / `get` 落盘（默认 `FsStore` 保持既有 `{HARNESS_DIR}` 路径与原子写语义）。集成方可经 `setArtifactStore` 在进程内挂载自有存储，或经 `MSTAR_STORE_MODULE` / `--store` 按命令挂载——仅限文件系统路径，URI scheme 在 `import()` 前一律拒绝。
- 新增 `mstar-harness persist <kind> --key <key> [--file <path>|--stdin] [--store <module>] [--schema <id>]` 与 `mstar-harness persist get <kind> --key <key> [--store <module>]`，支持 `status` / `snapshot` / `residuals` / `review` / `json`，put 前先运行既有 kind 校验器。
- `mstar-harness init` 成功运行后会自动全局安装**匹配版本**的 `@mstar-harness/cli`，使 `mstar-harness` 二进制进入 PATH 供引擎校验命令使用。PATH 上版本已匹配时跳过安装；npm 出错时 fail-soft（init 仍以 0 退出）；可用 `--no-global-cli` 跳过；`--dry-run` 只打印将执行的 `npm i -g` 命令而不执行。
- `mstar-harness doctor` 现在会对每个 target 打印一条非致命 CLI-on-PATH 提示（缺失 / 版本不匹配 / 匹配）。
- mstar-dispatch-gates：角色绑定字段自检的宿主列改由 `mstar-host` §Detect active host 的 tool-shape 检测裁决，明确禁止以 config 路径/仓库内容判定宿主（防止把其他宿主的派发键名——如 OpenCode 的 `subagent`——误用到 task 工具 schema 为 `agent` 的 omp 会话）。
- 新增一等公民 **review JSON kind**（`mstar.review/v1`）：`synthesizeReview` 将已核验 findings 折叠为可校验的 envelope（verdict/tally 来自 `computePrTally`），`mstar-harness persist review` 在写入前校验 envelope（拒绝 inspector M1 词汇），`pr-deep-review` / `amazing-pr-review` Stage 3 必须持久化该 envelope —— Markdown 报告仅为可选的人工副本。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.5.0**。

## [3.4.1] - 2026-08-27

### Harness

- **反递归预检改为 caller 语义（修复 #156）**：`composeDispatchGate` 不再把宿主角色绑定字段当作派发方身份送入 `antiRecursionPrecheck`——在 omp/OpenCode/Cursor 上该字段（`agent` / `subagent` / `subagent_type`）携带的是派发**目标**，而目标 == `Execute as` 正是文档规定的 C5 合规派发模式，导致 `Enforcement: hard` 下每个正确派发都被 `dispatch.anti-recursion.self-type` 硬阻断、省略字段又被 `empty-binding` 硬阻断（不存在合规绑定）。组合现接受 `caller`（派发方自身角色）+ `callerRequired`：仅在有 caller 绑定时运行预检，仅在宿主契约强制该绑定（dsh）时对空绑定 fail-closed。`agent` 选项已移除——调用方迁移到 `caller`。
- **omp 插件**：Gate 2（任务派发）不再运行反递归分支（omp `tool_call` 事件无 caller 身份；NEVER 红线经 `mstar-dispatch-gates` 保持 prompt 级），文档规定的 `agent: "<Execute as role-id>"` 模式在 hard 下不再被阻断。派发 gate 现同时遵从仓库级 `.mstarc` / compass `enforcement: hard`（此前仅读 header flag——hard compass 不会加固 Gate 2，与 Gate 1 及 dsh `resolveDispatchHard` 分叉）；soft 模式派发违规改为经 extension logger warn 输出而非静默丢弃（与 opencode 对齐；静默丢弃正是 #156 钳制潜伏五个迭代的原因）。
- **OpenCode 侧**：`validateDispatchAssignment` 移除 `subagentType` 管线（派发目标不是反递归信号），并在 Assignment header flag 之下叠加仓库级 `.mstarc`/compass hard 设置，与 status 写入 gate 及 dsh 对齐。合规派发不再产生 `self-type` / `empty-binding` 告警；hard 仓库现在会把无 flag 的派发违规升级为 error 级 + `hardBlocked`。
- **dsh 侧**：`dispatchGateCore` 传入 `caller: config.dispatchBinding ?? ''` + `callerRequired: true`——行为不变（自我递归 critical；未设置绑定在 hard 下 fail-closed）。`mstar_dispatch_validate` 的 `agent` 参数更名为 `caller`（派发方自身角色；未知时省略）。
- **文档**：`mstar-dispatch-gates` 记录 caller-vs-target 的 engine 执行范围；`mstar-host/references/omp.md` 新增 Gate 2 反递归范围说明；修正 dsh `dispatchBinding` 过时的「跳过预检」描述为 fail-closed 契约。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.4.1**。

## [3.4.0] - 2026-08-27

### Harness

- 将 `/pr-deep-review` 改名为 `/amazing-pr-review`（干净切换，无 alias），并落地三档强度：`quick`（单趟 1 席，收集 + 审查同席）/ `default`（无 flag 默认档——2 个领域席，收集合入领域席，席位精简）/ `deep`（原完整三阶段流水线：collect → domain review → main-agent synthesis，4–7 席）。档位由显式关键字或变更形状推断；默认档不再全量扇出完整席位计划。
- 审查安全评审中的确定性静态检查现为机械化的 engine 代码并提供 CLI 入口：`mstar audit secret-scan [path]` 以只读方式遍历 git 追踪文件，经 `scanSecrets` 打印 `{file, line, type}` findings（绝不打印值），命中即 exit 1；pattern 覆盖 provider key 形状（AKIA/ASIA、sk-ant-、ghp_/github_pat_、sk_live_、sk-、xox[baprs]-、JWT、私钥块）、never-commit 文件名（`.env*`、`*.pem`、`*.key`、`id_rsa`、credentials/service-account JSON、git-credentials）、CI/IaC 泄漏形状（Actions 明文 `env:` 块条目与同行赋值、Docker `ENV`/`ARG`、Terraform `password =`），并排除安全占位符（`${ENV_VAR}`、`process.env.X`）。`mstar audit supply-chain [path]` 执行 `supplyChainChecks`：跨已知 lockfile 集合的 lockfile-missing / lockfile-duplicate、`action-unpinned`（`@main`/`@latest`，容忍行尾注释，SHA 锁定视为干净）与 `pull_request_target-head` 的 PR head checkout；可达性 triage 仍留给 reviewer。
- 凭证 pattern 现有单一事实来源：`packages/engine/src/audit.ts` 的 `WHOLE_MATCH_PATTERNS` / `VALUE_PATTERNS` 同时支撑 `redactSecrets` 与 `scanSecrets`，完成 engine 与 prose 双表漂移的对账——engine 表补入细粒度 GitHub PAT（`github_pat_`）与 Stripe live key（`sk_live_`）。`scaffoldAuditPlan` 对 finding 的 evidence/description 统一 wire `redactSecrets`，使脚手架产物兑现 redaction 承诺；`security-review.md` §6 将重复的 pattern 列表缩为指向 `mstar audit secret-scan` 的 engine-check pointer，仅保留纪律性散文。
- 将 deferred-PR backlog 注册程序化：`mstar status backlog-register` / `mstar status backlog-close` 取代 `skills/mstar-audit/references/pr-review.md` 中手写的 python 锁协议。engine `appendProjectRegisterEntries` / `closeProjectRegisterEntry` 在 `withStatusWriteLock` 内执行原子 temp+rename 写入（崩溃安全、fail-loud 校验）；同日 key bump（`-2`、`-3`…）与 entry-id 唯一性在锁内强制（B-9）。
- **角色参考：** 为开发角色（`fullstack-dev`、`fullstack-dev-2`、`frontend-dev`）的 Role Mission 增加一句共享编码哲学：“YAGNI 是你的编程哲学，PDCA 是你的行为规范。”
- **角色参考：** 将执行角色 Role Mission 统一为第二人称 “You are …” 写法（`qa-engineer`、`prompt-engineer`、`ops-engineer`、`fullstack-dev-shared`）；`project-manager` 作为主控保留 Identity 段例外。
- 在 README 徽章行（Last commit 之前）新增 `@mstar-harness/cli`、`@mstar-harness/dsh`、`@mstar-harness/opencode` 三个 **npm 总下载量** 徽章。
- 重构 `amazing-pr-review` 批量语义为**一个 session = 一个 PR**：传入多个 PR 时只对**第一个**执行完整三阶段深审；其余 PR 登记为 `{PROJECT_DIR}/_default/residuals.json` 中的 audit todos（`decision: defer`、`target: next session`、`tracking: pr-deep-review backlog`），并在报告中建议为每个剩余 PR 开独立 session。移除旧的四坐席 N/4 批量扇出模型。
- 将单 PR 深审重构为**三阶段流水线**（收集 → 领域审查 → 主代理合成）：轻量只读收集席按领域扇出，mstar 内置角色按领域做 code+security 审查，主代理去重、三路核验并发布唯一一条 GitHub Review。发布权移交主代理，领域席/收集席不发布。扇出规模驱动，复用既有 ~300 行规模带。
- 将**三阶段流水线**与 **one session = one PR** 语义同步到 skill core、角色契约与用户可见文档：`mstar-audit` SKILL.md（`pr` 变体分派、Hard Rule 2）、`mstar-roles` 共享 Audit Mode 与 `code-reviewer.md` Mode C（每个席位——collect 或 domain——都在 result payload 中返回证据/findings：任何席位可能写阻断，证据文件由主代理代写/汇总；席不产出 verdict、永不发布），以及 README.md / README_CN.md / docs/cli.md。发布权在全部表面统一归**主代理**——评审席永不发布。
- PR 审查的确定性算术与命名契约从 LLM 手算迁入经测试的 engine 代码，并以新的 `mstar pr-review` 命令组暴露：`tally`（由已采纳 findings JSON 计算锁定公式的 tally/verdict/score 并输出逐字两行 chat header）、`report-path`（本地报告/证据文件名解析器，含同日 `-r2`/`-r3` 碰撞递增、绝不捏造 SHA）、`validate-report`（已存报告 frontmatter 校验：verdict 由 tally 推导、score 公式重算、comments 三态）。`mstar-audit/references/pr-review.md` 的 § Tally / § 本地报告命名 / § Output shape 现带有指向这些命令的 engine-check callout。
- PR 审查的外部副作用改为经测试的 engine 代码，并通过新的 `mstar pr-review` 命令组暴露：`post`（由 `planReviewPost` 构建 GitHub Review 计划——owner/repo 只从 PR url 解析、绝不取自 `headRepository`；`event` 锁定为字面量 `COMMENT`；`commit_id = headRefOid`；422 回退至多一次，将被拒的 inline 评论恰好折叠进正文）、`worktree-setup` / `worktree-cleanup`（`pickReviewBranchName` 无碰撞命名循环、显式 refspec fetch、untracked-only 也算非空 changeset 的 `preflightChangeset` 门禁、sidecar 守护的清理——移除树、prune 并只删除被记录的审查分支，受 report-saved 门禁约束）、`size`（`prReviewSizing` ~100/~300/~1000 分档 + 阶段一席位计划、拆分建议、文件体积关注）与 `seat-prompt`（`prReviewSeatPrompt` 骨架：Hard Rules 4/5 原文、payload 返回契约、no-verdict/no-post 条款、`<domain>-<seat>` slug）。Finding 文档新增程序化钩子：`mstar lint --type finding` 由 `validateFindingDoc` 支撑（`### [CATEGORY-NN]` 编号、category/effort/risk/confidence 枚举、证据 `path:line` 形状；`--pr-variant` 下校验 Merge class 的存在/枚举/位置）。
- The SP-A review-tier inference ladder is deterministic engine code: `resolvePrReviewTier` walks explicit keyword → too-large advise-split → sensitive surface → large → small (tiny-mechanical → quick, otherwise default) and throws a conflict error on any two distinct tier keywords; `prReviewSeatPrompt` takes a `tier` so quick/default drop deep-only ingredients (the independent cross-domain security seat, collect-wave fan-out wording; quick additionally shrinks its read-first set), and `mstar pr-review size` prints band + inferred tier + seat plan. `mstar-audit/references/pr-review.md` sections carry engine-check callouts pointing at these commands instead of duplicated never-prose.
- SP-A 审查档位推断梯成为确定性 engine 代码：`resolvePrReviewTier` 按显式关键字 → 过大建议拆分 → 敏感面 → 大改动 → 小改动（tiny-mechanical → quick，否则 default）的顺序判定，出现任意两个不同档位关键字即抛出冲突错误；`prReviewSeatPrompt` 接受 `tier` 参数，quick/default 省略 deep 专属成分（独立跨域安全席、收集波次扇出表述；quick 另会收缩 read-first 清单），`mstar pr-review size` 输出分档 + 推断档位 + 席位计划。`mstar-audit/references/pr-review.md` 各节现带有指向这些命令的 engine-check callout，取代重复的 never 式散文。
- 移除根 `package.json` 的 `postinstall` 钩子（`opencode:bundle-assets` && `dsh:bundle-assets`）——静态安全扫描将其标记为安装期代码执行面（[high] R10）。资产镜像仅在显式运行 `bun run <pkg>:bundle-assets` 或各包 build/prepublish 链时同步。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.4.0**。

## [3.3.0] - 2026-08-25

### Harness

- `mstar-audit` 评审流程加固：`pr-review.md` 新增**输入模式**（未提交工作区 / 单提交评审）、**规模分档**与按变更形态的**升级评审**（schema/API/框架/性能/安全面）、**来源规格发现**（逐条对照验收标准打分）、**标准优先级**与十二项坏味道**基线**（含绑定规则），以及**结构性预设**合并类别与冷静克制的语气契约；`audit-playbook.md` 新增 **Chesterton's Fence** / 过度简化防护与**依赖新增/升级纪律**；`codebase-audit.md` 要求简化/删除类计划必须携带**行为保持验证门禁**；`finding-format.md` 新增**注明重构手法**的 Fix 草图（结构性修复）。
- 新增 **`mstar harness scaffold [path]`**（默认 cwd）一次性 harness 初始化：engine `scaffoldHarness` 现同时预建 `projects/_default/`（`roadmap.md` 含通过 `validateRoadmap` 的 frontmatter 与 `## Direction` 占位，以及通过 `validateProjectRegister` 的空 `residuals.json`）；CLI 在缺失时追加 canonical `.gitignore` snippet、写入最小 `.mstar/AGENTS.md`，并打印 created/skipped 摘要。幂等 —— 在已初始化树上重跑只补缺失件。
- `mstar harness scaffold` 现遵循 `.mstarc`：按 `.mstarc` 声明的 `harness_dir`（或 `MSTAR_HARNESS_DIR` 覆盖）落盘，`projects/_default/` 落在解析后的 `project_dir` 下，并打印解析后的 harness/project 目录。canonical `.gitignore` snippet 仅对默认 `.mstar/` 布局追加 —— 自定义 harness 布局跳过（自行管理 ignore 规则）。`.gitignore` fence 在宽规则缺失但存在 `!.mstar/…` re-include 时，将宽规则拼接到 re-include 之前（gitignore 后者胜出），保证 re-include 仍生效。
- `mstar path resolve` 失败指引由 `mstar init` 改为 `mstar harness scaffold`。
- `mstar-audit`：Security 类别新增 `references/security-review.md` 深查参考——可利用性门槛（具体攻击场景）、attacker/server-controlled 输入源分诊、框架误报豁免表、跨文件数据流扫描、hunting angles，以及扩展面（认证/会话、业务逻辑、客户端、AI/LLM、供应链/CI-CD、基础设施配置、隐私保留）。playbook §2 接线指向该文件；审计索引模板新增 **Needs verification** 与 **Hardening & checked notes** 两节，使每类安全处置都有明确落位；第三方出处集中至根目录 `ATTRIBUTION.md`（技能文件不再携带外链）。
- `mstar-roles` 角色提示词改为**身份优先**：leaf 角色文件以 mission / 职责 / NEVER 规则开头；原顶部 "Required Skill Dependencies" 下沉为文末 **Skill Preset (PM-Activated)** 预设区。专题 skill 由 PM 通过新增的 Assignment `Skill presets:` 字段控制——实质轮次（implementation / QC / QA）缺省即默认该角色的 `standard` 预设；显式 `none`（或 trivial 路由）则以身份执行、不自行加载。QC/QA 角色自有 procedure 文件（`references/qc-specialist/*`、`acceptance-gate.md`）永不门控。`project-manager` 作为核心编排者保持 required reading 不变。
- **dsh 插件**：fallbacks 种子强制加载引导线同步预设模型（`tests/fallbacks-seeds.spec.ts` 与双语 README 镜像更新；配对哈希已重录）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.3.0**。

## [3.2.6] - 2026-08-24

### Harness

- **PR 深审报告模板加固**：`Considered & rejected` 占位符不再把 bullet 短横线包进尖括号（此前一条已发布 review 逐字渲染了 `<finding>` 包裹）；拒绝条目改为 `- **<短标题>**: rejected — <理由>`，并在模板顶部显式声明“尖括号仅是填空槽、永不渲染”；无修复计划时 Plan to fix 整块折叠为单独一行 `none` 而非散文。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.2.6**。

## [3.2.5] - 2026-08-24

### Harness

- **PR 深审默认列出全部发现**：`/pr-deep-review` 移除 `[full]` 参数 —— 完整发现列表（含全部 merge class 与 nits）现在始终出现在 chat 输出与 GitHub Review 中，不再截断。README 命令签名同步更新。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.2.5**。

## [3.2.4] - 2026-08-24

### Harness

- **PR 深审本地报告留档**：`pr` 变体每次审查现会在 `{PROJECT_DIR}/<project-id>/reports/pr-review/`（无项目流程用 `_default`）落盘一份持久 markdown 报告 —— YAML frontmatter 元数据（PR、head SHA、verdict、score、tally、review URL）+ 逐字保存的 GitHub Review 正文；bare branch/diff 审查则存 chat 展示内容。经主 checkout 写入（绝不写入 review worktree 内），于 worktree 清理前保存且不因 POST 失败而跳过；Completion Report 输出形状新增 `- report:` 字段。
- **文档只描述现状**：从运行时 skills 中移除真正已废弃路径的描述 —— `{PLAN_DIR}/reports/`（旧报告目录；无代码引用、无迁移指令）与已停产的 `{HARNESS_DIR}/notes.json`（无代码创建或读取；运行时 notes 走 `workflows/<id>/notes.jsonl`）。经出厂代码核实的兼容行为全部保留：`designs/` 只读 `{SPECS_DIR}` 回退（`resolveSpecsDir`）、legacy 扁平 delivery-compass 的读兼容/迁移指令、`.agents/` 发现链，以及全部 v1→v2 迁移护栏。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.2.4**。

## [3.2.3] - 2026-08-24

### Harness

- **PR 深审报告模板**：GitHub Review 评论改为固定三段式报告 —— 结论区（verdict + 置信度分数 + 四类发现的 emoji 统计表）、陈述区（PR 内容概述、按 merge class 排序的 findings 详述、linked-issue AC、Verified、Considered & rejected）、建议区（可折叠的 **Plan to fix**，以 ```md 围栏块承载修复计划）。Chat 输出契约不变。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.2.3**。

## [3.2.2] - 2026-08-24

### Harness

- 删除根 Changelog 开头的 **Published harness surfaces** 版本表。各发布面版本已对齐，表头与发布脚本中改写该表的步骤一并移除。每版 `### Version alignment` 块保留。
- **`mstar-harness-core` 护栏改为宿主中立**：`未经用户同意不改 opencode.json、凭据、secrets.env` → `未经用户同意不改宿主配置文件与用户凭据`——共享 skill 不再点名单一宿主的配置文件。
- `/pr-deep-review` 现在基于 finding 计数（tally）输出合并信号：中间结论词 `needs review` 更名为 `needs fixes`，每个已接受的 PR finding 携带 `Merge class`（`must-fix` | `should-fix` | `nit`），输出形状新增 `- score_pct:`（`max(0, 100 - 40*must_fix - 15*should_fix - 3*nit - 10*unverified)`，下限 0）与 `- tally:` 四项计数。结论由 tally 推导（`must-fix ≥ 1` → `blocked`，否则 `should-fix ≥ 1` → `needs fixes`，否则 `ship it`）；关联工单 leftover `unmet` AC 在映射前计入 `should_fix`（不安全则计入 `must_fix`），不另开 finding。`score_pct` 仅为展示反馈，绝不覆盖结论。聊天输出与 GitHub Review `body` 以 `{verdict} · {score_pct}%` 加 tally 行开头；事件仍为 `COMMENT`。发现列表裁剪规则现仅作用于 nits —— 所有 `must-fix` / `should-fix` 都会列出。公式与 tally 标准 SSOT 于 `skills/mstar-audit/references/pr-review.md` § Verdict synthesis / Tally and derived score。
- **Release prep** 在同名分支上的上一份 PR 已关闭或已合并时会**新建** `release vX.Y.Z`，不再把 `gh pr view` 对 closed PR 成功当成原地更新（此前会改 #131 正文却不新建 3.2.2 PR）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.2.2**。

## [3.2.1] - 2026-08-24

### Harness

- `/pr-deep-review` 现在在有 PR 编号时**强制发布** GitHub Review：在 PR 上留下 `COMMENT` 事件的评论（可定位到 diff 行的发现发为行内评论，已写好的后续 plan 以 `<details>` 折叠索引并入摘要正文），输出形状新增 `comments:` 字段。发布流程 SSOT 在 `skills/mstar-audit/references/pr-review.md` § Comment posting；`mstar-audit` Hard Rule 2 与 Audit Mode 角色契约仅为此 GitHub Review POST 开例外（Git 仍只读、不提交）。`code-reviewer` 新增 Mode C（PR review，加载 `pr` 变体）。`commands/pr-deep-review.md` 删除「可选 / 单独显式步骤」措辞。仅聊天输出的结论对 PR 席位不再视为完成。
- README「使用」节重组为三类入口：**通用（不跑迭代）**、**迭代**、**审计与 Review**——第三类将 `/codebase-audit` 与 `/pr-deep-review` 合并为单表同一标题，导语统一说明只读顾问定位并点名 `mstar-audit` 两个变体（此前两者为并列顶级小节；行内 SSOT 尾巴并入导语）。双语对应修改同步落地（README.md / README_CN.md）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.2.1**。

## [3.2.0] - 2026-08-23

### Harness

- 将共享的 plan-output 契约从 `references/codebase-audit.md` 上提至 `mstar-audit` SKILL.md 核心，新增 **`## Plan output (all variants)`** 章节：仅用户选定后才写入的边界、`{PLAN_DIR}/audit-<date>/` 目录布局（README 索引 + 编号 plan 文件）、`plan.main.md` + plan-quality-bar 增强、Status 块字段与状态值、`git rev-parse --short HEAD` 提交戳、以及四步 handoff（promote / 状态机 / fast-track Prepare / SDD 或 inline 派发）。两个变体（`codebase-audit`、`pr-review`）与两个命令（`/codebase-audit`、`/pr-deep-review`）均改引核心章节；`pr-review.md` § Plan output 不再引用 `codebase-audit.md`。Engine audit Status-block 与 scaffold 校验器的 spec 引用同步指向 `mstar-audit SKILL.md § Plan output`；`pr-review.md` § Evidence rules 新增 `finding-format.md` § What disqualifies a finding 引用。提前关闭 residual R1（第三个变体到来时上提——现由 `pr` 变体满足）。
- 将 `mstar-audit` 重构为**变体载体（variant carrier）**：SKILL.md 只保留公共核心（hard rules、recon、attack-and-vet 纪律、变体分发表、output 契约），完整 codebase-audit 细节逐字迁至 `references/codebase-audit.md`（Phase 2 九类别 fan-out 与 subagent prompt 要求、effort 表、scope variants、Phase 4 plan 撰写、audit index / plan 文件输出模板、`mstar audit scaffold` callout、handoff to execution）。`pr-deep-review` 不再加载仅 full-audit 相关的内容；各指针面（`references/pr-review.md`、两个 commands、`code-reviewer` 角色、`mstar-harness-core` 索引）改引公共核心 + 正确变体 reference。
- 新增通用 PR 深度审查命令（`pr-deep-review`）+ `mstar-audit` `pr` variant：worktree 隔离、证据先行、合并前审查结论（`ship it` / `needs review` / `blocked`）、关联工单 AC 卫生与兄弟 PR 批量支持。
- 技能更名：`mstar-plan-conventions` → **`mstar-conventions`**、`mstar-plan-artifacts` → **`mstar-artifacts`**——两个技能是通用 harness 约定（路径、产物），并非 plan 专属，故去掉 `plan-` 前缀。所有活表面已同步（`skills/**` 加载顺序、索引行与交叉引用、`commands/**`、`AGENTS.md`、`README.md` + `README_CN.md` 技能表、`docs/cli.md`、`.cursor/` routing-eval fixtures 与本地校验、`scripts/` 守卫、engine/dsh/cli 源码注释与路径字面量、dsh 测试预期）。历史 changelog 与 engine 测试 fixture 散文保持原样——其中的旧名称作为历史记录是正确的。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.2.0**。

## [3.1.3] - 2026-08-23

### Harness

- **`mstar audit promote`（CLI）**：用户选定后，审计计划可正式进入 v2 工作流状态机，类型为 `type: plan` —— `promoteAuditPlans` 先写工作流快照（`{HARNESS_DIR}/workflows/<id>/snapshot.json`，每个选定计划一行 `PlanRow`：`id` + `title` + `file`），再在根 `status.json` 注册工作流，保证 snapshot-before-register 不变量。`--plans` 接受 README 索引列 id、stem 或 basename；`--workflow` 默认取 `audit-<date>/` 目录 basename；`--harness` 默认取解析到的 `{HARNESS_DIR}`。promote 仍是用户选择后的显式动作——审计本身永不注册（咨询性契约不变）。
- **Engine**：`@mstar-harness/engine` 导出 `promoteAuditPlans`（标题取自审计索引，缺失时回退到 `readPlanFileSummary`）。
- **Harness skills**：`mstar-audit` Handoff 步骤 1 现将 `mstar audit promote <audit-dir> --plans <ids>` 列为首选路径（手写 `mstar-plan-artifacts` 作为回退保留）。
- **三个 CLI `execFileSync` 包装统一为一个 `runCliCommand` 助手**（`packages/cli/src/exec.ts`）：`runCommand`（shared-install）、`runOmp`（omp）、`runDsh`（dsh）变为薄包装，公开签名与行为不变；timeout / env / dry-run 不再可能在三个包装间各自漂移，`runDsh` 保留 `env: process.env` + `timeout` 契约（测试中依赖 PATH 注入 fake dsh）。
- **Engine git env 固定回归测试（仅测试）**：`packages/engine/test/exec-env.test.ts` 断言 `path.ts` / `sdd.ts` / `worktree.ts` 中任何 git `execFileSync` 调用的 options 不得携带空 env（`env: {}` / `env: { PATH: "" }`）——不修改任何生产 env 行为。
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.1-rc.2` 线（`^0.1.1-rc.2`；`@deepseek-ai/cordis` 保持 `^4.0.1`；`dsh-llm-fallbacks` 保持 `^0.3.0`——其 0.3.3 的 peers 为 `^0.1.1-rc.1`，可由 rc.2 线满足）。对照 deepseek-harness @ `b150a55` 的 `0.1.1-rc.1 → 0.1.1-rc.2` diff 验证：变更内容为统一的 image/Files 请求管线与 permission-preset copy-and-default 回退——插件未消费其中任何面（无 image 区域读取、无 attachment 请求 payload、无 permission-preset default-copy 辅助；仅有的 `preset`/`permission` 引用是 `dsh-llm-fallbacks` 角色 seed 注册表与 dsh-core `/permission` 命令先例），零适配层改动。lock 全新解析为单份 `0.1.1-rc.2` 线——任意位置零 `0.1.1-rc.1`（及更旧）副本，无 `dsh-client-web-react` holdover。
- **Engine 公共面**：`redactSecrets` 不再从 `@mstar-harness/engine` barrel 再导出（对从裸包导入的下游为破坏性变更）；该审计模块工具改由新增的 `@mstar-harness/engine/src/audit` 子路径提供，`RedactResult` / `SecretFinding` 类型仍留在 barrel。barrel 引用方需迁移到子路径。
- **dsh**：审计 seam（`packages/dsh/src/gates/seams.ts`）改为从 `./src/audit` 子路径导入 `redactSecrets`，不再走 barrel。
- **三个迭代命令瘦身为薄包装**：共享的 PM 不变量、会话 todos、连续执行 STOP 清单与派发预检 bash（可选 warn-only + `enforcement: hard` fail-fast）统一收敛到 `skills/mstar-iteration/references/command-shared-invariants.md` 单份，`mstar-iteration` 指向该引用。frontmatter 命令名 / `description` / `agent` / `input` 与各命令独有内容（start 的 grill-me、drive 的 helper/完成定义、loop 的不加载 grill-me）保持不变。
- **`mstar-iteration` 描述触发增强**：即使宿主未触发 `/iteration-*` 斜杠命令，"start an iteration" / "drive the iteration" / "run an autonomous loop" 等自然语言也可加载该 skill；阶段标签不再以命令名充当阶段名。
- **技能指针与 callout 卫生**：`mstar-audit` Handoff 第 1 步改为在 `{WORKFLOW_DIR}/<id>/snapshot.json` 注册 workflow 与 plan 行（根 `status.json` v2 仅作 workflows 注册表）；plan-conventions 的 R# 句改为以 `{PROJECT_DIR}/<id>/residuals.json` 为 open 状态 SSOT。
- **加载条件修复**：`mstar-design-md` 在 `architect` 与 `product-manager` 角色引用中改为 **On demand**（仅 UI / design-token 条件触发）；`mstar-compound-refresh` 不再揽下 STRATEGY.md 的 bootstrap（交由 `mstar-strategy` 承接）。
- **Callout 去重守卫**：`drift-lint.ts` 新增 `checkCalloutDuplication`——归一化空白与双语变体后，同一 Engine-check callout 正文出现在多个文件即判定失败；lease（`mstar-plan-artifacts`）与 review seats（`mstar-review-qc`）callout 各保留一份 canonical，其余位置改为一行为指针。
- **共享反递归 NEVER**：五条概念性反递归红线收敛到 `mstar-roles/references/_shared/leaf-executor-core.md`，各角色文件保留角色专属条目并加一行指针。
- **策略文档精简**：`mstar-strategy` 的 create/maintain 长文替换为指向 `project-knowledge-bootstrap.md` Phase 2 的指针（六段式表格与 engine check 保留）。
- **知识使用门禁**：harness 入口、iteration §1、`iteration-start` Research、phase-gates implement 与 `knowledge-and-designs.md` 默认先发现 `{KNOWLEDGE_DIR}/README.md` 索引——即使 `plans[].metadata` 无 knowledge 链接，implementer 也须扫描索引并阅读相关 Active 行（已注册的 metadata 链接仍为强制）。
- 不新增 `audit promote` CLI（由独立的 promote plan 负责）。
- **audit-004 validator CLI 面闭环**：五个 CLI 命令（`mstar status tech-debt`、`mstar status findings-cleanup <plan-id>`、`mstar lease verify-integration`、`mstar worktree qc-alignment <file>`、`mstar host skill-root`）已用 dist 构建产物（`node packages/cli/dist/mstar-harness.js`）对仓库 fixtures 冒烟验证可运行，退出码符合各自文档语义；无任何命令实现改动。残留项 `20260816-audit-004-validator-cli-surface` 原地置为 `lifecycle: resolved`，证据见冒烟输出。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.1.3**。

## [3.1.2] - 2026-08-21

### Harness

- **空宿主绑定的反递归改为失败关闭**：`dispatch.antiRecursionPrecheck` 在宿主角色绑定字段（omp task 条目 `agent` / opencode `subagent` / cursor `subagent_type` / dsh `dispatchBinding`）为空、缺失或仅空白时，现返回 **critical** 级 `dispatch.anti-recursion.empty-binding` 违规——宿主无法证明派发代理未在递归，派发不得在 NEVER 红线未成立的情况下继续。`composeDispatchGate` 不再对空绑定跳过预检（`if (agent !== "")` 跳过已移除）；预检成为唯一决策点，对所有 Assignment 形态文本（含只读 scout/explore，无豁免）均执行。已设置绑定且等于 `Execute as` 时保留既有 critical `dispatch.anti-recursion.self-type`；已设置绑定但 `Execute as` 为空时反递归支路仍为 ok（字段存在性仍归 `validateAssignmentFields`）。
- **OpenCode 表面**：`validateDispatchAssignment`（经 `composeDispatchGate`）在 task 工具未携带 `subagent` / `subagent_type` 键时以 critical 级别警告 `dispatch.anti-recursion.empty-binding`；在 Assignment 自身 `**Enforcement**: hard` 下空绑定会硬阻断（`hardBlocked: true`）。无 `src` 改动——hook 已把默认 `""` 绑定流入 engine 组合。
- **dsh 表面**：`dispatchGateCore` 将 `config.dispatchBinding ?? ''` 传入 engine 组合，未设置绑定时每次 Assignment 形态派发都会发出 `dispatch.anti-recursion.empty-binding`（critical）——warn 模式为 advisory，hard 模式下为 `PreToolDecision { kind: 'deny' }`。启动警告文案不再声称预检被"跳过"：hard 强制下未设置 `dispatchBinding` 现失败关闭，直至绑定被设置。Zod `dispatchBinding` schema 保持不变。
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.1-rc.1` 线（`^0.1.1-rc.1`；`@deepseek-ai/cordis` 保持 `^4.0.1`；`dsh-llm-fallbacks` 重新对齐 `^0.2.0` → `^0.3.0`，使其 peers 落在 `^0.1.1-rc.1`）。对照 deepseek-harness @ `528c682e06` 的 `0.1.0-rc.8 → 0.1.1-rc.1` diff 验证：所有已消费的服务端包仅变更文档/`package.json`，客户端已消费面为纯增量，`__ModuleLoader__` 握手原样存活——零适配层改动。未消费任何 checklist seam（credentials records、pi-ai auth、index-inject、session-projection）。lock 全新解析为单份 `0.1.1-rc.1` 线——任意位置零 `0.1.0-rc.8` 副本，`dsh-client-web-react` rc.7 holdover 已消除（fallbacks 0.3.3 移除了该 peer）；`@oh-my-pi/*` / `@bufbuild/protobuf` 解析与此前 lock 一致。此线未解锁任何此前被阻塞的 mstar-dsh 目标。
- **Plan 写入路径门禁补上符号链接逃逸缺口**：`assertPlanWritingPath` 现对**已存在**的 plan 文件做 canonical 路径与 canonical `{PLAN_DIR}` 的对比（plans 目录本身可以是符号链接的合法布局）。词法上位于 `{PLAN_DIR}` 之下、但 `realpath` 指向其外的 plan 路径，现返回 **high** 级 `plan-path.symlink-escape` 违规，不再返回 `plan-path.ok`；内部别名（`plans/alias.md` → `plans/real.md`）与整目录 `plans/` 符号链接布局仍通过。文件不存在（首次写入）仅做词法检查；意外 fs 错误（EACCES 等）降级为词法判定——门禁绝不抛异常。`plan-path.outside-plan-dir` 与 `plan-path.no-harness` 语义保持不变。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.1.2**。

## [3.1.1] - 2026-08-20

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.1.1**。

## [3.1.0] - 2026-08-20

### Harness

- **Agent-flow 台账尾部读取**：`readAgentFlow` 现以有界的最新优先尾部方式读取大台账（超过 64 KiB 读取门限）——从 EOF 后向展开、对齐行边界，成倍回溯直至窗口含 `limit` 条完整行——目录层按字节支付 O(window)，不再解析每条历史行。小台账保留原有全量读取路径不变；两条路径共用同一解析漏斗，尾部/全量结果结构上一致。写入路径（追加 + 锁内 500 行截断）保持不变。
- **项目级研究语料**：主题研究（surveys、epic roadmaps、第三方 notes）现存放于 `{PROJECT_DIR}/<id>/references/` — 由 `mstar-project-governance`（Scope 表）、`artifact-storage-paths.md`（路径 SSOT 新行）与 `knowledge-and-designs.md`（边界：研究 ≠ specs ≠ knowledge ≠ 迭代 guides）命名。
- **Engine 文件名列表**：`packages/engine/src/project.ts` 新增 `PROJECT_REFERENCES_DIR` + `listProjectReferenceFiles(projectDir)` — 返回排序相对路径（根级文件 + 一层子目录文件；跳过 `roadmap.md` / `residuals.json` 游离文件；目录缺失 → `[]`）；仅目录元数据，不读文件正文，不做 markdown schema 校验。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.1.0**。

## [3.0.1] - 2026-08-20

### Harness

- **CI 重新运行 dsh 测试与 typecheck**：删除 link-farm 时代的 `dsh:link` 调用与 dsh 源码树可用性 gate（`DSH_SOURCE_DIR` / `~/.dsh/source/current`）——rc.8 的 seam 包改从公共 npm registry 解析，dsh 套件在 CI 无条件执行；install e2e 在 PATH 无 `dsh` bin 时仍自行跳过。测试 fixture 补齐 v3.0.0 新增的 `MstarHarnessState.project` 字段（4 个 spec 共 5 处），修复 main 上 `typecheck:tests` 的既有红态。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.0.1**。

## [3.0.0] - 2026-08-20

### Harness

- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.0-rc.8` 线（`^0.1.0-rc.8`；`@deepseek-ai/cordis` 保持 `^4.0.1`）。对照本地 rc.7→rc.8 源码，已消费 seam 无需改适配层：唯一涉及的消费面变化是 `dsh-commands` 的 `CommandRuntime.execute` 新增必填 `images` 参数（插件注册不受影响，仅测试调用点更新）以及 `CommandInvocation` 新增 `attachments` 字段（纯增量）。lock 全新解析为单份 rc.8 hoist（`dsh-client-web-react` 保持 rc.7——npm 最新发布版）；`dsh-llm-fallbacks` 由 0.2.0 移至 0.2.2，9 键服务面 drift STOP gate 同步更新。
- 本仓 harness 目录统一为 `.mstar/`：维护文档并入 `.mstar/docs/`，旧维护根目录移除，探测/override 文档不再提及旧根名。`harnessDir` / `MSTAR_HARNESS_DIR` 语义不变——显式 override 优先；探测顺序保持 `.mstar/` → `.agents/` → `.plans/`/`plans/`。
- `drift-lint` 的 roadmap 引用豁免现识别 `.mstar/` 前缀（gitignored roadmap/ADR 文档）；engine/dsh/opencode 源码引用已更新到新路径。
- `.mstarc` 现在支持 `[config]` 下的全部 harness 目录符号：`plan_dir`、`sdd_dir`（per-plan 基目录）、`iteration_dir`、`knowledge_dir`、`specs_dir`（权威——跳过候选链），外加 `harness_dir`。engine 各解析器（`resolvePlanDir` / `resolveSddDir` / `resolveIterationDir` / `resolveKnowledgeDir` / `resolveSpecsDir`）从 harness 目录或其父目录的最近 `.mstarc` 读取；`mstar_path_resolve` 同时输出 knowledge 目录。
- `.mstarc` `[config] enforcement=hard|soft` 声明仓库级硬门禁策略（非法值忽略）。优先级：显式 Config > Assignment `Enforcement: hard` 头标记（仅派发）> `.mstarc` > 迭代 compass > 默认 warn-only——`.mstarc` `soft` 可回滚 hard compass，`hard` 硬化无标记的派发与各闸门。新增 engine `resolveMstarcEnforcement` / `resolveRepoEnforcement`；dsh 各闸门、opencode hook 与 omp hook 现均组合仓库策略。
- 新增 gitignored 的仓库本地配置 **`.mstarc`**（`[config] harness_dir=<dir>`）：harness 根非默认名的仓库可在其中程序化声明根目录——`resolveHarnessDir` 优先于探测读取它（显式 `opts.harnessDir` / `MSTAR_HARNESS_DIR` 仍最高优先），`sddWorkspace` 同步遵循，canonical `.gitignore` 片段（engine / CLI init fence / plan-conventions）默认忽略 `.mstarc`。解析顺序 SSOT 已更新至 `mstar-plan-conventions` § {HARNESS_DIR} 解析顺序。
- tracked 的 `*.ts` / `*.md` 文件不再引用 gitignored 的 harness 产物（`.mstar/` 下的 status.json、plans/、sdd/、iterations/、knowledge/、references/、archived/、docs/ 等路径）：engine/host/测试注释与文档改用 `{HARNESS_DIR}` / 消费者默认值或直接去掉本地路径；drift-lint 的 `.mstar/` 引用豁免已移除（该守卫现在直接强制此规则），规则已写入 AGENTS.md。
- **v3 工作流生命周期 schema（engine）**：生命周期状态从根 `status.json` 的 `plans[]` / `residual_findings` 迁入按工作流的快照（`{HARNESS_DIR}/workflows/<id>/snapshot.json`，`validateWorkflowSnapshot`）与项目 register（`{HARNESS_DIR}/projects/<id>/residuals.json`，`validateProjectRegister`）；v2 根文件只保留 `version` / `updated_at` / 活跃 `workflows[]`。新增目录解析器 `resolveWorkflowDir` / `resolveProjectDir`。
- **`mstar migrate`（CLI）**：v1→v2 树的一次性迁移（`migrateHarnessTree` / `applyMigratePlan`）——v1 根归档到 `archived/status.v1.json`，每个生命周期提升为 `workflows/<id>/snapshot.json`，播种项目 register 与 roadmap，以 v2 根替换为提交点；重跑为幂等 no-op；`--dry-run` 打印步骤计划并把 apply 期校验违规作为 warning 呈现；退出码 0/1/2；`--path` 默认取解析到的 `{HARNESS_DIR}`。
- **CLI / tools / hook 硬切到 v2 输入**：`status validate`（v2 根或快照）、`status tech-debt` / `status findings-cleanup`（项目 register）、`lease verify` / `lease verify-integration` / `iteration gate` / `worktree check`（经 `--workflow <id>` 的工作流快照）、`path resolve`（新增 workflow/project 目录）；`status archive-residuals` 移除（报错桩指向 register 关闭流程）；`tools/mstar_*` 与 omp/opencode Gate 1 hook 校验三类 v3 协调文档，P1-only engine 导出改为懒加载，旧版已发布 engine 下降级为警告而非整体丢失 hook/工具。
- **Skills v2 表面**：退役 `done-compaction` / `plans-done` / `notes.empty` 产物并清除全部引用；将 `mstar-*` skills 的 status/residual/lease/convention 表面改写为 v2 地址（`workflows/<id>/snapshot.json`、`projects/<id>/residuals.json`、`mstar status validate` / `findings-cleanup` / `tech-debt`、`mstar lease verify --workflow <id>`、`mstar iteration gate --workflow <id>`）。
- **`mstar-engine-legacy`**（新增）：engine-absent 宿主条件契约档案——status v1→v2 字段历史、lease 协议、各宿主 QC 座次 N=3/N=1 重述、反递归清单、Engine-check 样板；engine 约束激活时不加载。
- **`mstar-project-governance`**（新增）：`projects/<id>/roadmap.md` 编写约定（frontmatter schema + body 约定，warnings-only）与 `residuals.json` register 生命周期（open → verified close in place、severity 枚举、provenance 字段、`_default` 回退）；schema 与 engine `project.ts` 校验器逐字一致。
- **文档同步**：README.md / README_CN.md 布局描述与工作流图更新为 v2 状态面（workflow snapshot / project register；`.mstarc` 新增 `workflow_dir` / `project_dir` 键）；routing-eval 场景集重指向 v2 产物地址。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 3.0.0**。

## [2.4.1] - 2026-08-17

### Harness

- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.0-rc.7` 线（`^0.1.0-rc.7`；`@deepseek-ai/cordis` 保持 `^4.0.1`）。对照本地 rc.6→rc.7 源码，已消费 seam 无需改适配层（`createUserMessage` / `ToolExecution` / `PreToolDecision` / `PreStepDecision` / `FsWriteIntent` / dump-config `disabled: true` 未变；`apps/cli/src` 仅为版本号）。lock 清除所有低于 `0.1.0-rc.7` 的条目——62 个唯一 `@deepseek-ai/dsh-*` 包、每包单份 hoisted、0 个嵌套副本。根 `dependencies` 保持仅 engine。
- **README 可读性**：安装表 Command 用 `<br>` 分行；`npm i -g @mstar-harness/cli` 单独成块；迭代 / 代码库审计表列名为 **命令**（完整签名），**何时** 分行说明。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.4.1**。

## [2.4.0] - 2026-08-17

### Changed

- **dsh 安装目标**：`npx @mstar-harness/cli init --target dsh` 现可一条命令装齐 dsh 全量能力——它运行**两条独立** `dsh plugin --profile web add` 调用（先 `@mstar-harness/dsh`，再 `dsh-llm-fallbacks`；绝不折叠进 patch 文件）。`doctor --target dsh` 逐行报告 `uninstalled` / `disabled` / `mounted`，存在未安装或禁用行时以非 0 退出。`--no-fallbacks`（仅 dsh target 生效）跳过 `dsh-llm-fallbacks` 行；`--dry-run` 纯预览，不探测不执行；重复执行幂等（已装行跳过）。README 双语对、`INSTALL.md`、`docs/cli.md` 已同步。
- **CLI `mstar` bin 别名**：`@mstar-harness/cli` 现随规范名 `mstar-harness` 一起安装第二个可执行文件 `mstar`——两者映射到同一个 `dist/mstar-harness.js` 入口，两个名字可互换（由新增 manifest 测试固定）。`commands/` 中的引用改用 `mstar-harness`（版本稳健：长名存在于每个已发布版本；短别名随本版本发布），`docs/cli.md` 与 README 双语对补充了别名说明。**注意**：`mstar` 属于共享 bin 命名空间——名为 `mstar` 的无关第三方 npm 包声明了同一命令名，未安装 `@mstar-harness/cli` 时裸 `npx mstar …` 只会解析到该第三方工具；脚本中请保持规范名 `mstar-harness`，冲突时用长名。已全局安装旧版的用户，下次升级即可获得 `mstar` shim：`npm i -g @mstar-harness/cli@latest`（或 bun 等价命令）会重链全部已声明 bin。
- **drift-lint 二进制前缀守卫**：`validation:drift` 现在会把 Engine-check callout 中每个反引号 CLI 引用的二进制前缀，与 `packages/cli/package.json` 声明的 `bin` 名称（manifest 为 SSOT）逐一比对，引用不存在的可执行名（如拼写错误 `mstarr`）会导致 drift-lint 失败，而不再是在子命令路径全部校验通过时被静默放过。

### Harness

- **dsh 全量支持（文档）**：`packages/dsh` README 三联的 Install 节现写明一条命令的 CLI 入口（`init --target dsh`——编排两条 `dsh plugin --profile web add` 安装）以及两条行装齐后零配置获得什么：13 个 `mode: subagent` mstar 角色种子、persona 取镜像默认（settings 可 revert、运行时 advisory 报告覆盖），并附 fresh publish 的 `minimumReleaseAge` 窗口提示（重跑 init 或显式 pin 版本）。installed-deployment e2e 闭环：真实 CLI 安装进临时 `DSH_HOME`、从安装产物 boot，断言 13 角色全部 seeded 且 persona 非空。根 README 双语对补充 dsh 全量支持一句。
- **五问 lint 运行时模式**：`lintFiveQuestion(body, mode?)` 新增 `mode: "runtime"`（默认 `"authoring"`，非破坏）与锁定别名表 `RUNTIME_HEADING_ALIASES` —— 标题同义词（如 Workflow→`process`/`playbook`、Decision Rules→`hard rules`/`门禁`、Evidence→`output format`/`证据`、References→`dependencies`/`关系`）对已发布专题 skill 计为对应 canonical 章节。`mstar skill lint` 对 `mstar-*` 目录选 runtime 模式（`mstar-skill-authoring` 恒为 authoring/strict）；`mstar-harness-core` 打印显式 **exempt** 行。Greenfield（authoring）lint 仍要求 canonical 标题。
- **运行时语料对齐**：15 个已发布 `mstar-*` 专题 skill 增加最小标注/薄章节（Evidence ×13、Workflow ×9、References ×6，另补 `mstar-host` 的 load-order/decision-rules 缺口），内容均取自既有素材 —— 全部运行时 skill 通过 runtime 模式五问 lint；`mstar-audit` 零改动。`skills/mstar-skill-authoring/SKILL.md` 记录别名表（运行时语义仍为 SSOT：别名豁免机械 lint，不豁免内容）。
- **drift-lint Guard 5（五问语料冒烟）**：`bun run validation:drift` 现在加载全部已发布运行时 `skills/mstar-*/SKILL.md`（排除 `mstar-harness-core` 与 `mstar-skill-authoring`），剥离 frontmatter 后以 runtime 模式运行 `lintFiveQuestion` —— 删除 Step-3 对齐标题或失去运行时别名覆盖都会令 CI 失败（audit finding 5）。
- **`mstar-skill-authoring` 自身 strict 自检**：fence 感知标题扫描暴露标准自身 `SKILL.md` 为 fence false-green（五问覆盖仅来自 `## 默认 Body 结构` 模板代码块），现已补真实 `## Workflow` / `## 6 条作者原则（Decision Rules，必须遵守）` / `## 验证门控（Evidence，原则 4 + 6）` 章节如实作答，`mstar skill lint skills/mstar-skill-authoring` 通过 strict（authoring）模式。
- **fragment 校验 fail-loud**：`scripts/prepare-release.ts` 现对每个 changelog fragment 的 `packages:` token 按发布面枚举（`root | cli | opencode | engine | dsh`）校验。此前拼错的 token（如 `clii`、`scripts`）不匹配任何 changelog 目标，导致该 fragment 的要点被静默丢弃；现发版准备会在任何 changelog 改动或 fragment 归档前，逐行打印错误并以 exit 1 中止。`validateFragmentPackages` 已导出供测试使用。
- **`mstar roles validate`**：新增 CLI 命令，暴露 mstar-roles skill 目录检查 —— dsh seam `validateRolesState` 的薄镜像：对 roles 目录运行 `validateRoleMapping`，并对每个同级 `mstar-*` skill 运行 `lintLoadOrder`，不可读的同级 skill 尽力跳过。默认路径走项目根解析（`--roles-dir` → `skills/mstar-roles`，`--skills-dir` → 其父目录）；exit 0 打印 OK 与计数，违规 exit 1 且每行一条。`skills/mstar-roles/SKILL.md` 的 engine-check callout 现改为引用 CLI 命令。
- **drift-lint Guard 4**：`scripts/drift-lint.ts` 中的 roles/load-order corpus 护栏（plan 003 Task 2）—— 对每个 `skills/mstar-*/SKILL.md` 文本运行 `lintLoadOrder`（每个都必须在 Load Order / First action 章节声明 `mstar-harness-core`），并对 `skills/mstar-roles` 运行 `validateRoleMapping`（映射/参数表必须与磁盘上的 `references/*.md` 布局一致）；CI drift-lint 现会在角色表或 load-order 回归时失败。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.4.0**。

## [2.3.0] - 2026-08-16

### Harness

- **SDD fix 轮次机械细节**：`mstar-sdd` 新增四条 PM fix 波次派发与收口机械规则——**未验证轮消耗轮次**（fix round 缺少验证证据——reviewer 未确认 / 报告未落盘——视为不 clean，重查并计轮，绝不进入收敛分支）、**全部问题重进**（下一轮 fix dispatch 携带全部 open findings（含上轮未验证项），绝不 slice 丢弃子集）、**跨轮上下文摘录（封顶）**（第 2 轮起 dispatch brief 附前几轮 findings 与处置摘录——约 500 词/轮、总量约 1500 词，为建议值而非硬上限）、**未收敛如实列出**（波次收尾仍有 open findings → 逐条明细 + 明确「重新喂给下一轮 fix 或转 residual 留档」处置，绝不静默收口）。C5 折入 `mstar-sdd` SKILL.md "After all tasks" + `references/file-handoffs.md` 互指（per-task fix loop 适用同一机械）。
- **Residual fail-loud 交接契约**：`mstar-plan-artifacts` 的 `status-and-residuals.md` 现要求 findings 在登记 R# 前必须过 engine 校验——单条过 `validateResidual`、全量过 `validateStatus`；畸形条目（非对象、缺九必填字段 id/title/severity/source/scope/decision/owner/target/tracking 任一、或 severity 非枚举）一律**拒绝**——修正后重写，绝不静默透传、降级写入或先写后补。C6 折入；architect 核验 D-3 分支 = 已覆盖缺测试，故 `packages/engine` 补齐非对象拒绝回归用例（`validateResidual` 级 + `validateStatus` 聚合级各 1，engine 套件 658 pass / 0 fail），零源码 diff、无新增公共 API。
- **CLI `dispatch validate` 非 ASCII 字面量修复**：bun 执行 CLI bundle 时对正则/字符串字面量的原始多字节 UTF-8 解码错误，导致合法的 `Branch policy: direct on main — <reason>`（em-dash）被误报为双 violation。`packages/engine` + `packages/cli` 共 20 个 src 文件的非 ASCII 字面量全部转 `\uXXXX`，另加 dist 构建后转义器（bun build 会把字符串转义还原为原始 UTF-8）、em-dash + ASCII 双 fixture 的 bundle-smoke 回归用例，以及 `bun run lint:ascii-literals` + CI 步骤防复发。守门范围覆盖 engine/cli 源码与 CLI dist bundle；opencode dist bundle 未接 escaper——不作为大 bun bundle 运行。
- **回归固化 paired-evidence 参考**：新增 `mstar-skill-authoring/references/regression-fixation.md`——把「真实产物」当被测对象（built bundle / 命令序列，而非源码 import）、mock 宿主钩子、双路径断言一致、修复固化（复现 → FAIL → 修复 → PASS → 入回归集）；零外部依赖，明确为可选重武器（默认仍是 P6 before/after + 应用案例）。SKILL.md 补 References 指针并同步 verdict 枚举为 4 值 SSOT（Approve | Request Changes | Needs Discussion | Unconfirmed）。
- **数据流定向调试规程**：`mstar-coding-behavior` §4 Debugging 新增紧凑诊断规程——先画数据流再下判断（输入 → 处理 → 存储 → 输出，每步谁写谁读；bug = 数据流某处状态偏离预期），四类可互验交叉检查（re-run the repro / log comparison / input-output comparison / dual-path comparison——当场无法验证的假设不构成结论），以及修复证伪（修复后重跑原复现并与预期对照；明确报告「verification failed」，绝不假装成功）——与既有 root-cause / repro-test 条目互指而非重述。
- **QC 报告证据契约 + `Unconfirmed` verdict**：`qc-specialist` report-template 的 findings 条目现要求每个严重级别都附 `Verification` + `Expected vs observed`——Critical/Warning 可用四类交叉验证（或 `diff/read/grep` 锚点），Suggestion 仅用 `diff/read/grep` 锚点——并由两条硬规则背书（无法陈述可验证交叉检查 → 不报该 finding；证据通道失败 ≠ 「无问题」——受影响范围标 **Unconfirmed**，不得默认无发现）；verdict 枚举新增 `Unconfirmed` 以覆盖证据通道失败；`deep-review-lenses.md` 现要求每个透镜 finding 附 diff/read/grep 锚点 + 预期 vs 实际（无锚点不入报告）。
- **Audit 红队攻击子步**：`mstar-audit` Phase 3 在人工 vet 前新增攻击子步——取 top candidate findings（按 leverage 排序，数量随 finding 总量自适应）逐条执行三向攻击（反例 / 更简单解释 / 证据可验证性）；survived 原样交 vet，refuted 剔除并记入 index 的 "considered and rejected" 节（沿用 `- <finding>: not worth doing because <one line>` 行格式），攻击自身产出的幻觉声明丢弃并记入红队记录行（绝不进 findings 表，也不占 "considered and rejected" 名额），未被攻击覆盖的 finding 视为未审查、保留交 vet——与 vet 步一行互指（攻击步判定「主张是否立得住」；vet 保留打开引用代码逐条核实 + by-design / mis-attribution / duplicate 处置）。
- **QC 汇总覆盖语义 + `Unconfirmed` 传导**：`mstar-review-qc` PM consolidated 节现要求——未提及 = 未审查（未被任何席位提及的 finding / severity 项 / 声明不得标记为已解决或通过，如实标注 `unreviewed` 并按需转 targeted re-review）；汇总层零注入（每条 consolidated 发现可溯源到某 `qcN.md`，PM 自身观察走独立 Status Update）；任一席位 verdict = `Unconfirmed` → gate 决策不得为 `Approve`，先补证据再收敛（走既有 targeted re-review 机制——同 `qcN.md` `## Revalidation` 原位更新 verdict，不新增形态、不改 N 规则）。PM `Consolidated Decision Template` verdict 枚举同步为 4 值（Approve | Request Changes | Needs Discussion | Unconfirmed）。
- 在 README 头部新增 **DSHFIND** badge，链接到 DSH 插件目录。
- **短命引用 lint（engine）**：新增 `findEphemeralCitations` 扫描 skill 文本中的短命引用——具体 task 工件（`task-<digits>-(brief|report|fix-report|diff)`，含点号形式 `task-N.diff`）与 SDD 深链（`.mstar/sdd/` / `.agents/sdd/` + 具体首段）——同时判别占位符形式（`task-N-report`、`<plan-id>`、`{SDD_DIR}/…`、`.mstar/sdd/**` 路径 glob）：当前 `skills/` corpus 零误报。
- **CLI `skill lint`**：`mstar skill lint` 五问 checklist 后接入第三项 `skill lint (ephemeral citations)`；每条引用报为 `skill.ephemeral.<kind>` 违规（行号 + 匹配 + 占位符改写建议）并置 exit 1。
- **drift-lint 守卫**：docs 审计枚举集合相等（docs/cli.md `<category>` 行与 README 类别聚焦列表对 engine `AUDIT_CATEGORIES`——捕获 `deps` 这类杜撰 token 与 `bug` / `direction` 这类遗漏）、push 范围内 README.md / README_CN.md 同 commit 双语配对、以及复用 `findEphemeralCitations` 的 skills corpus 短命引用守卫；另加 `citesKnowledgeConventions` 豁免 harness 本地 knowledge 引用。
- **历史改写推送安全**：`mstar-branch-worktree` 新增「History rewrite 与推送安全」节——已推送分支的任何 history rewrite 须先 `git fetch` 记录远端**精确 OID**，再以 `--force-with-lease=<branch>:<observed-oid>` 发布（禁止裸 `--force`）；改写后既有 review threads / approvals / check 结果不再构成当前证据，merge 结论前须重审；`mstar-iteration` phase-4-5 reference 现以该节为 rewrite / force-with-lease / 证据失效规则的 SSOT。
- **装置库（Authoring devices）**：`skillsbench-authoring.md` 新增 6 个小型可组合撰写装置（calibrated examples file、recall batteries、overcorrection traps、required-explicit-input、questions ≠ write authority、invocation boundary），每个映射至一至两条 SkillsBench 原则并附仓内实例。
- **双语最小对照编辑规则**：`AGENTS.md` Core Rules 新增规则——配对文档（README.md/README_CN.md、packages/dsh README 三件套）更新时只做最小对照编辑，**绝不**为应用一处更新而整篇重译，并在同一变更集内重录配对哈希（`git hash-object`）。
- **知识文档行文卫生**：`mstar-compound` workflow 新增 §3.5 HEAD-resolvability 质量门（HEAD 读者——无 chat transcript / dispatch prompt / 未合并草稿——可解析每个引用并核验每个声明），含 mstar 适配的泄漏分类（dead session citations、change narration、review choreography、无 `simplify:`/`temporary` 标记的 hedges、authoring-language slips）与 sanctioned keep 规则（review bundle 内 R#/finding id、issue 引用、measured bounds、iteration/plan id）；`writing-specialist` Output Guidance 仅以指针指向 SSOT，不复制正文。
- **未来决策价值分类轴**：`mstar-compound-refresh` Phase 2 新增第二轴——正文中的 rationale / alternatives considered / negative guarantees / reintroduction conditions 仍指导未来变更的文档**无论长度一律 Keep**——并附守护规则（captured rejected approach 仅在败方仍是 tempting、meaningful mistake 时保留），以及对 frozen-archive seal 机制的显式排除（规则 6 delete-don't-archive 保持不变）。
- **writing-specialist 编辑准则**：Output Guidance 新增 complete-proposition rule（修剪前列举 actor+action / condition / modality / negative guarantee / ownership 命题，仅当每个事实子句存活时才可修剪）、按 6 类 mstar 产物（knowledge docs / plans / review bundles / SKILL.md / README / completion reports）的 coverage-by-artifact 表，以及 doc standards（atomic-move 规则、tutorial-vs-reference 分类）。
- 在 README.md/README_CN.md 与 docs/cli.md 中补充 `/codebase-audit` 用法与关键词参数（深度级别、类别聚焦、`branch`、`next`/`roadmap`、`simplify`）。
- **QC 深度评审透镜**：`deep-review-lenses.md` 新增 5 个透镜（Lifecycle & Concurrency、Ownership / Derived-State、Bounds、Enforcement-Path、Real-Entry-Path），每个含 2–4 条可由 diff/read/grep 回答的结构化追问；加深 Testing / Contract 透镜；信号映射默认席位同步（QC3 += Enforcement-Path / Ownership；QC2 += Bounds / Real-Entry-Path）。
- **审计 playbook 探针**：`mstar-audit` playbook §1/§2/§4/§5 补 8 条代码库级探针（derived-state drift、bounds covering the final operation、enforcement bypass、real entry path、externally observable state、user-visible output is behavior、public-but-one-caller、unjustified defaults/public options）；§5 新增 prove-or-reject 方法论（消费方三分类、hand-rolled 与依赖替换的门槛、mirrored-fact test、strong-candidate 家族、守卫）。
- **`/codebase-audit simplify`**：新增 `simplify` scope variant，复用现有命令路由——面向 DEBT 的深度扫描，findings 归 Category DEBT，绝不写 inline TODO。
- cli/opencode/dsh 的 `@mstar-harness/engine` devDependency 改用 `workspace:*` 协议；移除 release-prep 中的 engine spec 同步步骤。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.3.0**。

## [2.2.0] - 2026-08-13

### Harness

- **dsh 插件**：context catalog 新增 **`agentFlow`** 证据行——实际 subagent 派发/结算 ledger（`{HARNESS_DIR}/agent-flow.jsonl`，有界 JSONL，截断至约 500 条；单一记录核心 `DshHostAdapter.dispatchGate` 覆盖 `tools/pre-execute` listener 与 `beforeDispatch` host hook 两条路径；真实结算记录——`tools/post-execute` 是已验证的 registry seam（每次工具调用都会发出）结算前台派发调用，后台任务经 `ctx.tasks.onTaskDone` 终态结算，按精确派发标识配对——绝不伪装结算，未配对调用不记录）。工作流面板主图新增预期 vs 实际 subagent 流转 pipeline：第三列阶段盒（由派发证据点亮）、可折叠事件明细 footer（role → planId#taskId、全部五种状态色、结算 ✓）以及 flow-expected / flow-actual / flow-unexpected 图例。
- **dsh 插件**：ledger 缺失文件状态现读取为空视图（面板自 plan 合并起显示「暂无实际派发」空态，而非「证据缺失」降级语）；ledger 追加路径文档化为单写者并做大小门控 + 原子截断替换。
- **dsh 插件**：修复统一 `mstar-engine-status` 目录行在迭代门禁段无法构建时（无 `status.json`、无 active 舵向 compass 或控制文档不可读）导致整轮会话失败的问题（`session event "user/message" carries non-JSON-serializable data`）。可选的 `iteration` 键现在改为省略而非以 `undefined` 呈现，注入消息在 `Session.append` 边界保持无损 JSON 可序列化。
- **dsh 插件**：修复 `@mstar-harness/dsh` 构建门禁——完整构建现可产出 web 客户端 bundle（`dist/client.js`）。根因：`tsconfig.json` 的 `types` 缺少 `react`（TS7026：面板 `.tsx` 源码无 `JSX.IntrinsicElements`），且 `@deepseek-ai/dsh-client-*` peer-stub workspace 链接缺失（TS2307），导致构建末尾的 `bunx tsc` 失败、客户端 bundle 缺失。类型检查门禁已恢复绿色；`dsh --profile web` 正常启动，插件 `/plugins/@mstar-harness/dsh/client.js` 已注册并可服务。
- **dsh 插件**：mstar 斜杠命令（`/iteration-start`、`/iteration-drive`、`/iteration-loop`、`/codebase-audit`）现在声明 `input` hint（`commands/*.md` 新增 frontmatter `input:`），dsh web 客户端在菜单点选后会 **claim** 命令而非立即执行：`/name ` 以命令高亮插入输入框、参数 hint 以 ghost text 提示、按 Enter 才提交——与 `/plan`、`/goal`、`/advisor` 相同的交互。用户键入的参数以 `## User input` 小节追加进 steer 的命令消息；带引号的 frontmatter 值（description/input）现在按去引号注册。更新 `mstar-host/references/dsh.md`。
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.0-rc.3` 线（`^0.1.0-rc.3`；`@deepseek-ai/cordis` `^4.0.1`——与 dsh-advisor 上游升级同类对齐，`dsh-external/dsh-advisor#14`）；所有低于 `0.1.0-rc.3` 的已装版本（旧 `0.0.1-rc.x` / `0.1.0-rc.2` 的 lock 条目与嵌套副本）已从 `bun.lock` + `node_modules` 清除。monorepo 根新增 `bun` `overrides` 条目，把 `@deepseek-ai/dsh-llm` 钉在 `^0.1.0-rc.3`：否则 bun 会为每个依赖它的 dsh 包安装同版本的嵌套 peer 副本，TS 5.9 的 package-id 解析把副本视为不同模块——插件在 `MessageSourceMap` 上的 augmentation（`mstar-engine-status` catalog kind）无法并入 dsh-agent/dsh-session 看到的联合类型，导致 `agent/pre-step` catalog push 处 `createUserMessage` 类型报错。`tests/peer-deps.spec.ts` 固定 `^0.1.0-rc.3`。
- **dsh 插件**：`@deepseek-ai/dsh-*` 各 seam 的开发期解析从本地 **link farm** 切到 **npm registry** `0.0.1-rc.5`（bun 凭 monorepo 根 `.npmrc` 的 `${NPM_TOKEN}` 自动安装 peer）。删除 `scripts/setup-dsh-links.ts` 与 `dsh:link`/`dsh:link:check`（`prepare` 现为纯 build）；移除 `peerDependenciesMeta.optional`（旧的跳过未发布 peer 的 workaround）并补全 peer 集合——`dsh-client-runtime`/`dsh-client-locale`/`dsh-client-ui-conversation`/`dsh-client-ui-slots`/`dsh-invariants`/`dsh-jobs` 加入既有 peer（全部 `^0.0.1-rc.5`）；新增 `keywords: ["dsh", "dsh-plugin"]` 与 `tests/peer-deps.spec.ts`（registry peer 契约 + peer 不得标 optional 的回归断言）。
- **dsh 插件**：`@deepseek-ai/dsh-*` peer 升级到 `0.1.0-rc.6` 线（`^0.1.0-rc.6`；`@deepseek-ai/cordis` 保持 `^4.0.1`）——所有低于 `0.1.0-rc.6` 的 lock 条目（`0.1.0-rc.3` 钉点与任何 `0.0.1-rc.x` 残留）已从 `bun.lock` 清除；整个 dsh 树现统一解析为 `0.1.0-rc.6`（60 条 lock 条目，每包单份 hoisted 副本）。monorepo 根的 `bun` `overrides` 条目（`@deepseek-ai/dsh-llm`）已**删除**：所有 dsh 包位于同一 `^0.1.0-rc.6` 范围时 bun 会去重为单副本，rc.3 时代的嵌套副本 workaround 不再需要（已验证：1 条 lock 条目、0 个嵌套 `dsh-llm` 副本；`MessageSourceMap` augmentation 类型检查通过）。根 `dependencies` 保持仅 engine。seam 解析文档已按公开 registry 现实更新（根 `.npmrc` 认证 token 已在 0c884d47 移除）：`packages/dsh` README（中/英）与 `tests/peer-deps.spec.ts` 不再声称存在根 `.npmrc`/`${NPM_TOKEN}`——spec 现断言 scoped-registry 映射不得回归、已装 `dsh-llm` 精确解析为 `0.1.0-rc.6`。注意：`@deepseek-ai/*` 的 `dist-tags.latest` 指向 `0.0.1-rc.1`（古老版本线，其包引用了从未发布的 peer 如 `dsh-user-interaction`），因此**不得**使用 `bun update @deepseek-ai/...`——它会降级到该线并 404；lock 清除 + `bun install` 才是受支持的升级路径。
- **dsh 插件**：`@deepseek-ai/dsh-*` 各 seam 的开发期依赖策略由提交的 `peer-stubs/` 占位包改为 **link farm**（`packages/dsh/scripts/setup-dsh-links.ts`，dsh-advisor 模式）：把本地 dsh 源码树（`$DSH_SOURCE_DIR` → `$DSH_HOME/source/current` → `~/.dsh/source/current`）中的**真实**包 symlink 进仓库根 `node_modules/@deepseek-ai/`（幂等；`bun run dsh:link` / `dsh:link:check`；已接入 `prepare`，位于 build 之前）。`peerDependencies` 保留（运行时由宿主提供；标记 optional 以避免 bun 1.2 访问私有 registry 404）；删除 `peer-stubs/` workspace。
- **dsh 插件**：CI（validate job）现检测 dsh 源码树可用性（`$DSH_SOURCE_DIR` / `~/.dsh/source/current`），不存在时跳过 dsh 测试/typecheck 步骤——CI 不跑 dsh。
- **dsh 插件**：`src/index.ts` 由 3184 行单体瘦身为 `src/gates/*` 之上的模块索引（纯重构、零行为变更——27 名导出面由 `tests/export-surface.spec.ts` 冻结不变，导出面类型层现经 `typecheck:tests`（`bunx tsc --noEmit -p tests/tsconfig.json`）进入 CI 类型检查）。
- **dsh 插件**：`HarnessResolver.forWorkspace` 现显式传入 `workspaceRoot = 会话工作区 cwd`（探测起点）——`{HARNESS_DIR}` 探测在会话工作区处停止、永不向上，工作区之上的 harness 目录（如全局 `~/.mstar` CLI 安装根）不再被采纳。dsh 边界与 CLI 的 git top-level 边界有意分叉。显式 `config.harnessDir` 仍全权优先。
- **dsh plugin**: the pre-step catalog is now ONE unified `mstar-engine-status` message — watermark (version, harness dir, enforcement) + iteration phase-gate section (when a steering compass resolves) + workspace-state digest section (plan registry, open residuals, branch/policy anchors, active leases, knowledge summary, compass direction — when the workspace has a `status.json`) — all from one cached `status.json`/compass/knowledge read.
- **dsh plugin**: the catalog row is TTL-refreshed per workspace (Config `catalogTtlMs`, default 60000 ms — mid-session plan/compass/residual changes land within one interval while the hot path stays a timestamp compare + cache hit) and digest-gated (injected once per turn, re-injected only when it changed — a long turn shows the catalog once, not per step).
- 统一本地布局约定：临时文件放 `.tmp/*`，git worktrees 放 `.worktrees/*`（均 gitignored）；约定写入 AGENTS.md。
- **dsh 插件**：web 客户端工作流面板现为 **"MStar 工作流" / "MStar Workflow"**——重构布局（header 均布版本 / harness 目录 / enforcement；右侧固定 sidebar 放 plans / residuals / knowledge / leases / branches+policy / direction；主体为 **react-flow 循环工作流图**）与全面视觉升级（dsw token 间距 ramp、层级、暗色、动效）。图经纯函数 `projectGraph` 投影 `mstar-engine-status` catalog（schema 常量与 catalog 证据严格分离；永不 throw；显式降级态）：阶段环（iteration-start → autonomous-execute → iteration-close → pr-delivery → merge-ready，loop 边）+ plan 状态机（Todo → InProgress → InReview → Done / InProgress ⇄ Blocked / unknown 桶），含当前阶段高亮、图例、缩放平移与 fitView。`@xyflow/react@^12.11.2` 内联进 `dist/client.js`（MIT；体积/许可证已审查记录）；构建脚本新增断言：产物无 `import.meta` / ESM 语句——web loader 以经典 `<script>` 执行插件 bundle，zustand v4 的 `import.meta.env` 读取（会在 parse 期破坏面板）已用 define 消除。本地安装链路复验：profile add → web boot → client.js 路由服务的正是构建产物（sha1 逐字节一致）。
- **dsh 插件**：修复 MStar 工作流面板"无样式"问题——web 客户端 bundle 中 CSS Modules 哈希类名可能以数字开头（FNV-1a → 8 位 hex，约 62.5% 概率），拼出非法选择器（如 `.20fd0e45_root`）被浏览器静默丢弃（整条规则失效）。客户端 bundle 构建现于 CSS 文本层按 WHATWG `CSS.escape` 转义数字开头的类选择器（如 `.20fd0e45_root` → `.\32 0fd0e45_root`；DOM 类名不变），并新增构建期双层断言（transform 层 + 产物 artifact 层）确保无未转义数字开头 hash 选择器残留——防止静默样式丢失再次发生。
- **dsh 公开发布准备**：移除 `@mstar-harness/dsh` 的 `prepare` 脚本（fresh checkout 下 `bun install` 不再因 gitignored 的 engine `dist/` 失败；monorepo 与 cli/opencode 一致显式构建各包），把 dsh 接入发布流程（`release-surfaces.ts` 版本表面 + changelog、`release.yml` 构建/发布），并全面公开 README——删除私有 dsh-provider 区块与私有镜像 repo-URL 安装（`dsh-external/mstar-workflow`），改为 registry 形式 `dsh plugin --profile web add @mstar-harness/dsh`（外加 local-checkout 开发安装）。清除误提交的 `.pnpm-store/`（现已 gitignore）。
- **dsh 插件**：修复 ReactFlow v12 自定义节点缺 Handle 导致边被静默丢弃的问题——整图 17 条边（阶段环 5 + 状态机 5 + connector 1 + pipeline 6）在真实浏览器中全部恢复渲染。
- **dsh 插件**：`packages/dsh` 同步到 dsh `0.0.1-rc.2` 重命名波——消费 seam 包改名（`@deepseek-ai/dsh-skill-local` → `@deepseek-ai/dsh-skill-filesystem`；测试专用 `dsh-tasks`/`dsh-tasks-fake` → `dsh-jobs`/`dsh-jobs-fake`），peerDependencies 从 `^0.0.1-rc.1` 升到 `^0.0.1-rc.2`，并同步 API 符号改名（`SkillService` → `SkillRegistry`；可选后台 seam 面 `ctx.tasks`/`onTaskDone`/`TaskId`/`TaskDoneListener`/`TaskSnapshot` → `ctx.jobs`/`onJobDone`/`JobId`/`JobDoneListener`/`JobSnapshot`；client `LocaleService` → `LocaleRuntime`、`SlotsService` → `SlotRegistry`）。文档/README 中 `skill-local` 措辞改为 `skill-filesystem`。
- **dsh plugin**: the `<mstar_engine_status>` watermark now shows one unified `mstar version` line instead of separate engine/plugin versions (single-version invariant — the bundled engine and the plugin share one version).
- 清理面向用户 skills 中的本地维护路径引用：`mstar-host/references/dsh.md` 与 `mstar-iteration/references/phase-2-worktree-lease.md` 现仅引用运行时消费者契约（复核零残留）。
- `mstar-branch-worktree` 的 feature worktree 命名统一到 workspace 根 `.worktrees/<plan-id>-<slug>` 约定（AGENTS.md「Local scratch layout」），随仓库约定 gitignore。
- **dsh 插件**：web 客户端模块清单从顶层 `dshClient` 字段迁移到嵌套 `dsh.client`（`platform: 'web'` + 声明的 inject 面），对齐上游 `client-modules` 发现逻辑（`dsh.client` + `exports["./client"]`）。旧顶层键已移除——上游无兼容回退，旧字段会静默导致客户端半体不被发现，使 "MStar 工作流" 面板从 web boot manifest（`window.__DSH_BOOT__.entries`）中消失。新增 manifest 契约防回归测试冻结新契约，上游若再次改名会先行报警。
- **dsh 插件**：版本对齐至 `2.0.5`（单一版本不变量——`@mstar-harness/engine` devDependency 精确钉定 `2.0.5`，dsh 套件中的引擎版本断言更新为 `2.0.5`），在上游 v2.0.5 合入后恢复统一的 `mstar version` 水印。
- **dsh 插件**：版本提升至 `2.1.1`（单一版本不变量——`@mstar-harness/engine` devDependency 精确钉定 `2.1.1`，dsh 套件中的引擎版本断言更新为 `2.1.1`），在上游 v2.1.1 同步后恢复统一的 `mstar version` 水印（QC F-001：发布 bundle 与工作区源码现在报告同一版本）。
- **dsh 插件**：`@mstar-harness/dsh` 包现随附 **web 客户端插件**（工作流面板），与服务器半体共享同一 `mstar` bundle 行——`dsh.client` + `exports["./client"]` 使客户端半体被自动发现（无需独立 profile 层或安装步骤）。插件在 `conversation.view` view ring 注册一个 tab（`id: 'mstar-workflow'`、`order: 20`），以结构化面板渲染最新 `mstar-engine-status` catalog 行：水印（版本 / harness 目录 / enforcement）、迭代相位段（transition、all-plans-done、gate 判定 + 违规、status/compass 锚点）、工作区状态段（plan 看板、residual、分支/策略锚点、租约、知识、方向）与新鲜度标记；刷新跟随会话快照（不轮询）。bundle 以 closure-factory CJS 产物（`dist/client.js`）在 `/plugins/@mstar-harness/dsh/client.js` 提供；已验证本地安装进 `web` profile。
- **dsh 插件**：**Known limitations**——本迭代面板为结构化分段呈现；图形化流程画（react-flow DAG）为**下迭代**范围（compass Roadmap Position）。本迭代不引入 react-flow 依赖、不改面板渲染形态。
- **dsh plugin**: `{HARNESS_DIR}` now resolves per session workspace — the probe starts from the session cwd (never the launch/process cwd), so the engine-status watermark and the gates follow the workspace the session actually works in; an explicit `harnessDir` config still wins outright.
- **dsh 宿主**：并发 subagent 派发现**强制要求 background 模式**——任何需要并行执行的 N≥2 派发（QC 三审、双轨实现）必须在同一条消息中对每个 `subagent` 调用都设置 `run_in_background: true`；前台（foreground）N≥2 调用会串行执行（工具为 fail-closed `exclusive` 分类），不算满足 N 并行要求（属派发未完成 / `Blocked`）。更新 `mstar-host/references/dsh.md`（PM dispatch + QC default）。
- **dsh 插件**：代理 canvas 图例精简 + Phase 布局优化（plan `20260813-panel-agent-canvas-legend-layout`）——(1) 图例**精简为 3 条角色卡状态条目**（`agent-running` 执行中发光 / `agent-settled` 已完成——独立绿框 + ✓，off 档角色不显示 / `agent-idle` 未工作虚线）；7 条协作边/布局技术条目（`flow-actual` / `port` / `group` / `sub-bucket` / `supervise` / `on-demand` / `unknown`）从图例文案移除（canvas 本身仍保留这些边/端口/分区——仅图例文案精简）；(2) **Phase 1 / Phase 2 两组改为左右并排**——Phase 1（review-edit-chain）在左、Phase 2（sdd-implement → qc-tri → qa-gate）在右，顶部对齐——取代原先的上下堆叠，显著节省纵向画布空间。文档同步：dsh.md SSOT + bundle 镜像 + README.md / README.zh.md / bundle/README.md。
- **dsh 插件**：代理执行 tab（spec F1.4）现为**可拖动 canvas**（取代并删除 stage 列式 AgentFlowZone）：原生 pointer 事件实现**拖拽平移**（pointerdown/move/up + `setPointerCapture`，仅 translate、无 zoom、零第三方依赖、`touch-action: none`），坐标空间内容层以 `data-canvas-pan` 暴露 pan 状态（`transform: translate(xpx, ypx)`；网格背景随内容移动）。每个 **KNOWN_AGENTS** 全集成员渲染一张实体卡——**title = agent 名**（session id / task tag 仅为记录字段）；无派发证据的 agent 显示 muted **idle 卡**（虚线框、`data-agent-idle`），有证据者按诚实状态优先级点亮（running business 发光环 / settled ✓ / error / denied / advisory）。协作边复用 `AgentEdge` 模型：dim dashed 预期 stage 骨架、business 实际交接边、**带动画的「next」边**（`@keyframes canvas-dash-flow`，`prefers-reduced-motion` 下关闭——引擎级验证）。**Legend** 在 canvas 上重新挂载，含 idle swatch（`data-mstar-legend-item="agent-idle"`）+ 协作边 swatch；canvas 降级提示现区分 settle-only ledger（`data-canvas-note="settle-only"`）与 empty/degraded；同时清理了 `zones.module.css` 中 AgentFlowZone 死样式。
- **dsh 插件**：agent canvas 已由浏览器 harness 在 **light + dark** 双主题下验证——实体卡（idle 虚线 / running 发光 / settled ✓）、legend swatch（含 idle swatch）与 next 边 stroke 均做双主题计算样式探针（host token 翻转可观测、panel/zones/canvas 三份 css 零裸色、`prefers-reduced-motion` 运行断言 next 边与 running 卡动画 computed 为 `none`）；**真实指针拖拽**序列（CDP `Input.dispatchMouseEvent`）将 `data-canvas-pan` transform 从 `translate(0px, 0px)` 平移到 `translate(60px, 30px)` 且 pointer capture 正确释放——拖拽契约端到端验证；证据见 `{SDD_DIR}/review/harness/`（browser-checklist.md + browser-results.txt）。
- **dsh 插件**：MStar 工作流面板的代理执行区现渲染真实 subagent 流转——六个 EXPECTED_ROLE_FLOW stage/phase 列承载由实际派发证据聚合的**实体卡**（agent 显示名 / role chip / 任务标签 `planId#taskId` / 状态点 / ×N 计数；执行中实体带 business glow-pulse 高亮，无证据 stage 显示虚线「待执行」占位并列出预期 role chips，头部带 `N 执行中 · M 待执行` 摘要）。流转箭头：列间 dim expected 骨架箭头、同列卡片间小交接箭头，以及**带动画的「next」边**——business dash-flow 箭头（`@keyframes agent-dash-flow`，`prefers-reduced-motion` 下关闭）自最新执行中实体所在 stage 指向常量序下一列，仅存在 running 实体时绘制。ledger 缺失/为空/仅 settle 时区降级为 muted 空态（绝无橙色 warn 框）。
- **dsh 插件**：代理区与 agent 流转事件 dock 已由浏览器 harness 在 **light + dark** 双主题下验证——对实体卡、状态点、待执行占位、next 边 dash 动画（声明 + computed `animation-name`）与 dock 事件行状态色做了双主题计算样式探针，并含一次 `prefers-reduced-motion` 运行断言动画被关闭；证据见迭代 guide `iter-20260810-panel-zones/guides/agent-flow-zone-dual-theme-verification.md`。
- **dsh 插件**：MStar 工作流面板 canvas 重构为 **HTML/CSS zone dashboard**——react-flow 循环图（`@xyflow/react` 渲染层、其 plain-`.css` text loader 与 devDependency）全部移除，构建现断言产物 `dist/client.js` **不含 `xyflow`/`reactflow` 标记**（bundle 由约 468 KB 降至约 85 KB raw）。canvas 撑满 Tab（无整页滚动）：**迭代区**（Step 1–5 竖排 stepper + `Step N/5` 徽标、激活高亮 / 未激活暗淡态、分支面板：迭代 base / 目标分支 / spec 集成分支——仅激活时渲染）、**任务区**（6 列 kanban：Todo / InProgress / InReview / Done / Blocked / unknown + 计数徽标，Done ≤5 + `+N more`）、**代理执行区**（pending 骨架——实体与流转箭头见 plan `20260810-panel-agent-flow-zone`）、底部 **fixed footer 条**（zone 图例 + gate 摘要，违规列表可折叠）与 canvas 左下角 **AgentEventDock**（agent 流转事件条，仅在有事件时挂载——0 事件时整体隐藏）。三个橙色 warn 框清零——降级态一律 muted 空态，绝无橙色框。
- **dsh 插件**：zone dashboard 全 token 驱动（零任意形式裸色），并已由浏览器 harness 在 **light + dark** 双主题下验证——对 zone 背景/边框、状态色与 muted 空态做了双主题计算样式探针（尊重 `prefers-reduced-motion`，动效 ≤200ms）；证据见迭代 guide `iter-20260810-panel-zones/guides/canvas-zones-dual-theme-verification.md`。
- **dsh 插件**：事件记录 tab（spec F1.5）现为**非 canvas 日志页**——`EventLogPage` 从投影的 `ZoneView` 切片（原样消费，零投影改动）渲染两个分区：**Agent 流转事件**（`view.events` ≤50 latest-first；off-pipeline 未匹配派发经 `expected: false` 折叠一次，绝不二次追加）与**违规记录**（`view.violations` gate 违规：severity/code/message）。**每条都是可展开的原生 `<details>`**（无 JS、键盘可达）：summary 即开关（role/agent、stage、`planId#taskId` 标签、HH:MM 时间、token 状态色 chip、settled ✓、耗时、unexpected 徽标），展开体呈现**完整 catalog 字段**（role/agent/stage/plan/task/category/time/kind/status/expected/settled/duration；违规行：severity/code/message）——缺失字段显示 muted **「—」**，绝不捏造。空态/degraded 全程 muted（双空 → 单条「暂无记录」；混合空态各分区独立降级）——绝无橙色 warn 框。canvas 角标 **`AgentEventDock`** **移除**（无双份日志，spec §5）：其行布局 + 状态色迁入本页，header TabNav 即跳转入口——全仓零 `data-agent-event-dock` 残留。新增 `data-event-log-*` 测试锚点族（分区/行/详情/字段/缺失/空态）、`PanelKey` union 新增 23 个 `event-log.*` 文案键（zh/en 对称），以及 token 驱动的 `event-log.module.css`（零裸色——dark 为宿主 token 翻转；`<details>` disclosure 箭头为 token 色 `::before`，展开时旋转 90°；150ms 悬停/旋转落在 120–150ms 窗口；动效由面板根 `prefers-reduced-motion` 规则统一关闭）。
- **dsh 插件**：事件记录页已由浏览器 harness 在 **light + dark** 双主题下验证，并完成**真实 `<summary>` 点击**展开 `<details>`（断言 open 状态 + 展开体计算样式）：分区帧（bg/border）、日志行 summary、状态 chip（business/warn/error/success）、severity chip（error/warn）、disclosure 箭头（caption token，展开时旋转）与 muted 空态均做双主题探针（宿主 token 翻转可观测、panel/zones/canvas/event-log 四份 css 零裸色、无面板侧 dark 覆盖）；`prefers-reduced-motion` 运行断言行悬停过渡 computed 为 `0s`；证据见 `{SDD_DIR}/review/harness/`（browser-checklist.md + browser-results.txt + 双主题截图，含一条已展开详情）。
- **dsh 插件**：QC 修复波（plan `20260811-panel-event-log` 复审）：「未匹配角色」徽标改为**仅派发行**显示——settle 行（完成记录）永不标记 unexpected，其详情「预期角色」座渲染「—」；`formatEventTime`/`formatEventTimeFull` 对有限但超出 Date 范围的 `ts` 不再抛 RangeError（与缺失值一样降级为「—」）；流转事件分区标题改用对称的 `event-log.section.events` locale 键；README/dsh 指南将 footer 条移除归因修正为 tabs-shell plan（本 plan 仅移除 `AgentEventDock`）。
- **dsh 插件**：面板 F2 快速修复（plan `20260811-panel-f2-quickfix`）——（1）「任务迭代」tab 的步骤行改为 5 个等分铺满单元块（flex `1 1 0`、内容居中、`--mstar-space-*` 间距），徽标为纯数字、摘要为 `n/total`——连接条（`data-step-connector*`）已移除，zh/en 均无「步骤/Step」字样；（2）`KNOWN_AGENTS` 现恰为 14 个角色——`project-manager`（主编排代理，绝非可分配 subagent）从「代理执行」roster 中移除；（3）代理画布删除 `ops-on-demand` 管线阶段（5 阶段、`qa-gate` 为终点），`ops-engineer` / `prompt-engineer` 移入独立的**按需执行列**（投影层 `zone` 语义、无 expected/next 箭头进出、本地化列标签 + 图例条目），并将 SDD 实现 ↔ 任务审查**回环反向边**（`sdd-task-review → sdd-implement`）渲染为视觉可辨的弯曲双向箭头并带独立 `data-agent-edge-loop` 锚点——`pending` 语义随之更新（11 个流内角色）。
- **dsh 插件**：面板 F3 代理 general 模型（plan `20260811-panel-f3-agent-general`）——（1）「代理执行」画布管线由 5 阶段降为 **4 阶段**（`review-edit-chain → sdd-implement → qc-tri → qa-gate`，`qa-gate` 为终点；`sdd-task-review` 阶段删除，其 SDD L2 审查者移出管线）；（2）`KNOWN_AGENTS` 现恰为 **13 个角色**——`generalPurpose` 改为 **`general` 桶**（独立末列，`stage: null`），`explore` 已移除（无卡无列——零散 `explore` 派发归入 `general`），`ops-engineer` / `prompt-engineer` 保留 on-demand 列，`project-manager` 仍不入 roster；（3）实体卡改为**按 role 聚合**而非按 session——同一角色跨 session 合并为一张卡 ×N，所有 off-roster 派发（原 `generalPurpose` 审查者、`scout`、匿名 `role === ''`）归入唯一 `general` 实体（`agent` / `task` 仅作记录字段）；（4）SDD 回环边重画为 `sdd-implement` ↔ `general`——画在**列带下方**的弯曲双向箭头（锚定列底、真实贝塞尔极值在最低列底下方 16px、`data-agent-edge-loop="autonomous-execute:sdd-implement->general"`）；（5）`AgentZone` 为 `'flow' | 'on-demand' | 'general'`（`unexpected` 列移除；列 = 4 阶段 + on-demand + general）；（6）「事件记录」页两个分区改为**左右并排**的锁定高度两列 grid（`repeat(2, minmax(0, 1fr))`——页面不再整页滚动，各分区固定标题、内部滚动），1200px 以下回退为堆叠行，`data-event-log-*` 锚点全保留（事件日志 unexpected 徽标语义不变——`expected` ⟺ 角色 ∈ EXPECTED_ROLE_FLOW union）。
- **dsh 插件**：面板 F4.2 代理视图布局（plan `20260811-panel-f4-agent-view`）——「代理执行」画布移除独立 **general 桶列**（现为 5 列：4 阶段 + on-demand；`data-canvas-column` 不再出现 `general`）：唯一 `general` 桶卡渲染于 **`sdd-implement` 桶内底部**（稳定分区——dev 卡在前、general 卡在后，虚线分隔 + 桶内小 `general` 标签，idle 占位保留，`data-agent-bucket="general"`）；`sdd-implement` ↔ `general` 的 **SDD 回环边移除**——列带下方不再绘制弯曲双向箭头、无 `data-agent-edge-loop` 锚点（`AgentEdge.loop` / `solveLoopBow` / `LOOP_BOW_MARGIN` / `GENERAL_COLUMN` 死代码清理）；3 条前向骨架箭头、同列交接箭头与带动画的 next 边不变，on-demand 桶（ops-engineer / prompt-engineer）不动。按真实派发证据的「动态线」为后续迭代路线。
- **dsh 插件**：面板 F4.3 迭代区（plan `20260811-panel-f4-iteration-zone`）——「任务迭代」页展开态头部改为**左右分栏**：分支面板（`data-iteration-head-branches`）居左小半、Steps 区（`data-iteration-head-steps`）居右大半（`data-iteration-head-split`，DOM 序 branches 在前；窄宽于既有 860px 断点回退堆叠；无激活迭代时不渲染分支面板）。当前步改为 compass 驱动：steering compass `status: active`（Phase 1 进行中——catalog `compassStatus` 字段）时 Step 1（iteration-start）渲染为**当前步**且 verdict 为 `unknown`、**无 PASS/FAIL 徽标**（Phase 1 无 gate 判定），next = Step 2；`locked` / 缺失 `compassStatus` 保持既有 gate transition 驱动的 Step 2→4 + 徽标；每一步预留固定高度 verdict 座（`data-step-verdict-seat`）使居中内容组对齐——PASS/FAIL 徽标不再歪斜、不再推挤 Step 块对齐。文档已同步（dsh.md SSOT + bundle 镜像 + READMEs + 知识库仅更新）。
- **dsh 插件**：面板 F4.1 时效性（plan `20260811-panel-f4-timeliness`）——「代理执行」画布现反映**真实**子代理完成状态：settle 仅来自已验证的完成信号——`tools/post-execute`（dsh-tools registry 对每次工具调用都会发出，已对上游源码验证）结算前台派发工具调用，`ctx.tasks.onTaskDone` 终态结算后台子代理（`completed → ok` / `killed → denied` / `failed → error`）；每个配对 settle 携带其派发的标识（`role`/`planId`/`taskId`，与派发事件同字段同语义），QC tri N=3 并发下各卡各自结算、「N 执行中」计数由 ledger 派生，未配对/非派发调用不记录（绝不捏造）。ledger 记录（派发/结算）现会**立即失效**工作区 TTL 缓存的 catalog 行——活跃编排期间面板按步刷新，不再受 60s TTL 延迟上限约束（空闲间隔保持最后快照——已文档化的限制）。
- **dsh 插件**：面板 F5 代理布局重构（plan `20260812-panel-f5-agent-layout`）——「代理执行」画布现为 **4 阶段列 + 最右 `unknown` 列**（`general` 桶获得**自己的最右列**，用户 2026-08-12 决策——原 F4.2「`sdd-implement` 桶内底部」落点被取代）；`sdd-implement` 列按投影 `entity.bucket` 拆为**子桶**——上方 **implementor**（flow 角色按 stage 原始顺序，随后 on-demand 角色 ops-engineer / prompt-engineer 带**按需徽标**；独立 on-demand 列已删除）与下方 **sdd-reviewer**（code-reviewer，SDD L2 task reviewer——v2.1.1，原 `generalPurpose` 席位），带 implementor / sdd-reviewer 标题标签；`sdd-implement` 列内新增 **双向监督线**（implementor ↔ sdd-reviewer——mstar-sdd 相互监督契约），默认 dim 虚线、仅当投影 `evidenced` 为真时亮起 business 实线（证据驱动点亮，绝不伪造激活）；`KNOWN_AGENTS` 由 **13 增至 14 角色**（`code-reviewer` 进入管线 roster）；无 harness 分支渲染**居中未激活态卡片**（文件夹图标 + 「未检测到 Morning Star harness」标题 + hint——无 tab、无 sidebar，检测到 harness 后自动呈现）。文档同步：dsh.md SSOT + bundle 镜像 + README.md / README.zh.md / bundle/README.md。
- **dsh 插件**：面板 F5 设计系统落地（plan `20260812-panel-f5-design-system`）——「代理执行」画布按用户审阅定稿的设计系统实现（design doc v3，2026-08-12 两轮反馈）：**(1) 透明度分级**——每张实体卡携带投影 `emphasis: 'current' | 'next' | 'off' | null` 分级，按迭代当前阶段派生（当前阶段角色 **100%** chrome 全强度、后续阶段预期角色 **75%**、已过阶段 / 无阶段 on-demand + general 角色 **45%**，`null` = 无迭代 → 不覆盖）；恒为 chrome **alpha 混合**（`--mstar-canvas-emphasis-*` token），绝不整卡 `opacity`——状态点与 running 辉光保持全不透明。**(2) 连线重构**——**严格四列布局**、无独立 unknown 列（`general` 桶下沉至 `qa-gate` 列底部 unknown 子分区）；`expected` 阶段骨架箭头与**带动画的 next 边**已**移除**（流转顺序由固定列序 + 列标签暗示、当前位置由 running 辉光 + 状态点承担），仅余两类语义线：证据驱动的 **`actual` 交接线**以 **bezier `C` 曲线**绘制，锚定卡片 **4 端口**（上/下/左/右四边中点；静止不可见、hover 显示），箭头尖端退让至端口外 **10px standoff**；**双向监督线**改锚**列外侧隙垂直锚点**（`x = 卡片右缘 + 18px`，垂直 bezier 流）；两条线**总则**——**H1** 箭头沿线在锚点处的局部切线、**H2** 线不叠任何文字。卡片为唯一圆角元素（辉光施加于圆角 `.card-body`，无方形外轮廓）。文档同步：dsh.md SSOT（含 leaf report 工具纪律——leaf 完成交付走 closing 消息、不调 `report` 工具，其默认 quiet 投递会在父代理 next-step 队列滞留）+ bundle 镜像 + README.md / README.zh.md / bundle/README.md。
- **dsh 插件（v4，用户第 4 轮反馈）**：「代理执行」画布落地第 4 轮设计修订（plan Task 8，design doc v4）：**(1) Phase 1/2 分组 + 当前 plan 标注**——4 列拆为**上下两个分组 band**（上：Phase 1 review-edit-chain 顺序完成链；下：Phase 2 sdd-implement → qc-tri → qa-gate 循环迭代 plans），各带组标签行；**Phase 2 组标签标注当前 plan**（投影 `activePlanId` = `state.plans[]` 中首个 InProgress plan_id；多个进行中 → `+N more` 诚实计数；无 → 灰字「无进行中 plan」）。**(2) 已完成实体独立绿框 + 绿 ✓（off 档排除）**——`settled && emphasis ≠ 'off'` 的实体获得独立全强度绿色框体（圆角卡片体 success 边框 + 1px ring）+ 状态点绿 ✓；off 档角色（已过阶段 / 无阶段 on-demand + general）显示灰字圆点、**绝不显示完成标记**（修复 v3 缺陷：off 低透明时绿✓泄漏）。**(3) 迭代信息 Section 两 tab 共用**——任务迭代页与代理执行页渲染**同一 `IterationInfoSection` 组件**、同一 `view.iteration` 数据（单实现、双挂载）。跨 band 交接线（Phase 1 ↔ Phase 2）改走侧隙垂直锚点，不穿组标签行（H2）。文档同步：DESIGN.md / DESIGN.dark.md v4（Phase 分组、完成态 token、plan 标注、共用 Section）+ dsh.md SSOT + README.md / README.zh.md / bundle/README.md。
- **dsh 插件**：面板 F5 迭代区补丁（plan `20260812-panel-f5-iteration-zone-fix`）——(1) 迭代 Steps 升级为**四态状态机**（`current` / `next` / `done` / `idle`）：current 之前的步骤投影为 `done`「已完成」（已完成的 Step 1 不再在 Step 2 current 时显示为待命 idle；`next` 仍为唯一前向目标，`idle` 仅为 schema 余项），配低调「已完成」样式——徽标成功色描边 + 淡化 chip 文案加前导 ✓（`data-step-state="done"`，投影推导、非 UI 猜测）；(2) 展开态分栏中的分支面板**宽度受约束**（`flex: 0 1 260px` + `max-width: 280px`——不再随容器撑宽；Steps 行吸收剩余宽度，<860px 竖排时重置为内容高度）。`current`/`next`/verdict 语义、Phase-1 无徽标规则与 Step-5 永不为当前的限制均保留（Step 5 仅当 Step 4（pr-delivery）为当前步时渲染 `next`——文档已校正对齐）。文档同步：dsh.md SSOT + bundle 镜像 + README.md / README.zh.md / bundle/README.md。
- **dsh 插件——面板快速修复（plan `20260813-panel-quick-fixes`）**：工作流面板三个 tab 落地 2026-08-13 快速修复。**(1) 任务迭代 tab**——kanban 现为 **5 列**（Todo / InProgress / InReview / Done / **`blocked-unknown`**——Blocked 与原有 unknown 兜底**合并为单列**「受阻/未知」/「Blocked / Unknown」）；每列渲染行数统一以 `PLAN_CAP` 封顶，并带可点击的 **「更多」/「收起」展开按钮**（`data-kanban-more` 锚点）展开全量——投影保留全部 plan 行（封顶只是渲染关注点，绝不丢弃）。**(2) 代理执行 tab**——画布只投影**当前迭代**的派发证据（steering compass `iterationId`，否则经 catalog `plans[].iterationRefs` 取最近迭代——按 8 位日期前缀 + doneAt）；可证明跨迭代的事件不产生实体/连线，roster 常驻 idle 卡，无 plan / 未知 plan / 独立 plan 的派发绝不隐藏；**`advisory` 不再终态**——软执法派发落到配对 settle（有 settle 显示绿 ✓ 已完成、无 settle 显示执行中），`denied` 仍终态，advisory verdict 仍在事件记录页呈现；连线收紧（**H1/H2**——同列纵向流的中线会穿过中间卡片时改走列**左侧隙带**（正向与反向）；反向水平 bezier 保持**方向感知**控制点位于端点**之间**——不穿卡不压字），**图例移至画布视口下方**。**(3) 事件记录 tab**——列表改为分区内部滚动：面板根节点接入宿主 `data-conversation-composer-overlay`（全高 opt-in）使 `.rowList` 的 `overflow-y: auto` 真正生效，宿主页面不再整页滚动，底部按宿主发布 `--dsh-composer-height` 预留悬浮 composer 间隙。
- 更新 `skills/mstar-host/references/dsh.md` + `packages/dsh/README.md` / `README.zh.md` / `bundle/README.md`（`harness-skills/` 镜像已 gitignore，由 `bun run bundle-assets` 重新生成，不手工提交）。
- **dsh 插件**：MStar 工作流面板 sidebar 重构（信息布局方向 #1）——header 行移除，版本 + harness 目录迁至**底部 fixed 小面板**（小字号 muted、不随 sidebar digest 滚动）；sidebar 收口并重排（计划 ≤5 时间倒序 + `+N more`、未决残留 findings ≤10 带 severity chip + 溢出提示、策略区 **enforcement 首位** + push / worktree / control worktree、租约、知识、方向）；branches 区块移出 sidebar 迁入迭代区（plan `20260810-panel-canvas-zones`）。catalog 证据：`HarnessPlanView.doneAt`（读 `done_at`）与 `MstarHarnessState.residualFindings`（open 生命周期过滤、severity 排序、上限 10）——模型可见文本保持紧凑。
- **dsh 插件**：sidebar/底栏主题审计固化——`panel.module.css` 全部 color-family 声明经 `--dsw-*` token 解析（零裸色任意形式，含 CSS Color 4 `color()`），间距走 `--mstar-space-*` ramp，动效 120–200ms 且 `prefers-reduced-motion` 关闭；暗色 = 宿主 `body[data-ds-dark-theme]` token 翻转（面板侧无主题覆盖）。已由浏览器 harness 实跑验证（light + dark 双主题计算样式探针覆盖 sidebar/底栏背景、文字、边框、状态色——46 PASS / 0 FAIL，证据见迭代 guide）。
- **dsh 插件**：MStar 工作流面板由单页 zone dashboard 重构为 **Tabs + Content** 布局——右侧 **sidebar 常驻**（所有 tab 共享：计划 / 残留 / 策略 / 租约 / 知识 / 方向 + 底部版本/harness meta dock）与固定 header nav 3 个 MenuTab（**任务迭代 / 代理执行 / 事件记录**，默认 = 任务迭代，D1）切换主 content。任务迭代 tab 全面重组织（spec F1.3）：**Content Head** 承载迭代信息（iterationId / gate verdict / 分支）并将 5 个迭代 **Steps 横排**（当前步高亮、进入当前步的连线段点亮——不做「已完成」勾选，诚实呈现 schema 的 current/next/idle 态）；**未启动（`active === false`）时整体收拢为一行摘要（可展开）**，启动后展开完整 Steps，且同一挂载实例在实时 catalog 更新把 `active` 从 false 翻转为 true 时会自动展开（用户已激活后手动收拢不被覆盖）。下方任务区为**全宽标准 Kanban**（6 列 Todo/InProgress/InReview/Done/Blocked/unknown，Done 溢出沿用 PLAN_CAP，content 区内独立滚动——不再被 canvas 高度压成小坨）；代理执行 / 事件记录两 tab 落 muted 占位页（真实页面由 `agent-canvas` / `event-log` plan 交付）。zone dashboard 布局随之收敛：`WorkflowCanvas` / `IterationZone` 删除，其 zone 级图例项与 footer/gate-summary 样式一并移除，bundle 负向 xyflow 断言保持。
- **dsh 插件**：Tabs+Content 面板已由浏览器 harness 在 **light + dark** 双主题下验证——对迭代 head / 横排 steps / 全宽 kanban / 常驻 sidebar / tab nav / muted 占位页做了双主题计算样式探针（token 翻转可观测、零裸色、`prefers-reduced-motion` 运行断言根规则关闭全部 transition）；布局不变量在浏览器内钉死：页面不整体滚动、content 区是唯一纵向滚动体、sidebar 跨 tab 切换常驻、kanban 列铺满 content 宽度（harness 发现真实布局问题——kanban 列 `min-width` 现按 border-box 计算，六列在桌面宽度下可铺满而非溢出到内部滚动条后面）；证据见 `{SDD_DIR}/review/harness/`（browser-checklist.md + browser-results.txt）。
- **同步上游 v2.1.1**：将上游 `mstar-harness` v2.1.1 线合入 dev-dsh 分支——新增 `code-reviewer` 角色（只读 L2 SDD 任务评审 / 审计执行席；取代 `generalPurpose` 作为 SDD 每任务评审席位，仅当宿主缺失该角色 agent 时回退 generic），在 engine、CLI `init` fence 与 bundled skills 中全面采用 canonical 的 harness 默认忽略 `.gitignore` 格式（`.mstar/**` + 追踪重包含 `AGENTS.md` / `knowledge/` / `specs/`），并将全部 11 个版本面对齐到 2.1.1。
- **engine**：`emitGitignoreSnippet` / `validateGitignore` / `HARNESS_PROCESS_GITIGNORE` 改为输出「默认忽略 + 重包含」格式，替代旧的逐目录平铺 ignore 清单；`ROLE_MAPPING` 扩至 14 个 id，新增 `code-reviewer`。
- **bundle-assets**：将 `packages/dsh/harness-skills` / `harness-commands` 从合并后的 `skills/` 树重同步——上游改动的 6+ 个 bundled skills 及全部 `mstar-host/references/*.md` 宿主适配（cursor/kimi/omp/opencode/zcode）均携带 v2.1.1 措辞（SDD 任务评审 → `code-reviewer`）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、`@mstar-harness/dsh`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.2.0**。

## [2.1.1] - 2026-08-12

### Harness

- canonical `.gitignore` 片段改为默认忽略整个 harness 目录（`<dir>/**`），仅白名单跟踪结果（AGENTS.md、knowledge/、specs/）—— 新增进程子目录自动被忽略。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.1.1**。

## [2.1.0] - 2026-08-12

### Harness

- 新增 **`code-reviewer` 角色（L2）**：只读席位，承担 SDD per-task 审查与 `Task category: audit` / `mstar-audit` 执行。PM 入口仍为 `/codebase-audit`；大型仓库经 Assignment `Delegation: allowed (scout/explore only, read-only)` 扇出只读 `scout` / `explore`。
- 将 `code-reviewer` 接入 SDD per-task 派发（具名 L2 reviewer id，`generic` 回退）、audit 路由（`mstar-harness-core`、`commands/codebase-audit.md`）、engine `ROLE_MAPPING`（13→14）与双语 README 角色表；`qc-specialist*`（L3）/ QA（L4）语义不变。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.1.0**。

## [2.0.6] - 2026-08-10

### Harness

- `mstar-host` 新增**宿主无关的全流程 goal 规则**：凡暴露 `/goal` 指令的宿主（Codex Goal Mode、omp 及未来 code agent），无论推进 iteration 还是非 iteration，都必须将「完整走完全流程」设置为 goal（iteration：start → per-plan cycles → close → PR delivery → merge-ready loop；per-plan：specify → clarify → plan → tasks → implement → plan QC tri + QA gate → Done），不得只设子阶段 goal。
- 移除 Codex 专属 `references/codex-plan-goal-mode-bridge.md`：goal 文本规则改为宿主无关，统一收在 `mstar-host` SKILL.md；Codex Plan Mode 直接读 `references/_shared/plan-mode-bridge-core.md`。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.0.6**。

## [2.0.5] - 2026-08-10

### Harness

- `/iteration-start`：新增可选 `direction` 提示（约束 §2 候选、种子 §3 grill-me —— start 仍为交互式）与 `pause` 标志；Phase 1 锁定 + integration branch 后默认自动推进 Phase 2→5（execute → close → PR → merge-ready）。`/iteration-drive` 仍作为独立 re-entry/resume 命令保留。同步更新 `iteration-loop` 对比表、README/README_CN 命令表与流程图、OpenCode 包 quick start；新增 routing eval `iteration-start-auto-continue-phase2`。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.0.5**。

## [2.0.4] - 2026-08-09

### Harness

- omp 插件：engine 版本兼容 —— 阻断 hook 与 `mstar_dispatch_validate` 不再静态导入 `composeDispatchGate`；在早于该导出的 engine 上，任务派发 gate（Gate 2）跳过并打印一次性警告（状态 gate 保持生效），派发工具返回显式升级错误而非静默消失（与 `mstar_iteration_gate` 对齐）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.0.4**。

## [2.0.3] - 2026-08-09

### Harness

- omp 插件：进程内 engine 绑定 —— 模型可调用的 mstar_* 校验工具 + 阻断型 tool_call gate hook（仅 Enforcement: hard 生效；命令层 shell-out 保留为 fallback）。
- engine：`iteration.parseCompassFrontmatter` 从 CLI 移入 engine（单一共享解析器；CLI 改从 engine 重新导入）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.0.3**。

## [2.0.2] - 2026-08-08

### Fixed

- OpenCode 插件入口改为 default export `{ server: MorningStarHarnessPlugin }`，避免辅助函数被当成 plugin 注册（修复启动时 `plugin config hook failed: N.config` / `N.dispose`）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.0.2**。

## [2.0.1] - 2026-08-08

### Fixed

- OpenCode 插件钩子不再因非 string 的 `task`/`write` 参数刷 abort 日志：Assignment 与 `status.json` 校验在 `.match` / `path.resolve` 前拒绝非 string 输入，且 `tool.execute.before` 对 `prompt`/`filePath` 只读取一次（避免 getter/Proxy 类型翻转）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.0.1**。

## [2.0.0] - 2026-08-08

### Harness

- **移除 Bash SDD/rollup 脚本（引擎 CLI 成为文档化路径）**：删除 `skills/mstar-sdd/scripts/{sdd-workspace,task-brief,review-package}` 与 `skills/mstar-plan-artifacts/scripts/tech-debt-rollup.sh`。技能正文改为文档化 `mstar sdd workspace|task-brief|review-package` 与引擎 `techDebtRollup` import（schema 门禁仍为 `mstar status validate`）；奇偶校验测试改为对照由已证明 byte-parity 的移植产物（slice 2）捕获的 golden fixtures。
- 新增 **`@mstar-harness/engine`** 包脚手架：版本对齐的工作区库（仅 `zod` + `ajv` + `node:*`，无 `bin`），提供类型化 `ValidationResult` 与 `readHarnessVersion()` 占位 core，并纳入发布面清单（10 → 11）、changelog 组装与根 workspaces。
- **Engine 加固（slice 1 QC 修复波）**：lease 位置/孤儿/双写校验（`lease.verify.*`）移入 `@mstar-harness/engine`（CLI `mstar lease verify` 改为薄包装）；`archiveResiduals` 增加 plan-id 路径穿越防护、状态写锁与追加去重；`withStatusWriteLock` 增加所有权防护（绝不删除其他 writer 的 lockdir）、`holder.pid` 崩溃诊断文件与快速失败的重入检测；`readHarnessVersion` 优先读取模块自身 manifest（发布安装不再回退为 `0.0.0`）；`tech-debt-rollup` 奇偶校验精确镜像 jq `//`（`false`/`0` 边界用例对照 bash oracle）；新增残项关闭完整性（`closed_at` + `closure_note`）与 plan 行 `Done` ⇒ 无 lease 不变量。发布脚本在根 changelog 头部确保 `@mstar-harness/engine` 注册表行与包历史链接。
- **Harness Workflow Engine 定位（iteration v2.0.0）**：统一 7 个插件 manifest 与 4 个包 manifest 的引擎优先描述；根 plugin.json 新增 `workflow-engine` / `workflow-enforcement` / `deterministic-workflow` / `harness-workflow` 关键词；README.md / README_CN.md 围绕「确定性工作流门禁由 TS 引擎强制执行（而非仅靠 prompt）、判断留在 `mstar-*` skills」重新表述，并新增交付内容表（Harness Workflow Engine / mstar CLI / `mstar-*` skills / 宿主适配）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、`@mstar-harness/engine`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 2.0.0**。

## [1.8.9] - 2026-08-07

### Harness

- 在仓库根新增便携式 **Agent Plugins v1.0.0** manifest（`plugin.json`），与 CLI 发布面保持一致（`skills/` 为 Agent Skills 组件），并新增 `mstar-harness plugin validate` 按 Agent Plugins v1.0.0 规范校验插件包（含 `mcp.json` / `skills/`）。
- **Phase 5 checkout**：merge-ready 产品修复直接在 control / `spec_integration_branch` checkout 上改；**禁止**另开 Phase 5 feature/fix worktree，也**禁止**套用 Phase 2「control 禁止产品编辑」。SSOT 在 `mstar-iteration`（`phase-4-5-pr-delivery` §5.0）；**不**写入通用 `mstar-branch-worktree` skill。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单及便携式 Agent Plugins 清单：**→ 1.8.9**。

## [1.8.8] - 2026-08-06

### Harness

- **`mstar-skill-authoring`**：将 skill-writer 六原则并入运行时撰写技能——专家流程优先、紧凑 5 问 body、1–3 skill 路由、按 model+harness 实测、只补模型缺口、每次改动做 paired 实验。Body 保留可执行门控；完整 writer 流程 / 输出模板 / 反模式 → `references/skillsbench-authoring.md`（渐进披露）。
- 收紧 `description` 触发契约（含排除条件）；保留 purpose test / frontmatter / 渐进披露 / review 模板作为可复用 SSOT。
- 重写为**通用** skill 撰写规范（任意领域/仓库）：去掉 body 中 Morning Star / 仅 `mstar-*` 品牌化表述；本仓工作仅保留最短 harness 挂钩（Load Order + `mstar-host` 路径解析）。
- 恢复 `## Skill-relative script and asset paths` 小节标题，使 `mstar-host` 的 § 交叉引用继续有效（Post-Skill-Change stale-ref 清单）。
- 收敛 `AGENTS.md` changelog 规则：§1 为唯一权威（含开发期禁止手改 assembled `CHANGELOG*`）；Quality Gate #6 保留为可执行检查；删除其余 copy-paste 重复。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单：**→ 1.8.8**。

## [1.8.7] - 2026-08-06

### Harness

- 将 SDD 派发模板改为**宿主中立**，不再固定引发单一宿主工具 schema：`implementer-prompt.md`、`task-reviewer-prompt.md`、`implementer-continuation-prompt.md` 改用 `Dispatch:` / `Role:` / `Name:` / `Prompt body:` 标签 + 内联宿主字段映射（`omp agent / Cursor subagent_type / OpenCode subagent → mstar-host C5`），替代 Cursor 专有字段（`subagent_type`、`description`、`prompt`）。L2 任务 reviewer 模板现直接给出 omp `agent` 取值（`reviewer` 或 `task` + C5b），消除 SDD 下导致 generic worker 回退的映射困惑。
- 精简 `mstar-host/references/omp.md` 与 `parallel-dispatch.md` 中**envelope-first** 的重复论述为单行机械规则 + SSOT 指针（长段散文本身会加剧注意力挤占），并在 omp SDD 段补充 L2 reviewer `agent` 映射。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp/Claude 插件清单：**→ 1.8.7**。

## [1.8.6] - 2026-08-06

### Harness（派发保真 — invoke 字段完整性门禁）

- 在派发自检处新增**逐项字段完整性门禁**：每条 Task/subagent invoke 必须携带与 `Execute as` 匹配的角色绑定字段（omp `agent` / Cursor `subagent_type` / OpenCode `subagent` / Kimi·ZCode `subagent_type`）。漏写字段（如 omp 漏 `agent` ⇒ 静默回退 generic `task`）现为**派发未完成**——与 paste-only（零 invoke）同级——避免裸 `tasks:[{task:"…"}]` 仅因 invoke 计数 = N 而蒙混过关。N=1 顺序 Review-&-Edit 链显式覆盖（count 门在该处恒过）。
- `mstar-dispatch-gates`：发送前自检 + 反模式条目；`mstar-host/references/parallel-dispatch.md`：硬规则 + 自检步骤；`mstar-host/references/omp.md`：Review-&-Edit 示例为每轮（architect / writing-specialist）展示完整 `task(...)` 块并显式 `agent`，并加 N=1 gotcha。
- `.cursor/skills/mstar-routing-eval`：新增回归信号「invoke 角色字段缺失 ⇒ 静默 generic 回退」。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.6**。

## [1.8.5] - 2026-08-06

### Harness（技能路径发现 — 运行时表面）

- 关闭仍留在**已发布运行时表面**上的 cwd 型 `skills/mstar-*` 陷阱：Cursor `rules/mstar-entry.mdc`、`rules/mstar-cursor-plan-mode.mdc`，以及 omp CLI 安装后提示 `packages/cli/src/adapters/omp.ts`（改为 `mstar-host → references/omp.md` / `skill://…`）。
- **`mstar-host`**：新增 § Resolve loaded skill root（按宿主 prefer + 文件系统回退：omp `skill://`、Cursor 插件 checkout、OpenCode `harness-skills/`、Codex/Kimi/ZCode 插件挂载）。各宿主 reference 指向该表；`mstar-skill-authoring` 同步 rules/CLI note 反模式。
- INSTALL / `docs/cli.md` 的 Host adapter 条目改为同一套技能相对写法（不再用 consumer cwd 的 `skills/mstar-host/references/…`）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.5**。

## [1.8.4] - 2026-08-06

### Harness（技能脚本路径发现）

- **技能相对脚本命名**：运行时文档改为 skill **`mstar-sdd`** → `scripts/<name>`（或 `<mstar-sdd>/scripts/…`），不再写成 consumer cwd 路径 `skills/mstar-sdd/scripts/…`。Agent 会按字面路径在应用仓库下搜索，从而找不到已加载 skill / 插件安装位置。
- 更新 `mstar-sdd`（SKILL + `file-handoffs`）、`mstar-plan-artifacts`（`tech-debt-rollup`）、`mstar-plan-conventions`、`mstar-iteration`、PM Assignment `SDD dir` cue，以及 `mstar-skill-authoring`（新增「Skill-relative script and asset paths」约定）。
- 维护者 `.cursor/LOCAL-VALIDATION.md` 仅在本 harness 仓根保留 `skills/…` smoke 命令，并加明确说明。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.4**。

## [1.8.3] - 2026-08-05

### Harness（omp 角色 agent 派发）

- **修正 omp C5**：插件 install/link 后，由 `agents/*.md` 发现的角色 id（`product-manager`、`architect`、`fullstack-dev`、`qc-specialist*` 等）是合法的 live `task.agent`。优先 **`agent: "<Execute as role-id>"`**；仅当 live schema 未列出该角色时才回退 `task` / `scout` / …。schema 已有对应角色却仍写 `agent: "task"` 为反模式。
- **保留 C5b**：即使 `agent` 已等于角色 id，Assignment 仍需 **Act as + skill load**（agent shell ≠ 完整 Morning Star 角色提示）。
- 更新 `skills/mstar-host/references/omp.md`（C5 + C5b 自包含）；`_shared/host-role-binding-core.md` 为 **仅 Kimi/ZCode**（文件内不再出现 omp 行/说明——其他宿主走各自 references）；并更新 `parallel-dispatch.md`、`mstar-host` skill description；同步 INSTALL / `docs/cli.md`。删除 README「宿主说明 / Host notes」旁注，Use 区只保留入口。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.3**。

## [1.8.2] - 2026-08-05

### 文档（README + 宿主识别）

- **README**（`README.md` + `README_CN.md`）：所有宿主表格按推荐宿主顺序重排（`omp > OpenCode > Cursor > Kimi = ZCode > Codex`）；**使用**一节重组为 通用（不跑迭代） → 迭代 → 代码库审计。
- **`mstar-host`**：重写宿主识别表，**仅用会话工具形态 / 可见命令**——`*-plugin/plugin.json` 文件无法识别宿主（在本源仓与任何多宿主安装里它们都同时存在）。合并重复的 Cursor 两行为一行，以 `subagent_type` 为关键信号。
- **宿主参考**：移除 `codex.md` / `kimi.md` / `zcode.md` / `omp.md` 各自 `Load when` 触发行里的插件标记子句，只保留工具形态 / 可见命令信号。路径参考上下文行与 plan-mode bridge 的 `plugin is installed` 前提留作文档（非识别触发）。
- **omp**：在 `references/omp.md` 记录原生 internal URL 方案（`skill://`、`local://`、`agent://`、`artifact://`、`history://`）。

### CLI

- `zcode` adapter 不再硬编码 `PLUGIN_VERSION` 常量（此前已漂移到 `1.6.0`）。marketplace 条目生成与 `doctor` 的 ZCode 版本校验改为通过 `utils.ts` 新增的共享 `readHarnessVersion()` 从 `packages/cli/package.json` 派生（`index.ts` 的 `--version` 也改用同一 helper）。修正 `INSTALL.md` 与 ZCode adapter 中陈旧的 `1.5.6` / `1.6.0` 版本字符串。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.2**。

## [1.8.1] - 2026-08-05

### Harness（skills + commands 优化）

- **无损优化** `skills/` 与 `commands/`，按 SkillsBench 原则（紧凑 body、progressive disclosure、dedup 到 SSOT）。无任何规则、门禁、字段名或 NEVER 条目被改动或删除——规则只移动或压缩，绝不消失。
- **提取到 `references/`**：`mstar-iteration` Phase 3 → `phase-3-iteration-close.md`、Phase 4/5 → `phase-4-5-pr-delivery.md`（body 574 → 384 行）；`mstar-compound` Q1–Q8 + Phase 1–7 → `compound-workflow.md`（275 → 103）。
- **压缩**：`mstar-coding-behavior` 216 → 142（保留 The Ladder、`simplify:` 标记、minimal-check）；`qc-specialist/deep-review-lenses.md` 11 个透镜清单 → 每透镜一行（155 → 94）。
- **去重**：反模式清单 → `mstar-harness-core` 索引；新增 `_shared/leaf-executor-core.md`（9 个 leaf 角色的 Completion Report + Git NEVER 去重）；新增 `_shared/host-role-binding-core.md` + `_shared/plan-mode-bridge-core.md`（kimi/zcode/omp 宿主文件 + 5 个 plan-mode bridge 去重）。
- **命令 → 薄编排器**：4 个命令 943 → 388 行（−59%）；新增 `mstar-iteration/references/phase5-helper-discovery.md`。
- **描述**：收紧 `coding-behavior`、`branch-worktree`、`phase-gates` 的 frontmatter 为触发契约。
- **文档**：`README.md` + `README_CN.md` 增加推荐宿主顺序（`omp ≥ OpenCode ≥ Cursor > Kimi = ZCode > Codex`）。
- **命名**：`Completion Report v2` → `Completion Report`（模板已统一，去掉版本后缀）。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.1**。
## [1.8.0] - 2026-08-05

### Harness（代码库审计 skill）

- **新增 `mstar-audit` skill**：只读顾问式工作流，改编自 [improve](https://github.com/shadcn/improve) skill（MIT，© shadcn）。跨 9 个类别审查代码库（正确性/安全/性能/测试/技术债/依赖/DX/文档/方向），vet findings，按 leverage 排序，向 `{PLAN_DIR}/audit-<date>/` 写入自包含的改进计划。**不**引入 improve 的 `execute`/`reconcile`/`--issues` 变体——mstar 的 SDD、`status.json` 与 residual 追踪已替代它们。
- **新增 `plan-quality-bar` 参考**（`mstar-plan-artifacts/references/plan-quality-bar.md`）：计划自包含标准——验证门、STOP 条件、drift check、机器可检查的 done criteria。适用于 SDD task-brief、Prepare plan 与 audit plan。
- **新增 `/codebase-audit` 命令**（`commands/codebase-audit.md`）：独立入口。以 `codebase-` 前缀命名避免宿主命令冲突（沿用 `iteration-*` 约定）。接线：`mstar-harness-core` Task category `audit` + skill 索引；`mstar-phase-gates` Plan 质量门；`mstar-sdd` 引用；`mstar-roles` architect 加载项；`pm` skill 入口；`iteration-start` §1 Research 可选来源。
- **致谢**：improve（MIT，© shadcn），在 `mstar-audit/SKILL.md` 与 `plan-quality-bar.md` 中标注。

### CLI（`@mstar-harness/cli`）

- **Codex adapter**：`CODEX_PROJECT_COMMAND_NAMES`（从 `CODEX_ITERATION_SKILL_NAMES` 重命名）现包含 `codebase-audit`；project-scoped 安装将其物化为 `.agents/skills/codebase-audit/SKILL.md`。
- **omp adapter**：smoke 测试与安装说明包含 `codebase-audit`。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.0**。

## [1.7.1] - 2026-08-05

### CLI（`@mstar-harness/cli`）

- **omp doctor**：解析 omp 17.x 的 `omp plugin list --json` 形状 `{ npm, marketplace }`（不再只认数组/`plugins`），并匹配 `manifest.name`。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.7.1**。

## [1.7.0] - 2026-08-05

### Harness（omp 宿主面）

- **omp 作为第六宿主面**：标记 `.omp-plugin/plugin.json` + `.claude-plugin/plugin.json`（插件根 = 仓库根；挂载 `./skills/`、`./commands/`、`./agents/`）。新增 `skills/mstar-host/references/omp.md`，覆盖 `task`/`ask`/`hub`、文件名 slash 命令（`/iteration-*`）、以及 C5/C5b 内置 `task.agent` + prompt 角色绑定。`omp-plan-mode-bridge.md` 用于 `/plan` 双写。`mstar-host` detect 表、`pm` 入口、`parallel-dispatch` 已同步。
- 安装：`omp plugin install github:btspoony/mstar-harness` 或对本地 harness checkout 执行 `omp plugin link`；`omp plugin list` 中的包名为根 `morning-star`。

### CLI（`@mstar-harness/cli`）

- **`omp` 安装目标**：`npx @mstar-harness/cli init --target omp` 确保 `~/.mstar/harness` 并执行 `omp plugin link`（失败则回退 `omp plugin install github:btspoony/mstar-harness`）。`doctor --target omp` 校验标记、skills/commands 冒烟与 `omp plugin list`。`shared-install` 的 `HARNESS_MARKERS` 接受 `.omp-plugin/plugin.json`。

### 版本对齐

- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.7.0**。

## [1.6.1] - 2026-08-04

### Harness（QC = 代码审查席，非测试执行席）

- **L3 Plan QC 明确为 diff/逻辑审查**：`mstar-review-qc` 边界 + `qc-specialist*` workflow/shared NEVER——共享 `Review cwd` 上的并行三审 **不得**跑 test/build/install/lint/typecheck（工具链争用导致 peer QC `Blocked`）。覆盖率从 **diff** 判断，不靠重跑 suite。
- **运行时证据归 L1 / L4**：QA `acceptance-only` 复用 implementer/CI/既有 QA 日志；QC 报告是 findings，不是测试日志。PM Assignment 反模式与 `qa-trigger-matrix` 同步。
- **OpenCode `qc-specialist*` agents**：bash 白名单收束为 git + 轻量只读分析（移除 eslint/tsc/ruff/clippy 等）。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi/ZCode 插件：**→ 1.6.1**。

## [1.6.0] - 2026-08-03

### Harness（ZCode 宿主面）

- **ZCode 作为第五宿主面**：插件根 = 仓库根，经 `.zcode-plugin/plugin.json` 挂载（`./skills/`、`./commands/`、`./agents/`）；无 `sessionStart`（ZCode 不支持——PM 入口手动 `/morning-star-harness:pm`）。新增 `skills/mstar-host/references/zcode.md`，tool map 按真实 ZCode 会话工具编写（`Agent` / `AskUserQuestion` / `EnterPlanMode`·`ExitPlanMode` / `TodoWrite` / `Bash` / `Read` / `Edit` / `Write` / `WebSearch` / `WebFetch` / `TaskOutput`·`TaskStop`），复用 Kimi **C5b role-in-prompt binding**（ZCode 仅内置 `subagent_type` profile）。`zcode-plan-mode-bridge.md` 处理 Enter/Exit 双写。
- **`mstar-host` SKILL.md**：description、detect-host 表、兜底行加入 ZCode。

### CLI（`@mstar-harness/cli`）

- **`zcode` 安装 target**：`npx @mstar-harness/cli init --target zcode` 注册 `mstar-local` marketplace 到 `~/.zcode/cli/plugins/known_marketplaces.json` + `marketplaces/mstar-local/marketplace.json`，两者均指向 **`github:btspoony/mstar-harness`** 仓库 source（与 ZCode 内建 marketplace source 形状一致）。Project scope 另在 `.zcode/plugin-checkout` 保留本地 checkout 做 agent 文件 smoke 校验。`doctor --target zcode` 校验两个 JSON + checkout + gitignore。`shared-install` 的 `HARNESS_MARKERS` 新增接受 `.zcode-plugin/plugin.json`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi/ZCode 插件：**→ 1.6.0**。

## [1.5.6] - 2026-07-28

### Harness（residuals）

- **`Findings cleanup: zero-residual | allow-residual`**：计划级「不残留」模式——可修 findings 尽量在当轮 fix→re-review 清干净。正式 **iteration Phase 2** 默认 **`zero-residual`**（仅真 blocker-defer + Durable Roadmap 可留 open R#）。独立 `/pm`、hotfix、`inline` 仍默认 **`allow-residual`**。
- Assignment 字段 + 可选 `plans[].metadata.findings_cleanup`；SSOT 在 `mstar-plan-artifacts`；贯通 `mstar-review-qc`、PM NEVER / Assignment、iteration close、QA 矩阵说明与 routing-eval。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.6**。

## [1.5.5] - 2026-07-27

### Harness（worktree / L1）

- **默认 gitignore 下的 control-path harness**：进程产物（`plans/`、`iterations/`、`status.json`、`sdd/` 等）仍本地；经 **control worktree** 绝对路径读写。Feature worktree 只改产品代码——**禁止**因 feature 缺 plans 而 waive worktree；**禁止**把「无 flock」当成 worktree 豁免（仅 `Plan parallelism: serial`）。
- Assignment：绝对 **`Control harness root`**、control 系 **`Plan Path`** / **`SDD dir`**、feature **`Worktree path`**。
- **`sdd-workspace`**：支持 `MSTAR_CONTROL_ROOT` / control-root 参数；linked worktree 无 `status.json` 时 fail closed。
- routing-eval：无 flock 串行保留 worktree、gitignore control-path 场景。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.5**。

## [1.5.4] - 2026-07-27

### Harness（Cursor 宿主）

- **`mstar-host` Cursor Task invoke schema**：文档化扁平并列字段（`prompt` + `subagent_type` + `description`）、范例、反模式（嵌套/字符串化 JSON、OpenCode `subagent`、MCP 包装、漏传 `subagent_type`）与发送前自检，降低 Task 首次参数格式失败。`parallel-dispatch.md` 增加指针。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.4**。

## [1.5.3] - 2026-07-25

### Harness（commands / frontmatter）

- **Frontmatter YAML**：对含 `: ` 的 `description` 加引号，避免 Cursor/插件发现不到 command/skill（`iteration-loop`、`mstar-branch-worktree`、`mstar-phase-gates`、`mstar-plan-artifacts`、`mstar-review-qc`、`mstar-sdd`）。
- **`/iteration-loop` scale**：新增 **`XL`** = **>4** 个业务 plan（`S`/`M`/`L`/`XL`；默认仍为 `M`）。SSOT：`mstar-iteration` §1.2 + `references/autonomous-direction-lock.md`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.3**。

## [1.5.2] - 2026-07-23

### Harness（git 策略 + SPECS_DIR）

- **进程 vs 结果 Git 策略**：`{HARNESS_DIR}` 下默认 tracked — `AGENTS.md`、`knowledge/`、`specs/`；默认 gitignored — `plans/`、`iterations/`、`status.json`、`sdd/`、`archived/`、`notes.json`。跨 clone handoff = tracked 结果 + 根目录 `CONCEPTS.md` / `STRATEGY.md`；residual 经 compound 提升，**勿**默认 `git add` `status.json` / `plans/`。
- **`{SPECS_DIR}` 解析顺序**：`{HARNESS_DIR}/specs/` → `docs/specs/` → 仓库根 `specs/`（空目录跳过；greenfield 创建 `{HARNESS_DIR}/specs/`）。Legacy 只读：非空 `designs/` 路径。
- 已对齐：`mstar-plan-conventions`、`mstar-plan-artifacts`、`mstar-sdd` file-handoffs、宿主 Plan 模式桥接、双语 README、`.cursor/LOCAL-VALIDATION.md`。
- **CLI**：`init`/`doctor` 追加/检查完整 process gitignore 集（见 `packages/cli/CHANGELOG.md`）。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.2**。

## [1.5.1] - 2026-07-22

### Harness（Phase 5 push cadence）

- **Phase 5 push cadence（HARD）**：发现 CI/review 问题可**本地提前修**，但 **`git push` 必须等**当前 head 上一波 CI **与** review 全部跑完。CI 结束后若出现新 reviews，可继续本地修；**禁止在 CI 仍在跑时 push**（会打断 AI reviews，浪费 token 且无完整结果）。SSOT：`mstar-iteration` §5.1a；已对齐 `iteration-drive` / `iteration-loop` 与 core 反模式。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.1**。

## [1.5.0] - 2026-07-22

### Harness（迭代 Phase 2 worktree + lease）

- **Phase 2 control worktree**（`spec_integration_branch`）+ 每 plan **feature worktree**，配合 `execution_lease` / `integration_merge_lease`（同机独占写锁；合入 integration 串行；`Done` 仅在 merge 成功后）。
- 多会话跨 plan 并行 implement（lease 门控）；`Worktree mode: waived` **不**豁免跨 plan 并行安全闸；`Plan parallelism: serial` 仅调度串行。
- routing-eval 与双语 README Phase 2 默认说明已更新。

### Harness（Phase 5 helpers）

- **Phase 5 merge-ready helpers**：优先 `babysit` 或任意 `*-babysit`；`greploop` **仅当**仓库具备 Greptile/`greploop` 时可选。两者都适用时先 babysit/`*-babysit`，再可选 greploop。已更新 `mstar-iteration` §5 指针与 `commands/iteration-drive` / `iteration-loop`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.0**。

## [1.4.0] - 2026-07-17

### Harness（Kimi Code 宿主）

- **Kimi 宿主支持**：`.kimi-plugin/plugin.json`（与 Cursor/Codex 同构的 host 目录布局；`sessionStart.skill: pm`）；`mstar-host` Kimi 参考 / Plan 模式桥；角色绑定写在 Agent prompt（内置子 agent 仅 `coder` / `explore` / `plan`）。
- **安装**：主路径为 Kimi TUI `/plugins install https://github.com/btspoony/mstar-harness` 后 `/plugins reload`（无 CLI `--target kimi`）。
- 插件命令：`/morning-star-harness:iteration-start` · `iteration-drive` · `iteration-loop`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.4.0**。

## [1.3.2] - 2026-07-15

### Harness（Cursor Plan Phase 1 反馈驱动）

- **`/iteration-start` Cursor Plan 路径**：feedback-driven — 用户只提方向/意见；Agent 探索、推荐并改 plan。`grill-me` 仅在反馈结束后、仍有阻塞缺口时发起。
- **Single CreatePlan URI（HARD）**：Phase 1 Plan 会话只 CreatePlan 一次；后续原地改同一文件；误开第二份则合并并删除。
- **`mstar-host` / rule / `mstar-iteration` §1.2**：Phase 1 Plan UX 写明反馈驱动与推荐 branch policy（禁止静默 `main`/`master`）。
- **Routing eval v20**：`iteration-phase1-cursor-plan-feedback-driven`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.3.2**。

## [1.3.1] - 2026-07-13

### Harness（迭代 package 目录化）

- **`iterations/<id>/` 目录优先**：compass 迁至 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`，同目录含 `guides/`、`specs/`、可选 package `README.md`。根 `{ITERATION_DIR}/README.md` **一行 = 一次迭代**（不再 compass + workspace 双行）。
- **Legacy 只读兼容**：根目录 flat `{ITERATION_DIR}/<id>-delivery-compass.md` 仍可读；新写必须走 package 路径。
- 涉及：`mstar-iteration`（及 references）、`mstar-compound` package 提升、`mstar-plan-conventions` / `mstar-plan-artifacts` 路径文档、角色壳、`/iteration-start` · `/iteration-drive` · `/iteration-loop`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.3.1**。

## [1.3.0] - 2026-07-11

### Harness（bootstrap 吸收）

- **退役 `/mstar-bootstrap` 命令**：7 阶段项目知识 bootstrap 流程迁入 `mstar-compound-refresh/references/project-knowledge-bootstrap.md`；`mstar-compound-refresh` 与 `mstar-harness-core` 保留简短指针。

### CLI（Codex iteration skills）

- **项目级 Codex 安装**：将 `iteration-start`、`iteration-drive`、`iteration-loop` 物化为 `.agents/skills/*/SKILL.md` 符号链接（源自 harness commands）；`doctor` 校验链接；全局安装跳过并给出明确警告。

### 文档

- **根目录 `INSTALL.md`**：从 README 抽离的可机读安装步骤。
- **精简双语 README**：CLI 优先 Quick Start；厘清 `/iteration-start` → `/iteration-drive` 与 `/iteration-loop` 使用路径。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.3.0**。

## [1.2.1] - 2026-07-10

### Harness（Cursor Plan 模式 × Phase 1 分阶段方向锁）

- **`/iteration-start` Cursor Plan 路径**：Boot 后先 CreatePlan 空白 Phase 1 脚手架，再动态分阶段 `grill-me` 并每段更新 plan；Review & Edit / lock / integration 分支仅在 **Build** 后执行。Agent / OpenCode 仍为 Research → Explore → grill-me → Write → Review。
- **`mstar-host` Cursor bridge / rule**：补充 `mstar-iteration` Phase 1 in Plan mode（skills 不反向引用 command 名）。
- **`mstar-iteration` §1.2**：宿主 Plan UX 可先 scaffold 再分阶段收敛；非 Plan 宿主不变。
- **Routing eval v19**：`iteration-phase1-cursor-plan-staged-grill`。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.2.1**。

## [1.2.0] - 2026-07-10

### Harness（`/iteration-loop` + autonomous direction lock）

- **`/iteration-loop`**：新 PM 命令，自动化完整 Phase 1→5（适合 cloud agent）。可选参数 `direction` + `scale`（`S`\|`M`\|`L`，默认 `M`）；代码优先自动锁方向（不跑 grill-me）；保留顺序 Review & Edit 链；Continuous execution 直至 Phase 5 merge-ready。与 `/iteration-start`（仅 Phase 1 + grill-me）、`/iteration-drive`（仅 Phase 2→5）区分。
- **`mstar-iteration` §1.2**：direction lock 模式 `interactive` | `autonomous`；scale budget **只计业务 plan**（不计 harness 流程）；autonomous branch resolve。细则 → `references/autonomous-direction-lock.md`（skill 为能力提供者，不反向引用 command 名）。
- **文档**：README / README_CN / OpenCode 包 README 命令表区分 start / drive / loop。
- **Routing eval v18**：`iteration-loop-autonomous-direction-lock` — 禁止例行方向确认、禁止 grill-me、禁止静默默认 `main`、禁止把流程 plan 计入 scale。

### CLI / CI / 发布

- **OpenCode `init` 快路径**：不再交互选模型，也不再调用 `opencode models`（该命令可能无输出卡住）。默认只写 `$schema` + `@mstar-harness/opencode@latest`，角色模型用 OpenCode 默认；可选 `--*-model` 仍作高级覆盖。
- **CI**：对 `packages/cli`、`packages/opencode` 及 bundled `skills`/`agents`/`commands` 做 path 过滤构建；含 CLI smoke + pack。
- **Release**：改用 Node 24 自带 npm 做 Trusted Publishing；去掉 Node 22 上损坏的 `npm install -g npm@latest`（修复 `MODULE_NOT_FOUND: sigstore`）；发布前先 build。

### 版本对齐

- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.2.0**。

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
