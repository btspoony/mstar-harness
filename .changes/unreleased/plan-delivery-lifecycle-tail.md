---
category: Harness
packages: root
---

- Wired the **per-plan delivery tail** into the normal route (frozen contract `plan-workflow-lifecycle-contract`): register at commitment → pre-lock knowledge-recall receipt → execute/acceptance → compound disposition (`created`/`updated`/reasoned `skipped`) → development PR submission → merge-ready milestone → verified merge → terminal close/unregister. Standalone development plans now reach the same delivery lifecycle; iteration plan rows and plan-scoped session authority are unchanged.

<!-- CN -->
- 将**每计划交付尾部**接入常规路线（冻结契约 `plan-workflow-lifecycle-contract`）：承诺时注册 → 计划锁定前知识回执 → 执行/验收 → compound 处置（`created`/`updated`/有理由 `skipped`）→ 开发类 PR 提交 → merge-ready 里程碑 → 核实合并 → 终态关闭/注销。独立开发 plan 现在走同一交付生命周期；iteration 子 plan 行与 plan-scoped 会话权限不变。
