# PM 路由评估

本评估用于验证 `@project-manager` 是否将任务路由到正确的 agent 和门禁。

## 输入

- 场景集：`~/.config/opencode/docs/agents/routing-evals.json`
- 路由策略来源：`~/.config/opencode/agents/project-manager.md`
- 全局约束：`~/.config/opencode/AGENTS.md` 和 `~/.config/opencode/docs/agents/harness-loop.md`

## 评估方法

对每个场景：

1. 将实际路由与 `expected_route` 进行比对。
2. 检查所需产出是否已规划并最终产出。
3. 验证没有 `hard_fail_if` 条件被违反。
4. 验证 `Context Loaded` 已声明且包含必要文件。
5. 记录路由质量和缺失的证据。

## 评分

- `Pass`：路由和产出满足预期，无硬性失败。
- `Borderline`：存在轻微偏差但质量门禁得到保留。
- `Fail`：触发硬性失败条件或跳过关键门禁。

## 回归信号

如果以下情况在两个或以上场景中出现，则说明路由逻辑退化：

- 实现类任务省略了 QA 门禁
- QC 路径相对任务类型被过度或不足使用
- 跨模块工作缺少 architect/探索阶段
- 非热修复任务使用了热修复路径
- `Context Loaded` 缺失或缺少必要的 plan 路径

## 迭代规则

如果任一场景失败：

- 向用户提议对 `~/.config/opencode/agents/project-manager.md` 或 `~/.config/opencode/docs/agents/*` 的修改（全局配置仅由用户本人维护，agent 不得直接写入）
- 重新运行完整场景集
- 在 plan notes 中记录变更内容及原因
