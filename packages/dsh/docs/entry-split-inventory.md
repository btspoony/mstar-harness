# dsh entry split — 模块盘点 + 拆分方案（plan `20260810-dsh-entry-split` T1）

- **范围**：`packages/dsh/src/index.ts`（3184 行）→ `src/gates/*` 纯重构拆分的模块盘点与 move plan。
- **冻结基线**：worktree branch `feature/dsh-entry-split` @ `76bbad4`（含 Plan A 全部代码：engine workspaceRoot 边界 + 2.0.5 版本对齐）。
- **配套**：导出面快照断言测试 `packages/dsh/tests/export-surface.spec.ts`（导出集恒等）；本方案节已回写主 plan Task 1（`.mstar/plans/20260810-dsh-entry-split.md`）。
- **硬约束**：零逻辑改动（机械搬移 + 最小 import 编辑）；导出面不变；入口瘦身为模块索引（仅 import/export + 启动接线）；全量 suite ≥394 且不回退；禁止 barrel / 运行时循环依赖。

---

## 1. 现状盘点 — `src/index.ts`（3184 行）

| # | Section | 行范围 | 内容 |
|---|---------|--------|------|
| 1 | 头部注释 + imports | 1–93 | 模块注释（**禁 default export**，Loader 丢 `inject` 元数据）；node:fs/path/url、cordis、schemastery、dsh-skill-local、`@mstar-harness/engine`（34 个函数 + 8 个类型）、dsh-fs/dsh-tools/dsh-commands/dsh-llm/dsh-agent、`./service.ts`、`./types.ts` |
| 2 | 公开 re-export | 95–101 | `DshMstar`（service.ts）、`DshMstarOptions`（type）、`MstarEngineStatusSource`/`MstarHarnessState`/`MstarIterationGateView`（type，types.ts）——cordis `Context` augmentation（`ctx.dshMstar`）所在 service.d.ts 的入口引用 |
| 3 | 插件 manifest | 103–111 | `export const name = 'dsh'`、`export const inject: string[] = []` |
| 4 | 模块常量 | 113–148 | `LOGGER_NAME`、`STATUS_FILE`、`DISPATCH_LOGGER`、`HOST_LOGGER`、`SKILL_LINT_LOGGER`、`CATALOG_LOGGER`、`DEFAULT_CATALOG_TTL_MS`、`EXPLICIT_CACHE_KEY`、`RESIDUAL_SEVERITIES`、`DEFAULT_DISPATCH_TOOLS`、`ASSIGNMENT_HEADING_RE`、`ASSIGNMENT_FIELD_RE` |
| 5 | 插件配置 | 150–225 | `export interface Config`（6 可选字段）+ `export const Config: z<Config>`（schemastery schema） |
| 6 | Advisory 类型 + SeamId + cordis augmentation | 227–391 | `StatusGateAdvisory`、`DispatchGateAdvisory`、`SkillLintAdvisory`、`SeamId`、`SeamLintAdvisory`；`declare module 'cordis'`：`Context.dshHostAdapter` + `Events` 四事件（`mstar/dispatch-gate` / `mstar/status-gate` / `mstar/skill-lint` / `mstar/seam-lint`） |
| 7 | 共享助手 | 393–403 | `formatViolation`（violation → 日志行）、`asRecord`（unknown → record） |
| 8 | **status gate** | 405–587 | `isStatusTarget`、`resolveHard`、`validateStatusValue`（status 校验 + findings_cleanup gate）、`validateStatusDoc`（单读 TOCTOU 收敛）、`gateStatusIntent`（repair-escape + degrade 包络）、`writeIntentListener`、`editIntentListener`（prepend 注册契约） |
| 9 | **skill-lint gate** | 589–826 | `SkillLintVetoError`（typed veto）、`stripFrontmatter`、`lintSkillDoc`、`lintSkillWrite`、`skillRootsOf`、`isSkillTarget`、`skillNameOf`、`skillCanonicalForm`、`resolveSeamHard`、`gateSkillIntent`（repair-escape）、`skillWriteIntentListener` |
| 10 | **artifact seam gates** | 828–1201 | `SEAM_LOGGERS`、`isIndexFile`、`isMarkdownDoc`、`isAuditPlanTarget`、`isRolesTarget`、`rolesDirOf`、`isSeamTarget`、`auditSecretsViolations`（Hard Rule 4 只引用 file:line）、`validateDesignDoc`、`validateAuditDoc`、`validateCompoundDoc`、`validateRolesState`、`validateSeamDoc`、`emitSeamAdvisory`、`gateSeamIntent`、`seamWriteIntentListener`、`SeamVetoError`、`lintSeamWrite` + 4 个 seam 绑定（`lintDesignMdWrite`/`lintAuditWrite`/`lintCompoundWrite`/`lintRolesWrite`） |
| 11 | **dispatch gate** | 1203–1728 | `isAssignmentShaped`、`resolveDispatchHard`、`denyReason`、`leaseViolation`、`assignmentHeaderValue`、`firstToken`、`assignmentHeaderValues`、`isNaValue`、`planIdOf`、`sessionIdOf`、`leaseGateViolations`（dsh 增量 lease 检查）、`worktreeViolation`、`worktreeL2Violations`、`worktreeL1Violations`、`dispatchGateCore`（engine 单一组合 + worktree 增量）、`gateDispatch`、`preExecuteListener`（deny 短路 / degrade 包络）、`assignmentTextFromFields` |
| 12 | packaged dirs + skill-local config | 1730–1794 | `packagedSkillsDir`、`packagedCommandsDir`（import.meta.url 包相对，非 cwd 锚定）、`skillLocalConfig`（provider `mstar`、`includeDefaultRoots: false`） |
| 13 | **host adapter** | 1796–1956 | `DshHostAdapterOptions`、`DshHostAdapter extends Service implements HostAdapter`（`statusGate`/`dispatchGate` 共享核心 + `beforeStatusWrite`/`beforeDispatch`/`beforeMerge` hooks） |
| 14 | **engine-status catalog**（pre-step） | 1958–2418 | `pluginVersion`、`engineStatusSource`、`CatalogCacheEntry`、`buildCatalogSources`、`catalogSourcesFor`（TTL）、`renderEngineStatusCatalog`、`harnessStateSource`、`knowledgeDigest`、`compassDirection`、`steeringCompassPath`、`iterationGateSource`、`preStepCatalogListener`（digest 门控重发）、`TurnDigest`、`agentDigestKey` |
| 15 | 视图映射 + **工具注册** | 2420–2896 | `iterationViolationView`、`iterationGateView`、`ITERATION_VIOLATION_SCHEMA`、`registerSddIterationTools`（`mstar_sdd_workspace`/`mstar_sdd_task_brief`/`mstar_iteration_gate`）、`registerSeamTools`（`mstar_design_md_validate`/`mstar_audit_validate`/`mstar_compound_validate`/`mstar_roles_validate`）——均 `ctx.inject(['tools'], …)` 延迟注册 |
| 16 | 命令注册 | 2898–2967 | `commandFrontmatterField`、`parseCommandMarkdown`、`registerMstarCommands`（`ctx.inject(['commands'], …)`，`source: { kind: 'user' }` steer） |
| 17 | **HarnessResolver** + session 助手 | 2969–3031 | `HarnessResolver`（per-workspace 探测，explicit 优先，memoized）、`sessionCwdOf`、`actorAgentOf` |
| 18 | **apply()** | 3033–3184 | 启动接线：resolver 构造 → `DshMstar` service → `DshHostAdapter` service → `registerMstarCommands` → skill-local mount → boot 观测 warn（hard 缺 dispatchBinding/dispatchTools）→ fs 三组 gate 注册（prepend）→ `tools/pre-execute` → `agent/pre-step` catalog（TTL cache + digest）→ sdd/iteration 工具 → seam 工具 |

