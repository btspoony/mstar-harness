/**
 * `mstar-panel` locale namespace (spec §4.3): en (default) + zh, registered
 * via `ctx.locale.register(NS, { zh, en })` at plugin apply. The key union is
 * merged into the ui-slots `LocaleNamespaceMap` so the framework synthesizes
 * a typed `t` seat for the panel component (dictionary keys are checked
 * against the union by `LocaleDictOf`).
 *
 * T2 (spec panel-layout-graph §4): the iteration/gate detail moved into the
 * graph — the `iteration.*` keys were replaced by the `graph.*` family (phase
 * ring labels, plan-state bucket labels, legend, verdicts, degraded notes).
 *
 * T3 (spec agent-flow-catalog-graph §2.4): the expected/actual agent-flow
 * pipeline — `flow.*` keys (event strip title, status labels, degraded/empty
 * notes, unexpected) + `graph.legend.flow-*` legend labels.
 */

import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace id for the workflow-viz panel. */
export const NS = 'mstar-panel'

/** Panel dictionary keys (union of every translatable string the panel renders). */
export type PanelKey =
  | 'view.mstar-workflow'
  | 'empty.waiting'
  | 'empty.no-harness'
  | 'watermark.version'
  | 'watermark.harness'
  | 'watermark.none'
  | 'panel.unknown'
  | 'graph.phase.iteration-start'
  | 'graph.phase.autonomous-execute'
  | 'graph.phase.iteration-close'
  | 'graph.phase.pr-delivery'
  | 'graph.phase.merge-ready'
  | 'graph.state.Todo'
  | 'graph.state.InProgress'
  | 'graph.state.InReview'
  | 'graph.state.Done'
  | 'graph.state.Blocked'
  | 'graph.state.unknown'
  | 'graph.legend.title'
  | 'graph.legend.phases'
  | 'graph.legend.plan-states'
  | 'graph.legend.edge-forward'
  | 'graph.legend.edge-loop'
  | 'graph.legend.edge-connector'
  | 'graph.legend.state-current'
  | 'graph.legend.state-next'
  | 'graph.legend.state-idle'
  | 'graph.legend.verdict-pass'
  | 'graph.legend.verdict-fail'
  | 'graph.legend.flow-expected'
  | 'graph.legend.flow-actual'
  | 'graph.legend.flow-unexpected'
  | 'flow.title'
  | 'flow.empty'
  | 'flow.degraded'
  | 'flow.unexpected'
  | 'flow.in-flight'
  | 'flow.settled-ok'
  | 'flow.error'
  | 'flow.advisory'
  | 'flow.denied'
  | 'flow.event-count'
  | 'graph.iteration-id'
  | 'graph.current'
  | 'graph.next'
  | 'graph.pass'
  | 'graph.fail'
  | 'graph.violations'
  | 'graph.no-violations'
  | 'graph.no-compass'
  | 'graph.no-plans'
  | 'graph.no-state'
  | 'state.title'
  | 'state.plans'
  | 'state.residuals'
  | 'state.branches'
  | 'state.policy'
  | 'state.leases'
  | 'state.knowledge'
  | 'state.direction'
  | 'state.none'
  | 'state.branch.iteration-base'
  | 'state.branch.target'
  | 'state.branch.spec-integration'
  | 'state.policy.push'
  | 'state.policy.worktree'
  | 'state.policy.control-worktree'
  | 'state.knowledge.docs'
  | 'freshness.last-updated'
  | 'freshness.refresh-note'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'mstar-panel': PanelKey
  }
}

/** zh dictionary (repo bilingual convention; zh is the stub fallback locale). */
export const zh: LocaleDictOf<'mstar-panel'> = {
  'view.mstar-workflow': 'MStar 工作流',
  'empty.waiting': '等待首条 engine-status catalog…',
  'empty.no-harness': '未检测到 Morning Star harness',
  'watermark.version': 'mstar {version}',
  'watermark.harness': 'harness: {dir}',
  'watermark.none': '无',
  'panel.unknown': '未知',
  'graph.phase.iteration-start': '迭代启动',
  'graph.phase.autonomous-execute': '自主执行',
  'graph.phase.iteration-close': '迭代收口',
  'graph.phase.pr-delivery': 'PR 交付',
  'graph.phase.merge-ready': '合并就绪',
  'graph.state.Todo': '待办',
  'graph.state.InProgress': '进行中',
  'graph.state.InReview': '审查中',
  'graph.state.Done': '完成',
  'graph.state.Blocked': '受阻',
  'graph.state.unknown': '未知',
  'graph.legend.title': '图例',
  'graph.legend.phases': '阶段环',
  'graph.legend.plan-states': 'plan 状态机',
  'graph.legend.edge-forward': '正向流转',
  'graph.legend.edge-loop': '循环 —— 下一轮迭代',
  'graph.legend.edge-connector': '当前阶段焦点',
  'graph.legend.state-current': '当前阶段',
  'graph.legend.state-next': '下一步',
  'graph.legend.state-idle': '未点亮（schema）',
  'graph.legend.verdict-pass': 'gate PASS',
  'graph.legend.verdict-fail': 'gate FAIL',
  'graph.legend.flow-expected': '预期 stage（空心）',
  'graph.legend.flow-actual': '实际派发（实心）',
  'graph.legend.flow-unexpected': '未匹配角色（描边）',
  'flow.title': 'Agent 流转事件',
  'flow.empty': '暂无实际派发（记录自 agent-flow plan 合并起生效）',
  'flow.degraded': 'agentFlow 证据缺失',
  'flow.unexpected': '未匹配角色',
  'flow.in-flight': '已派发',
  'flow.settled-ok': '已结算',
  'flow.error': '出错',
  'flow.advisory': '提示',
  'flow.denied': '拒绝',
  'flow.event-count': '{count} 条',
  'graph.iteration-id': '迭代',
  'graph.current': '当前',
  'graph.next': '下一步',
  'graph.pass': 'PASS',
  'graph.fail': 'FAIL',
  'graph.violations': '违规 ({count})',
  'graph.no-violations': '无违规',
  'graph.no-compass': '无 steering compass / status.json',
  'graph.no-plans': '无 plan 行（状态机骨架）',
  'graph.no-state': '无工作区状态摘要',
  'state.title': '工作区状态',
  'state.plans': '计划',
  'state.residuals': '未决残留',
  'state.branches': '分支',
  'state.policy': '策略',
  'state.leases': '租约',
  'state.knowledge': '知识',
  'state.direction': '方向',
  'state.none': '无',
  'state.branch.iteration-base': 'iteration base',
  'state.branch.target': 'target',
  'state.branch.spec-integration': 'spec integration',
  'state.policy.push': 'push',
  'state.policy.worktree': 'worktree',
  'state.policy.control-worktree': 'control worktree',
  'state.knowledge.docs': '{count} 篇文档',
  'freshness.last-updated': '最后更新 {time}',
  'freshness.refresh-note': '刷新跟随 catalog 重发（约 ≤1 分钟）',
}

