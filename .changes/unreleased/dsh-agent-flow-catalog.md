---
packages: root
---

- **dsh plugin**: the context catalog now carries an **`agentFlow`** evidence row — the actual subagent dispatch/settle ledger (`{HARNESS_DIR}/agent-flow.jsonl`, bounded JSONL truncated to ~500 events; single recording core `DshHostAdapter.dispatchGate` behind both the `tools/pre-execute` listener and the `beforeDispatch` host hook; Tier-1 dispatch-only baseline + Tier-2 best-effort `tools/post-execute` settle behind a verification gate — settlement is never fabricated). The workflow panel's main graph adds the expected-vs-actual subagent flow pipeline: a third column of stage boxes lit by dispatch evidence, a collapsible event-detail footer strip (role → planId#taskId, all five status colors, settled ✓), and the flow-expected / flow-actual / flow-unexpected legend.
- **dsh plugin**: fixed ReactFlow v12 silently dropping every edge whose endpoint node exposes no connection-point `<Handle>` — all 17 graph edges (phase ring 5 + state machine 5 + connector 1 + pipeline 6) render again in the real browser.

<!-- CN -->
- **dsh 插件**：context catalog 新增 **`agentFlow`** 证据行——实际 subagent 派发/结算 ledger（`{HARNESS_DIR}/agent-flow.jsonl`，有界 JSONL，截断至约 500 条；单一记录核心 `DshHostAdapter.dispatchGate` 覆盖 `tools/pre-execute` listener 与 `beforeDispatch` host hook 两条路径；Tier-1 dispatch-only 基线 + Tier-2 `tools/post-execute` best-effort 结算并带验证闸——绝不伪装结算）。工作流面板主图新增预期 vs 实际 subagent 流转 pipeline：第三列阶段盒（由派发证据点亮）、可折叠事件明细 footer（role → planId#taskId、全部五种状态色、结算 ✓）以及 flow-expected / flow-actual / flow-unexpected 图例。
- **dsh 插件**：修复 ReactFlow v12 自定义节点缺 Handle 导致边被静默丢弃的问题——整图 17 条边（阶段环 5 + 状态机 5 + connector 1 + pipeline 6）在真实浏览器中全部恢复渲染。
