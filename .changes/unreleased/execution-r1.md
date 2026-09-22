---
category: Harness
packages: root
---

- Added the **consumer-v1 source/package inventory producer** `scripts/execution-consumer-manifest.ts`: `collectExecutionConsumerManifest(repoRoot)` records, per consumer (engine, CLI, DSh, OMP, OpenCode, ZCode), the canonical build-entry source digests, generated artifact digests, entrypoint, exact runtime target/floor and declared capability, plus the canonical copied-instruction trees each package bundles from the repo-root `skills/`, `commands/` and `agents/` corpus. It reuses the existing build layouts (`packages/*/package.json` `build`/`bundle-assets`, `scripts/build-zcode-hooks.ts`) instead of a second build system.
- Added `verifyExecutionConsumerManifest(manifest)` as a generation-independent validator: it re-derives every fact from the bytes on disk — source, generated artifact, copied instruction tree (including symlink canonical targets), package `engines` floor, capability and digest — and refuses with a stable `consumer.*` code on any drift. A recorded path that would leave the repository refuses before any read, so no installed or foreign state is inspected.
- Added the CLI `bun scripts/execution-consumer-manifest.ts --repo . --write|--check`: `--write` emits `packages/<id>/dist/execution-consumer.json` for engine/CLI/DSh/OMP/OpenCode plus `hooks/execution-consumer.json` (the ZCode plugin-root copy), and `--check` re-verifies every written manifest without writing. Missing or empty build output refuses; the producer never fabricates parity, and the OpenCode `decision-only` capability is recorded explicitly rather than advertised as a writer.
- Packaging evidence only: no version surface, package metadata, generated bundle or installed state is modified, and the committed ZCode hook is not regenerated here.

<!-- CN -->
- 新增 **consumer-v1 源/包清单生产者** `scripts/execution-consumer-manifest.ts`：`collectExecutionConsumerManifest(repoRoot)` 为每个消费方（engine、CLI、DSh、OMP、OpenCode、ZCode）记录规范构建入口源摘要、生成产物摘要、入口点、精确运行时目标/下限与声明能力，以及各包从仓库根 `skills/`、`commands/`、`agents/` 语料打包的规范复制指令树。它复用现有构建布局（各包 `build`/`bundle-assets` 与 `scripts/build-zcode-hooks.ts`），不引入第二套构建系统。
- 新增与生成过程解耦的校验器 `verifyExecutionConsumerManifest(manifest)`：它从磁盘字节重新推导每项事实——源、生成产物、复制指令树（含符号链接的规范目标）、包 `engines` 下限、能力与摘要——任何漂移都以稳定的 `consumer.*` 码拒绝。会离开仓库的记录路径在任何读取前即被拒绝，因此不会检查已安装或外部状态。
- 新增 CLI `bun scripts/execution-consumer-manifest.ts --repo . --write|--check`：`--write` 为 engine/CLI/DSh/OMP/OpenCode 写出 `packages/<id>/dist/execution-consumer.json`，并写出 `hooks/execution-consumer.json`（ZCode 插件根副本）；`--check` 在不写入的前提下重新校验每份已写清单。构建输出缺失或为空即拒绝；生产者不伪造一致性，OpenCode 的 `decision-only` 能力被显式记录，而不是宣称可写。
- 仅为打包证据：不修改任何版本面、包元数据、生成 bundle 或已安装状态，也不在此处重新生成已提交的 ZCode hook。
