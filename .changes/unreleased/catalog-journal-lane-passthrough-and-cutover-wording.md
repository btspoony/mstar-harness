---
category: Fixed
packages: root
---

- **A journal lane this checkout does not hold no longer refuses workflow selection.** A bound remote
  checkout whose private cache is absent, or a scope with no collaboration store yet, carries no
  `catalog_operations` row, so it gets the same pre-activation pass-through `store.not-active` already
  had instead of `collaboration.not-initialized`. A registered workflow with a genuinely pending
  registration still refuses `catalog.registration-pending`, and the verdict now runs on the source
  read the host actually uses (`readExecutionWorkflowSource`), not only where a caller happens to
  consult the gate.
- **The cutover-required disclosure no longer implies a released 4.8.x build can use the store after
  activation.** The execution schema is never lowered, so that build refuses it as
  `store.schema-unsupported` even after the cutover; the failure now says so and names this newer
  build as the one that completes the ladder.
- **`store upgrade` honours `--operation`.** The composite recovery tells the operator to reissue the
  same verb under the same operation id, so the verb now records and replays under the caller's id
  instead of minting a fresh one that would reserve a second operation.

<!-- CN -->
- **本检出并不持有的 journal lane 不再拒绝 workflow 选择。** 已绑定但私有 cache 缺失的 remote 检出，
  或尚无协作库的作用域，都不含 `catalog_operations` 行，因此获得与 `store.not-active` 相同的前置放行，
  而不是 `collaboration.not-initialized`。已注册 workflow 若确有 pending 注册仍以
  `catalog.registration-pending` 拒绝；该判定现在跑在宿主真正使用的源读取
  （`readExecutionWorkflowSource`）上，而不只是调用方恰好另行查询闸门的地方。
- **cutover-required 披露不再暗示已发布的 4.8.x 版本在激活后可用该库。** execution schema 从不回退，
  因此该版本即使走完 cutover 仍以 `store.schema-unsupported` 拒绝；失败信息现在明说这一点，并指名
  由这个更新的版本完成迁移阶梯。
- **`store upgrade` 遵守 `--operation`。** 复合恢复指引要求操作者以相同 operation id 重发同一动词，
  因此该动词现在按调用方给的 id 记录与重放，而不再另生成一个会额外预留第二个操作的 id。
