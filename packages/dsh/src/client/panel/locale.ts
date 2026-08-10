/**
 * `mstar-panel` locale namespace (spec §4.3): en (default) + zh, registered
 * via `ctx.locale.register(NS, { zh, en })` at plugin apply. The key union is
 * merged into the ui-slots `LocaleNamespaceMap` so the framework synthesizes
 * a typed `t` seat for the panel component (dictionary keys are checked
 * against the union by `LocaleDictOf`).
 *
 * T2 (spec panel-zones §2, plan 20260810-panel-canvas-zones): the react-flow
 * graph is replaced by the zone dashboard — the `graph.phase.*` /
 * `graph.state.*` / react-flow `graph.legend.*` key families are gone with
 * the graph library; the footer keeps the `graph.pass/fail/violations`
 * gate-summary keys, and the new `zone.*` family covers the three zone
 * titles/placeholders + the zone-semantic legend. The `flow.*` key family
 * (agent-flow event dock) is unchanged.
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
  | 'graph.pass'
  | 'graph.fail'
  | 'graph.violations'
  | 'graph.no-violations'
  | 'zone.legend.title'
  | 'zone.legend.iteration'
  | 'zone.legend.current'
  | 'zone.legend.disabled'
  | 'zone.legend.tasks'
  | 'zone.legend.verdict-pass'
  | 'zone.legend.verdict-fail'
  | 'zone.legend.flow-expected'
  | 'zone.legend.flow-actual'
  | 'zone.legend.flow-unexpected'
  | 'zone.iteration.title'
  | 'zone.iteration.placeholder'
  | 'zone.tasks.title'
  | 'zone.tasks.placeholder'
  | 'zone.agents.title'
  | 'zone.agents.placeholder'
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
  | 'state.title'
  | 'state.plans'
  | 'state.residuals'
  | 'state.policy'
  | 'state.leases'
  | 'state.knowledge'
  | 'state.direction'
  | 'state.none'
  | 'state.enforcement'
  | 'state.enforcement.hard'
  | 'state.enforcement.soft'
  | 'state.plans.more'
  | 'state.residual.more'
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
  'graph.pass': 'PASS',
  'graph.fail': 'FAIL',
  'graph.violations': '违规 ({count})',
  'graph.no-violations': '无违规',
  'zone.legend.title': '图例',
  'zone.legend.iteration': '迭代区',
  'zone.legend.current': '当前阶段',
  'zone.legend.disabled': '迭代未激活',
  'zone.legend.tasks': '任务 kanban',
  'zone.legend.verdict-pass': 'gate PASS',
  'zone.legend.verdict-fail': 'gate FAIL',
  'zone.legend.flow-expected': '预期 stage（空心）',
  'zone.legend.flow-actual': '实际派发（实心）',
  'zone.legend.flow-unexpected': '未匹配角色（描边）',
  'zone.iteration.title': '迭代',
  'zone.iteration.placeholder': '迭代区（Step N / 分支）待实现',
  'zone.tasks.title': '任务',
  'zone.tasks.placeholder': '任务 kanban 待实现',
  'zone.agents.title': '代理执行',
  'zone.agents.placeholder': '代理执行区（实体 / 流转）待实现',
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
  'state.title': '工作区状态',
  'state.plans': '计划',
  'state.residuals': '未决残留',
  'state.policy': '策略',
  'state.leases': '租约',
  'state.knowledge': '知识',
  'state.direction': '方向',
  'state.none': '无',
  'state.enforcement': '执行策略',
  'state.enforcement.hard': 'hard',
  'state.enforcement.soft': 'soft',
  'state.plans.more': '+{count} 更多',
  'state.residual.more': '+{count} 更多',
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
  'graph.pass': 'PASS',
  'graph.fail': 'FAIL',
  'graph.violations': 'violations ({count})',
  'graph.no-violations': 'no violations',
  'zone.legend.title': 'Legend',
  'zone.legend.iteration': 'iteration zone',
  'zone.legend.current': 'current step',
  'zone.legend.disabled': 'disabled iteration',
  'zone.legend.tasks': 'task kanban',
  'zone.legend.verdict-pass': 'gate PASS',
  'zone.legend.verdict-fail': 'gate FAIL',
  'zone.legend.flow-expected': 'expected stage (hollow)',
  'zone.legend.flow-actual': 'actual dispatch (filled)',
  'zone.legend.flow-unexpected': 'unexpected role (outlined)',
  'zone.iteration.title': 'Iteration',
  'zone.iteration.placeholder': 'Iteration zone (Step N / branches) pending',
  'zone.tasks.title': 'Tasks',
  'zone.tasks.placeholder': 'Task kanban pending',
  'zone.agents.title': 'Agent Flow',
  'zone.agents.placeholder': 'Agent flow zone (entities / flow) pending',
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
  'state.title': 'Workspace state',
  'state.plans': 'Plans',
  'state.residuals': 'Open residuals',
  'state.policy': 'Policy',
  'state.leases': 'Leases',
  'state.knowledge': 'Knowledge',
  'state.direction': 'Direction',
  'state.none': 'none',
  'state.enforcement': 'enforcement',
  'state.enforcement.hard': 'hard',
  'state.enforcement.soft': 'soft',
  'state.plans.more': '+{count} more',
  'state.residual.more': '+{count} more',
  'state.policy.push': 'push',
  'state.policy.worktree': 'worktree',
  'state.policy.control-worktree': 'control worktree',
  'state.knowledge.docs': '{count} docs',
  'freshness.last-updated': 'last updated {time}',
  'freshness.refresh-note': 'refreshes with catalog re-emission (≤~1 min)',
}
