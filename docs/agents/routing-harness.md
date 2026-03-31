# PM 路由评估

本评估用于验证 `@project-manager` 是否将任务路由到正确的 agent 和门禁。

## 输入

- 场景集：`~/.config/opencode/docs/agents/routing-evals.json`
- 路由策略来源：`~/.config/opencode/agents/project-manager.md`
- 全局约束：`~/.config/opencode/docs/agents/AGENTS.md` 和 `~/.config/opencode/docs/agents/harness-loop.md`

## 评估方法

对每个场景：

1. 将实际路由与 `expected_route` 进行比对。
2. 检查所需产出是否已规划并最终产出。
3. 验证没有 `hard_fail_if` 条件被违反。
4. 验证 `Context Loaded` 已声明且包含必要文件。
5. 验证 Assignment 的语言契约：字段名英文、任务正文可中文、执行产出/报告英文（除非用户明确要求其他语言）。
6. 记录路由质量和缺失的证据。

### 评估执行步骤（1-2-3）

1. **准备输入**：加载当前 `routing-evals.json`、`project-manager.md`、`harness-loop.md`。
2. **逐案判定**：按 `expected_route` / `must_have_artifacts` / `hard_fail_if` 打分并记录证据。
3. **输出报告**：按 `evaluation-harness.md` 中的 `Routing Eval Report` 模板汇总（含 `phase_gate_compliance_rate`）。

## 评分

- `Pass`：路由和产出满足预期，无硬性失败。
- `Borderline`：存在轻微偏差但质量门禁得到保留。
- `Fail`：触发硬性失败条件或跳过关键门禁。

### Phase Gate 评分细则

用于量化 `specify -> clarify -> plan -> tasks -> implement` 合规度。

- `Pass`
  - 非 hotfix：Prepare 与 Execute 门禁均完整通过；无跳步实现。
  - hotfix：允许压缩路径，但已明确事后 `clarify/RCA` 补记安排。
- `Borderline`
  - 门禁顺序总体正确，但存在可修复的轻微缺项（例如 `Phase Gate Checklist` 字段漏写但证据可追溯）。
  - 未出现“先实现后补 gate”的行为。
- `Fail`
  - 非 hotfix 跳过 `clarify` 或 `tasks`。
  - 已知 plan drift 仍继续实现，且无 plan 回写。
  - hotfix 未承诺或未记录事后 `clarify/RCA`。

### 建议量化指标

- `phase_gate_compliance_rate = pass_cases / total_cases`
- 建议门槛：
  - 日常迭代：`>= 0.9`
  - 关键发布前：`= 1.0`

## 回归信号

如果以下情况在两个或以上场景中出现，则说明路由逻辑退化：

- 实现类任务省略了 QA 门禁
- QC 路径相对任务类型被过度或不足使用
- 跨模块工作缺少 architect/探索阶段
- 未按 `specify -> clarify -> plan` 完成准备阶段即进入实现
- `plan` 完成后未进行 `tasks` 拆解就直接实现
- 非热修复任务使用了热修复路径
- 对业务 Git 仓库的实现类分派缺少 **`Working branch`** 或明确的 **`Branch policy`**（见 `harness-loop.md`「Git 功能分支门禁」）
- `Context Loaded` 缺失或缺少必要的 plan 路径
- 非热修缺陷在未记录根因或可证伪假设前大规模改代码
- 生产/高危运维变更缺少回滚说明或高危清单
- 声明 Report-only 的 QA 任务却改动业务逻辑，或无谓触发全量三审
- Assignment 语言契约不一致（字段名漂移为中文、或要求英文报告却回报为中文且无用户豁免）

## 迭代规则

如果任一场景失败：

- 向用户提议对 `~/.config/opencode/agents/project-manager.md` 或 `~/.config/opencode/docs/agents/*` 的修改（全局配置仅由用户本人维护，agent 不得直接写入）
- 重新运行完整场景集
- 在 plan notes 中记录变更内容及原因
