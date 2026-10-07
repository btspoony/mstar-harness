---
category: Harness
packages: commands, cli, engine
---

- Command admission now returns **grouped structured diagnostics**: every schema violation carries its safe field path, stable issue code, message and array index in `details.diagnostics`, so one call reports all missing or malformed fields instead of flattened messages alone.
- **CLI parser errors name the field**: missing arguments and option values identify the input field and the leaf help route (`mstar <path> --help`) when deterministic; unknown flags keep the honest parser diagnostic without a guessed field. Usage responses stay `usage`/exit 2, distinct from engine refusals.
- Plan writes use explicit plan addresses under the acquired workflow coordinator. Sparse own-context resolution retains structured diagnostics for actual scope, identity, token and state conflicts. Stopped-owner recovery names only the workflow coordinator and real stop attestation, never a per-row replacement.
- Usage-message construction for schema rejections is now **bounded**: when a rejected input produces more than 20 issues, the first-line message carries the first 20 causes plus an explicit `…and N more issues` pointer, while `details.diagnostics` keeps every diagnostic (uncapped, with the established secret-shape redaction). The `rejected` summary field reports only the first cause's flag/expected/received facts; the full per-issue facts remain in `details.diagnostics`.
- Top-level CLI and command refusals share one envelope with help routes and recovery guidance; input-schema failures flow through central validation, root-union guidance is preserved, and schema discovery publishes truthful coordinator and plan recovery token kinds.

<!-- CN -->
- 命令准入现在返回**分组结构化诊断**：每条 schema 违规都在 `details.diagnostics` 中携带安全字段路径、稳定 issue code、消息与数组索引，一次调用即可报告全部缺失或畸形字段，而非仅拼接消息。
- **CLI 解析错误指名字段**：缺失参数与选项值在可确定时标明输入字段与叶子帮助路由（`mstar <path> --help`）；未知旗标保留诚实的解析诊断，不猜测字段。usage 响应保持 `usage`/exit 2，与引擎拒绝相区分。
- Plan 写入在已获取身份的 workflow coordinator 下使用明确 plan 地址。稀疏 own-context 推导保留实际 scope、身份、token 与状态冲突的结构化诊断。停止身份恢复仅点名 workflow coordinator 与真实停止见证，不再逐行替换。
- schema 拒绝的 usage 消息构造现在**有界**：当被拒输入产生超过 20 条 issue 时，首行消息携带前 20 条原因加明确的 `…and N more issues` 指针，`details.diagnostics` 保留全部诊断（不设上限，沿用已有的 secret-shape 脱敏）。`rejected` 摘要字段只报告首条 cause 的 flag/expected/received 事实；逐条完整事实在 `details.diagnostics`。
- CLI 与 commands 顶层拒绝共用同一信封，提供帮助路由和恢复指引；输入 schema 错误经过集中校验，根级联合约束指引得以保留，schema discovery 会发布准确的协调者和计划恢复 token 类型。
