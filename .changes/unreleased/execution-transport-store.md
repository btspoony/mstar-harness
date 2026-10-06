---
category: Harness
packages: root
---

- DB coordinator prepare/progress/complete and workflow mutations run inside atomic transactions, advancing applicable revisions once with exact-request receipts.
- While execution authority is **active**, the legacy file route is refused at every entry boundary (`execution.direct-write-refused` / `execution.consumer-not-ready`); a store that exists but cannot be read fails closed instead of serving leftover JSON, and no DB failure falls back to files.
- Coordinator recovery is an explicit attested bootstrap: it names the prior holder, adopts only the ownership that revocation orphaned, and never revives an old-epoch lease.
- Atomic catalog/execution registration publishes catalog delta, ordinary workflow/row metadata, membership and receipt under root CAS; catalog updates never silently move registered pointers.
- Added the **authoritative execution read route** (`readExecutionAuthority` / `resolveExecutionReadRoute` / `readExecutionSource`): workflow/plan state is read from the store in one read transaction, and an authority that is missing, staged, corrupt or busy refuses instead of degrading to leftover root/snapshot JSON, newest-workflow guessing or dashboard projections.
- Workflow coordinator store reads, workflow-wide lease verify-integration, L1 source-metadata/worktree inspection and cleanup enumerate ACTIVE records directly; no per-plan lease verifier or holder admission remains.
- Source readiness only. No installed consumer is switched, no bundle is regenerated or repackaged, no version surface is bumped and no live activation or release is claimed. Deferred session files, side ledgers, packaging parity and installed fencing stay in the 2b backlog; the committed ZCode bundle `hooks/mstar-write-gate.mjs` is knowingly stale against this source and is refreshed with the release round, not here.
- Replaced the staged execution migration preview/apply/activate/retire/abort protocol with the single static `mstar store upgrade --operator <name>` path. The upgrade imports recognizable stopped-workspace state in one run and leaves skipped source bytes in place.
- Kept standalone backup recovery (`store backup`, `store execution restore-preview`, `store execution restore`) and live-state export (`store execution export`) independent from upgrade.
- Added whole-store recovery (`previewExecutionRestore` / `restoreExecutionBackup` / `exportExecutionState`): the backup carries committed WAL-visible work, a restore requires a matching accepted-loss digest and a current safety backup, and the diagnostic export is inert and credential-free.
- CLI/session/host writes use independently acquired workflow coordinator identity with explicit plan addresses and checked or derived current transport context. No per-plan PM identity or child transfer survives.
- Kept the file forms only in explicitly labelled pre-activation sections that also state an active authority refuses them; no active instruction tells a reader to hand-edit a snapshot or to treat a legacy envelope as the live route.
- Made the session reference a lookup rather than a bearer credential: it names a stored row and grants nothing without the caller the engine compares inside its own transaction, and a reference, an expectation value or an operation id is never forwarded into a child assignment. Resume is not recovery — a stopped owner is replaced only by the explicit recovery verb on an active authority, or by the guarded Prepare recovery on the file route.
- Host specifics moved to their owning host references and were sourced from the reviewed implementations; the DSh README pair was realigned on the ledger identity/dedup authority, the durable cursor and the archived display tail.
- Added two vocabulary entries to `CONCEPTS.md`: **Consulted header set** (a label-keyed plan parser consults a closed, exactly-matched label set — never a prefix, so a descriptive sibling such as `Working branch policy` cannot alias a consulted field) and **Maintenance exclusion** (the single outermost lock an engine lifecycle operation holds so no cooperative writer in any package can append into its window; a coordination discipline, not an authority).
- Documented the shipped coordinator identity routes in the skill corpus: the host-owned `mstar_coordinator` entry (`bind`, `show-recovery`, `recover`), the local `plan bind --coordinator --session-id` form, the `mstar workflow recover-coordinator` verb, and the registered-plan pointer forms. The corpus now separates them explicitly from the active-store DB recovery (full execution token + stop attestation) and from the native one-shot handoff (`mstar-host/references/omp.md`, `mstar-use-cli/references/plan-and-workflow.md`, `mstar-use-cli/references/preconditions.md`).
- Registered plan pointers are documented as the **canonical absolute** `{PLAN_DIR}/<plan-id>.md` — a canonical absolute or normalized harness-relative input is accepted, the repository-relative `.mstar/plans/<id>.md` spelling is refused before the first journal/snapshot/root write — and the guarded `correctPlanFiles` correction is the only same-row repair, changing only `row.file` plus `updated_at` under the existing Prepare admission and double byte-version CAS (`mstar-artifacts/references/status-and-residuals.md`, `mstar-iteration/references/phase-1-prepare.md`).
- Workflow coordinator identity is explicitly acquired; public recovery output contains safe facts, never envelope paths/body. No Assignment or row identity is a binding input.
- Documentation only: no source behaviour, flag or refusal code changes here, and no installed generation, released verb availability or operational handoff is claimed.

