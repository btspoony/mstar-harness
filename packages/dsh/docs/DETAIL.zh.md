![dsh 会话中的一步：mstar-engine 状态行报告 workflow.selection.no-active，mstar_plan_bind 在注册 lifecycle 之前被拒绝，mstar_audit_validate 把评审报告脱敏为行号与类型，右侧栏「晨星工作流」面板读取同一份工作区状态](preview.zh.svg)

插件让工作区 harness 在 dsh 会话里可见、可约束：一条模型可见的 `mstar-engine` 目录行在 `agent/pre-step` 注入（引擎状态、迭代阶段门禁与工作区摘要）；三个原生工具承载共享 MCP 连接无法提供的门禁（`mstar_plan_bind` 绑定 coordinator 计划并写入本会话的 `executionBinding` 槽，`mstar_audit_validate` 执行 `mstar-audit` Hard Rule 4 的凭据扫描且只按行号与类型报告，`mstar_execution_clear` 只清除调用者自己的绑定）；右侧栏的「晨星工作流」面板通过 `/api/mstar/*` 读写同一份状态。
