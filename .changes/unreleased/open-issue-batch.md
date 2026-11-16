---
category: Harness
packages: root, dsh, engine, cli, commands
---

- **The quiesced-WAL store probe has one home (no user-visible behaviour).** `packages/engine` test support gains `store-file-probe.ts` (`store-test-runtime.ts` keeps the lazy driver constructor); the store and recovery suites share it instead of each carrying a private copy of the quiesced-shape gate and the raw read-with-retry.
- **A scenario version probe that cannot spawn names the interpreter instead of throwing.** The store suite's failure banner reports `version probe failed (<spawn error code>)` with the binary path, so a missing interpreter surfaces as the scenario failure rather than a `TypeError` on a null stdout.
- **The zero-match push residue cause names both exits.** When no remote issue carries the correlation marker, the engine cause now offers `--release <localId>` and `--adopt <localId>=<issueUrl|externalId>`; which exit applies stays the operator's call, and `issue-sync` covers the message.
- **The boot diagnostic stays silent under an explicit soft.** `packages/dsh` dispatch-gate tests pin the precedence Config > `.mstarc` > compass: the same active-iteration `enforcement: hard` arm that fires the unset-`dispatchTools` diagnostic without an override leaves it silent under `enforcement: 'soft'`.
- **Replay assertions compare the replayed receipt, not just its exit code.** Operation-id replay cases in `packages/cli` and `packages/commands` deep-compare the served receipt against the commit it replays through the shared `receiptStable` helper, which excludes only the `replayed` marker — `recovery` is compared, so a sidecar change that keeps exit 0 now fails.
- **The `--session-ref` claim is scoped to execution-bound verbs.** The host-neutral MCP authority note says the "supplied ⇒ checked, omitted ⇒ derived" constraint holds for the execution-bound verbs `workflow` / `plan` / `session` / `iteration`, rather than "the mutation verbs" as a class.
- **The audit fan-out security seat carries must-check / not-evidence lists.** The `mstar-audit-fanout` seat template gains a per-category gate whose security entry lists the entry points and boundary facts the seat must sweep and the observations that are leads rather than findings; `skills/mstar-audit/references/codebase-audit.md` points at that same gate table so the prose dispatch path cannot drift, and the behaviour suite requires both markers in the security seat prompt and in no other.

<!-- CN -->
- **quiesced-WAL store 探针归一（无用户可见行为）。** `packages/engine` 测试支持新增 `store-file-probe.ts`（`store-test-runtime.ts` 保留惰性 driver 构造）；store 与 recovery 两套用例共用它，不再各自保留一份 quiesced-shape 闸门与 raw read-with-retry。
- **版本探针无法 spawn 时场景失败点名解释器，不再抛出。** store 用例的失败横幅改为报告 `version probe failed (<spawn 错误码>)` 与二进制路径，缺失解释器呈现为场景失败而非 null stdout 上的 `TypeError`。
- **零匹配 push 残留的 cause 同时点名两个出口。** 当没有远端 issue 携带关联标记时，engine 的 cause 现在给出 `--release <localId>` 与 `--adopt <localId>=<issueUrl|externalId>`；选哪个出口仍由操作者判断，`issue-sync` 覆盖该消息。
- **显式 soft 下启动诊断保持静默。** `packages/dsh` 的 dispatch-gate 用例钉住优先级 Config > `.mstarc` > compass：同一条 active iteration 的 `enforcement: hard` 分支在无覆盖时会触发 unset-`dispatchTools` 诊断，而在 `enforcement: 'soft'` 下静默。
- **重放断言比对重放出的 receipt，而非只看退出码。** `packages/cli` 与 `packages/commands` 的 operation-id 重放用例经共享的 `receiptStable` 助手逐字段比对被重放的 commit（只排除 `replayed` 标记，`recovery` 参与比较）；退出码为 0 但字段变化的回归现在会失败。
- **`--session-ref` 的说法收窄到 execution-bound 动作。** host-neutral MCP authority 笔记写明「给出即校验、省略即推导」这一约束适用于 execution-bound 的 `workflow` / `plan` / `session` / `iteration`，而非「mutation 动作」这一类。
- **audit fan-out 的 security 席位带上 must-check / not-evidence 清单。** `mstar-audit-fanout` 席位模板新增按类别的闸门，security 条目列出该席位必须扫过的入口与边界事实，以及只算线索、不算 finding 的观察；`skills/mstar-audit/references/codebase-audit.md` 点名同一张闸门表（harness 仓库 `packages/dsh/workflows/mstar-audit-fanout.js` 的 `seatPrompt`），以免 prose 派发路径漂移；行为用例要求两个标记都出现在 security 席位提示词中，且不出现在其他席位。
