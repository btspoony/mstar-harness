---
category: Changed
packages: cli
---

- Added `mstar session run --workflow W --role coordinator|plan-pm [--plan P] [--harness H] -- <argv>`: it mints one local identity for the child, overwrites the identity channel, removes the legacy one, inherits stdio and propagates the child's exit code or the signal that killed it. `mstar session recover` replaces a stopped coordinator under an independently acquired identity, a named prior holder and a stop attestation.
- `mstar plan` now carries both transports disjointly: `--session` runs the unchanged pre-activation file call, while `--session-ref` plus the addressed scope's full execution token as `--expect` plus `--operation` runs the DB verbs. A mixed invocation, a partial active flag set, a numeric expectation on the active route and `--session-id` there are usage refusals decided before any IO.
- `mstar workflow register` / `iteration register` publish through the atomic DB registration, `workflow evidence` records the delivery transition and `status workflow-close` performs the terminal lifecycle transition — no file close, no unregister step and no `--ended-at` rewrite survive on the active route. The closed `phase` / `lifecycle` / `execution-policy` / `integration-worktree` grammar joins the existing `mstar workflow` group.
- Added the execution operator family under the existing `store` group: `store execution preview | apply | activate | retire | abort | restore-preview | restore | export`. Each verb validates its own flags and forwards the operator's reviewed documents into the real engine operations; the mutating forms fail closed (exit 2) when the artifact of the boundary they cross is missing, and `restore` requires the exact accepted-loss digest — there is no default yes.
- `store activate` stays the issue/catalog barrier and is never aliased to execution activation: the execution barrier is `store execution activate`, and no verb in the family claims lease recovery or touches the issue/catalog retirement path.
- `status validate` reports the root and per-workflow execution tokens the active writes consume as their CAS, so a caller passes `--expect` from a read instead of inventing one.

<!-- CN -->
- 新增 `mstar session run --workflow W --role coordinator|plan-pm [--plan P] [--harness H] -- <argv>`：为子进程铸造一个本地身份、覆盖身份通道、删除 legacy 键、继承 stdio，并传递子进程退出码或被信号杀死时的信号。`mstar session recover` 在独立获取的身份、具名前任持有者与停止见证下替换已停止的协调者。
- `mstar plan` 现在**不相交地**承载两种传输：`--session` 走未变的 pre-activation 文件调用；`--session-ref` + 被寻址 scope 的**完整执行令牌**（`--expect`）+ `--operation` 走 DB 动词。混用调用、active 旗标不全、active 路由上传入数字期望、以及在该路由传 `--session-id`，都在任何 IO 之前以 usage 拒绝。
- `mstar workflow register` / `iteration register` 经原子 DB 注册发布，`workflow evidence` 记录 delivery 转换，`status workflow-close` 执行终态 lifecycle 转换——active 路由上不再有文件 close、不再有 unregister 步骤、不再重写 `--ended-at`。闭合的 `phase`/`lifecycle`/`execution-policy`/`integration-worktree` 语法并入既有 `mstar workflow` 组。
- 在既有 `store` 组下新增执行操作族：`store execution preview | apply | activate | retire | abort | restore-preview | restore | export`。每个动词校验自身旗标并把操作者评审过的文档转发给真实引擎操作；变更型动词在缺少其跨越边界所需制品时 fail-closed（exit 2），`restore` 必须给出精确的已接受丢失摘要——没有默认 yes。
- `store activate` 仍是 issue/catalog 屏障，绝不别名为执行激活：执行屏障是 `store execution activate`；该族中没有任何动词声称租约恢复或触碰 issue/catalog 退役路径。
- `status validate` 报告 active 写入作为 CAS 消费的根级与逐 workflow 执行令牌，因此调用方从一次读取取得 `--expect`，而不是自己编一个。
