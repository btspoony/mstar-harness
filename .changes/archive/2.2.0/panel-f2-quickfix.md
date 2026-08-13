---
category: Harness
packages: root
---

- **dsh plugin**: panel F2 quickfix (plan `20260811-panel-f2-quickfix`) — (1) the 任务迭代 tab's step row now renders 5 equal full-width unit blocks (flex `1 1 0`, centered content, `--mstar-space-*` gap) with pure-number badges and `n/total` summary — the connector bars (`data-step-connector*`) are removed and zh/en carry no 步骤/Step wording; (2) `KNOWN_AGENTS` is now exactly 14 roles — `project-manager` (the primary orchestration agent, never an assignable subagent) is removed from the 代理执行 roster; (3) the agent canvas drops the `ops-on-demand` pipeline stage (5 stages, `qa-gate` terminal), moves `ops-engineer` / `prompt-engineer` into a separate **on-demand column** (projection-owned `zone`, no expected/next arrows into it, localized label + legend entry), and renders the SDD implement ↔ task-review **loop back-edge** (`sdd-task-review → sdd-implement`) as a visually distinct curved double-arrow with its own `data-agent-edge-loop` anchor — `pending` semantics follow (11 in-flow roles).

<!-- CN -->
- **dsh 插件**：面板 F2 快速修复（plan `20260811-panel-f2-quickfix`）——（1）「任务迭代」tab 的步骤行改为 5 个等分铺满单元块（flex `1 1 0`、内容居中、`--mstar-space-*` 间距），徽标为纯数字、摘要为 `n/total`——连接条（`data-step-connector*`）已移除，zh/en 均无「步骤/Step」字样；（2）`KNOWN_AGENTS` 现恰为 14 个角色——`project-manager`（主编排代理，绝非可分配 subagent）从「代理执行」roster 中移除；（3）代理画布删除 `ops-on-demand` 管线阶段（5 阶段、`qa-gate` 为终点），`ops-engineer` / `prompt-engineer` 移入独立的**按需执行列**（投影层 `zone` 语义、无 expected/next 箭头进出、本地化列标签 + 图例条目），并将 SDD 实现 ↔ 任务审查**回环反向边**（`sdd-task-review → sdd-implement`）渲染为视觉可辨的弯曲双向箭头并带独立 `data-agent-edge-loop` 锚点——`pending` 语义随之更新（11 个流内角色）。
