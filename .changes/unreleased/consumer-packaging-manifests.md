---
category: Harness
packages: root, engine, cli
---

- Added the `consumer-v1` source/package inventory producer (`scripts/execution-consumer-manifest.ts`): per consumer (engine, CLI, DSh, OMP, OpenCode, ZCode) it records the canonical build-input closure, the generated output closure, the entrypoint, the exact runtime target and floor, the declared capability and the copied-instruction trees each package bundles from the repo-root `skills/`, `commands/`, `agents/` and `assets/` corpus — reusing the existing build layouts instead of introducing a second build system. `--write` emits the manifests; `--check` re-verifies every written manifest against the bytes on disk without writing anything.
- The producer also publishes one per-consumer evidence document derived from the aggregate, so the handoff form cannot disagree with the operator-facing artifact.
- Assembled-package Node regression drives the built CLI's coordinator registration, binding, ordinary source/configuration/progress and exact retry; it compares public/store facts, current consumer manifests and committed ZCode hook stdin/exit behavior. It never launches a per-row PM.
- The regression states explicitly what it is not: no native host process, no installed binary and no TypeScript source import. Host entrypoints are covered by generated-manifest parity plus a populated OMP-shaped database fixture executed against the built engine generation.

<!-- CN -->
- 新增 `consumer-v1` 源/包清单生产者（`scripts/execution-consumer-manifest.ts`）：对每个消费者（engine、CLI、DSh、OMP、OpenCode、ZCode）记录规范构建输入闭包、生成输出闭包、入口点、确切的运行时 target 与下限、声明的能力，以及各包从仓库根 `skills/`、`commands/`、`agents/`、`assets/` 语料复制的指令树——复用既有构建布局，不引入第二套构建系统。`--write` 产出清单；`--check` 在不写入任何字节的前提下对照磁盘字节复核每一份清单。
- 生产者同时发布由聚合清单派生的逐消费者证据文档，使交接形态不可能与面向操作者的制品不一致。
- 装配包 Node 回归驱动构建 CLI 的 coordinator 注册、绑定、普通 source/configuration/progress 与精确重试，比较公开/store 事实、当前 consumer manifest 和已提交 ZCode hook 的 stdin/退出行为，不启动逐行 PM。
- 该回归明确写出它**不是**什么：没有原生宿主进程、没有已安装二进制、不 import TypeScript 源码。宿主入口点由生成清单一致性加一个「OMP 形状的 populated 数据库夹具」在已构建引擎世代上运行来覆盖。
