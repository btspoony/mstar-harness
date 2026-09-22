---
category: Harness
packages: root
---

- Guarded the **injected `ArtifactStore`** at the canonical control targets: a store injected through `setArtifactStore` / `--store` / `MSTAR_STORE_MODULE` is served behind a wrapper whose `put` / `get` / `delete` refuse the root register, a workflow snapshot and a `json` alias of either while the CANONICAL CONTROL root's execution authority is ACTIVE — before the injected method runs, with the same `execution.direct-write-refused` / `execution.consumer-not-ready` refusals the default `FsStore` reports.
- The guard resolves that control root from the process (`storeDbPath`) and never from the injector's own `root` claim, so a custom store with no root, a false root or a foreign root cannot establish or bypass the authority; an `FsStore` keeps its own root-verified boundary, and body documents (review envelopes, unrelated `json`) still round-trip through injection.
- Proved the retained-evidence boundary: SDD evidence bodies stay files under the configured `{SDD_DIR}` roots with the byte hashes a handoff record pins, across a fixture authority switch and with no copy written into the store, while a missing body, edited bytes and a symlink escaping the plan's own areas each refuse instead of counting as an accepted approval.

<!-- CN -->
- 在**规范化控制目标**处为**注入式 `ArtifactStore`** 加装门禁：经 `setArtifactStore` / `--store` / `MSTAR_STORE_MODULE` 注入的 store 由包装层服务，当**规范化控制根**的执行权威为 ACTIVE 时，其 `put` / `get` / `delete` 会拒绝根 register、workflow snapshot 及指向二者的 `json` 别名——拒绝发生在注入方法运行之前，且沿用默认 `FsStore` 报告的 `execution.direct-write-refused` / `execution.consumer-not-ready` 两种拒绝。
- 该门禁从进程侧解析该控制根（`storeDbPath`），绝不采信注入方自述的 `root`，因此无 root、虚假 root 或外来 root 的自定义 store 既不能建立也不能绕过权威；`FsStore` 保留其自校验 root 的边界，正文文档（review 信封、无关 `json`）经注入仍可往返。
- 证明保留证据边界：SDD 证据正文在配置的 `{SDD_DIR}` 根下仍是文件，其字节哈希与 handoff 记录所固定的哈希一致，跨越 fixture 权威切换且 store 中不留副本；而缺失正文、被改动的字节、以及逃出该 plan 自身区域的符号链接一律被拒绝，不会成为被接受的批准。
