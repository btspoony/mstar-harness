/**
 * `mstar-panel` locale namespace: en (default) + zh, registered via
 * `ctx.locale.register(NS, { zh, en })` at plugin apply. The key union is
 * merged into the ui-slots `LocaleNamespaceMap` so the framework synthesizes a
 * typed `t` seat for the panel component (dictionary keys are checked against
 * the union by `LocaleDictOf`).
 *
 * Families:
 * - `tab.*` — the three section tabs (任务迭代 / 项目路线图 / 事件记录). The
 *   agents tab is retired with the emission-mediated read path;
 * - `zone.*` — the tasks page's iteration stepper, branch panel and kanban;
 * - `roadmap.*` — the roadmap page, INCLUDING one copy line per absence state
 *   (`not-applicable` / `absent` / `no-milestones` / `unavailable`), so a
 *   degraded read is never mistakable for an empty roadmap;
 * - `event-log.*` — the single merged event flow (流转 / 结算 / 违规 rows);
 * - `state.*` / `freshness.*` / `empty.*` — the workspace digest, the snapshot
 *   freshness stamp and the panel's own empty/degraded states.
 *
 * The former agents page and canvas-legend key families are GONE with those
 * surfaces.
 */

import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace id for the workflow-viz panel. */
export const NS = 'mstar-panel'

