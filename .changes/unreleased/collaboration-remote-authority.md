---
category: Breaking
packages: root
---

- **An existing collaboration lane must be upgraded explicitly.** The lane now carries two further immutable migrations —
  `collaboration-remote-cache` (version 2: the stable `issues.issue_ref` and the remote cache tables) and
  `collaboration-remote-outbox` (version 3: `remote_outbox` and `remote_outbox_receipts`).
  `mstar store upgrade --operator <name>` advances an admitted version-1 lane in place to version 3, preserving its issue
  history and minting one stable reference per issue; every ordinary read, write and `store init` refuses
  `collaboration.upgrade-required` until that upgrade ran.
- **`local`/`mirror` checkouts on an origin-backed repository now need a live Git selector lookup.** A failed lookup is
  `remote.selector-unavailable` instead of assumed absence, and a published `draining` selector stops local/mirror
  writers with `collaboration.stale-binding`. A checkout keeps its own lane only when the origin confirms no selector.
- **`remote` mode is implemented.** The protected selector is the only selection authority; the checkout's database is a
  verified observation cache maintained by `mstar store collaboration remote status|bind|observe`. Required views,
  counts and gates answer from admitted snapshots or refuse with `remote.unavailable`,
  `collaboration.observation-incomplete` or `collaboration.observation-stale`; they never fall back to local rows.
  Switching a published `local`/`mirror` lane to remote is the reviewed transition: `remote bind` retires the
  predecessor under write exclusion to `collaboration.retired-<storeId>-<epoch>.db` beside the lane and creates the
  cache only afterwards.
- **Freshness now has two clocks.** A required view, count, rollup or findings/completion gate needs a current positive
  access check AND an observation whose provider traversal started inside the same 60-second window; a completion
  witness is also bound to its exact selector commit and generation. Optional views disclose the gap instead.
- **A collaboration mutation re-proves its selection before commit.** A selector that moves to a draining or successor
  generation while a writer waits rolls the effect back, and a missing private cache never substitutes for the
  checkout's recorded selector lineage.
- **Remote writes are durable intents, not provider calls.** In a `remote` checkout every business write freezes an
  intent in the version-3 outbox (`remote adopt-issue` enqueues an `issue-adopt` intent) and refuses
  `remote.effect-pending` until a recorded receipt confirms it; a lane still below version 3 refuses
  `remote.outbox-unavailable` and is advanced by `store upgrade`. The CLI performs no provider call —
  `outbox-dispatch` issues the host's single send permit — so no credential or transport ships in the checkout.

<!-- CN -->
- **已存在的协作 lane 必须显式升级。** lane 现携带两个后续不可变迁移——`collaboration-remote-cache`（版本 2：稳定的
  `issues.issue_ref` 与远程缓存表）与 `collaboration-remote-outbox`（版本 3：`remote_outbox` 与
  `remote_outbox_receipts`）。`mstar store upgrade --operator <name>` 就地推进已准入的版本 1 lane 至版本 3，保留其
  issue 历史并为每个 issue 生成一个稳定引用；在该升级执行前，普通读取、写入与 `store init` 都以
  `collaboration.upgrade-required` 拒绝。
- **有 origin 的仓库上，`local`/`mirror` 检出现在需要实时 Git selector 查询。** 查询失败为
  `remote.selector-unavailable`，不再被当作“没有 selector”；仓库发布了 `draining` selector 时，local/mirror 写入以
  `collaboration.stale-binding` 停止。只有当 origin 确认不存在 selector 时，检出才保留自己的 lane。
- **`remote` 模式已实现。** 受保护 selector 是唯一的选源权威；检出数据库只是由
  `mstar store collaboration remote status|bind|observe` 维护的已验证观测缓存。必需视图、计数与门禁只从已准入快照作答，
  否则以 `remote.unavailable`、`collaboration.observation-incomplete` 或 `collaboration.observation-stale` 拒绝，
  绝不回退到本地行。把已发布的 `local`/`mirror` lane 切到 remote 需走审查过的迁移：`remote bind` 在写入排他下把前身
  lane 退休为同目录的 `collaboration.retired-<storeId>-<epoch>.db`，随后才创建缓存。
- **新鲜度现在有两个时钟。** 必需视图、计数、汇总或 findings/完成门禁既需要当前有效的正向访问校验，也需要 provider
  遍历开始时间落在同一个 60 秒窗口内；完成证据还绑定其确切的 selector commit 与 generation。可选视图只披露缺口。
- **协作写入在提交前重新证明选源。** 若 selector 在写入方等待期间移动到 draining 或后继 generation，效果回滚；私有缓存
  缺失也不能替代检出记录的 selector 血缘。
- **远程写入是持久 intent，而不是 provider 调用。** 在 `remote` 检出中，每个业务写入都会在版本 3 的 outbox 中冻结一个
  intent（`remote adopt-issue` 入队 `issue-adopt` intent），并持续以 `remote.effect-pending` 拒绝，直到记录的 receipt
  确认该效果；仍低于版本 3 的 lane 以 `remote.outbox-unavailable` 拒绝，并通过 `store upgrade` 推进。CLI 不执行任何
  provider 调用——`outbox-dispatch` 只签发宿主的唯一发送许可——因此检出中不携带凭据或传输实现。
