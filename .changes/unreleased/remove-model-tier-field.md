---
category: Harness
packages: root
---

- Removed the Assignment **`Model tier`** field. It was unenforceable — a skill document cannot observe which model a host actually runs — and nothing machine-checked it: neither the engine nor the CLI required it, so removing it needed no runtime change.
- Deleted the field's two host-mapping tables and every producer/consumer reference with them: the `mstar-sdd` tier section (including its "always name model on dispatch" rule), the `Model:` lines in the three SDD dispatch-prompt templates and the sticky-session header line, the `file-handoffs` required-field bullet, the Phase 2 per-task dispatch step and the Assignment-field clause that forbade omitting it, the Assignment template field and its SDD NEVER mention, the routing-eval expectation string, and the tier section in `mstar-host/references/cursor.md`. The never-omit clauses that named the field now cover only `Execution mode` / `SDD dir`.
- Host-native model selection is left to the host and the session, where it already lived: Cursor's Task `model` argument is documented as an optional host slug for the session's own model policy that prescribes no mstar tier, and the dsh `agent()` and omp model-handoff capabilities keep their existing descriptions.

<!-- CN -->
- 已删除 Assignment 的 **`Model tier`** 字段。该字段不可执行 —— skill 文档无法观测宿主实际运行哪个模型 —— 且没有任何机器校验它：engine 与 CLI 都不要求它，因此删除它无需运行期改动。
- 一并删除该字段的两张宿主映射表及所有生产方/消费方引用：`mstar-sdd` 的档位章节（含其「派发时必须指明模型」规则）、三份 SDD dispatch prompt 模板与 sticky session 头部行中的 `Model:` 行、`file-handoffs` 的必需字段条目、Phase 2 的 per-task 派发步骤与「禁止省略该字段」的 Assignment 字段条款、Assignment 模板字段及其 SDD NEVER 提及、routing-eval 期望字符串，以及 `mstar-host/references/cursor.md` 中的档位章节。原先点名该字段的「禁止省略」条款现只覆盖 `Execution mode` / `SDD dir`。
- 宿主原生的模型选择仍留在它原本所在之处，交由宿主与会话决定：Cursor 的 Task `model` 参数被记述为可选的宿主 slug，服务于会话自身的模型策略，不规定任何 mstar 档位；dsh `agent()` 与 omp model handoff 能力保持既有描述不变。
