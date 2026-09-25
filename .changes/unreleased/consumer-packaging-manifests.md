---
category: Harness
packages: root, engine, cli
---

- Added the `consumer-v1` source/package inventory producer (`scripts/execution-consumer-manifest.ts`): per consumer (engine, CLI, DSh, OMP, OpenCode, ZCode) it records the canonical build-input closure, the generated output closure, the entrypoint, the exact runtime target and floor, the declared capability and the copied-instruction trees each package bundles from the repo-root `skills/`, `commands/`, `agents/` and `assets/` corpus — reusing the existing build layouts instead of introducing a second build system. `--write` emits the manifests; `--check` re-verifies every written manifest against the bytes on disk without writing anything.
- The producer also publishes one per-consumer evidence document derived from the aggregate, so the handoff form cannot disagree with the operator-facing artifact.
- Added the assembled-package Node regression (`packages/cli/test/execution-package.node.test.mjs`, run with `node --test`): it drives the built CLI bundle as a subprocess through the active DB transport (register, both session binds, prepare, a read, a read-only resume, a write and its exact retry), re-checks every CLI claim against the engine's public readers and against `node:sqlite` directly, re-derives the generated consumer manifests from the bytes on disk, and exercises the committed ZCode hook bundle the way the host runs it (stdin envelope plus exit code).
- The regression states explicitly what it is not: no native host process, no installed binary and no TypeScript source import. Host entrypoints are covered by generated-manifest parity plus a populated OMP-shaped database fixture executed against the built engine generation.

<!-- CN -->
- 新增 `consumer-v1` 源/包清单生产者（`scripts/execution-consumer-manifest.ts`）：对每个消费者（engine、CLI、DSh、OMP、OpenCode、ZCode）记录规范构建输入闭包、生成输出闭包、入口点、确切的运行时 target 与下限、声明的能力，以及各包从仓库根 `skills/`、`commands/`、`agents/`、`assets/` 语料复制的指令树——复用既有构建布局，不引入第二套构建系统。`--write` 产出清单；`--check` 在不写入任何字节的前提下对照磁盘字节复核每一份清单。
- 生产者同时发布由聚合清单派生的逐消费者证据文档，使交接形态不可能与面向操作者的制品不一致。
- 新增装配包 Node 回归（`packages/cli/test/execution-package.node.test.mjs`，以 `node --test` 运行）：把已构建的 CLI bundle 作为子进程驱动 active DB 传输（register、两种 session bind、prepare、读取、只读 resume、一次写入及其精确重试），用引擎公开读取器与 `node:sqlite` 直接复核 CLI 的每项声明，从磁盘字节重新推导生成的消费者清单，并按宿主实际运行方式（stdin 信封 + 退出码）演练已提交的 ZCode 钩子 bundle。
- 该回归明确写出它**不是**什么：没有原生宿主进程、没有已安装二进制、不 import TypeScript 源码。宿主入口点由生成清单一致性加一个「OMP 形状的 populated 数据库夹具」在已构建引擎世代上运行来覆盖。