**横切观察**：
- **adapter 是共享 gate 核心的宿主面**：`gateStatusIntent`/`gateDispatch` 经 `adapter.statusGate`/`adapter.dispatchGate` 复用同一校验路径；listener 与 host hooks 共享 ONE code path。
- **resolver 贯穿所有事件路径**：fs 意图、pre-execute、pre-step、工具 execute 均按 session workspace 解析（显式 config 优先，永不 process-cwd 探测）。
- **常量散布但归属清晰**：`STATUS_FILE`（3 模块用）、`DISPATCH_LOGGER`（dispatch + apply boot warn 用）、`DEFAULT_CATALOG_TTL_MS`/`EXPLICIT_CACHE_KEY`（catalog + apply 用）跨 entry 边界；其余 logger 常量单模块私有。
- **`Config`/`HarnessResolver`/`packagedSkillsDir`/`resolveSeamHard`/`iterationViolationView` 等被多模块消费** → 必须落入 `_shared.ts`，否则 entry↔gate 形成运行时环。

---

## 2. 导出面冻结清单（Plan B Task 4 快照断言测试基准）

### 2.1 值导出（17 个 — `Object.keys` 运行时可见）

| 名称 | 种类 | 现位置 |
|------|------|--------|
| `name` | const | entry（manifest） |
| `inject` | const | entry（manifest） |
| `Config` | const（z schema，同名 interface 兼类型导出） | entry |
| `SkillLintVetoError` | class | §9 |
| `lintSkillDoc` | function | §9 |
| `lintSkillWrite` | function | §9 |
| `SeamVetoError` | class | §10 |
| `lintSeamWrite` | function | §10 |
| `lintDesignMdWrite` | function | §10 |
| `lintAuditWrite` | function | §10 |
| `lintCompoundWrite` | function | §10 |
| `lintRolesWrite` | function | §10 |
| `skillLocalConfig` | function | §12 |
| `DshHostAdapter` | class（Service） | §13 |
| `HarnessResolver` | class | §17 |
| `apply` | function | §18 |
| `DshMstar` | class（re-export from `./service.ts`） | §2 |

