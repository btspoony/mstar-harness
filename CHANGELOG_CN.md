[CHANGELOG_CN.md#C297]
1:# 更新日志
2:
3:本仓库 harness 发布面版本以 [CHANGELOG.md](CHANGELOG.md) 为准：**1.8.3**。
4:
5:| 发布面 | 位置 | 版本 |
6:| --- | --- | --- |
7:| monorepo 根 | `morning-star`（`package.json`） | **1.8.3** |
8:| CLI | `@mstar-harness/cli`（`packages/cli`） | **1.8.3** |
9:| OpenCode 插件 | `@mstar-harness/opencode`（`packages/opencode`） | **1.8.3** |
10:| Cursor 插件 | `.cursor-plugin/plugin.json` | **1.8.3** |
11:| Codex 插件 | `.codex-plugin/plugin.json` | **1.8.3** |
12:| Kimi 插件 | `.kimi-plugin/plugin.json` | **1.8.3** |
13:| ZCode 插件 | `.zcode-plugin/plugin.json` | **1.8.3** |
14:| omp 插件 | `.omp-plugin/plugin.json` / `.claude-plugin/plugin.json` | **1.8.3** |
15:
16:各包独立日志：[packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)、[packages/opencode/CHANGELOG.md](packages/opencode/CHANGELOG.md)。
17:
18:## [Unreleased]
19:
20:## [1.8.3] - 2026-08-05
21:
22:### Harness（omp 角色 agent 派发）
23:
24:- **修正 omp C5**：插件 install/link 后，由 `agents/*.md` 发现的角色 id（`product-manager`、`architect`、`fullstack-dev`、`qc-specialist*` 等）是合法的 live `task.agent`。优先 **`agent: "<Execute as role-id>"`**；仅当 live schema 未列出该角色时才回退 `task` / `scout` / …。schema 已有对应角色却仍写 `agent: "task"` 为反模式。
25:- **保留 C5b**：即使 `agent` 已等于角色 id，Assignment 仍需 **Act as + skill load**（agent shell ≠ 完整 Morning Star 角色提示）。
26:- 更新 `skills/mstar-host/references/omp.md`（C5 + C5b 自包含）；把 `_shared/host-role-binding-core.md` 收窄为 **仅 Kimi/ZCode**（omp 不再与 built-in-only 宿主并列）；并更新 `parallel-dispatch.md`、`mstar-host` skill description；同步 INSTALL / `docs/cli.md`。删除 README「宿主说明 / Host notes」旁注，Use 区只保留入口。
27:
28:### 版本对齐
29:
30:- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.3**。
31:
32:## [1.8.2] - 2026-08-05
33:
34:### 文档（README + 宿主识别）
35:
36:- **README**（`README.md` + `README_CN.md`）：所有宿主表格按推荐宿主顺序重排（`omp > OpenCode > Cursor > Kimi = ZCode > Codex`）；**使用**一节重组为 通用（不跑迭代） → 迭代 → 代码库审计。
37:- **`mstar-host`**：重写宿主识别表，**仅用会话工具形态 / 可见命令**——`*-plugin/plugin.json` 文件无法识别宿主（在本源仓与任何多宿主安装里它们都同时存在）。合并重复的 Cursor 两行为一行，以 `subagent_type` 为关键信号。
38:- **宿主参考**：移除 `codex.md` / `kimi.md` / `zcode.md` / `omp.md` 各自 `Load when` 触发行里的插件标记子句，只保留工具形态 / 可见命令信号。路径参考上下文行与 plan-mode bridge 的 `plugin is installed` 前提留作文档（非识别触发）。
39:- **omp**：在 `references/omp.md` 记录原生 internal URL 方案（`skill://`、`local://`、`agent://`、`artifact://`、`history://`）。
40:
41:### CLI
42:
43:- `zcode` adapter 不再硬编码 `PLUGIN_VERSION` 常量（此前已漂移到 `1.6.0`）。marketplace 条目生成与 `doctor` 的 ZCode 版本校验改为通过 `utils.ts` 新增的共享 `readHarnessVersion()` 从 `packages/cli/package.json` 派生（`index.ts` 的 `--version` 也改用同一 helper）。修正 `INSTALL.md` 与 ZCode adapter 中陈旧的 `1.5.6` / `1.6.0` 版本字符串。
44:
45:### 版本对齐
46:
47:- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.2**。
48:
49:## [1.8.1] - 2026-08-05
50:
51:### Harness（skills + commands 优化）
52:
53:- **无损优化** `skills/` 与 `commands/`，按 SkillsBench 原则（紧凑 body、progressive disclosure、dedup 到 SSOT）。无任何规则、门禁、字段名或 NEVER 条目被改动或删除——规则只移动或压缩，绝不消失。
54:- **提取到 `references/`**：`mstar-iteration` Phase 3 → `phase-3-iteration-close.md`、Phase 4/5 → `phase-4-5-pr-delivery.md`（body 574 → 384 行）；`mstar-compound` Q1–Q8 + Phase 1–7 → `compound-workflow.md`（275 → 103）。
55:- **压缩**：`mstar-coding-behavior` 216 → 142（保留 The Ladder、`simplify:` 标记、minimal-check）；`qc-specialist/deep-review-lenses.md` 11 个透镜清单 → 每透镜一行（155 → 94）。
56:- **去重**：反模式清单 → `mstar-harness-core` 索引；新增 `_shared/leaf-executor-core.md`（9 个 leaf 角色的 Completion Report + Git NEVER 去重）；新增 `_shared/host-role-binding-core.md` + `_shared/plan-mode-bridge-core.md`（kimi/zcode/omp 宿主文件 + 5 个 plan-mode bridge 去重）。
57:- **命令 → 薄编排器**：4 个命令 943 → 388 行（−59%）；新增 `mstar-iteration/references/phase5-helper-discovery.md`。
58:- **描述**：收紧 `coding-behavior`、`branch-worktree`、`phase-gates` 的 frontmatter 为触发契约。
59:- **文档**：`README.md` + `README_CN.md` 增加推荐宿主顺序（`omp ≥ OpenCode ≥ Cursor > Kimi = ZCode > Codex`）。
60:- **命名**：`Completion Report v2` → `Completion Report`（模板已统一，去掉版本后缀）。
61:
62:### 版本对齐
63:
64:- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.1**。
65:## [1.8.0] - 2026-08-05
66:
67:### Harness（代码库审计 skill）
68:
69:- **新增 `mstar-audit` skill**：只读顾问式工作流，改编自 [improve](https://github.com/shadcn/improve) skill（MIT，© shadcn）。跨 9 个类别审查代码库（正确性/安全/性能/测试/技术债/依赖/DX/文档/方向），vet findings，按 leverage 排序，向 `{PLAN_DIR}/audit-<date>/` 写入自包含的改进计划。**不**引入 improve 的 `execute`/`reconcile`/`--issues` 变体——mstar 的 SDD、`status.json` 与 residual 追踪已替代它们。
70:- **新增 `plan-quality-bar` 参考**（`mstar-plan-artifacts/references/plan-quality-bar.md`）：计划自包含标准——验证门、STOP 条件、drift check、机器可检查的 done criteria。适用于 SDD task-brief、Prepare plan 与 audit plan。
71:- **新增 `/codebase-audit` 命令**（`commands/codebase-audit.md`）：独立入口。以 `codebase-` 前缀命名避免宿主命令冲突（沿用 `iteration-*` 约定）。接线：`mstar-harness-core` Task category `audit` + skill 索引；`mstar-phase-gates` Plan 质量门；`mstar-sdd` 引用；`mstar-roles` architect 加载项；`pm` skill 入口；`iteration-start` §1 Research 可选来源。
72:- **致谢**：improve（MIT，© shadcn），在 `mstar-audit/SKILL.md` 与 `plan-quality-bar.md` 中标注。
73:
74:### CLI（`@mstar-harness/cli`）
75:
76:- **Codex adapter**：`CODEX_PROJECT_COMMAND_NAMES`（从 `CODEX_ITERATION_SKILL_NAMES` 重命名）现包含 `codebase-audit`；project-scoped 安装将其物化为 `.agents/skills/codebase-audit/SKILL.md`。
77:- **omp adapter**：smoke 测试与安装说明包含 `codebase-audit`。
78:
79:### 版本对齐
80:
81:- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.8.0**。
82:
83:## [1.7.1] - 2026-08-05
84:
85:### CLI（`@mstar-harness/cli`）
86:
87:- **omp doctor**：解析 omp 17.x 的 `omp plugin list --json` 形状 `{ npm, marketplace }`（不再只认数组/`plugins`），并匹配 `manifest.name`。
88:
89:### 版本对齐
90:
91:- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.7.1**。
92:
93:## [1.7.0] - 2026-08-05
94:
95:### Harness（omp 宿主面）
96:
97:- **omp 作为第六宿主面**：标记 `.omp-plugin/plugin.json` + `.claude-plugin/plugin.json`（插件根 = 仓库根；挂载 `./skills/`、`./commands/`、`./agents/`）。新增 `skills/mstar-host/references/omp.md`，覆盖 `task`/`ask`/`hub`、文件名 slash 命令（`/iteration-*`）、以及 C5/C5b 内置 `task.agent` + prompt 角色绑定。`omp-plan-mode-bridge.md` 用于 `/plan` 双写。`mstar-host` detect 表、`pm` 入口、`parallel-dispatch` 已同步。
98:- 安装：`omp plugin install github:btspoony/mstar-harness` 或对本地 harness checkout 执行 `omp plugin link`；`omp plugin list` 中的包名为根 `morning-star`。
99:
100:### CLI（`@mstar-harness/cli`）
101:
102:- **`omp` 安装目标**：`npx @mstar-harness/cli init --target omp` 确保 `~/.mstar/harness` 并执行 `omp plugin link`（失败则回退 `omp plugin install github:btspoony/mstar-harness`）。`doctor --target omp` 校验标记、skills/commands 冒烟与 `omp plugin list`。`shared-install` 的 `HARNESS_MARKERS` 接受 `.omp-plugin/plugin.json`。
103:
104:### 版本对齐
105:
106:- 提升 monorepo 根、`@mstar-harness/opencode`、`@mstar-harness/cli`、Cursor/Codex/Kimi/ZCode/omp 插件清单：**→ 1.7.0**。
107:
108:## [1.6.1] - 2026-08-04
109:
110:### Harness（QC = 代码审查席，非测试执行席）
111:
112:- **L3 Plan QC 明确为 diff/逻辑审查**：`mstar-review-qc` 边界 + `qc-specialist*` workflow/shared NEVER——共享 `Review cwd` 上的并行三审 **不得**跑 test/build/install/lint/typecheck（工具链争用导致 peer QC `Blocked`）。覆盖率从 **diff** 判断，不靠重跑 suite。
113:- **运行时证据归 L1 / L4**：QA `acceptance-only` 复用 implementer/CI/既有 QA 日志；QC 报告是 findings，不是测试日志。PM Assignment 反模式与 `qa-trigger-matrix` 同步。
114:- **OpenCode `qc-specialist*` agents**：bash 白名单收束为 git + 轻量只读分析（移除 eslint/tsc/ruff/clippy 等）。
115:
116:### 版本对齐
117:
118:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi/ZCode 插件：**→ 1.6.1**。
119:
120:## [1.6.0] - 2026-08-03
121:
122:### Harness（ZCode 宿主面）
123:
124:- **ZCode 作为第五宿主面**：插件根 = 仓库根，经 `.zcode-plugin/plugin.json` 挂载（`./skills/`、`./commands/`、`./agents/`）；无 `sessionStart`（ZCode 不支持——PM 入口手动 `/morning-star-harness:pm`）。新增 `skills/mstar-host/references/zcode.md`，tool map 按真实 ZCode 会话工具编写（`Agent` / `AskUserQuestion` / `EnterPlanMode`·`ExitPlanMode` / `TodoWrite` / `Bash` / `Read` / `Edit` / `Write` / `WebSearch` / `WebFetch` / `TaskOutput`·`TaskStop`），复用 Kimi **C5b role-in-prompt binding**（ZCode 仅内置 `subagent_type` profile）。`zcode-plan-mode-bridge.md` 处理 Enter/Exit 双写。
125:- **`mstar-host` SKILL.md**：description、detect-host 表、兜底行加入 ZCode。
126:
127:### CLI（`@mstar-harness/cli`）
128:
129:- **`zcode` 安装 target**：`npx @mstar-harness/cli init --target zcode` 注册 `mstar-local` marketplace 到 `~/.zcode/cli/plugins/known_marketplaces.json` + `marketplaces/mstar-local/marketplace.json`，两者均指向 **`github:btspoony/mstar-harness`** 仓库 source（与 ZCode 内建 marketplace source 形状一致）。Project scope 另在 `.zcode/plugin-checkout` 保留本地 checkout 做 agent 文件 smoke 校验。`doctor --target zcode` 校验两个 JSON + checkout + gitignore。`shared-install` 的 `HARNESS_MARKERS` 新增接受 `.zcode-plugin/plugin.json`。
130:
131:### 版本对齐
132:
133:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi/ZCode 插件：**→ 1.6.0**。
134:
135:## [1.5.6] - 2026-07-28
136:
137:### Harness（residuals）
138:
139:- **`Findings cleanup: zero-residual | allow-residual`**：计划级「不残留」模式——可修 findings 尽量在当轮 fix→re-review 清干净。正式 **iteration Phase 2** 默认 **`zero-residual`**（仅真 blocker-defer + Durable Roadmap 可留 open R#）。独立 `/pm`、hotfix、`inline` 仍默认 **`allow-residual`**。
140:- Assignment 字段 + 可选 `plans[].metadata.findings_cleanup`；SSOT 在 `mstar-plan-artifacts`；贯通 `mstar-review-qc`、PM NEVER / Assignment、iteration close、QA 矩阵说明与 routing-eval。
141:
142:### 版本对齐
143:
144:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.6**。
145:
146:## [1.5.5] - 2026-07-27
147:
148:### Harness（worktree / L1）
149:
150:- **默认 gitignore 下的 control-path harness**：进程产物（`plans/`、`iterations/`、`status.json`、`sdd/` 等）仍本地；经 **control worktree** 绝对路径读写。Feature worktree 只改产品代码——**禁止**因 feature 缺 plans 而 waive worktree；**禁止**把「无 flock」当成 worktree 豁免（仅 `Plan parallelism: serial`）。
151:- Assignment：绝对 **`Control harness root`**、control 系 **`Plan Path`** / **`SDD dir`**、feature **`Worktree path`**。
152:- **`sdd-workspace`**：支持 `MSTAR_CONTROL_ROOT` / control-root 参数；linked worktree 无 `status.json` 时 fail closed。
153:- routing-eval：无 flock 串行保留 worktree、gitignore control-path 场景。
154:
155:### 版本对齐
156:
157:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.5**。
158:
159:## [1.5.4] - 2026-07-27
160:
161:### Harness（Cursor 宿主）
162:
163:- **`mstar-host` Cursor Task invoke schema**：文档化扁平并列字段（`prompt` + `subagent_type` + `description`）、范例、反模式（嵌套/字符串化 JSON、OpenCode `subagent`、MCP 包装、漏传 `subagent_type`）与发送前自检，降低 Task 首次参数格式失败。`parallel-dispatch.md` 增加指针。
164:
165:### 版本对齐
166:
167:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.4**。
168:
169:## [1.5.3] - 2026-07-25
170:
171:### Harness（commands / frontmatter）
172:
173:- **Frontmatter YAML**：对含 `: ` 的 `description` 加引号，避免 Cursor/插件发现不到 command/skill（`iteration-loop`、`mstar-branch-worktree`、`mstar-phase-gates`、`mstar-plan-artifacts`、`mstar-review-qc`、`mstar-sdd`）。
174:- **`/iteration-loop` scale**：新增 **`XL`** = **>4** 个业务 plan（`S`/`M`/`L`/`XL`；默认仍为 `M`）。SSOT：`mstar-iteration` §1.2 + `references/autonomous-direction-lock.md`。
175:
176:### 版本对齐
177:
178:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.3**。
179:
180:## [1.5.2] - 2026-07-23
181:
182:### Harness（git 策略 + SPECS_DIR）
183:
184:- **进程 vs 结果 Git 策略**：`{HARNESS_DIR}` 下默认 tracked — `AGENTS.md`、`knowledge/`、`specs/`；默认 gitignored — `plans/`、`iterations/`、`status.json`、`sdd/`、`archived/`、`notes.json`。跨 clone handoff = tracked 结果 + 根目录 `CONCEPTS.md` / `STRATEGY.md`；residual 经 compound 提升，**勿**默认 `git add` `status.json` / `plans/`。
185:- **`{SPECS_DIR}` 解析顺序**：`{HARNESS_DIR}/specs/` → `docs/specs/` → 仓库根 `specs/`（空目录跳过；greenfield 创建 `{HARNESS_DIR}/specs/`）。Legacy 只读：非空 `designs/` 路径。
186:- 已对齐：`mstar-plan-conventions`、`mstar-plan-artifacts`、`mstar-sdd` file-handoffs、宿主 Plan 模式桥接、双语 README、`.cursor/LOCAL-VALIDATION.md`。
187:- **CLI**：`init`/`doctor` 追加/检查完整 process gitignore 集（见 `packages/cli/CHANGELOG.md`）。
188:
189:### 版本对齐
190:
191:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.2**。
192:
193:## [1.5.1] - 2026-07-22
194:
195:### Harness（Phase 5 push cadence）
196:
197:- **Phase 5 push cadence（HARD）**：发现 CI/review 问题可**本地提前修**，但 **`git push` 必须等**当前 head 上一波 CI **与** review 全部跑完。CI 结束后若出现新 reviews，可继续本地修；**禁止在 CI 仍在跑时 push**（会打断 AI reviews，浪费 token 且无完整结果）。SSOT：`mstar-iteration` §5.1a；已对齐 `iteration-drive` / `iteration-loop` 与 core 反模式。
198:
199:### 版本对齐
200:
201:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.1**。
202:
203:## [1.5.0] - 2026-07-22
204:
205:### Harness（迭代 Phase 2 worktree + lease）
206:
207:- **Phase 2 control worktree**（`spec_integration_branch`）+ 每 plan **feature worktree**，配合 `execution_lease` / `integration_merge_lease`（同机独占写锁；合入 integration 串行；`Done` 仅在 merge 成功后）。
208:- 多会话跨 plan 并行 implement（lease 门控）；`Worktree mode: waived` **不**豁免跨 plan 并行安全闸；`Plan parallelism: serial` 仅调度串行。
209:- routing-eval 与双语 README Phase 2 默认说明已更新。
210:
211:### Harness（Phase 5 helpers）
212:
213:- **Phase 5 merge-ready helpers**：优先 `babysit` 或任意 `*-babysit`；`greploop` **仅当**仓库具备 Greptile/`greploop` 时可选。两者都适用时先 babysit/`*-babysit`，再可选 greploop。已更新 `mstar-iteration` §5 指针与 `commands/iteration-drive` / `iteration-loop`。
214:
215:### 版本对齐
216:
217:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.5.0**。
218:
219:## [1.4.0] - 2026-07-17
220:
221:### Harness（Kimi Code 宿主）
222:
223:- **Kimi 宿主支持**：`.kimi-plugin/plugin.json`（与 Cursor/Codex 同构的 host 目录布局；`sessionStart.skill: pm`）；`mstar-host` Kimi 参考 / Plan 模式桥；角色绑定写在 Agent prompt（内置子 agent 仅 `coder` / `explore` / `plan`）。
224:- **安装**：主路径为 Kimi TUI `/plugins install https://github.com/btspoony/mstar-harness` 后 `/plugins reload`（无 CLI `--target kimi`）。
225:- 插件命令：`/morning-star-harness:iteration-start` · `iteration-drive` · `iteration-loop`。
226:
227:### 版本对齐
228:
229:- monorepo、OpenCode、CLI、Cursor/Codex/Kimi 插件：**→ 1.4.0**。
230:
231:## [1.3.2] - 2026-07-15
232:
233:### Harness（Cursor Plan Phase 1 反馈驱动）
234:
235:- **`/iteration-start` Cursor Plan 路径**：feedback-driven — 用户只提方向/意见；Agent 探索、推荐并改 plan。`grill-me` 仅在反馈结束后、仍有阻塞缺口时发起。
236:- **Single CreatePlan URI（HARD）**：Phase 1 Plan 会话只 CreatePlan 一次；后续原地改同一文件；误开第二份则合并并删除。
237:- **`mstar-host` / rule / `mstar-iteration` §1.2**：Phase 1 Plan UX 写明反馈驱动与推荐 branch policy（禁止静默 `main`/`master`）。
238:- **Routing eval v20**：`iteration-phase1-cursor-plan-feedback-driven`。
239:
240:### 版本对齐
241:
242:- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.3.2**。
243:
244:## [1.3.1] - 2026-07-13
245:
246:### Harness（迭代 package 目录化）
247:
248:- **`iterations/<id>/` 目录优先**：compass 迁至 `{ITERATION_DIR}/<iteration-id>/delivery-compass.md`，同目录含 `guides/`、`specs/`、可选 package `README.md`。根 `{ITERATION_DIR}/README.md` **一行 = 一次迭代**（不再 compass + workspace 双行）。
249:- **Legacy 只读兼容**：根目录 flat `{ITERATION_DIR}/<id>-delivery-compass.md` 仍可读；新写必须走 package 路径。
250:- 涉及：`mstar-iteration`（及 references）、`mstar-compound` package 提升、`mstar-plan-conventions` / `mstar-plan-artifacts` 路径文档、角色壳、`/iteration-start` · `/iteration-drive` · `/iteration-loop`。
251:
252:### 版本对齐
253:
254:- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.3.1**。
255:
256:## [1.3.0] - 2026-07-11
257:
258:### Harness（bootstrap 吸收）
259:
260:- **退役 `/mstar-bootstrap` 命令**：7 阶段项目知识 bootstrap 流程迁入 `mstar-compound-refresh/references/project-knowledge-bootstrap.md`；`mstar-compound-refresh` 与 `mstar-harness-core` 保留简短指针。
261:
262:### CLI（Codex iteration skills）
263:
264:- **项目级 Codex 安装**：将 `iteration-start`、`iteration-drive`、`iteration-loop` 物化为 `.agents/skills/*/SKILL.md` 符号链接（源自 harness commands）；`doctor` 校验链接；全局安装跳过并给出明确警告。
265:
266:### 文档
267:
268:- **根目录 `INSTALL.md`**：从 README 抽离的可机读安装步骤。
269:- **精简双语 README**：CLI 优先 Quick Start；厘清 `/iteration-start` → `/iteration-drive` 与 `/iteration-loop` 使用路径。
270:
271:### 版本对齐
272:
273:- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.3.0**。
274:
275:## [1.2.1] - 2026-07-10
276:
277:### Harness（Cursor Plan 模式 × Phase 1 分阶段方向锁）
278:
279:- **`/iteration-start` Cursor Plan 路径**：Boot 后先 CreatePlan 空白 Phase 1 脚手架，再动态分阶段 `grill-me` 并每段更新 plan；Review & Edit / lock / integration 分支仅在 **Build** 后执行。Agent / OpenCode 仍为 Research → Explore → grill-me → Write → Review。
280:- **`mstar-host` Cursor bridge / rule**：补充 `mstar-iteration` Phase 1 in Plan mode（skills 不反向引用 command 名）。
281:- **`mstar-iteration` §1.2**：宿主 Plan UX 可先 scaffold 再分阶段收敛；非 Plan 宿主不变。
282:- **Routing eval v19**：`iteration-phase1-cursor-plan-staged-grill`。
283:
284:### 版本对齐
285:
286:- monorepo、OpenCode、CLI、Cursor/Codex 插件：**→ 1.2.1**。
287:
288:## [1.2.0] - 2026-07-10
289:
290:### Harness（`/iteration-loop` + autonomous direction lock）
291:
292:- **`/iteration-loop`**：新 PM 命令，自动化完整 Phase 1→5（适合 cloud agent）。可选参数 `direction` + `scale`（`S`\|`M`\|`L`，默认 `M`）；代码优先自动锁方向（不跑 grill-me）；保留顺序 Review & Edit 链；Continuous execution 直至 Phase 5 merge-ready。与 `/iteration-start`（仅 Phase 1 + grill-me）、`/iteration-drive`（仅 Phase 2→5）区分。
293:- **`mstar-iteration` §1.2**：direction lock 模式 `interactive` | `autonomous`；scale budget **只计业务 plan**（不计 harness 流程）；autonomous branch resolve。细则 → `references/autonomous-direction-lock.md`（skill 为能力提供者，不反向引用 command 名）。
294:- **文档**：README / README_CN / OpenCode 包 README 命令表区分 start / drive / loop。
295:- **Routing eval v18**：`iteration-loop-autonomous-direction-lock` — 禁止例行方向确认、禁止 grill-me、禁止静默默认 `main`、禁止把流程 plan 计入 scale。
296:
297:### CLI / CI / 发布
298:
299:- **OpenCode `init` 快路径**：不再交互选模型，也不再调用 `opencode models`（该命令可能无输出卡住）。默认只写 `$schema` + `@mstar-harness/opencode@latest`，角色模型用 OpenCode 默认；可选 `--*-model` 仍作高级覆盖。
300:- **CI**：对 `packages/cli`、`packages/opencode` 及 bundled `skills`/`agents`/`commands` 做 path 过滤构建；含 CLI smoke + pack。
…
302:
…
306:
…
921:`@mstar-harness/cli` 的 0.2.0 说明见 [packages/cli/CHANGELOG.md](packages/cli/CHANGELOG.md)。OpenCode 打包、`skills/` + `agents/` 随 postinstall 同步等与 0.2.0 同期变更见根目录英文 CHANGELOG 中 0.2.0 一节。

[Showing lines 1-300 of 922. Use :301 to continue]