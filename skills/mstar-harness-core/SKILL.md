---
name: mstar-harness-core
description: "Lifecycle and authorization authority: delivery loop, state machine, Done ownership, task-category routing, topic index. Use for lifecycle, authorization, Done, routing, or CLI/plugin version drift."
---

# Morning Star Harness Core（晨星核心）

本 skill 是 harness 的**唯一全局入口与裁决层**。专题 skill 展开细节；**冲突时以本 skill 的状态机、Done 权限与索引为准**。

## 与其它 `mstar-*` skill 的加载契约

- 本 skill 是 harness 的**生命周期 / 授权语义权威**（状态机、Done 权限、门禁、路由以本 skill 为准）；加载**选择**权威是 **`mstar-roles`**（hub bootstrap → 角色身份 → Assignment `Skill presets:` 决策，见其 § Load Order）。本 skill 不维护第二份全局必读角色表。
- Directly invoked `mstar-*` topics declare `mstar-harness-core` first in Load Order / First action unless `lintLoadOrder` exempts their exact identity: standalone `mstar-coding-behavior`, the standalone document-corpus contract `mstar-doc-corpus` (corpus authoring precedes, and must not require, lifecycle loading), and the inbound-only `mstar-engine-legacy` archive — the archive may be referenced by runtime skills, it never names another topic skill. The existing `mstar-roles` hub bootstraps role-preset selection; explicit `none` still retains identity and shared-leaf authorization, anti-recursion, and evidence obligations.
- Load only topics selected by `mstar-roles` and the relevant topic index; do not read all topics as a precaution. General-engineering wording is not a load-order exemption.
- **加载条件（`mstar-engine-legacy`）**：`mstar-engine-legacy` 是 **engine-absent 执行状态边界档案**。**engine 约束激活（或宿主含 engine 能力）时不加载**——engine-present 宿主以运行时 skills 的 engine-check 指针 + engine 校验为权威；仅 engine-absent 宿主（无 `mstar` CLI / engine import）为确认执行状态边界而读取（触发契约见其 description）：执行状态走对话追踪（no-plan mode），不重建任何文件执行路径。字段历史与迁移形状不在该归档——它们随 engine 留在运行时侧。

## Standalone harness（`mstar-*` 自洽）

- **`mstar-*` skill 体系**在本仓库内自洽运行：正文与 load order **不得**依赖仓库外的 skills、CLI、或 MCP 服务。
- **Commands**（如 `/iteration-start`）可引用本仓库 bundled、**非 `mstar-*`** 的辅助资产（例如 `skills/grill-me/`）；该引用**仅**存在于 command 层，**不**进入 `mstar-*` 专题索引或 load matrix。
- 框架/SDK/API 问题：先 Read/Grep 项目内文档、规格与源码；仍不确定时再向用户澄清。不将第三方文档工具写入 `mstar-*` 必读路径。

## 信息源优先级

1. 当轮用户显式指令  
2. 项目 `AGENTS.md` / `CLAUDE.md`  
3. 当轮相关 knowledge 文档（登记/完整性查 store.db catalog：`mstar catalog list` / `show`；`{KNOWLEDGE_DIR}/README.md` 若存在仅为散文导览，无登记行义务）
4. `mstar-*` skills（本 skill + 专题）  
5. `mstar-roles` 角色正文  

冲突且用户未覆盖 → **暂停升级人工**。Knowledge **永不**高于用户 / `AGENTS.md`。

## 最小交付循环

**Per-plan:** `specify → clarify → plan` → `plan(locked) → tasks → implement` (multi-task defaults to SDD) → independent plan QC tri + **PM Acceptance** → Done (`inline` single-seat exception unchanged). Phase gates → **`mstar-phase-gates`**; acceptance → **`mstar-roles/references/project-manager/acceptance.md`**. Standalone development continues after Done through `compound disposition → submit PR → merge-ready (resumable milestone) → verify merge → terminal close/unregister/reconcile`; `verification/report-only` follows its registered completion policy without a forced PR. Lifecycle authority → **`mstar-artifacts/references/plan-workflow-lifecycle-contract.md`**; PM sequence → **`mstar-roles/references/project-manager/plan-management.md`**; compound → **`mstar-knowledge/references/compound-workflow.md`**. Iteration rows share one outer delivery tail.

