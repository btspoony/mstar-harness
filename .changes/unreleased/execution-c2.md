---
category: Changed
packages: engine
---

- Added the **execution coverage substrate** (`packages/engine/src/execution-coverage.ts`, architecture contract §4.1/§4.2): the closed 18-surface inventory, a byte codec per surface, canonical receipt/result hashing, the manifest-row source assignment and `validateExecutionCoverage`.
- Coverage is **recomputed from the retained bytes, never asserted by a receipt**: the validator hashes every named witness, decodes the real formats (v2 register and workflow snapshots, session envelopes, JSONL note/agent-flow ledgers, JSON selection and launch documents, the canonical host-history export, retained SDD bodies, producer manifests, a recovery inventory) and derives each `resultHash` from what the bytes say — so an invented result, a changed byte, a borrowed or unpinned witness, a foreign workflow identity, an unknown document shape, a mislabelled consumer capability or a diagnostic-bearing host export all refuse as `execution.coverage-incomplete`.
- Each manifest row carries the sources C3's discovery assigned to it, and a receipt must name exactly that set; harness-produced documents (producer manifests, host-history exports, recovery inventories) must be canonical §3.1 JSON, while retained legacy bodies keep their existing formats.

<!-- CN -->
- 新增 **执行覆盖基底**（`packages/engine/src/execution-coverage.ts`，架构契约 §4.1/§4.2）：18 个 surface 的闭合清单、每个 surface 的字节 codec、规范化 receipt/result 哈希、manifest 行的 source 归属与 `validateExecutionCoverage`。
- 覆盖结果**由留存字节重算，而非由 receipt 声明**：校验器对每个命名 witness 重新哈希、解码真实格式（v2 根 register 与 workflow snapshot、session envelope、notes/agent-flow 的 JSONL、selection/launch 的 JSON 文档、canonical host-history export、留存 SDD 正文、producer manifest、recovery inventory），并据字节内容推导 `resultHash`——因此伪造结果、字节变更、借用或未 pin 的 witness、外来 workflow 身份、未知文档形状、错标 consumer capability、带 diagnostic 的 host export，全部以 `execution.coverage-incomplete` 拒绝。
- manifest 每行携带 C3 discovery 分配给它的 source，receipt 必须与该集合完全一致；harness 产生的文档（producer manifest、host-history export、recovery inventory）必须是规范 §3.1 JSON，而留存 legacy 正文保持既有格式。