### 2.2 类型导出（11 个 type-only — 运行时擦除，类型层守卫）

`Config`（interface，与值同名）、`StatusGateAdvisory`、`DispatchGateAdvisory`、`SkillLintAdvisory`、`SeamId`、`SeamLintAdvisory`、`DshHostAdapterOptions`、`DshMstarOptions`（re-export）、`MstarEngineStatusSource` / `MstarHarnessState` / `MstarIterationGateView`（re-export from `./types.ts`）

### 2.3 cordis augmentation（`declare module 'cordis'`）

- `Context.dshHostAdapter: DshHostAdapter`
- `Events`：`'mstar/dispatch-gate'`、`'mstar/status-gate'`、`'mstar/skill-lint'`、`'mstar/seam-lint'`（各携带对应 Advisory payload）

**合计：28 个不同具名导出 + 1 个 augmentation**。冻结于 `tests/export-surface.spec.ts`：运行时精确值导出集 + 编译期全命名空间恒等（`keyof typeof entry` 与 28 名联合互包含）+ augmentation 探测。

---

## 3. 拆分方案 — `src/gates/*`（move plan）

> 模块边界：gates 内部化（仅 entry 或显式相对导入引用，禁止 barrel / 运行时循环依赖）；跨模块共享入 `_shared.ts`。公共导出由 entry 原样 re-export（**导出面不变**）；模块内部新增导出仅为 entry/相邻模块接线所需，不进公共面。

### 3.1 模块划分与内容

