---
category: Harness
packages: root, cli, engine, commands
---

- **Recovery-first engine surface.** Exported lifecycle operations (`mutatePlanCoordination`, `mutateExecutionPlan`, `mutateExecutionWorkflow`, `amendPrepareWorkflow`, the registration producers and the closes) accept a sparse intent — omitted redundant selectors, revisions, session projections and copied metadata — resolved against the caller's trusted root, its durable association and recorded declarations, with transaction-local inputs staying strict. Published resolvers: `resolveIntentRoot`, `resolveIntentTarget`, `resolveCurrentAuthority`.
- **One recovery sidecar on every outcome.** A successful value carries `recovery`; a refusal carries the same object under `error.details.recovery` (`outcome`, `applied`, `unresolved`, `resolvedFrom`, `warnings`, `commitState`), so a partially applied compound intent is never reported as a mutation-free refusal.
- **Semantic replay instead of transport freshness.** A repeated intent is a current success with no revision, receipt or byte churn; a revision that moved without the intent changing is a drift warning rather than a refusal; a genuinely different payload or target still refuses.
- **Registration derives its own identity.** `derivePlanRegistration` and `deriveLifecyclePhase` derive a plan's id/title/pointer and an iteration's phase with the selected document as the authority; an interrupted registration finishes its missing link on retry and a phase-less iteration is derived on read.
- **Prepare amendment commits per component.** Independent components land and withheld ones report one minimum decision each in the stable `append plan <id>` / `correct-plan-file <id>` / `integration-worktree <path>` / `execution-policy <value>` vocabulary — one partial receipt per call on both authority routes, no applied component applied twice on replay.
- **Every declared lifecycle state has a writer, on both routes.** Evidence recorded before a row is `Done` completes the report-only tail; `closeFileWorkflow` is the file authority's one close verb and the DB route composes the same intent on one handle; explicit `failed`/`stopped` outcomes are recordable on both routes, settling only owned claims of non-live holders and preserving the first `ended_at`.
- **Additive engine exports only.** New: `closeFileWorkflow`, the intent resolvers, phase constants, `CloseWorkflowOutcome` and the resolution/derivation/close types. No export renamed or removed.
- **CLI and MCP recovery transports.** The CLI and stdio MCP share the command registry and return the same versioned outcome envelope for recovery-sensitive commands; MCP tool schemas expose the registry's payload contracts, and the smoke probe runs against isolated file and SQLite roots.
- **`roadmap replace` states its own comparison basis.** `--expect-project` and `--expect-roadmap` are irreducible caller claims; an omitted claim is one aggregated usage refusal naming both flags, and a stale claim refuses `roadmap.revision-conflict` with nothing written (the guard no longer compares the authority against itself).
- **MCP tool schemas no longer advertise fields the handler does not read**, and a declared string-or-null payload field (`IssueTriage.owner`) keeps its type instead of degrading to `z.unknown()`.
- **Cancellation during a dashboard start stops the listener it created** instead of leaking a connection-scoped service; a handle another call already owns is reused and left running.
- **`plan issue-add` derives plan-owned project association per finding** and reports independently invalid entries with their array indexes before capture; DB capture and plan linking stay composed in one transaction with occurrence keys as stable event identities.
- **Declared per-kind `persist.write` payload schemas**; aggregate status validation failures surface through the persist command while coordinated replacement/version-conflict handling is preserved.
- **Documented `judgment review-advice` as the supported route** for the historical, unregistered `judgment submit` intent; ReviewDecisionPack-owned fields are derived and multiple missing pack paths surface together.
- **Documented `mstar-harness schema` discovery** for issue capture/occurrence/triage/closure/link and plan progress payloads; disposition-specific fields are checked before writing, not guessed through repeated refusals.
- **Test corpus cleanup.** Every inventoried package corpus (engine, cli, commands, omp, opencode, judgment) was swept under one written keep/delete rule: assertions pinning source shape, wording/help prose, forwarding echoes, duplicated registry copies, exported arity or environment constants were deleted, not renamed or re-pinned; consumer-visible behavior, boundaries, atomicity, authority, replay and actionable diagnostics were retained.
- **Development acceptance stays isolated.** Acceptance language aligned with isolated product-behavior proof rather than live provider, authenticated host, installed artifact or device receipts; separately authorized operational verification remains independent.
- **Native model-handoff preference off is a success-shaped no-op** with a neutral notice at both direction-lock and phase-1-lock; enabled handoff still checks coordinator identity and actual readiness.
- Allowed sparse active workflow mutations and workflow close to derive current tokens and generate one operation id when omitted; explicit session references and tokens remain constraints.
- ACTIVE cleanup reads the authoritative store; a launched minted coordinator identity takes precedence over ambient identity without granting unrelated workflow authority.

<!-- CN -->
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
- **明确 `judgment review-advice` 是历史未注册 `judgment submit` 意图的受支持路由**；ReviewDecisionPack 契约字段自动补全，多个缺失路径一并指出。
- **补充 `mstar-harness schema` 查询指引**（issue 捕获/复现/分诊/关闭/关联及 plan progress 载荷）；按处置类型预先核对字段，不再逐项试错。
- **测试语料清理。** 所有登记在册的包语料（engine、cli、commands、omp、opencode、judgment）按同一条书面保留/删除规则完成清扫：仅固定源码形态、措辞/帮助文案、转发回声、重复注册表副本、导出元数或环境常量的断言一律删除而非重新固化；面向使用者的行为、边界、原子性、授权、重放与可操作诊断均予保留。
- **开发验收保持隔离。** 验收语言对齐隔离的产品行为证据，不要求真实供应商、已认证宿主、已安装产物或设备收据；另行授权的运维验证保持独立。
- **原生模型交接偏好关闭即成功形态无操作**，direction-lock 与 phase-1-lock 均返回中性通知；开启时仍校验协调者身份与真实就绪条件。
- 活跃 workflow 修改与关闭允许稀疏调用：省略时从当前作用域派生令牌并生成一次操作 ID；显式会话引用和令牌仍作为约束校验。
- ACTIVE 清理读取权威 store；启动时铸造的 coordinator 身份优先于环境身份，不因此授予其他 workflow 权限。
