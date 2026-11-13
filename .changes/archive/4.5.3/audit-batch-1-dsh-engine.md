---
category: Changed
packages: dsh, engine
---

- Resolved Enforcement through one helper: the dsh boot diagnostic now honours an explicit
  `enforcement: soft`, so it no longer announces "hard is active" while the gates run warn-only, and
  the status gate and dispatch gate call the shared resolver instead of keeping their own copies.
- Derived the compound `problem_type` aggregate from the two track tuples, so adding a value is one
  edit and can no longer desynchronise aggregate validation from the track-specific required fields.
- Removed dsh surface with no consumer: the private `currentSelection` method, the
  `engine-status-endpoint` constant re-exports, and the duplicate endpoint-constant exports on the panel
  client. The wire module remains the single import path.

<!-- CN -->
- **Enforcement 解析收敛到单一 helper**：dsh 启动诊断现在识别显式 `enforcement: soft`，不再在
  门禁 warn-only 时宣告 “hard is active”；status 与 dispatch 门禁改调共享解析器，不再各存副本。
- **compound `problem_type` 全量由两条轨道元组派生**：新增取值只需改一处，聚合校验与轨道必填
  字段不会再脱节。
- **删除 dsh 无消费者的接口面**：私有 `currentSelection`、`engine-status-endpoint` 的常量再导出，
  以及 panel client 上重复的端点常量导出；wire 模块保持唯一导入路径。