**迭代级**：`iteration-start → [per-plan cycle × N] → iteration-close → PR delivery → PR merge-ready loop`。merge 是独立的授权动作：按 compass `pr_merge_policy`（`reviewed-auto` → 本地 PR 级 review 循环的 `ship it` 结论，须 settled、已 posted、且 `head` 等于当前 PR head，**并且**（仅当挂载了外部 review bot 时；无 bot 记 N/A）外部 AI review 在当前 head 达到其通过线、不失败、无 blocking finding；`reviewed-bot` → 不自起 review loop，挂载的自动 review bot（如 mstar-inspector）在当前 head 的最新 review 达到其自身门（mstar-inspector 为 `mstar-inspector review` check `success`）且无 blocking finding，无 bot 属配置失效；`owner-gated` → **人类 owner**（操作者/用户，不是 coordinator 席位）对当前 PR head 的显式书面批准）判定，merge-ready / CI 绿 / QC Approve 各自都不构成授权；`pr_merge_policy` 缺失即停并回到 Phase 1。细则 → **`mstar-iteration`** → `references/phase-4-5-pr-delivery.md` §5.1b/§5.3。

**Capture duty**：确认的 finding 即落为 `{HARNESS_DIR}/store.db` 的 issue（计划内 `mstar plan issue-add`，计划外 `mstar issue add`；同一 finding 再次出现追加 occurrence，**不**新开第二个）——**捕获只记证据，处置是独立的授权动作**。cutover 落地后 **open issue 即 residual SSOT**（project register 只作迁移历史）。契约唯一权威 → **`mstar-project-governance`「Issue capture」**（本 skill 不复述）。

## 加载约定（强制）

加载选择 SSOT：**`mstar-roles`** hub § Load Order（Assignment `Skill presets:` 决策；PM required reading 不受 preset 门控）。下表是各角色的**典型追加指引**，不是第二套选择机制；冲突时以 hub 为准。**路由最小化（`mstar-skill-authoring` 原则 3）：** 单任务目标 **1–3** 个专题 skill（本 skill / hub 身份读除外）；「按任务追加」只选当前任务类真正需要的子集，禁止「以防万一」整表加载。

| 角色 | 始终 | 按任务追加（典型；每回合择 1–3） |
|------|------|-------------------|
| **All harness roles** | Load selection → **`mstar-roles`** (§ Load Order); this skill owns lifecycle/authorization. The hub bootstraps role selection without requiring core-first. | — |
| **`@project-manager`** | 本 skill | 仅当本回合需要时择子集：编排/门禁/路径 → `mstar-dispatch-gates` / `mstar-phase-gates` / `mstar-conventions`（hub 身份仍走 `mstar-roles`）；implement → `mstar-sdd`；派 QC 前 → `mstar-review-qc`；并行/审查检出 → `mstar-branch-worktree`；plan 产物 → `mstar-artifacts`；UI Prepare → `mstar-design-md`；写 skill → `mstar-skill-authoring`；迭代 → `mstar-iteration`；结晶/bootstrap → `mstar-knowledge`；audit → `mstar-audit`；跑 CLI → `mstar-use-cli`。**不**读 `mstar-coding-behavior` |
| **Implementation / review / ops** | This skill + `mstar-coding-behavior` + role reference | Git writes: `mstar-branch-worktree`; plan paths: `mstar-conventions`; PM before QC: `mstar-review-qc`; QC execution: `mstar-roles/references/qc-specialist/`; status/residuals: `mstar-artifacts`; UI: `mstar-design-md`; knowledge (PM): `mstar-knowledge`; CLI execution/interpretation: `mstar-use-cli` |
| **leaf 承接方** | 上栏 + **`mstar-dispatch-gates`**（反递归节） | — |

Routing eval（宿主插件内回归用，**非**运行时必读）→ `.cursor/skills/mstar-routing-eval/`。

## 状态机

`Todo` → `InProgress` → `InReview` → `Done` | `Blocked`

- Done sign-off belongs solely to the primary project-manager after evidence-backed PM Acceptance; the authoritative row write uses that coordinator's direct complete operation with independent QC, acceptance and declared-route proof. Leaf agents never write Done.
- The primary coordinator uses revisable prepare, progress and direct complete; no per-row PM identity/bind/claim, sealed Assignment or transfer protocol. Default cleanup is allow-residual. Ordinary metadata/defaults need no ceremonial prepare record.

