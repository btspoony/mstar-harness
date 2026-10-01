---
category: Harness
packages: root
---

- Replaced the plan template's universal integration sequence with the lifecycle contract's three declared completion routes: iteration keeps its pinned integration, standalone development completes straight from the accepted handoff, and standalone report-only records its `completion_policy` fulfilment before `Done`. Absent integration anchors no longer falsely block report-only plans and never excuse genuinely missing registration facts.
- Updated `mstar-artifacts/templates/plan.main.md` (Engine lifecycle block) and `mstar-artifacts/references/plan-quality-bar.md` (item 8, Engine lifecycle ownership) to match the authority.
- Thinned the iteration cold-start entry path: `mstar-iteration` Load order now owns the artifact/host topic triggers, and the `iteration-start` / `iteration-drive` / `iteration-loop` Boots keep only intent, route choice and the pointer to that authority instead of independently maintained load matrices. Pause/full routing, fail-closed invalid drive input, credential/leaf boundaries and required host actions are unchanged; the reconstructed Boot-mandated read set (per-file UTF-8 bytes measured; no observed stream trace yet) drops the start path's cold-start reads to the first executable action from 12 (268,870 B) to 6 (109,763 B); token counts unknown.

<!-- CN -->
- 将计划模板中的通用集成序列替换为生命周期契约声明的三条完成路由：iteration 保留固定集成，standalone development 从已接受交接直接完成，standalone report-only 在 `Done` 之前记录其 `completion_policy` 履行。缺失集成锚点不再错误阻断 report-only 计划，也绝不豁免真正缺失的注册事实。
- 更新 `mstar-artifacts/templates/plan.main.md`（Engine lifecycle 块）与 `mstar-artifacts/references/plan-quality-bar.md`（第 8 条 Engine lifecycle ownership）以与权威契约保持一致。
- 精简迭代冷启动入口路径：`mstar-iteration` Load order 现在拥有 artifacts/host 的 topic 触发时点，`iteration-start` / `iteration-drive` / `iteration-loop` 的 Boot 只保留 intent、route choice 与指向该权威的指针，不再各自维护加载矩阵。pause/full 路由、非法 drive 输入 fail-closed、凭据/leaf 边界与必需宿主动作不变；按入口文本重建的 Boot 必读集合（逐文件 UTF-8 字节实测；尚无真实流式读取 trace）使 start 路径到首个可执行动作的冷启动读取从 12 次（268,870 B）降至 6 次（109,763 B）；token 计数未知。
