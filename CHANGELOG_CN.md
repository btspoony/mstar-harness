# 更新日志

本仓库 harness 各发布面版本一致，详见 [CHANGELOG.md](CHANGELOG.md)。

各包独立日志：[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)、[packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md)、[packages/engine/CHANGELOG.md](packages/engine/CHANGELOG.md)。

## [Unreleased]

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