/** Panel dictionary keys (union of every translatable string the panel renders). */
export type PanelKey =
  | 'view.mstar-workflow'
  | 'guide.description'
  | 'tab.tasks'
  | 'tab.roadmap'
  | 'tab.events'
  | 'page.iteration.not-started'
  | 'page.iteration.expand'
  | 'page.iteration.collapse'
  | 'event-log.title'
  | 'event-log.empty'
  | 'event-log.ledger-unavailable'
  | 'event-log.field.role'
  | 'event-log.field.agent'
  | 'event-log.field.plan'
  | 'event-log.field.task'
  | 'event-log.field.category'
  | 'event-log.field.time'
  | 'event-log.field.kind'
  | 'event-log.field.status'
  | 'event-log.field.settled'
  | 'event-log.field.duration'
  | 'event-log.field.child-id'
  | 'event-log.field.run-id'
  | 'event-log.field.name'
  | 'event-log.field.members'
  | 'event-log.field.stop-reason'
  | 'event-log.field.reason'
  | 'event-log.field.severity'
  | 'event-log.field.code'
  | 'event-log.field.message'
  | 'event-log.kind.dispatch'
  | 'event-log.kind.settle'
  | 'event-log.kind.violation'
  | 'event-log.yes'
  | 'event-log.no'
  | 'roadmap.title'
  | 'roadmap.direction'
  | 'roadmap.goals'
  | 'roadmap.milestones'
  | 'roadmap.expand'
  | 'roadmap.collapse'
  | 'roadmap.not-applicable'
  | 'roadmap.absent'
  | 'roadmap.no-milestones'
  | 'roadmap.unavailable'
  | 'roadmap.unassigned'
  | 'roadmap.milestone.no-issues'
  | 'empty.waiting'
  | 'empty.loading'
  | 'empty.unavailable'
  | 'empty.no-harness'
  | 'empty.no-harness-hint'
  | 'watermark.version'
  | 'watermark.harness'
  | 'watermark.none'
  | 'panel.unknown'
  | 'graph.pass'
  | 'graph.fail'
  | 'zone.iteration.step-label'
  | 'zone.iteration.step-badge'
  | 'zone.iteration.step.current'
  | 'zone.iteration.step.next'
  | 'zone.iteration.step.done'
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
  | 'zone.tasks.collapse'
  | 'zone.project.title'
  | 'zone.project.milestones'
  | 'zone.project.residuals'
  | 'zone.project.none'
  | 'zone.project.roadmap.empty'
  | 'zone.project.roadmap.absent'
  | 'zone.project.roadmap.unavailable'
  | 'zone.project.roadmap.partial'
  | 'zone.state.Todo'
  | 'zone.state.InProgress'
  | 'zone.state.InReview'
  | 'zone.state.Done'
  | 'zone.state.blocked-unknown'
  | 'flow.empty'
  | 'flow.settle-only'
  | 'flow.link-only'
  | 'flow.degraded'
  | 'flow.unexpected'
  | 'flow.in-flight'
  | 'flow.settled-ok'
  | 'flow.error'
  | 'flow.advisory'
  | 'flow.denied'
  | 'state.title'
  | 'state.selection'
  | 'state.selection.history'
  | 'state.selection.unbound'
  | 'state.selection.pick'
  | 'state.selection.pending'
  | 'state.selection.failed'
  | 'state.plans'
  | 'state.residuals'
  | 'state.knowledge'
  | 'state.direction'
  | 'state.none'
  | 'state.policy'
  | 'state.enforcement'
  | 'state.enforcement.hard'
  | 'state.enforcement.soft'
  | 'state.plans.more'
  | 'state.residual.more'
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
  'view.mstar-workflow': '晨星工作流',
  'guide.description': '查看工作区状态、计划与迭代进度',
  'tab.tasks': '任务迭代',
  'tab.roadmap': '项目路线图',
  'tab.events': '事件记录',
  'page.iteration.not-started': '迭代未启动',
  'page.iteration.expand': '展开',
  'page.iteration.collapse': '收拢',
  'event-log.title': '事件记录',
  'event-log.empty': '暂无记录',
  'event-log.ledger-unavailable': '事件账本不可读，无法展示流转记录',
  'event-log.field.role': '执行角色',
  'event-log.field.agent': 'Agent（会话）',
  'event-log.field.plan': '计划',
  'event-log.field.task': '任务',
  'event-log.field.category': '任务类别',
  'event-log.field.time': '时间',
  'event-log.field.kind': '类型',
  'event-log.field.status': '状态',
  'event-log.field.settled': '已结算',
  'event-log.field.duration': '耗时',
  'event-log.field.child-id': '子会话 ID',
  'event-log.field.run-id': '运行 ID',
  'event-log.field.name': '运行名称',
  'event-log.field.members': '成员数',
  'event-log.field.stop-reason': '停止原因',
  'event-log.field.reason': '未决原因',
  'event-log.field.severity': '严重度',
  'event-log.field.code': '代码',
  'event-log.field.message': '信息',
  'event-log.kind.dispatch': '派发',
  'event-log.kind.settle': '结算',
  'event-log.kind.violation': '违规',
  'event-log.yes': '是',
  'event-log.no': '否',
  'roadmap.title': '项目路线图',
  'roadmap.direction': '方向',
  'roadmap.goals': '目标',
  'roadmap.milestones': '里程碑',
  'roadmap.expand': '展开',
  'roadmap.collapse': '收起',
  'roadmap.not-applicable': '未解析到项目，路线图不可用',
  'roadmap.absent': '该项目尚无路线图',
  'roadmap.no-milestones': '路线图已存在，但尚无里程碑',
  'roadmap.unavailable': '路线图读取失败：{reason}',
  'roadmap.unassigned': '未归属议题：{count}',
  'roadmap.milestone.no-issues': '无未关闭议题',
  'empty.waiting': '等待首条 engine-status catalog…',
  'empty.loading': '正在读取该会话的 engine-status 快照…',
  'empty.unavailable': 'engine-status 快照不可用（{reason}）',
  'empty.no-harness': '未检测到 Morning Star harness',
  'empty.no-harness-hint': '当前工作区未发现 .mstar/ harness 目录，详细面板保持未激活；检测到 harness 后自动呈现',
  'watermark.version': 'mstar {version}',
  'watermark.harness': 'harness: {dir}',
  'watermark.none': '无',
  'panel.unknown': '未知',
  'graph.pass': 'PASS',
  'graph.fail': 'FAIL',
  'zone.iteration.step-label': '{n}/{total}',
  'zone.iteration.step-badge': '{n}',
  'zone.iteration.step.current': '当前',
  'zone.iteration.step.next': '下一步',
  'zone.iteration.step.done': '已完成',
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
  'zone.tasks.collapse': '收起',
  'zone.project.title': '项目汇总',
  'zone.project.milestones': '里程碑',
  'zone.project.residuals': '未结残留',
  'zone.project.none': '无',
  'zone.project.roadmap.empty': '路线图已登记，但尚无里程碑',
  'zone.project.roadmap.absent': '路线图 authority 中没有项目记录',
  'zone.project.roadmap.unavailable': '路线图 authority 不可用（{reason}）',
  'zone.project.roadmap.partial': '以下项目没有路线图：{projects}',
  'zone.state.Todo': '待办',
  'zone.state.InProgress': '进行中',
  'zone.state.InReview': '审查中',
  'zone.state.Done': '已完成',
  'zone.state.blocked-unknown': '受阻/未知',
  'flow.empty': '暂无实际派发（记录自 agent-flow plan 合并起生效）',
  'flow.settle-only': '仅有结算记录（无派发证据）',
  'flow.link-only': '仅有身份记录（无派发证据）',
  'flow.degraded': 'agentFlow 证据缺失',
  'flow.unexpected': '未匹配角色',
  'flow.in-flight': '已派发',
  'flow.settled-ok': '已结算',
  'flow.error': '出错',
  'flow.advisory': '提示',
  'flow.denied': '拒绝',
  'state.title': '工作区状态',
  'state.selection': '所选工作流',
  'state.selection.history': '历史视图（终端快照）',
  'state.selection.unbound': '存在多个活动工作流——请为本会话选择一个。本会话没有租约，也不在任何工作流工作区内。选择之前写入会暂停。其他会话保持各自的绑定。',
  'state.selection.pick': '选择 {workflowId}',
  'state.selection.pending': '正在提交选择…',
  'state.selection.failed': '选择失败：{reason}',
  'state.plans': '计划',
  'state.residuals': '未决残留',
  'state.knowledge': '知识',
  'state.direction': '方向',
  'state.none': '无',
  'state.policy': '策略',
  'state.enforcement': '执行策略',
  'state.enforcement.hard': 'hard',
  'state.enforcement.soft': 'soft',
  'state.plans.more': '+{count} 更多',
  'state.residual.more': '+{count} 更多',
  'state.knowledge.docs': '{count} 篇文档',
  'freshness.last-updated': '快照 {time} · 第 {turn} 轮',
  'freshness.refresh-note': '该会话已存储的快照——不是实时值',
}

