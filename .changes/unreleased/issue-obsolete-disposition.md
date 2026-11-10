---
packages: root, engine, commands, cli, ui, dsh
---

- **The issue store gains an honest terminal state for a removed subject: `obsolete`.** One authoritative tuple in `packages/engine/src/issue.ts` now defines the disposition vocabulary, and every server schema, filter, aggregate, history query and outbound mapping derives from it instead of repeating a list. An `obsolete` close requires a nonblank reason and at least one removal reference, refuses any `canonicalIssueId` (including `null`/`""`) before mutation, and refuses with `issue.invalid-disposition` plus the exact removal-evidence recovery. Migration 19 is append-only and preserves existing rows, relations and triggers; the browser projection is generated from the same tuple, and `obsolete` maps to `Canceled` on outbound Linear pushes.

<!-- CN -->
- **issue store 为“主体已删除”的条目新增一个诚实的终态：`obsolete`。** `packages/engine/src/issue.ts` 的单一权威元组现在定义处置词表，所有服务端 schema、过滤器、聚合、历史查询与外发映射都从它派生，不再各自重复维护列表。`obsolete` 关闭要求非空原因与至少一条删除证据引用，并在任何变更前拒绝 `canonicalIssueId`（含 `null`/`""`），以 `issue.invalid-disposition` 及精确的补证据恢复路径拒绝。迁移 19 为追加式，保留既有行、关系与触发器；浏览器投影由同一元组生成，外发 Linear 时 `obsolete` 映射为 `Canceled`。
