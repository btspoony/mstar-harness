# Worktree / branch cleanup（merge 后回收）

> **Load when:** running or interpreting `mstar worktree cleanup`, planning Phase-2 same-round or Phase-6 post-merge recovery, or deciding Done-child eligibility while a parent lifecycle is still active.

> **Owner:** sole cleanup contract body; `mstar-iteration` call sites only point here.

生命周期末端的物理回收（feature/integration worktree、本地/远端分支删除）的 ownership 与守卫规则**只在本节**；两条时序车道的 call site（Phase-2 同轮 / Phase-6 收尾）只引用本节，不复制规则。命令（**dry-run 默认**；无 fetch / prune / 任何写入）：

```text
mstar worktree cleanup --workflow <id> [--harness <path>] [--apply] [--remote] [--worktree <path>] [--all-workflows] [--verbose]
```

- dry-run 逐候选打印 `verdict | kind | ref | reason` 后结束；`--apply` 只执行当前 `remove` 行。Exit：0 = 合法 dry-run / eligible 移除全部成功；1 = 探测/变更失败；2 = usage。失败行**永不扩大范围**；受保护/拒绝行保持可见。
- **候选范围（默认 scoped）**：默认候选只来自**选中 workflow 的记录归属**（ACTIVE：store 执行行元数据；或已验证的 `--worktree` 断言）；`--all-workflows` 恢复**全量扫**（含未记录 ref 与所有 workflow 的候选）。`--worktree <path>` 可重复：既收窄 worktree 候选集，也是**操作者所有权断言**——必须匹配记录的生命周期分支与同仓 checkout 身份，不能认领其他 lifecycle 的 worktree；带 `--worktree` 时本地分支候选进一步收窄到与保留断言 owner 精确同属的分支（无命中的断言 owner ⇒ 无分支候选，**没有**全量回退；missing / 越界的断言路径只产出一条 note，不构造目标）。
- `--remote` 只决定是否纳入 `origin/*` 删除候选；**本地**合并证据（`git branch --merged <base>` 成员资格）**无论是否 `--remote` 都会无条件收集**，**远端** integration 证据仅在使用 `--remote` 时收集。证据探测**有界**：base 解析一次、每个去重 base OID 至多一组 membership sweep + pass 内不可变备忘录，`--verbose` 追加逐对 ancestry 诊断（不改变候选与判定）。
- **信任模型**：`--harness <path>` 为操作者提供且受信——dry-run 与 `--apply` 的全部状态事实（lease、行归属元数据、protected 锚点）均读自该目录的 `store.db`。
- **来源选择（ACTIVE 权威）**：状态事实来自**一次**权威读（`readExecutionCleanupState(context, workflowId)`）——它独立于 registry 成员资格寻址被选 workflow（terminal / 已 unregister 后仍可寻址），并返回**完整保护清单**（全部 retained sibling 的 lease / 行归属 / protected 锚点）。retired/缺失的 JSON 不参与、也不被修复；权威损坏（保护行不可解析）**fail-closed 拒绝**整次读，绝不静默丢弃 sibling 保护。

**Ownership (never infer from names):** use retained row `metadata.working_branch`/`metadata.worktree_path`, track Assignments, valid Done completion source branch/path or a verified explicit `--worktree` assertion. Paths compare canonically; missing/ambiguous/foreign claims refuse. Direct complete persists source metadata with Done in the same transaction; cleanup never repairs state, advances rows or requires a deleted transfer state. Historical evidence may protect resources without authorizing deletion.

**合并证据硬前置**：本地资格 = `git branch --merged <base>` 成员资格，base 取候选自己的锚（plan/track → `branch.integration`；standalone plan / integration 分支 → `branch.target`）。远端证据绑定 {branch, tip, base} **同一分支化身**；当前 harness 无 PR-merged 记录源（`prMerged` 恒为 null）→ 远端仅走 tip-ancestor 历史残留路线。squash-only（tip 非 base 祖先）**保留并报告，绝不 `git branch -D`**；旧 merged PR 不能授权已复用分支的新化身。

**Refusals:** active workflow integration exclusion remains protected across known workflows; any checked-out branch, foreign/ambiguous ownership, dirty/locked checkout, protected anchors or nonterminal rows refuse removal. No names/age/labels bypass these guards.

**Cleanliness（owner 可见的删除后果）**：普通 `git status --porcelain` 将 tracked 修改与非 ignored 的 untracked 文件视作 dirty，仍拒绝移除；仅有 ignored 内容不再阻塞 eligible worktree 移除。`--apply` 移除该 worktree 时其中 ignored 内容也会被删除，Git 不为其提供恢复保障；owner 在执行前须确认该后果。status 探测失败仍使命令中止（exit 1），不得当作 clean；dirty / locked refusal 与**永不 force** 保持不变。

**Done child ≠ active parent**：已 merge 的 Done plan/track 行**即使父迭代仍在运行也 eligible**（时序车道 1）——不存在「父必须终结」的一刀切；反之，非终结 integration 与非 Done 行跨**所有** lifecycle 受保护。standalone plan 即整个 lifecycle：以 `branch.target` 为证据 base，且**先 terminal close** 才清理。

**顺序（--apply；worktree 移除 ≠ 分支删除）**：普通 `git worktree remove`（**永不 force**）移除 eligible attached worktree → **重新探测 + 重新规划** → 删除**现已**未检出的分支（`git branch -d`，**永不 `-D`**）→ 远端 expected-OID compare-and-delete（`git push --force-with-lease=refs/heads/<branch>:<observed-oid> origin :refs/heads/<branch>`；ref 已移动 → `cleanup.refuse.facts-changed`，**不**自动用新 OID 重试）。dry-run 打印 worktree `remove` + 其分支 `refuse(checked-out)` 是合法状态。**禁止**全局 `git worktree prune`（会动 foreign 注册）；Git 调用默认在 main worktree root，`git branch -d` 在该分支证据 base 的检出处执行（`-d` merged-into-HEAD 语义所需）——任何 Git 调用**永不位于移除候选内**。

**Cleanup/close never releases write exclusion:** ordinary direct complete releases applicable exclusion with verified Done; retained row source metadata/track Assignments preserve ownership afterward. A protected resource is not made eligible through state edits or takeover.

**两条时序车道（唯一合法时机）**：

1. **Phase-2 同轮**（per-plan）：integration merge 成功的**同一轮**回收该 Done plan/track 的 feature worktree + 已合并分支（call site → `mstar-iteration` `references/phase-2-worktree-lease.md`「Same-round plan cleanup」）。
2. **Phase-6 收尾**（integration 面）：只在 valid terminal close（§6.1–§6.3 完成）+ PR **proved merge** 之后回收 integration worktree / 分支 / 远端残留（call site → `mstar-iteration` `references/phase-6-post-merge-close.md` §6.4）。Phase-6 gate 只查本地 state，**不**验证 merged、**不**检查物理清理是否完成。

> **Engine check:** dry-run 即机器检查 —— `mstar worktree cleanup --workflow <id>`（engine `planWorktreeCleanup`）对当前 facts 输出 remove/keep/refuse 计划，每行带稳定 `cleanup.*` 码。若已知受保护目标（active lease / 非 Done / 非终结 owner）出现 `remove` → STOP：守卫有错，**任何 `--apply` 前先修**。On `fail`, do not proceed — fix and re-run. Contract → **`mstar-use-cli`** `references/checks-and-lints.md` § Engine check callouts.
