---
category: Harness
packages: engine, cli
---

- **Reduced the task-report lint to its verifiable claim.** `assertSddTddTriple` no longer scans for test-path, runner-token or output-token shapes, so `lint.sdd-tdd.missing-tests`, `missing-command` and `missing-output` are gone. It validates only the declared structure of the active verification round — one complete `Verification mode: scoped-check` block, and no bare `Tests: N/A` claim (now `lint.sdd-evidence.bare-tests-na`). A prose report no longer fails on formatting; PM/QC own applicability and evidence truth.
- **Inlined the MCP spawn stream bound.** The unused `allowTruncation` / `maxStreamBytes` parameters and the unreachable truncation branch are gone; oversized child output still rejects with `command.effect-unavailable`.

<!-- CN -->
- **把任务报告 lint 缩减到它真正能证明的声明。** `assertSddTddTriple` 不再扫描测试路径、运行器 token 或输出 token 形态，因此 `lint.sdd-tdd.missing-tests`、`missing-command`、`missing-output` 一并移除。它只校验当前验证轮次的声明结构——一个完整的 `Verification mode: scoped-check` 块，且没有裸 `Tests: N/A` 声明（现为 `lint.sdd-evidence.bare-tests-na`）。纯散文报告不再因格式失败；适用范围与证据真实性由 PM/QC 负责。
- **内联 MCP spawn 的流上限。** 未使用的 `allowTruncation` / `maxStreamBytes` 参数与不可达的截断分支删除；子进程输出超限仍以 `command.effect-unavailable` 拒绝。
