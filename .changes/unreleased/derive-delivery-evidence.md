---
category: Harness
packages: root, engine, commands
---

- **Delivery evidence no longer carries a hand-recorded PR identity.** The `delivery.pr` member is gone: the PR head and target ARE the registered `branch.work` / `branch.target` anchors (contract §4d), so recording a copy is refused as an unused member and a repaired anchor can no longer strand a frozen identity.
- **`delivery.merge` is now one optional fact: the provider commit.** The shape is `{ commit?: string }` — a full lowercase 40- or 64-hex commit id. The free-text `provider` / `evidence` attestation, which gated `completed` while nothing verified it, is deleted.
- **The merge is proven from local Git, once, for both consumers.** `verifyDeliveryEvidence` runs the pure evidence rules plus an ancestry proof in the plan row's recorded `metadata.worktree_path`: the target ref is read remote-first (`refs/remotes/origin/<target>`, else `refs/heads/<target>`) because a provider merge lands in the remote and `git fetch` advances it while a local head may stay stale; an ancestor `branch.work` tip passes, otherwise only a recorded `merge.commit` that exists as a commit and is contained in the target passes. Close and the read-only Phase-6 gate call the same function, so they cannot disagree; an unproven merge is `PHASE6_DELIVERY_MERGE_UNPROVEN` on both.
- **Stored blocks stay readable.** Snapshots recorded by the previous shape keep their `delivery.pr` and free-text `merge` as history: persisted-state validation reads those members as absent instead of invalidating the snapshot (the same read tolerance the pre-rename `branch.source` spelling gets). Every write path still refuses them.
- **Refusals name the cause and an executable recovery.** An unproven merge says whether the delivery branch was unresolved, the delivery tip outside the target, or the recorded commit absent, and points at fetching the target branch into the plan checkout, retrying, or recording the provider merge/squash commit via `mstar workflow evidence`. No network or provider call is added; every Git read uses the existing argv-array helpers.
- **Known limits, documented rather than hidden:** a squash or rebase merge is not provable from ancestry alone and needs its provider commit recorded; a target with no local and no fetched ref is a refusal, never a pass (a stale local head alone is not, because the remote ref is read first).
- `mstar workflow evidence` publishes the new shape (`merge { commit? }`, no `pr`) and its help text; the deleted anchor/PR advisory warning and its close-time immutability refusal are gone with the duplicate identity.
- Updated `mstar-artifacts/references/plan-workflow-lifecycle-contract.md` (§3 stage table, §4d/§4f/§4g), `mstar-iteration/references/phase-6-post-merge-close.md`, `mstar-artifacts/references/status-and-residuals.md`, and `mstar-artifacts/templates/plan.main.md`.

<!-- CN -->
- **交付证据不再携带手工记录的 PR 身份。** `delivery.pr` 成员删除：PR head/target 就是注册的 `branch.work` / `branch.target` 锚点（契约 §4d），记录副本会被当作未使用成员拒绝，修锚点也不会再撞上冻结的身份。
- **`delivery.merge` 只保留一个可选事实：provider commit。** 形状为 `{ commit?: string }`（小写 40/64 位完整 commit id）。原先只是自由文本、却被用来放行 `completed` 的 `provider` / `evidence` 自述已删除。
- **merge 由本地 Git 证明，close 与 Phase-6 gate 共用同一条规则。** `verifyDeliveryEvidence` 先跑纯证据规则，再在 plan 行记录的 `metadata.worktree_path` 内做祖先证明：目标引用**远端优先**（`refs/remotes/origin/<target>`，缺失则取 `refs/heads/<target>`），因为 provider merge 落在远端，`git fetch` 推进的是远端引用而本地 head 可能滞后；`branch.work` tip（本地引用优先）是祖先即通过，否则只有记录的 `merge.commit` 真实存在且被目标包含才通过。两者不可能给出不同结论；未证明的 merge 在两条路径上都是 `PHASE6_DELIVERY_MERGE_UNPROVEN`。
- **已存记录保持可读。** 旧形状写入的快照保留其 `delivery.pr` 与自由文本 `merge` 作为历史：持久状态校验把这些成员视为不存在，而不是判整份快照无效（与改名前的 `branch.source` 同一种读兼容）。写路径依旧拒绝它们。
- **拒绝既说原因也给可执行恢复。** 明确区分「交付分支无法解析」「tip 不在目标内」「记录的 commit 不存在」，并指向：先在 plan checkout 内 fetch 目标分支重试，或通过 `mstar workflow evidence` 记录 provider merge/squash commit。不新增任何网络/provider 调用，Git 读取全部沿用既有 argv 数组 helper。
- **已知边界写进文档而不是藏起来：** squash / rebase merge 无法仅靠祖先关系证明，必须记录 provider commit；目标在本地与远端都没有引用时是拒绝而非放行（单纯本地 head 滞后不算，因为先读远端引用）。
- `mstar workflow evidence` 发布新形状（`merge { commit? }`，无 `pr`）与对应 help；随重复身份一起删除的还有锚点/PR 不一致的告警与 close 时的不变性拒绝。
- 更新 `mstar-artifacts/references/plan-workflow-lifecycle-contract.md`（§3 阶段表、§4d/§4f/§4g）、`mstar-iteration/references/phase-6-post-merge-close.md`、`mstar-artifacts/references/status-and-residuals.md`、`mstar-artifacts/templates/plan.main.md`。