| 模块 | 承接 § | 内容 | 公共导出（entry re-export） | 模块导出（接线用） |
|------|--------|------|------------------------------|--------------------|
| `gates/status.ts` | §8 | `isStatusTarget`、`resolveHard`、`validateStatusValue`、`validateStatusDoc`、`gateStatusIntent`、`writeIntentListener`、`editIntentListener` + `LOGGER_NAME` | `StatusGateAdvisory`（type） | `writeIntentListener`、`editIntentListener`（entry）、`validateStatusValue`、`validateStatusDoc`（adapter） |
| `gates/skill-lint.ts` | §9 | `SkillLintVetoError`、`stripFrontmatter`、`lintSkillDoc`、`lintSkillWrite`、`skillRootsOf`、`isSkillTarget`、`skillNameOf`、`skillCanonicalForm`、`gateSkillIntent`、`skillWriteIntentListener` + `SKILL_LINT_LOGGER` | `SkillLintAdvisory`（type）、`SkillLintVetoError`、`lintSkillDoc`、`lintSkillWrite` | `skillWriteIntentListener`（entry） |
| `gates/seams.ts` | §10 | 全部 seam 门禁（见 §1 表 §10 列）+ `SEAM_LOGGERS` | `SeamId`（type）、`SeamLintAdvisory`（type）、`SeamVetoError`、`lintSeamWrite`、`lintDesignMdWrite`、`lintAuditWrite`、`lintCompoundWrite`、`lintRolesWrite` | `seamWriteIntentListener`（entry）、`validateDesignDoc`/`validateAuditDoc`/`validateCompoundDoc`/`validateRolesState`（tools） |
| `gates/dispatch.ts` | §11 | 全部 dispatch 门禁 + `DISPATCH_LOGGER`、`DEFAULT_DISPATCH_TOOLS`、`ASSIGNMENT_HEADING_RE`、`ASSIGNMENT_FIELD_RE` | `DispatchGateAdvisory`（type） | `preExecuteListener`（entry）、`dispatchGateCore`/`leaseGateViolations`/`assignmentTextFromFields`/`resolveDispatchHard`/`DISPATCH_LOGGER`（adapter + entry boot warn） |
| `gates/adapter.ts` | §13 | `DshHostAdapterOptions`、`DshHostAdapter`（含 `statusGate`/`dispatchGate`/`beforeStatusWrite`/`beforeDispatch`/`beforeMerge`）+ `HOST_LOGGER` | `DshHostAdapterOptions`（type）、`DshHostAdapter` | — |
| `gates/catalog.ts` | §14 + §15 视图映射 | catalog 全部函数 + `CATALOG_LOGGER`、`DEFAULT_CATALOG_TTL_MS`、`EXPLICIT_CACHE_KEY`、`RESIDUAL_SEVERITIES` | — | `preStepCatalogListener`、`buildCatalogSources`、`DEFAULT_CATALOG_TTL_MS`、`EXPLICIT_CACHE_KEY`、type `CatalogCacheEntry`/`TurnDigest`（entry 接线） |
| `gates/tools.ts` | §15 注册 | `registerSddIterationTools`、`registerSeamTools`、`ITERATION_VIOLATION_SCHEMA` | — | `registerSddIterationTools`、`registerSeamTools`（entry） |
| `gates/_shared.ts` | §4/5/7/12/17/15 | **插件契约**：`Config` interface + `Config` schema、`HarnessResolver` + `sessionCwdOf`/`actorAgentOf`；**共享助手**：`formatViolation`、`asRecord`、`resolveSeamHard`、`packagedSkillsDir`、`skillLocalConfig`、`iterationViolationView`/`iterationGateView`；**共享常量**：`STATUS_FILE` | `Config`（type + value）、`HarnessResolver`、`skillLocalConfig` | 全部（各 gate/entry 消费） |

### 3.2 入口（拆分后）— 模块索引 + 启动接线

`src/index.ts` 保留：
- 头部注释（禁 default export 契约）、`name`/`inject` manifest、`declare module 'cordis'` augmentation（单一 augmentation 点）。
- **`apply()` 启动接线**（不搬移）：resolver 构造、`DshMstar`/`DshHostAdapter` service 构造、skill-local mount、boot 观测 warn、5 个事件槽注册（fs×3 组 + pre-execute + pre-step）、catalog cache/digest 装配、两个工具注册调用。
- **命令注册**（§16，非 gate 实现，属启动接线）：`registerMstarCommands` + `parseCommandMarkdown` + `commandFrontmatterField` + `packagedCommandsDir` 留在 entry。
- 全部 28 个公开导出改为从 gates/_shared/service/types **原样 re-export**（`export { X } from './gates/…'`），零签名变化。

### 3.3 依赖图（运行时边）

```
src/index.ts ──> _shared / status / skill-lint / seams / dispatch / catalog / tools / adapter / service / types
adapter ──> status, dispatch, _shared          （status/dispatch 对 adapter 仅 type-only import → 擦除，运行时无环）
tools   ──> seams, _shared
status / skill-lint / seams / dispatch / catalog ──> _shared
```
- **无运行时环**：entry 是唯一扇出点；`adapter→status/dispatch` 与 `tools→seams` 单向。
- **类型环说明**：`gateStatusIntent`/`gateDispatch` 需要 `adapter: DshHostAdapter` 参数类型 —— 用 `import type`（擦除）。若 QC 要求彻底无环，备选：把 `validateStatusValue`/`dispatchGateCore` 抽入 `_shared.ts`（Task 4 决策，默认不抽以最小化搬移）。
- **禁 barrel**：gates 之间只允许显式相对导入；entry 是唯一 re-export 汇聚点。