/** en dictionary (default locale). */
export const en: LocaleDictOf<'mstar-panel'> = {
  'view.mstar-workflow': 'MStar Workflow',
  'empty.waiting': 'Waiting for the first engine-status catalog…',
  'empty.no-harness': 'No Morning Star harness detected',
  'watermark.version': 'mstar {version}',
  'watermark.harness': 'harness: {dir}',
  'watermark.none': 'none',
  'panel.unknown': 'unknown',
  'graph.phase.iteration-start': 'Iteration Start',
  'graph.phase.autonomous-execute': 'Autonomous Execute',
  'graph.phase.iteration-close': 'Iteration Close',
  'graph.phase.pr-delivery': 'PR Delivery',
  'graph.phase.merge-ready': 'Merge Ready',
  'graph.state.Todo': 'Todo',
  'graph.state.InProgress': 'In Progress',
  'graph.state.InReview': 'In Review',
  'graph.state.Done': 'Done',
  'graph.state.Blocked': 'Blocked',
  'graph.state.unknown': 'Unknown',
  'graph.legend.title': 'Legend',
  'graph.legend.phases': 'Phase ring',
  'graph.legend.plan-states': 'Plan state machine',
  'graph.legend.edge-forward': 'forward transition',
  'graph.legend.edge-loop': 'loop — next iteration',
  'graph.legend.edge-connector': 'current-phase focus',
  'graph.legend.state-current': 'current phase',
  'graph.legend.state-next': 'next phase',
  'graph.legend.state-idle': 'unlit (schema)',
  'graph.legend.verdict-pass': 'gate PASS',
  'graph.legend.verdict-fail': 'gate FAIL',
  'graph.legend.flow-expected': 'expected stage (hollow)',
  'graph.legend.flow-actual': 'actual dispatch (filled)',
  'graph.legend.flow-unexpected': 'unexpected role (outlined)',
  'flow.title': 'Agent flow events',
  'flow.empty': 'No actual dispatches yet (recording starts at agent-flow plan merge)',
  'flow.degraded': 'No agent-flow evidence (ledger missing)',
  'flow.unexpected': 'Unexpected roles',
  'flow.in-flight': 'dispatched',
  'flow.settled-ok': 'settled ok',
  'flow.error': 'error',
  'flow.advisory': 'advisory',
  'flow.denied': 'denied',
  'flow.event-count': '{count} events',
  'graph.iteration-id': 'iteration',
  'graph.current': 'current',
  'graph.next': 'next',
  'graph.pass': 'PASS',
  'graph.fail': 'FAIL',
  'graph.violations': 'violations ({count})',
  'graph.no-violations': 'no violations',
  'graph.no-compass': 'No steering compass / status.json',
  'graph.no-plans': 'no plan rows (state machine skeleton)',
  'graph.no-state': 'no workspace state digest',
  'state.title': 'Workspace state',
  'state.plans': 'Plans',
  'state.residuals': 'Open residuals',
  'state.branches': 'Branches',
  'state.policy': 'Policy',
  'state.leases': 'Leases',
  'state.knowledge': 'Knowledge',
  'state.direction': 'Direction',
  'state.none': 'none',
  'state.branch.iteration-base': 'iteration base',
  'state.branch.target': 'target',
  'state.branch.spec-integration': 'spec integration',
  'state.policy.push': 'push',
  'state.policy.worktree': 'worktree',
  'state.policy.control-worktree': 'control worktree',
  'state.knowledge.docs': '{count} docs',
  'freshness.last-updated': 'last updated {time}',
  'freshness.refresh-note': 'refreshes with catalog re-emission (≤~1 min)',
}
