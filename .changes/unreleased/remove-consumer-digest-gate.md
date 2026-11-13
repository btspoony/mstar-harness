---
category: Fixed
packages: root
---

- **The consumer manifest digest gate is deleted, not refreshed.** `scripts/execution-consumer-manifest.ts`, its suite and the seven tracked `scripts/packaging-manifests/*.json` snapshots are gone, together with the `.github/workflows/ci.yml` step that ran `--check` and the extra omp/dsh builds that existed only to feed it. The recorded digests described the machine that wrote them: a release branch whose only change was a version bump failed `pack-consumers` with `consumer.digest-mismatch` for a package that was never broken. Re-recording the snapshot would have re-established nothing.
- **Packaging protections stay.** The per-consumer builds, `npm pack` for the CLI and both OpenCode generations, the packed OpenCode V2 entry smoke and the packed-manifest metadata guard all remain; the CLI package regression (`packages/cli/test/execution-package.node.test.mjs`) keeps its real execution/store/hook scenarios and now reads the Node floor from `packages/cli/package.json` instead of the removed inventory.
- **Documentation corrected at its source.** The source-provenance record is archived (its subject no longer exists), the operational-traps record now states the deletion instead of a refresh recipe, and the affected knowledge documents no longer recommend re-taking a snapshot.

<!-- CN -->
- **consumer manifest 摘要门禁被删除，而不是刷新。** `scripts/execution-consumer-manifest.ts`、其测试套件与七份受版本控制的 `scripts/packaging-manifests/*.json` 快照一并移除，`.github/workflows/ci.yml` 中运行 `--check` 的步骤以及仅为它存在的 omp/dsh 额外构建也一并删除。这些记录的摘要描述的是写下它的那台机器：一个只改版本号的 release 分支因此在 `pack-consumers` 上以 `consumer.digest-mismatch` 失败，而包本身从未损坏。重新录制快照不会重新建立任何东西。
- **打包保护保留。** 各 consumer 的构建、CLI 与两代 OpenCode 的 `npm pack`、打包后 OpenCode V2 入口 smoke，以及 packed-manifest 元数据守卫全部保留；CLI 包回归（`packages/cli/test/execution-package.node.test.mjs`）保留其真实的执行/store/hook 场景，Node 下限改为读取 `packages/cli/package.json`，不再依赖已删除的清单。
- **文档在源头得到纠正。** source-provenance 记录已归档（其对象不复存在），operational-traps 记录改述删除而非重录配方，受影响的知识文档不再推荐重录快照。
