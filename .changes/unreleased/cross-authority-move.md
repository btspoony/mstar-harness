---
category: Breaking
packages: root
---

- **Every existing collaboration lane must be advanced to version 4, and the execution store gains version 22.** The lane
  now carries `collaboration-cross-authority` (version 4: a nullable `relations.to_issue` beside `to_ref`, the `issue_moves`
  ledger and fence, and the triggers that hold it), and the execution store gains `execution-issue-move-intent` (version 22),
  which rebuilds `execution_collaboration_intents` with a fifth composite kind, `issue-move`. `mstar store upgrade --operator
  <name>` advances an admitted version-1, -2 or -3 lane through the remaining steps in one `BEGIN IMMEDIATE`, and advances the
  execution store in the same invocation; every ordinary read, write and `store init` refuses
  `collaboration.upgrade-required` until the lane half ran, and a store below version 22 cannot record a move phase. A
  `remote` cache is never upgraded in place: `remote bind` replaces a pre-v4 cache, and refuses `remote.effect-pending` —
  naming the outbox route — while any intent is still `enqueued`, `unconfirmed`, or a `conflict` with no settlement reached.
- **One record can now move to another authority as a staged, resumable move.** `issue move --to-authority <repo-key>` walks
  `staged` → `verified` → `switched` → `published`; the source row of the new `issue_moves` ledger is both the ledger and the
  fence, so from `staged` on every `issues`, `relations` and `issue_sync_state` write to that record aborts and reaches the
  caller as `collaboration.operation-partial`. The same command resumes from whatever phase the ledger holds, `--discard`
  abandons a move at or before `switched` and leaves the source record byte-identical — it carries the record's `--expect`
  and no `--expect-store`, which a move's own phase commits have already advanced — and publication happens once per
  operation id before deleting the source record, its children and its settled mirror rows.
- **A relation whose target lives outside the lane is stored instead of refused.** `relations.to_issue` is nullable and
  `to_ref` holds the target's stable `IssueRef`; exactly one of the two is set, and the table refuses a row with both or
  neither. Both local readers answer `toIssue: null` / `toRef` / `title: null`, the row becomes a local relation in the
  transaction that admits the target, and a record frozen by a move is never a mirror push candidate. Local `issue show` and
  the `issue-detail` view now return the record's `issueRef`.
- **Three refusal codes join the contract.** `issue.move-in-progress` is the source fence a write meets (and
  `collaboration.move-phase-invalid` a transition that the ledger forbids) and `collaboration.move-destination-occupied` an
  occupant under the same reference that does not already hold the frozen image.
- **`mstar issue move` gains the cross-authority surface.** `--to-authority <repo-key>` selects the staged route (without it
  the verb keeps its local project reassignment). A destination that resolves to the record's own authority refuses
  `issue.scope-refused` before anything is staged.

<!-- CN -->
- **所有既有协作 lane 必须推进到版本 4，execution store 新增版本 22。** lane 现携带
  `collaboration-cross-authority`（版本 4：可空的 `relations.to_issue` 与 `to_ref` 并存、`issue_moves` 账本与栅栏，以及
  维持它的触发器），execution store 新增 `execution-issue-move-intent`（版本 22），重建
  `execution_collaboration_intents` 并加入第五个 composite kind `issue-move`。`mstar store upgrade --operator <name>`
  在一个 `BEGIN IMMEDIATE` 内把已准入的版本 1、2 或 3 lane 走完剩余步骤，并在同一次调用中推进 execution store；在 lane
  这一半执行前，普通读取、写入与 `store init` 都以 `collaboration.upgrade-required` 拒绝，而低于版本 22 的 store 无法记录
  迁移阶段。`remote` 缓存绝不被就地升级：`remote bind` 替换 pre-v4 缓存，且只要还有 `enqueued`、`unconfirmed` 或未达成
  结算的 `conflict` intent，就以 `remote.effect-pending` 拒绝并给出 outbox 恢复路径。
- **一条记录现在可以以分阶段、可恢复的方式迁移到另一个权威。** `issue move --to-authority <repo-key>` 依次走
  `staged` → `verified` → `switched` → `published`；新增 `issue_moves` 账本的 source 行既是账本又是栅栏，因此从
  `staged` 起，对该记录的任何 `issues`、`relations`、`issue_sync_state` 写入都会中止，并以
  `collaboration.operation-partial` 报告给调用方。同一命令从账本记录的任意阶段续跑，`--discard` 在 `switched` 或之前
  放弃迁移并让 source 记录逐列不变——它只携带记录的 `--expect`，不带 `--expect-store`（迁移自身的阶段提交已推进该
  lane revision）——发布对每个 operation id 只发生一次，并在删除 source 记录、其子行与已结算的
  mirror 行之前完成核对。
- **目标位于 lane 之外的关系现在被存储，而不是被拒绝。** `relations.to_issue` 可空，`to_ref` 保存目标的稳定
  `IssueRef`；两者恰好设置一个，表会拒绝两者皆空或皆设的行。两个本地读取端都作答 `toIssue: null` / `toRef` /
  `title: null`，在准入该目标的同一事务中该行变为本地关系，被迁移冻结的记录也不会成为 mirror 推送候选。本地
  `issue show` 与 `issue-detail` 视图现返回该记录的 `issueRef`。
- **三个拒绝码加入契约。** `issue.move-in-progress` 是写入遇到的 source 栅栏（账本禁止的转换则是
  `collaboration.move-phase-invalid`），`collaboration.move-destination-occupied` 是同引用下并不持有既定镜像的占用者。
- **`mstar issue move` 新增跨权威入口。** `--to-authority <repo-key>` 选择分阶段路线（不带它时该动词仍做本地项目改派）。
  目标解析为记录自身权威的迁移以 `issue.scope-refused` 拒绝，且在任何暂存发生前完成。