### 3.4 与 entry 的接线点（apply 内，逐行对应）

| 接线点 | 来源模块 | 现 § |
|--------|----------|------|
| `new HarnessResolver(config.harnessDir)` / `resolver.forWorkspace` | `_shared` | §17 |
| `new DshMstar(ctx, …)` | `service.ts`（不变） | §2 |
| `new DshHostAdapter(ctx, { resolver, config })` | `adapter` | §13 |
| `ctx.plugin(skill-local, skillLocalConfig(config))` | `_shared` | §12 |
| boot warn（hard 缺 binding/tools）`ctx.logger(DISPATCH_LOGGER)` | `dispatch` | §11/§18 |
| `fs/write-intent` → `writeIntentListener` / `editIntentListener` | `status` | §8 |
| `fs/write-intent` → `skillWriteIntentListener` | `skill-lint` | §9 |
| `fs/write-intent` → `seamWriteIntentListener` ×4（`seams` 数组） | `seams` | §10 |
| `tools/pre-execute` → `preExecuteListener` | `dispatch` | §11 |
| `agent/pre-step` → `preStepCatalogListener` + cache（`buildCatalogSources`/`DEFAULT_CATALOG_TTL_MS`/`EXPLICIT_CACHE_KEY`/`CatalogCacheEntry`/`TurnDigest`） | `catalog` | §14 |
| `registerSddIterationTools` / `registerSeamTools` | `tools` | §15 |
| `registerMstarCommands` | entry（保留） | §16 |

### 3.5 任务分步执行要点（T2/T3/T4，机械搬移）

- **Task 2（status + skill-lint + seams）**：先建 `_shared.ts`（Config、HarnessResolver、sessionCwdOf、actorAgentOf、formatViolation、asRecord、resolveSeamHard、packagedSkillsDir、STATUS_FILE）→ 再建 `status.ts`/`skill-lint.ts`/`seams.ts`（含各自 logger 常量）→ entry 改 import + re-export 这 3 组 → 跑全量测试（快照恒等必须绿）。注意 `skillRootsOf` 依赖 `packagedSkillsDir` 先落 `_shared`。
- **Task 3（dispatch + catalog + tools + adapter）**：`_shared` 增 `iterationViolationView`/`iterationGateView`；建 `dispatch.ts`（adapter 需要其 4 个导出）、`catalog.ts`、`tools.ts`（依赖 seams 的 4 个 validator 导出）、`adapter.ts`（最后建——依赖 status/dispatch 导出）；entry re-export `DshHostAdapter` 等；boot warn 的 `DISPATCH_LOGGER` 从 dispatch 导入。
- **Task 4（入口瘦身 + docs + 回归）**：删除 entry 内全部 gate 实现体（§8–§15 的搬移源），仅剩 §3.2 清单；导出面快照测试通过 + 既有导入签名不变；README/entry docs 若引用路径则更新（本文件即接线文档）；全量 suite ≥394、无测试删除；moves-only QC 核对搬移 diff 无逻辑改动。

---

## 4. 验证基线（BASE `76bbad4`）

| 项 | 结果 |
|----|------|
| 全量 `bun test`（BASE） | 394 tests：**392 pass / 2 fail**——2 个失败均为版本断言（`readHarnessVersion()` 期望 `'2.0.4'`，实测 `'2.0.5'`；`composition.spec.ts` + `plugin-shell.spec.ts`）。BASE 上即存在（环境 node_modules engine 已 2.0.5，dsh 测试断言未同步），**与 T1 无关**，由本分支后续版本对齐任务处理。 |
| T1 新增 `tests/export-surface.spec.ts` | **3 pass / 0 fail**（值导出集精确断言 + 类型导出探测 + manifest 契约） |
| 类型检查 | dsh `tsconfig.json` `include: ["src"]`——测试文件不在 tsc 范围；快照测试的类型层断言（全命名空间恒等 + augmentation 探测）在测试被 typecheck 时生效，运行时层由 `bun test` 强制。 |

## 5. 边界（Non-goals）

- 不改 compass / spec / 主 plan 正文（除本 plan Task 1 方案节）；零 dsh-private / knowledge / `status.json` 写；不 publish。
- 命令注册留在入口（属启动接线，非 gate 实现）；`declare module 'cordis'` augmentation 保留在入口（单一 augmentation 点）。
