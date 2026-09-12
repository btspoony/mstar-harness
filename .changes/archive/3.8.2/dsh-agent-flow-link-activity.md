---
packages: dsh
---

- **dsh plugin**: the compact model-facing agent-flow line now reports dispatch/settle **activity** only — `subagent-link` identity rows share their dispatch's role but no longer inflate the `by role` totals (they remain in the structured `source.agentFlow` summary).
- **dsh plugin**: a saturated per-Session call-window slot map now announces itself — the capacity refusal logs ONE bounded warn per apply (parent session identity + cap) instead of degrading child-identity linking silently for the rest of the session.

<!-- CN -->
- **dsh 插件**：模型可见的 agent-flow 紧凑行现在只统计派发/结算**活动量**——`subagent-link` 身份行虽沿用所属派发的 `role`，但不再抬高 `by role` 计数（它们仍保留在结构化 `source.agentFlow` 摘要中）。
- **dsh 插件**：单个 Session 的调用窗口槽位表饱和后会显式告警——容量拒绝每次 apply 只记录一条有界 warn（父会话身份 + 上限），不再于该会话剩余时间内静默降级子会话身份关联。
