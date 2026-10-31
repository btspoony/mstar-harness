---
packages: engine, dsh, cli
---

- **M0 read-only mirror import.** `mstar issue-sync import --project <id> [--max-pages <n>]` pulls the bound
  Linear project's issues into the store through the existing capture path: rows carry `provider='linear'`,
  `external_id` and `url`, a documented synthetic identity triple, and never merge into a local capture. A second
  run with unchanged remote state imports nothing and writes no row (the cursor makes the re-read a no-op), and a
  remote change to an already-imported item is re-planned once (`replanItem`, the new `applied → pending`
  transition) and applied exactly once. Imported rows are excluded from the local-only findings gate.
- A run advances its resumable cursor **only when the page it processed left nothing stranded**: an item still
  `failed`, or one the adapter could not map, blocks the advance so the next run re-reads that page (the overlap
  window) and the `failed → pending` retry can actually run. An unmappable item fails by identity with its page
  index and lets the rest of the page proceed.
- Probe failures keep their own cause and recovery: `linear.host-unavailable` (the host cannot reach its MCP
  service) and `linear.access-denied` (re-authorize the host) are distinct from the configuration-only
  `linear.provider-disabled`. The ingest path enforces the active-store guard, and remote revisions are compared
  as instants, never as strings.
- The dsh Linear listing adapter maps pages over an injected MCP transport: an embedded `errors` payload, an
  unmappable page or a transport failure refuses `linear.query-failed` instead of looking like an empty project,
  and no credential reaches a message. The tool inventory itself is still pending one authenticated `tools/list`
  (`specs/linear-mcp-tool-surface.md`), so the adapter runs on the documented fixture envelope.

<!-- CN -->
- **M0 只读镜像导入。** `mstar issue-sync import --project <id> [--max-pages <n>]` 从已绑定的 Linear 项目拉取 issue 并写入本地 store，行带 `provider='linear'`、`external_id`、`url` 与文档化的合成身份三元组。第二次运行无远端变化时导入 0 条、改 0 行；远端的一项变更恰好导入一次（经由新动词 `replanItem`，它只允许从 `applied` 出发、强制更晚的修订、且可重放）。页非原子：某项失败时运行在推进游标**之前**停止，下一次运行重读该页；不可映射的条目按身份失败并让该页其余条目继续。比较时间戳用时刻而非字符串（`…00.500Z` 曾排在 `…00Z` 之前）。导入行永不满足仅限本地的门禁，唯一证据是正对照。
