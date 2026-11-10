---
category: Harness
packages: root
---

- Added the tracked `docs/specs/` corpus describing the project's current architecture (layers and data flow, the store as state authority, the document corpora and their boundaries), and declared `specs_dir=docs/specs` in `.mstarc`.
- Brought the repository's ADR contract in line with the four-state lifecycle defined in the base change: `docs/adr/README.md` now documents the `archived/` bucket, its admission, the `Archived:` line and the freeze, and the archive class directories ship with the tree.

<!-- CN -->
- 新增 tracked `docs/specs/` 语料，描述项目当前架构（分层与数据流、store 作为状态权威、文档语料与边界），并在 `.mstarc` 声明 `specs_dir=docs/specs`。
- 使本仓库的 ADR 合同与基础变更中定义的四态生命周期一致：`docs/adr/README.md` 现记录 `archived/` 桶、其准入、`Archived:` 行与冻结规则，归档 class 目录随树提交。