ACTIVE 状态字段权威在 store.db 的 root register / workflow / plan 行（唯一执行权威）；无 store 的 harness plan 不登记——走对话追踪（no-plan mode）；`status.json` / snapshot 仅迁移源/历史，project register 无条件退役为迁移历史。字段与 issue severity/lifecycle → **`mstar-artifacts`**。

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

**硬规则**：`quick` **从不**跳过 `specify → clarify → plan`；禁止把新 CLI/API/多模块/新测例标为 `quick`。已启用 `{HARNESS_DIR}` 时，首次 implement 前须有主 plan 路径 + workflow/plan 行登记（ACTIVE 在 store.db，经 `mstar workflow register` 等公共注册动词；无 store 则 plan 不登记——走对话追踪（no-plan mode），见 **`mstar-conventions`**）。workflow 注册本身是 authorized domain operation（经授权 producer 的引擎原语，不自创第二注册机制），语义 → 冻结契约 `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`。

## `@explore` 边界

- 已分派角色的 Assignment：**禁止**用 `@explore` 代替实现/测试/审查/文档交付。
- 允许短窄只读辅助；`glob`/`grep`/`read` 够用时不必 `@explore`。
- PM 分派前摸底：**推荐**；分派后承接方**勿**转包。

## 长任务纪律

可追踪清单（plan `tasks` 或 Todo）；偏离时 PM 拉回；完成前须可核对证据（实现侧自检见 **`mstar-coding-behavior`**；门禁证据见 **`mstar-phase-gates`** / **`mstar-review-qc`**）。

**Durable Roadmap Gate**：凡声明“分批 / 后续 / next plan / later / temporary workaround”的非热修任务，必须在可追踪载体写清后续路线（批次、依赖、owner/触发条件、完成定义）。可接受载体：`{PLAN_DIR}` 主 plan、CreatePlan mirror、store.db issue、PM Task Board，或 `{HARNESS_DIR}/store.db` 的 milestone —— milestone ID + 关联 issue 的 acceptance/owner/dependency/trigger 证据（`mstar milestone` 家族写入与只读 rollup；规则唯一权威 → **`mstar-project-governance`「Milestone」**，本 skill 不复述）。只在对话或 Completion Report 里说“以后做”不算可追踪，不能进入 implement GO 或 Done。

## 专题 skill 索引

