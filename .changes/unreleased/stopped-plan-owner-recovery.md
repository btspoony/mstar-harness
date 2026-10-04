---
category: Harness
packages: commands, cli, engine
---

- `mstar session recover` accepts optional `--plan <id>` to recover exactly that plan's stopped plan-PM owner through active execution authority. Plan recovery requires `--prior-session` naming the actual prior owner; `--unowned` remains coordinator-only. The replacement plan-PM reference belongs to the current coordinator's independently acquired identity and does not borrow the stopped session, adopt integration ownership, or affect other plans. Without `--plan`, coordinator recovery remains unchanged. A recovered plan can follow the ordinary reviewed handoff → accept → complete lifecycle.
- A plan-PM binding remains attached to its native identity after completion. To recover another stopped plan in the same workflow, complete the first plan normally, explicitly stop its coordinator, acquire a genuinely new native coordinator session, recover that stopped coordinator, then recover the second exact plan with its own stop evidence and current plan token. Reusing the old native identity or copying its session reference cannot retarget the retained binding.

<!-- CN -->
- `mstar session recover` 新增可选 `--plan <id>`，通过 active execution authority 恢复指定计划的已停止 plan-PM owner。计划恢复必须由 `--prior-session` 指定真实前任 owner；`--unowned` 仍仅用于协调者恢复。新的 plan-PM 引用归当前协调者独立获取的身份所有，不借用已停止会话、不接管集成所有权，也不影响其他计划。不带 `--plan` 时，原协调者恢复行为保持不变。恢复后的计划可继续走正常的经审查 handoff → accept → complete 生命周期。
- 计划 PM 绑定在计划完成后仍保留于原生身份。要恢复同一 workflow 中另一个已停止计划，须先正常完成第一个计划，明确停止其协调者，再获取真正新的原生协调者会话，恢复该已停止协调者，然后使用第二个计划自身的停止证据和当前计划 token 恢复其精确 owner。复用旧原生身份或复制其 session reference 均不能重定向保留的绑定。
