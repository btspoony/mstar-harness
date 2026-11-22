---
category: Breaking
packages: root
---

- **An existing collaboration lane must be upgraded explicitly.** The lane now carries a second immutable migration
  (`collaboration-remote-cache`, version 2) that adds the stable `issues.issue_ref` and the remote cache tables.
  `mstar store upgrade --operator <name>` advances an admitted version-1 lane in place, preserving its issue history
  and minting one stable reference per issue; every ordinary read, write and `store init` refuses
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
- The durable remote write outbox, provider transport, and sandbox handoff remain unimplemented;
  `remote adopt-issue` refuses `remote.outbox-unavailable`, and every local domain write refuses
  `collaboration.mode-unavailable` in remote mode.

<!-- CN -->
- **已存在的协作 lane 必须显式升级。** lane 现携带第二个不可变迁移（`collaboration-remote-cache`，版本 2），新增稳定的
  `issues.issue_ref` 与远程缓存表。`mstar store upgrade --operator <name>` 就地推进已准入的版本 1 lane，保留其 issue
  历史并为每个 issue 生成一个稳定引用；在该升级执行前，普通读取、写入与 `store init` 都以
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
- 持久化远程写 outbox、provider 传输与 sandbox 交接仍未实现；`remote adopt-issue` 以 `remote.outbox-unavailable` 拒绝，
  remote 模式下所有本地域写入以 `collaboration.mode-unavailable` 拒绝。
