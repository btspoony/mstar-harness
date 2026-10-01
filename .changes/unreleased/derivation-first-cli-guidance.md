---
category: Harness
packages: root
---

- Replaced the plan template's universal integration sequence with the lifecycle contract's three declared completion routes: iteration keeps its pinned integration, standalone development completes straight from the accepted handoff, and standalone report-only records its `completion_policy` fulfilment before `Done`. Absent integration anchors no longer falsely block report-only plans and never excuse genuinely missing registration facts.
- Updated `mstar-artifacts/templates/plan.main.md` (Engine lifecycle block) and `mstar-artifacts/references/plan-quality-bar.md` (item 8, Engine lifecycle ownership) to match the authority.

<!-- CN -->
- 将计划模板中的通用集成序列替换为生命周期契约声明的三条完成路由：iteration 保留固定集成，standalone development 从已接受交接直接完成，standalone report-only 在 `Done` 之前记录其 `completion_policy` 履行。缺失集成锚点不再错误阻断 report-only 计划，也绝不豁免真正缺失的注册事实。
- 更新 `mstar-artifacts/templates/plan.main.md`（Engine lifecycle 块）与 `mstar-artifacts/references/plan-quality-bar.md`（第 8 条 Engine lifecycle ownership）以与权威契约保持一致。
