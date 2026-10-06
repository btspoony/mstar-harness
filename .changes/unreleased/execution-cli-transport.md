---
category: Changed
packages: cli
---

- Added coordinator-only `mstar session run --workflow W --role coordinator [--harness H] -- <argv>`: child-local identity replaces spoofed/legacy inputs, inherits stdio and propagates exit/signal. Session recover replaces the explicitly stopped workflow coordinator under acquired identity and stop attestation.
- Plan file/ACTIVE transports remain disjoint. Current coordinator context may be derived for ordinary actions; explicit session reference/token/operation inputs remain constraints. Mixed authority or numeric ACTIVE expectations refuse before payload IO.
- `mstar workflow register` / `iteration register` publish through the atomic DB registration, `workflow evidence` records the delivery transition and `status workflow-close` performs the terminal lifecycle transition — no file close, no unregister step and no `--ended-at` rewrite survive on the active route. The closed `phase` / `lifecycle` / `execution-policy` / `integration-worktree` grammar joins the existing `mstar workflow` group.
- `store execution restore-preview` and `restore` use ordinary `store backup` images for disaster recovery; `export` reports live execution state. The staged execution migration faces (`preview`, `apply`, `activate`, `retire`, `abort`) were removed. `store activate` remains only the issue/catalog migration step.
- `status validate` reports the root and per-workflow execution tokens the active writes consume as their CAS, so a caller passes `--expect` from a read instead of inventing one.

<!-- CN -->
- 新增 coordinator-only `mstar session run --workflow W --role coordinator [--harness H] -- <argv>`：子进程本地身份替换伪造/legacy 输入，继承 stdio 并传播退出码/信号。Session recover 在独立获取身份与停止见证下替换明确停止的 workflow coordinator。
- Plan 文件/ACTIVE 传输保持互斥。普通动作可推导当前 coordinator context；显式 session reference/token/operation 仍作为约束。混合权威或数值 ACTIVE expectation 在 payload IO 前拒绝。
- `mstar workflow register` / `iteration register` 经原子 DB 注册发布，`workflow evidence` 记录 delivery 转换，`status workflow-close` 执行终态 lifecycle 转换——active 路由上不再有文件 close、不再有 unregister 步骤、不再重写 `--ended-at`。闭合的 `phase`/`lifecycle`/`execution-policy`/`integration-worktree` 语法并入既有 `mstar workflow` 组。
- `store execution restore-preview` 与 `restore` 使用普通 `store backup` 镜像执行灾难恢复；`export` 报告 live execution state。staged execution migration 动词（`preview`、`apply`、`activate`、`retire`、`abort`）已删除。`store activate` 仅保留 issue/catalog migration 步骤。
- `status validate` 报告 active 写入作为 CAS 消费的根级与逐 workflow 执行令牌，因此调用方从一次读取取得 `--expect`，而不是自己编一个。