| Skill | 职责 |
|-------|------|
| `mstar-harness-core` | 本文件：入口、状态机、Task category、explore、索引、护栏 |
| `mstar-use-cli` | Intent-first command families, ordinary coordinator operations, three completion routes, CAS/receipts, exit/refusal codes; exact flags from source-built verb help |
| `mstar-phase-gates` | per-plan 双阶段门禁：Prepare/Execute、意图门禁、hotfix、可验证编辑 |
| `mstar-iteration` | 迭代管理：Phase 1–5（start / Autonomous Execute / iteration-close / PR delivery / PR merge-ready loop） |
| `mstar-dispatch-gates` | 派发、Delegation、反递归、依赖与隔离驱动并行、SDD 路径 plan QC 强制 tri |
| `mstar-engine-legacy` | Engine-absent execution-state boundary; execution state = conversation tracking (no-plan mode); no recreated file execution route |
| `mstar-sdd` | Subagent-driven development：file handoff、per-task review、ledger |
| `mstar-branch-worktree` | Feature branches, worktrees, QC / PM Acceptance checkout alignment |
| `mstar-conventions` | `{HARNESS_DIR}` 发现、初始化、Spec 分支模型摘要、产物路径 SSOT |
| `mstar-artifacts` | 主 plan、review bundle / durable summaries、store.db root register/plan 行与 issue severity/lifecycle、notes.jsonl ledger、knowledge；root/snapshot 文件仅迁移源/历史，project register 仅迁移历史 |
| `mstar-project-governance` | 项目 roadmap 的 store 内容权威（Direction 正文 + 结构化 milestone）与读写/导入/导出规则（legacy `roadmap.md` 仅 transport/history）；issue capture、迁移 register、`_default` 项目归属 |
| `mstar-design-md` | DESIGN.md 设计系统规范 —— 创建/审计/维护 design tokens，三级检查清单，light/dark 双主题 |
| `mstar-design-system` | 收敛既有 baseline 的方法 —— baseline 定位与机器化、结构/外观/行为三层 parity、defect/decision/phantom 分诊、coverage 证据（契约本体仍属 `mstar-design-md`） |
| `mstar-review-qc` | PM：QC tri 编排、residual 留档、四层边界；leaf 执行 → `mstar-roles/references/qc-specialist/` |
| `mstar-coding-behavior` | Requirement-first simplicity, surgical diagnosis/review, agent-facing interfaces, and scoped evidence |
| `mstar-knowledge` | 知识结晶与维护 —— 已解决问题→结构化知识文档（双轨 Bug/Knowledge、「是否值得结晶」自检清单、重叠检测、可发现性检查、CONCEPTS.md 协同、迭代收口 package 提升）＋审查/更新/合并/删除既有文档；**项目知识 bootstrap**（无/残旧 STRATEGY.md、CONCEPTS.md、`{KNOWLEDGE_DIR}`）→ `references/project-knowledge-bootstrap.md`（`STRATEGY.md` 契约 → `references/strategy-document.md`） |
| `mstar-doc-corpus` | 三层文档语料契约：knowledge / specs / ADR 的边界、文档骨架、命名与生命周期；**独立可用**（无需 harness 生命周期或 store），CLI（`mstar lint --type adr` / `--type specs`、`mstar compound validate`）只是**可选校验器** |
| `mstar-skill-authoring` | 通用 skill 撰写门控（SkillsBench 六原则）：trigger 契约、紧凑 5 问 body、渐进披露、paired 证据 |
| `mstar-prose` | 散文可解性判断（on-demand，不属任何默认加载路径）：HEAD 测试、八类推理转录泄漏、九条 keep 规则、ADR / issue 路由；判断任意表面（Markdown、注释、JSDoc、prompt、诊断、agent 指令）的文字是否只在撰写会话里成立，与 `mstar-skill-authoring` 的 skill 结构判断互补 |
| `mstar-audit` | Variant carrier：common core（hard rules、recon、vet、variant dispatch）+ SKILL.md `## Output format`（review report 运行目录 `<date>-codebase-<level>-<round>/`、findings、coverage、leads）+ `references/codebase-audit.md`（full-audit 变体：9 类别 fan-out、effort、scope variants、Phase 4 excerpt/reconcile、audit index 模板）+ `references/security-review.md`（security 深查：exploitability 门槛、FP 纪律、LLM/供应链面）+ `references/pr-review.md`（`pr` 变体）；`audit-playbook` + `finding-format` |
| `mstar-pr-loop` | Opt-in PR review → fix loop until the review verdict is `ship it`; also selectable at iteration Phase 1 as the local `reviewed-auto` review path, whose `ship it` row the iteration merge authorization reads. Never selected under `reviewed-bot` |
| `mstar-e2e` | Explicit independent real-browser/device/E2E workflow; PM orchestrates and ops executes, outside development acceptance gates |
| `mstar-roles` | 角色正文 hub |
| `mstar-host` | 宿主适配（自动识别；`references/opencode.md` / `cursor.md` / `codex.md` / `kimi.md` / `parallel-dispatch.md`） |

## 宿主 `mstar-host`

Read **`mstar-host`** after this skill; it detects the active host and routes to the matching reference — host names, tool shapes and per-host entry details live only there（本表不重复维护）。

## 版本对齐（CLI ↔ host 插件）

- 全局 CLI 与已安装的宿主插件**独立升级**；版本漂移是已知故障源（skills/commands 与 CLI 预期不再匹配）。
- 检查：`mstar-harness doctor --target <host>`（各宿主 target 名 = `mstar-host` 检测表中该宿主的 id；已实现的宿主以 `mstar-host` 与 CLI `--help` 为准）。
- **CLI 较新** → 提示用户更新宿主插件；**插件较新** → 提示用户更新全局 CLI（`npm i -g @mstar-harness/cli@latest`）。
- 触发纪律：harness 行为异常/疑似过期、已知新版本发布后、或用户要求时运行——**不是**每个会话都跑。

## 定向执行与验证边界

本节是全部角色的范围与验证授权 SSOT；角色方法只展开其执行细节，`Skill presets: none` 仍由共享 leaf 边界承接这些限制。

