---
category: Harness
packages: commands, cli, engine
---

- `mstar session recover` accepts optional `--plan <id>` to recover exactly that plan's stopped plan-PM owner through active execution authority. Plan recovery requires `--prior-session` naming the actual prior owner; `--unowned` remains coordinator-only. The replacement plan-PM reference belongs to the current coordinator's independently acquired identity and does not borrow the stopped session, adopt integration ownership, or affect other plans. Without `--plan`, coordinator recovery remains unchanged. A recovered plan can follow the ordinary reviewed handoff → accept → complete lifecycle.

<!-- CN -->
- `mstar session recover` 新增可选 `--plan <id>`，通过 active execution authority 恢复指定计划的已停止 plan-PM owner。计划恢复必须由 `--prior-session` 指定真实前任 owner；`--unowned` 仍仅用于协调者恢复。新的 plan-PM 引用归当前协调者独立获取的身份所有，不借用已停止会话、不接管集成所有权，也不影响其他计划。不带 `--plan` 时，原协调者恢复行为保持不变。恢复后的计划可继续走正常的经审查 handoff → accept → complete 生命周期。
