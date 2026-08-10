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
 *
 * T3 (spec panel-zones §3): the iteration zone is filled in — `zone.phase.*`
 * (the 5 PHASE_IDS names, the `graph.phase.*` wording moved into the zone
 * namespace), `zone.iteration.*` (active/inactive notes, Step N/5 label,
 * Step N badge, step-state chips) and `zone.branches.*` (the branch panel
 * moved from the sidebar). `zone.iteration.placeholder` is gone with the
 * placeholder.
 *
 * T4 (spec panel-zones §3): the task board kanban is filled in —
 * `zone.state.*` (the 6 PLAN_STATE_IDS column names — en is the raw status
 * word, zh the localized name), `zone.tasks.total` (zone header plan total),
 * `zone.tasks.no-plans` (the muted empty note) and `zone.tasks.more` (the
 * Done-column `+N more` overflow hint). `zone.tasks.placeholder` is gone with
 * the placeholder.
 *
 * T2 (spec panel-zones §4, plan 20260810-panel-agent-flow-zone): the agents
 * zone is filled in — `zone.agents.summary` (`N executing · M pending`),
 * `zone.agents.pending-label` (the dashed "待执行" placeholder chip) and
 * `zone.agents.next` (the animated next-edge label). `zone.agents.placeholder`
 * is gone with the placeholder.
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
  | 'zone.legend.next'
  | 'zone.iteration.title'
  | 'zone.iteration.active'
  | 'zone.iteration.inactive'
  | 'zone.iteration.step-label'
  | 'zone.iteration.step-badge'
  | 'zone.iteration.step.current'
  | 'zone.iteration.step.next'
  | 'zone.iteration.step.idle'
  | 'zone.phase.iteration-start'
  | 'zone.phase.autonomous-execute'
  | 'zone.phase.iteration-close'
  | 'zone.phase.pr-delivery'
  | 'zone.phase.merge-ready'
  | 'zone.branches.title'
  | 'zone.branches.iteration-base'
  | 'zone.branches.target'
  | 'zone.branches.spec-integration'
  | 'zone.tasks.title'
  | 'zone.tasks.total'
  | 'zone.tasks.no-plans'
  | 'zone.tasks.more'
  | 'zone.state.Todo'
  | 'zone.state.InProgress'
  | 'zone.state.InReview'
  | 'zone.state.Done'
  | 'zone.state.Blocked'
  | 'zone.state.unknown'
  | 'zone.agents.title'
  | 'zone.agents.summary'
  | 'zone.agents.pending-label'
  | 'zone.agents.next'
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
  'zone.legend.next': 'next 流转边（动画）',
  'zone.iteration.title': '迭代',
  'zone.iteration.active': '正在激活的迭代',
  'zone.iteration.inactive': '迭代未激活',
  'zone.iteration.step-label': '步骤 {n}/{total}',
  'zone.iteration.step-badge': '步骤 {n}',
  'zone.iteration.step.current': '当前',
  'zone.iteration.step.next': '下一步',
  'zone.iteration.step.idle': '待命',
  'zone.phase.iteration-start': '迭代启动',
  'zone.phase.autonomous-execute': '自主执行',
  'zone.phase.iteration-close': '迭代收口',
  'zone.phase.pr-delivery': 'PR 交付',
  'zone.phase.merge-ready': '合并就绪',
  'zone.branches.title': '分支',
  'zone.branches.iteration-base': '迭代 base',
  'zone.branches.target': '目标分支',
  'zone.branches.spec-integration': 'spec 集成分支',
  'zone.tasks.title': '任务',
  'zone.tasks.total': '{count} 个计划',
  'zone.tasks.no-plans': '暂无计划',
  'zone.tasks.more': '+{count} 更多',
  'zone.state.Todo': '待办',
  'zone.state.InProgress': '进行中',
  'zone.state.InReview': '审查中',
  'zone.state.Done': '已完成',
  'zone.state.Blocked': '受阻',
  'zone.state.unknown': '未知',
  'zone.agents.title': '代理执行',
  'zone.agents.summary': '{executing} 执行中 · {pending} 待执行',
  'zone.agents.pending-label': '待执行',
  'zone.agents.next': 'next',
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
  'zone.legend.next': 'next flow edge (animated)',
  'zone.iteration.title': 'Iteration',
  'zone.iteration.active': 'active iteration',
  'zone.iteration.inactive': 'iteration inactive',
  'zone.iteration.step-label': 'Step {n}/{total}',
  'zone.iteration.step-badge': 'Step {n}',
  'zone.iteration.step.current': 'current',
  'zone.iteration.step.next': 'next',
  'zone.iteration.step.idle': 'idle',
  'zone.phase.iteration-start': 'Iteration Start',
  'zone.phase.autonomous-execute': 'Autonomous Execute',
  'zone.phase.iteration-close': 'Iteration Close',
  'zone.phase.pr-delivery': 'PR Delivery',
  'zone.phase.merge-ready': 'Merge Ready',
  'zone.branches.title': 'Branches',
  'zone.branches.iteration-base': 'iteration base',
  'zone.branches.target': 'target',
  'zone.branches.spec-integration': 'spec integration',
  'zone.tasks.title': 'Tasks',
  'zone.tasks.total': '{count} plans',
  'zone.tasks.no-plans': 'no plans',
  'zone.tasks.more': '+{count} more',
  'zone.state.Todo': 'Todo',
  'zone.state.InProgress': 'InProgress',
  'zone.state.InReview': 'InReview',
  'zone.state.Done': 'Done',
  'zone.state.Blocked': 'Blocked',
  'zone.state.unknown': 'unknown',
  'zone.agents.title': 'Agent Flow',
  'zone.agents.summary': '{executing} executing · {pending} pending',
  'zone.agents.pending-label': 'pending',
  'zone.agents.next': 'next',
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
