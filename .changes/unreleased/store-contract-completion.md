---
packages: engine
---

- Made `FsStore.put` **fail loud on unpersistable envelope schemas**: a doc carrying an envelope `schema` id is now rejected with a canonical error instead of being silently dropped (FsStore persists `doc.payload` only); payload-internal `schema` fields are unaffected.
- Added optional **`ArtifactStore.list?(kind)`** enumeration: stores that cannot enumerate decline by omitting the member (callers probe `typeof store.list === "function"`, same pattern as `delete?`); `FsStore` implements it via the single kind→path table (missing backing file → `[]`, keys sorted ascending, every listed key round-trips through `get`, `json` kind throws the canonical usage error).

<!-- CN -->
- `FsStore.put` 现对**无法持久化的 envelope schema 快速失败**：携带 envelope `schema` id 的文档会以规范化错误拒绝写入，而非静默丢弃（FsStore 仅落盘 `doc.payload`）；payload 内部的 `schema` 字段不受影响。
- 新增可选 **`ArtifactStore.list?(kind)`** 枚举能力：无法枚举的存储可不实现该成员（调用方以 `typeof store.list === "function"` 探测，与 `delete?` 同一模式）；`FsStore` 基于唯一的 kind→path 表实现（缺失落盘文件 → `[]`，key 升序排列，每个列出的 key 均可经 `get` 往返，`json` kind 抛出规范化用法错误）。