/** en dictionary (default locale). */
export const en: LocaleDictOf<'mstar-panel'> = {
  'view.mstar-workflow': 'Morning Star Workflow',
  'guide.description': 'Workspace state, plans, and iteration progress',
  'tab.tasks': 'Task Iteration',
  'tab.roadmap': 'Roadmap',
  'tab.events': 'Event Log',
  'page.iteration.not-started': 'iteration not started',
  'page.iteration.expand': 'expand',
  'page.iteration.collapse': 'collapse',
  'event-log.title': 'Event Log',
  'event-log.empty': 'No records yet',
  'event-log.ledger-unavailable': 'The event ledger is unreadable — no flow records can be shown',
  'event-log.field.role': 'Role',
  'event-log.field.agent': 'Agent (session)',
  'event-log.field.plan': 'Plan',
  'event-log.field.task': 'Task',
  'event-log.field.category': 'Category',
  'event-log.field.time': 'Time',
  'event-log.field.kind': 'Kind',
  'event-log.field.status': 'Status',
  'event-log.field.settled': 'Settled',
  'event-log.field.duration': 'Duration',
  'event-log.field.child-id': 'Child session ID',
  'event-log.field.run-id': 'Run ID',
  'event-log.field.name': 'Run name',
  'event-log.field.members': 'Members',
  'event-log.field.stop-reason': 'Stop reason',
  'event-log.field.reason': 'Unresolved reason',
  'event-log.field.severity': 'Severity',
  'event-log.field.code': 'Code',
  'event-log.field.message': 'Message',
  'event-log.kind.dispatch': 'dispatch',
  'event-log.kind.settle': 'settle',
  'event-log.kind.violation': 'violation',
  'event-log.yes': 'yes',
  'event-log.no': 'no',
  'roadmap.title': 'Project roadmap',
  'roadmap.direction': 'Direction',
  'roadmap.goals': 'Goals',
  'roadmap.milestones': 'Milestones',
  'roadmap.expand': 'expand',
  'roadmap.collapse': 'collapse',
  'roadmap.not-applicable': 'No project resolved — the roadmap is not applicable',
  'roadmap.absent': 'This project has no roadmap yet',
  'roadmap.no-milestones': 'The roadmap exists, with no milestones yet',
  'roadmap.unavailable': 'Roadmap read failed: {reason}',
  'roadmap.unassigned': 'Unassigned issues: {count}',
  'roadmap.milestone.no-issues': 'No open issues',
  'empty.waiting': 'Waiting for the first engine-status catalog…',
  'empty.loading': 'Reading this session’s engine-status snapshot…',
  'empty.unavailable': 'Engine-status snapshot unavailable ({reason})',
  'empty.no-harness': 'No Morning Star harness detected',
  'empty.no-harness-hint': 'No .mstar/ harness directory found in this workspace — the detail panel stays inactive and activates automatically once a harness is detected',
  'watermark.version': 'mstar {version}',
  'watermark.harness': 'harness: {dir}',
  'watermark.none': 'none',
  'panel.unknown': 'unknown',
  'graph.pass': 'PASS',
  'graph.fail': 'FAIL',
  'zone.iteration.step-label': '{n}/{total}',
  'zone.iteration.step-badge': '{n}',
  'zone.iteration.step.current': 'current',
  'zone.iteration.step.next': 'next',
  'zone.iteration.step.done': 'done',
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
  'zone.tasks.collapse': 'collapse',
  'zone.project.title': 'Project Rollup',
  'zone.project.milestones': 'Milestones',
  'zone.project.residuals': 'Open Residuals',
  'zone.project.none': 'none',
  'zone.project.roadmap.empty': 'Roadmap is present but has no milestones',
  'zone.project.roadmap.absent': 'No project records are present in the roadmap authority',
  'zone.project.roadmap.unavailable': 'Roadmap authority unavailable ({reason})',
  'zone.project.roadmap.partial': 'No roadmap is recorded for these projects: {projects}',
  'zone.state.Todo': 'Todo',
  'zone.state.InProgress': 'InProgress',
  'zone.state.InReview': 'InReview',
  'zone.state.Done': 'Done',
  'zone.state.blocked-unknown': 'Blocked / Unknown',
  'flow.empty': 'No actual dispatches yet (recording starts at agent-flow plan merge)',
  'flow.settle-only': 'Settle records only (no dispatch evidence)',
  'flow.link-only': 'Identity records only (no dispatch evidence)',
  'flow.degraded': 'No agent-flow evidence (ledger missing)',
  'flow.unexpected': 'Unexpected roles',
  'flow.in-flight': 'dispatched',
  'flow.settled-ok': 'settled ok',
  'flow.error': 'error',
  'flow.advisory': 'advisory',
  'flow.denied': 'denied',
  'state.title': 'Workspace state',
  'state.selection': 'Selected workflow',
  'state.selection.history': 'history view (terminal snapshot)',
  'state.selection.unbound': 'Multiple active workflows — pick one for this session. This session has no lease and is not inside a workflow worktree. Writes pause until you pick. Other sessions stay on their own binding.',
  'state.selection.pick': 'Select {workflowId}',
  'state.selection.pending': 'Committing your pick…',
  'state.selection.failed': 'Pick failed: {reason}',
  'state.plans': 'Plans',
  'state.residuals': 'Open residuals',
  'state.knowledge': 'Knowledge',
  'state.direction': 'Direction',
  'state.none': 'none',
  'state.policy': 'Policy',
  'state.enforcement': 'enforcement',
  'state.enforcement.hard': 'hard',
  'state.enforcement.soft': 'soft',
  'state.plans.more': '+{count} more',
  'state.residual.more': '+{count} more',
  'state.knowledge.docs': '{count} docs',
  'freshness.last-updated': 'snapshot {time} · turn {turn}',
  'freshness.refresh-note': 'the stored snapshot for this session — never a live value',
}