- **本地全量测试默认禁止，完整套件交 CI。** 只有用户明确许可才能例外；Assignment 的 `Constraints` 引用许可，`Evidence Required` 写明命令、范围、环境与次数。PM 字段、风险等级、缺证据、fix wave 和早期探索都不产生许可；不得拆成多个无关“小测试”绕过全量边界。
- **Scoped investigation:** implementation, fixes, QC and acceptance inspect only the change, directly affected interfaces and relevant knowledge. Do not restart repository-wide scans, tests or review; report exact missing scope instead of expanding it.
- **只读审查席位有界。** review / QC / L2 task review 的范围是 Assignment 的 diff pack 加直接影响接口；只在 must-fix 线索上跟进出界。默认 **≤ 12 次文件打开或 ≤ 10 分钟**（PM 按 Assignment `Budget` 收紧，不得放宽）；席位还必须写明 `Return shape`（返回什么、如何在预算内停下），干净轮次显式返回 `findings: []` 而非散文。`Task category: audit` 的轮次同受这两项约束，即使 `Execute as` 不在 QC 席位集内（`audit` 类请求可落在 `@code-reviewer` 之外的执行者上）。触达即停止扩展：返回当前 verdict 与已得 findings，并在报告 `## Scope` 声明 `Truncated coverage:`。**截断 ≠ `Unconfirmed`**——后者仍是证据通道失败态并阻断 `Approve`；未覆盖范围按既有「未提及 = 未审查」由 PM 汇总，且部分覆盖的运行不可作为批准——门禁语义 → `mstar-review-qc`。
- **验证按变更映射。** 可执行逻辑使用对应单测；非可执行文档与 prompt/skill 策略使用真实定向静态或 before/after 证据，不制造测试文件。SDD 的 `Verification mode: scoped-check` 格式与适用性 → `mstar-sdd/references/file-handoffs.md`。报告结构校验不证明命令执行或 diff 适用性，也不是任意 shell 拦截器。
- **Invalidate only affected evidence.** A later HEAD or review range does not require a full rerun. Reuse applicable L1/CI/prior acceptance evidence with original scope and an applicability reason. Fixes verify only their regression; QC re-review covers owned findings, fix delta and direct interfaces. `full tri-review` counts seats, not repository scope; QC runs no test/build/install.
- **PM Acceptance owns L4.** The primary PM maps every required AC to reproducible evidence and an honest result; independent QC approval is not runtime proof. PM may directly execute only a named short, bounded acceptance check to fill a concrete gap, never product coding, test authoring, long suites, unrestricted verification or ops. Specialist dev/ops supply such evidence under separate assignments; PM retains sole sign-off. Procedure/report/recovery → **`mstar-roles/references/project-manager/acceptance.md`**.
- **No external-environment receipts for development acceptance.** During Prepare, replace AC/gate demands for live APIs/provider receipts, named/authenticated hosts/accounts, installed plugins/artifacts, real browser/device or deployed environments with isolated fixtures, relevant unit/component/integration checks or locally built CLI/MCP proof. QC/acceptance cannot reinstate these demands; disclose real-environment behavior as unverified. Explicit independent operational/`mstar-e2e` workflows remain authorized separately, with ops execution; their named scenarios are their own plan rows, never development gate duties.
- **依赖允许即并行。** PM 对无依赖、写所有权及 worktree 隔离的 ready tasks 并行派发；共享写目标、同一 session/ledger、前置接口与 integration merge 才按具体约束串行。leaf 不因并行策略获得派发权限。
- **恢复走原意图。** 当前引擎可推导的 root、binding、token 与前置 bookkeeping 不要求操作者先复制/修补；先用目标动作并读取 `applied` / `partial` / replay 收据。只有不可推导的身份、目标选择、授权或真实冲突才要求补充事实；partial 保留已提交部分，不能宣称整个动作 mutation-free。leaf 不接收凭据。
- **完成即交付。** Assignment 给出任务、输入、所有权、允许检查与可观察结果；执行者只解答这些问题，不重复分析已解决内容、不顺手修复或增加“保险”检查。真实范围缺口返回 PM，已有证据充分即停止。

## 核心研发守则

Global engineering invariants apply to all harness roles; implementation and review practice → **`mstar-coding-behavior`**.

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
