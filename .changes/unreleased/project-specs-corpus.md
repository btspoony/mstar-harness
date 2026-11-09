---
category: Harness
packages: root
---

- Added the tracked `docs/specs/` corpus describing the project's current architecture (layers and data flow, the store as state authority, the document corpora and their boundaries), and declared `specs_dir=docs/specs` in `.mstarc`.
- Extended the ADR contract with the `archived/` lifecycle: an implemented record that no longer guides future work moves there, keeps `Status: implemented`, gains an `Archived:` line and is frozen; `proposed`/`rejected` records never enter the archive.
- Registered the four spec documents in the store catalog; retired the stale catalog rows that pointed at the removed local specs directory.

<!-- CN -->
- 新增 tracked `docs/specs/` 语料，描述项目当前架构（分层与数据流、store 作为状态权威、文档语料与边界），并在 `.mstarc` 声明 `specs_dir=docs/specs`。
- 扩展 ADR 合同，加入 `archived/` 生命周期：不再指导未来工作的 implemented 记录迁入该目录，保留 `Status: implemented`、增加 `Archived:` 行并冻结；`proposed`/`rejected` 记录不得进入归档。
- 在 store catalog 登记 4 篇 spec 文档；清除指向已移除本地 specs 目录的陈旧 catalog 行。
