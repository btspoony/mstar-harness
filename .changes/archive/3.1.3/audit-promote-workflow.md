---
category: Harness
packages: root, cli, opencode
---

- **`mstar audit promote` (CLI)**: selected audit plans can now enter the v2 workflow lifecycle as `type: plan` — `promoteAuditPlans` writes the workflow snapshot (`{HARNESS_DIR}/workflows/<id>/snapshot.json`, one Todo `PlanRow` per selected plan, `id` + `title` + `file`) **before** registering the workflow in root `status.json`, so the snapshot-before-register invariant holds. `--plans` accepts the README Plan column id, stem, or basename; `--workflow` defaults to the `audit-<date>` dir basename; `--harness` defaults to the resolved `{HARNESS_DIR}`. Promote stays an explicit post-selection action — the audit itself never registers (advisory contract preserved).
- **Engine**: `promoteAuditPlans` exported from `@mstar-harness/engine` (titles come from the audit README index, falling back to `readPlanFileSummary`).
- **Harness skills**: `mstar-audit` Handoff step 1 now names `mstar audit promote <audit-dir> --plans <ids>` as the first-class v2 path (manual `mstar-plan-artifacts` wording kept as fallback).

<!-- CN -->
- **`mstar audit promote`（CLI）**：用户选定后，审计计划可正式进入 v2 工作流状态机，类型为 `type: plan` —— `promoteAuditPlans` 先写工作流快照（`{HARNESS_DIR}/workflows/<id>/snapshot.json`，每个选定计划一行 `PlanRow`：`id` + `title` + `file`），再在根 `status.json` 注册工作流，保证 snapshot-before-register 不变量。`--plans` 接受 README 索引列 id、stem 或 basename；`--workflow` 默认取 `audit-<date>/` 目录 basename；`--harness` 默认取解析到的 `{HARNESS_DIR}`。promote 仍是用户选择后的显式动作——审计本身永不注册（咨询性契约不变）。
- **Engine**：`@mstar-harness/engine` 导出 `promoteAuditPlans`（标题取自审计索引，缺失时回退到 `readPlanFileSummary`）。
- **Harness skills**：`mstar-audit` Handoff 步骤 1 现将 `mstar audit promote <audit-dir> --plans <ids>` 列为首选路径（手写 `mstar-plan-artifacts` 作为回退保留）。
