# Entry admission for standalone plans; ACTIVE audit-promote coverage

## English

- `mstar worktree check --entry` admission is now workflow-type specific: a standalone plan workflow requires only the source/target anchors its registration records (and uses `target` for main-worktree residency), while iteration workflows keep the required base/target/integration anchors plus the integration-checkout validation. Missing-anchor refusals now give per-type, achievable recovery instructions.
- Audit-promote CLI fixtures assert the ACTIVE execution graph (single store initialization, activated token) instead of the retired snapshot/`status.json` projections.

## 中文

- `mstar worktree check --entry` 的准入改为按工作流类型区分：standalone plan 工作流只要求其注册可记录的 source/target anchor（主 worktree 驻留校验使用 `target`）；iteration 工作流仍要求 base/target/integration anchor 与集成检出校验。缺失 anchor 的拒绝文案按类型给出可执行的恢复指引。
- audit-promote CLI 测试改为断言 ACTIVE 执行图（单次 store 初始化 + 读取已激活 token），不再断言已退役的 snapshot / `status.json` 投影。
