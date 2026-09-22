---
category: Changed
packages: engine
---

- Added the **execution coverage substrate** (`packages/engine/src/execution-coverage.ts`, architecture contract §4.1): the closed 18-surface inventory, the per-surface validator-version mapping (`session-v1`, `notes-v1`, `agent-flow-v2`, `selection-v1`, `omp-launch-v2`, `omp-hidden-v1`, `retained-body-v1`, `consumer-v1`, `recovery-v1`, `core-v1`), canonical receipt hashing and `validateExecutionCoverage`.
- Coverage is recomputed, never asserted: every witness must be pinned by the frozen manifest and hash to the handed-in bytes, the bounded evidence document must satisfy its closed schema, and a receipt's `resultHash` is the canonical digest of the facts recomputed from those bytes — so an unknown protocol, changed source bytes, a fabricated acknowledgement, a stale/foreign manifest or epoch binding, an unpinned or traversing witness, a duplicate or omitted sibling workflow and a borrowed absent result all refuse as `execution.coverage-incomplete`. Validation is pure: no file, driver or host access.

<!-- CN -->
- 新增 **执行覆盖基底**（`packages/engine/src/execution-coverage.ts`，架构契约 §4.1）：18 个 surface 的闭合清单、每个 surface 的校验器版本映射（`session-v1`、`notes-v1`、`agent-flow-v2`、`selection-v1`、`omp-launch-v2`、`omp-hidden-v1`、`retained-body-v1`、`consumer-v1`、`recovery-v1`、`core-v1`）、规范化 receipt 哈希与 `validateExecutionCoverage`。
- 覆盖是重算出来的，不是声明出来的：每个 witness 必须被冻结 manifest pin 住且与传入字节哈希一致，bounded evidence 文档必须满足其闭合 schema，receipt 的 `resultHash` 是据这些字节重算出的 facts 的规范摘要——因此未知 protocol、源字节变更、伪造的 acknowledgement、陈旧/外来 manifest 或 epoch 绑定、未 pin 或越界 witness、重复或缺漏兄弟 workflow、借用 absent 结果，全部以 `execution.coverage-incomplete` 拒绝。校验是纯函数：不访问文件、驱动或宿主。
