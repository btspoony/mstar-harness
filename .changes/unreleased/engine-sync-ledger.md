---
packages: engine
---

- **Sync ledger substrate.** Store migration 15 adds `project_bindings`, `issue_sync_state` and `sync_cursor`, and `issue-sync.ts` adds the item state machine (`unbound → pending → applied | failed | skipped`) with revision-guarded transitions and operation replay. Each public verb commits its ledger row and its `store_operations` receipt in **one transaction**, so an interrupted sync retries instead of hitting a one-way door. Skips record their reason in a dedicated column (never as the ledger's last error), retries keep the recorded remote identity, and rewriting the cursor already recorded is a no-op. New refusal `sync.local-issue-missing` names a `localId` that is not an issue in the store. `issue capture` on a local source identity that collides with a mirrored row's synthetic identity is now refused as `issue.scope-refused`, so a local capture **by identity** can never append an occurrence to an imported row (the id-addressed occurrence path is not guarded yet).

<!-- CN -->
- **同步账本基座。** store 迁移 15 新增 `project_bindings`、`issue_sync_state`、`sync_cursor`；`issue-sync.ts` 增加条目状态机（`unbound → pending → applied | failed | skipped`），带修订守卫与操作重放。每个公开动词都把账本行与 `store_operations` 收据放在**同一个事务**中提交，因此中断后是重试而不是撞上单向门。跳过原因写入独立列（绝不冒充账本的最后错误），重试保留已记录的远端身份，重复写入相同游标是空操作。新拒绝码 `sync.local-issue-missing` 表示 `localId` 在 store 中不存在。本地 capture 的 `sourceIdentity` 若与镜像行的合成身份相撞，现在以 `issue.scope-refused` 拒绝，因此本地 capture **按身份** 永远不能向导入行追加 occurrence（按 `issueId` 追加的路径尚未加守卫）。
