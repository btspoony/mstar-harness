---
category: Harness
packages: root
---

- **The Release workflow has no manual entry point.** `workflow_dispatch` and its `commit` input are removed: the publish job holds `id-token: write` + `contents: write`, and a dispatched run selects a ref whose copy of the workflow a repository writer could edit before running it, so the publish path is now reachable only through a merged `release vX.Y.Z` PR. A version that is already on the registry stays a reported skip, and a release that fails after some packages published is recovered by preparing the next patch release, which publishes the remaining packages under the new version.

<!-- CN -->
- **Release workflow 不再有手动入口。** `workflow_dispatch` 及其 `commit` 输入已移除：发布任务持有 `id-token: write` + `contents: write`，而手动派发会选定一个 ref，仓库写入者可先修改该 ref 上的 workflow 副本再运行，因此发布路径现在只能经已合并的 `release vX.Y.Z` PR 到达。已在 registry 上的版本仍被报告为跳过；发布过程中部分包已发布而失败的 release，恢复方式是准备下一个 patch 版本，由新版本发布其余包。