<!-- CN -->
- DB coordinator prepare/progress/complete 与 workflow 变更在原子事务内执行，通过精确请求收据令适用 revision 仅推进一次。
- 执行权威处于 **active** 时，旧文件路线在每个入口边界被拒绝（`execution.direct-write-refused` / `execution.consumer-not-ready`）；存在但不可读的 store 直接失败关闭而不再回退到残留 JSON；任何 DB 失败都不会回退到文件。
- 协调者恢复是显式的存证引导：必须命名前任持有者，只接管由撤销该持有者而孤儿化的所有权，且绝不复活旧 epoch 的租约。
- Catalog/execution 原子注册在根 CAS 下发布 catalog delta、普通 workflow/row metadata、成员关系与收据；catalog 更新不静默移动登记指针。
- 新增**权威执行读取路由**（`readExecutionAuthority` / `resolveExecutionReadRoute` / `readExecutionSource`）：workflow/plan 状态在单个读事务中从 store 读取；权威缺失、staged、损坏或忙时一律拒绝，而不是降级到残留的 root/snapshot JSON、猜测最新 workflow 或 dashboard 投影。
- Workflow coordinator store 读取、workflow-wide lease verify-integration、L1 source-metadata/worktree 检查及清理直接枚举 ACTIVE 记录；不再保留逐行 lease verifier 或 holder 准入。
- 仅为源码就绪。不切换任何已安装消费方，不重新生成或重新打包 bundle，不推进任何版本面，也不声称 live 激活或发布。延迟的 session 文件、side ledger、打包一致性与已安装隔离仍留在 2b 待办；已提交的 ZCode bundle `hooks/mstar-write-gate.mjs` 相对本源码有意保持陈旧，随 release 轮次刷新，不在此处处理。
- 将分段执行迁移的 preview/apply/activate/retire/abort 协议替换为唯一静态 `mstar store upgrade --operator <name>` 路径：一次导入已停止工作区中可识别的状态，并让跳过的源字节留在原处。
- 保留独立备份恢复（`store backup`、`store execution restore-preview`、`store execution restore`）与 live-state 导出（`store execution export`），不与 upgrade 路径耦合。
- 新增全库恢复（`previewExecutionRestore` / `restoreExecutionBackup` / `exportExecutionState`）：备份包含已提交的 WAL 可见工作，恢复要求匹配的已接受损失摘要与一份当前安全备份，诊断导出为惰性且不含凭据。
- CLI/session/host 写入使用独立获取的 workflow coordinator 身份、明确 plan 地址和显式约束或推导的当前传输 context。不再保留逐行 PM 身份或子级转交。
- 文件形态仅保留在显式标注的 pre-activation 章节，并同处声明 active 权威会拒绝它们；不再有任何 active 指令让读者手改 snapshot 或把 legacy 信封当作现行路由。
- 会话引用是**查找**而非持有凭据：它只命名一行已存记录，缺少引擎在自己事务内比对的调用方则不授予任何东西；引用、期望值与 operation id 绝不转发进子交接。resume ≠ recovery——已停止的持有者只能由 active 权威上的显式恢复动词替换，或在文件路由上由受守卫的 Prepare 恢复替换。
- 宿主细节移入其归属的 host reference，并以已评审实现为准；DSh README 双语对在 ledger 身份/去重权威、持久游标与归档显示尾部上重新对齐。
- 向 `CONCEPTS.md` 补入两个词条：**Consulted header set**（按标签解析计划时只咨询一个封闭且精确匹配的标签集合，绝不前缀匹配，因此 `Working branch policy` 这类描述性兄弟标签不会别名成被咨询字段）与 **Maintenance exclusion**（引擎生命周期操作持有的最外层单一锁，使任何包的协作写者都无法在其窗口内追加；它是协作纪律，不是权限）。
- 在技能正文中记录已交付的 coordinator 身份路径：宿主自有入口 `mstar_coordinator`（`bind`、`show-recovery`、`recover`）、本地 `plan bind --coordinator --session-id` 形态、`mstar workflow recover-coordinator` 动词，以及注册 plan 的指针形式。正文现明确把它们与 active-store 的 DB 恢复（完整 execution token + stop 证明）和原生一次性 handoff 区分开（`mstar-host/references/omp.md`、`mstar-use-cli/references/plan-and-workflow.md`、`mstar-use-cli/references/preconditions.md`）。
- 注册 plan 的指针记录为**规范绝对路径** `{PLAN_DIR}/<plan-id>.md`——接受规范绝对路径或规范化 harness 相对路径，仓库相对拼写 `.mstar/plans/<id>.md` 在第一条 journal／snapshot／根写入之前即被拒绝；受守卫的 `correctPlanFiles` 修正是唯一的同行修复手段，在既有 Prepare 准入与双重字节版本 CAS 下只改动 `row.file` 与 `updated_at`（`mstar-artifacts/references/status-and-residuals.md`、`mstar-iteration/references/phase-1-prepare.md`）。
- Workflow coordinator 身份必须明确获取；公开恢复输出只含安全事实，不含 envelope 路径/正文。Assignment 或逐行身份不构成 bind 输入。
- 仅文档变更：不改任何源码行为、标志或拒绝码，也不声称已安装代次、已发布动词可用性或真实 handoff。
