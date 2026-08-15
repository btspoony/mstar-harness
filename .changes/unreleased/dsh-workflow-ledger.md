---
category: Harness
packages: dsh
---

- **dsh plugin**: workflow / ralph fan-out runs now land in the agent-flow ledger — a session-event consumer (logger `mstar/workflow-ledger`, registered at apply) maps the durable `tool-workflow/run-start|agent-start|run-end` session events into three new ledger kinds (`workflow-run` / `workflow-agent` / `workflow-run-end`; `childId` preserved, run name + member count + stopReason surfaced in the Event Log tab). Source of record is the session log (cold scan at apply + live `session/event` firehose, one delta cursor per session id — one row per `(runId, kind, seq)`), NOT the in-memory `workflow/*` emits. Observe-only (zero gating): a failing ledger write never crashes or alters a run; the `sessions` service absent (dsh-session mounting after the mstar row, or missing) degrades silently to one debug log with the consumer disabled. On `agent-start`, a once-per-run depth advisory warns when the child session's `delegationDepth` is ≥ 2 — observe-time only, never a refusal path.

<!-- CN -->
- **dsh 插件**：workflow / ralph 扇出运行现进入 agent-flow 账本——会话事件消费者（日志器 `mstar/workflow-ledger`，apply 时注册）把持久化的 `tool-workflow/run-start|agent-start|run-end` 会话事件映射为三种新账本类型（`workflow-run` / `workflow-agent` / `workflow-run-end`；保留 `childId`，运行名 + 成员数 + stopReason 在事件日志 tab 呈现）。事实来源是会话日志（apply 冷扫描 + 实时 `session/event` firehose，每会话 id 一条 delta 游标——每个 `(runId, kind, seq)` 一行），**不是**内存中的 `workflow/*` emits。仅观察（零门禁）：账本写入失败绝不崩溃或改变运行；`sessions` 服务缺失（dsh-session 晚于 mstar 行挂载或缺失）静默降级为一条 debug 日志、消费者禁用。`agent-start` 时按运行至多一次的深度咨询在子会话 `delegationDepth` ≥ 2 时告警——仅观察时，绝非拒绝通道。
