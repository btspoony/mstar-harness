---
packages: engine, cli
---

- Made `FsStore.put` **fail loud on unpersistable envelope schemas**: a doc carrying an envelope `schema` id is now rejected with a canonical error instead of being silently dropped (FsStore persists `doc.payload` only); payload-internal `schema` fields are unaffected.
- Added optional **`ArtifactStore.list?(kind)`** enumeration: stores that cannot enumerate decline by omitting the member (callers probe `typeof store.list === "function"`, same pattern as `delete?`); `FsStore` implements it via the single kind→path table (missing backing file → `[]`, keys sorted ascending, every listed key round-trips through `get`, `json` kind throws the canonical usage error).
- Added the **`persist list <kind>`** CLI face: prints stored keys only (one per line, ascending, no header); `json` is rejected as a usage error before enumeration, and an injected store without `list` exits 2 (probed, never a TypeError).
- Added **`persist get --validate`**: reuses the put-gate validators on the fetched payload — stdout stays payload JSON only; notes (`validation: ok` / `json: parse-only`) and violations go to stderr; a miss or an invalid document exits 1.
- Added the **`persist delete <kind> --key <key>`** CLI face: idempotent (absent key is a no-op, exit 0, prints `deleted <kind>/<key>`), no confirmation prompt; an injected store without `delete` exits 2.

<!-- CN -->
- `FsStore.put` 现对**无法持久化的 envelope schema 快速失败**：携带 envelope `schema` id 的文档会以规范化错误拒绝写入，而非静默丢弃（FsStore 仅落盘 `doc.payload`）；payload 内部的 `schema` 字段不受影响。
- 新增可选 **`ArtifactStore.list?(kind)`** 枚举能力：无法枚举的存储可不实现该成员（调用方以 `typeof store.list === "function"` 探测，与 `delete?` 同一模式）；`FsStore` 基于唯一的 kind→path 表实现（缺失落盘文件 → `[]`，key 升序排列，每个列出的 key 均可经 `get` 往返，`json` kind 抛出规范化用法错误）。
- 新增 **`persist list <kind>`** CLI 面：仅打印存储的 key（每行一个，升序，无表头）；`json` 在枚举前即以用法错误拒绝；注入的存储缺少 `list` 时退出码 2（探测，绝不抛 TypeError）。
- 新增 **`persist get --validate`**：复用写入门禁的校验器校验读出的 payload——stdout 保持纯 payload JSON；备注（`validation: ok` / `json: parse-only`）与违规列表走 stderr；miss 或无效文档退出码 1。
- 新增 **`persist delete <kind> --key <key>`** CLI 面：幂等（key 不存在为空操作，退出码 0，打印 `deleted <kind>/<key>`），无确认提示；注入的存储缺少 `delete` 时退出码 2。
