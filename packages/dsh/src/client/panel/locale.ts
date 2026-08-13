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
 * the graph library; only `graph.pass` / `graph.fail` remain (the
 * gate-verdict labels reused by the tabs-shell IterationTaskPage head), and
 * the new `zone.*` family covers the three zone titles/placeholders + the
 * zone-semantic legend. The `flow.*` key family (agent-flow event dock) is
 * unchanged. The old footer's violations copy (`graph.violations` /
 * `graph.no-violations`) is carried by the event-log plan — it adds its own
 * dedicated keys when that page lands, NOT reserved in this union.
 *
 * T3 (spec panel-zones §3): the iteration zone is filled in — `zone.phase.*`
 * (the 5 PHASE_IDS names, the `graph.phase.*` wording moved into the zone
 * namespace), `zone.iteration.*` (Step N/5 label, Step N badge, step-state
 * chips) and `zone.branches.*` (the branch panel
 * moved from the sidebar). `zone.iteration.placeholder` is gone with the
 * placeholder.
 *
 * T4 (spec panel-zones §3): the task board kanban is filled in —
 * `zone.state.*` (the 5 PLAN_STATE_IDS column names — en is the raw status
 * word, zh the localized name; `blocked-unknown` is the merged
 * Blocked/unknown column, plan 20260813-panel-quick-fixes Task 1),
 * `zone.tasks.total` (zone header plan total), `zone.tasks.no-plans` (the
 * muted empty note), `zone.tasks.more` (the per-column `+N more` expand
 * affordance) and `zone.tasks.collapse` (the 「收起」 collapse label).
 * `zone.tasks.placeholder` is gone with the placeholder.
 *
 * T2 (spec panel-zones §4, plan 20260810-panel-agent-flow-zone): the agents
 * zone is filled in — `zone.agents.summary` (`N executing · M pending`).
 * `zone.agents.placeholder` is gone with the placeholder; the dashed
 * "待执行" chip (`pending-label`) and the animated next-edge label (`next`)
 * keys were removed with the AgentFlowZone in the agent-canvas QC wave
 * (S-001 — the free canvas renders neither, so they had zero consumers).
 *
 * T3 (same plan): the dock is collapsible (the frame is a native <details>,
 * header = <summary>) and the legend gains the entity-status swatches —
 * `zone.legend.agent-running` / `zone.legend.agent-settled` (the status-dot
 * treatments of the entity cards; the `zone.agents.*` family itself stays
 * minimal — title/summary, both rendered by the canvas, so no
 * `zone.agents.status.*` family is added: a status TEXT on the cards would be
 * dead strings, the spec §4 card shows a status point, and reusing `flow.*`
 * would conflate event status words (dispatched/settled ok) with entity
 * status words).
 *
 * T1 (spec panel-tabs §2/§6.1, plan 20260811-panel-tabs-shell): the panel is
 * re-laid-out as Tabs + Content — `tab.*` covers the 3 fixed MenuTab labels
 * (任务迭代 / 代理执行 / 事件记录) and `page.*.placeholder` the muted
 * placeholder copy for the agents/events tabs (the real pages land with the
 * agent-canvas / event-log plans; Task 3 refines the placeholders).
 *
 * T2 (spec panel-tabs §3, plan 20260811-panel-tabs-shell Task 2): the
 * IterationTaskPage head copy — `page.iteration.*` (the collapsed one-line
 * "not started" note + the expand/collapse toggle hints). The head reuses the
 * existing `zone.iteration.*` (step badge / Step n/5 label / step-state
 * chips), `zone.phase.*` (the 5 PHASE_IDS names) and `zone.branches.*`
 * (branch panel) keys; the kanban reuses `zone.tasks.*` / `zone.state.*`.
 *
 * T3 (spec panel-tabs §4, plan 20260811-panel-agent-canvas Task 3): the
 * legend re-mounts on the agent canvas — `zone.legend.agent-idle` (the idle
 * card treatment) joins the swatch family and the collaboration-edge labels
 * (flow-expected / flow-actual / general) now describe the canvas rendering
 * (dashed/solid lines + the general bucket — plan
 * 20260811-panel-f3-agent-general replaced the former flow-unexpected entry)
 * instead of the retired zone-dashboard stages; `flow.settle-only` is the
 * distinct muted copy for the settle-only canvas note (review T2-Imp-2
 * restored the old zone's separate anchor).
 *
 * T2 (plan 20260811-panel-f4-agent-view): the general bucket has NO column
 * of its own anymore — `zone.agents.general` is REPURPOSED as the small
 * in-bucket label on the general card (which sinks to the bottom of the
 * `sdd-implement` column — the value stays the user-fixed literal 'general'
 * in both locales); `zone.legend.general` rewords to the sink semantics
 * (「general 位于 sdd-implement 桶内底部」).
 *
 * T2 (plan 20260812-panel-f5-agent-layout Task 2 — the layout rework
 * supersedes the F4.2 sink): the general bucket moves to its OWN rightmost
 * UNKNOWN column — `zone.agents.unknown` (the column label, 未知 / unknown);
 * the in-bucket general tag is gone (the general card's title + the unknown
 * column label carry it), so `zone.agents.general` is REMOVED. The
 * `sdd-implement` column splits into sub-buckets — `zone.agents.bucket.*`
 * (implementor / sdd-reviewer caption labels); `zone.agents.on-demand`
 * re-keys as the on-demand BADGE (the implementor-sub-bucket roles, the
 * standalone on-demand column is removed). The legend entries gain
 * `zone.legend.sub-bucket` / `zone.legend.supervise` / `zone.legend.unknown`
 * (the former 'general' entry is replaced by 'unknown'); `zone.legend.general`
 * is REMOVED and `zone.legend.on-demand` rewords to the badge semantics.
 *
 * T5 (plan 20260812-panel-f5-design-system Task 5 — the 2026-08-12 edge
 * rework supersedes the Task-2 unknown COLUMN): the standalone rightmost
 * unknown column is REMOVED (user feedback #3 — FOUR columns total) — the
 * general bucket sinks into an unknown SUB-PARTITION at the bottom of the
 * LAST column, so `zone.agents.unknown` (the old column label) is REMOVED
 * and `zone.agents.unknown-sub` (「unknown / 未匹配角色」) is the sub-partition
 * caption. The legend drops the expected / next entries (both edges are
 * REMOVED, design doc §2.2) and gains `zone.legend.port` (the hover-visible
 * card ports, design doc §2.5); `zone.legend.flow-actual` / `supervise` /
 * `unknown` reword to the bezier / port-anchored / side-gap / sub-partition
 * semantics.
 *
 * T3 (plan 20260812-panel-f5-agent-layout Task 3): the no-harness branch
 * renders a CENTERED inactive-state card (icon + title + hint, no tabs /
 * no sidebar) instead of the left-aligned hint — `empty.no-harness-hint`
 * is the explanatory secondary copy under the reused `empty.no-harness`
 * title.
 *
 * T1 (plan 20260813-panel-agent-canvas-legend-layout Task 1 — 图例精简): the
 * legend narrows to the 3 role-card status entries —
 * `zone.legend.flow-actual` / `port` / `group` / `sub-bucket` / `supervise` /
 * `on-demand` / `unknown` are REMOVED (the collaboration-edge / layout tech
 * entries; the canvas itself keeps the edges / ports / partitions — only the
 * legend copy drops them). `zone.legend.agent-running` / `agent-settled` /
 * `agent-idle` remain.
 */

import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace id for the workflow-viz panel. */
export const NS = 'mstar-panel'

/** Panel dictionary keys (union of every translatable string the panel renders). */
export type PanelKey =
  | 'view.mstar-workflow'
  | 'tab.tasks'
  | 'tab.agents'
  | 'tab.events'
  | 'page.iteration.not-started'
  | 'page.iteration.expand'
  | 'page.iteration.collapse'
  | 'event-log.section.events'
  | 'event-log.section.violations'
  | 'event-log.empty'
  | 'event-log.empty.events'
  | 'event-log.empty.violations'
  | 'event-log.field.role'
  | 'event-log.field.agent'
  | 'event-log.field.stage'
  | 'event-log.field.plan'
  | 'event-log.field.task'
  | 'event-log.field.category'
  | 'event-log.field.time'
  | 'event-log.field.kind'
  | 'event-log.field.status'
  | 'event-log.field.expected'
  | 'event-log.field.settled'
  | 'event-log.field.duration'
  | 'event-log.field.severity'
  | 'event-log.field.code'
  | 'event-log.field.message'
  | 'event-log.kind.dispatch'
  | 'event-log.kind.settle'
  | 'event-log.yes'
  | 'event-log.no'
  | 'empty.waiting'
  | 'empty.no-harness'
  | 'empty.no-harness-hint'
  | 'watermark.version'
  | 'watermark.harness'
  | 'watermark.none'
  | 'panel.unknown'
  | 'graph.pass'
  | 'graph.fail'
  | 'zone.legend.title'
  | 'zone.legend.agent-running'
  | 'zone.legend.agent-settled'
  | 'zone.legend.agent-idle'
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
  | 'zone.state.Todo'
  | 'zone.state.InProgress'
  | 'zone.state.InReview'
  | 'zone.state.Done'
  | 'zone.state.blocked-unknown'
  | 'zone.agents.title'
  | 'zone.agents.summary'
  | 'zone.agents.on-demand'
  | 'zone.agents.unknown-sub'
  | 'zone.agents.bucket.implementor'
  | 'zone.agents.bucket.reviewer'
  | 'zone.agents.group.phase-1'
  | 'zone.agents.group.phase-2'
  | 'zone.agents.group.phase-n'
  | 'zone.agents.group.plan'
  | 'zone.agents.group.no-plan'
  | 'zone.agents.group.plan-more'
  | 'flow.empty'
  | 'flow.settle-only'
  | 'flow.degraded'
  | 'flow.unexpected'
  | 'flow.in-flight'
  | 'flow.settled-ok'
  | 'flow.error'
  | 'flow.advisory'
  | 'flow.denied'
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
  'tab.tasks': '任务迭代',
  'tab.agents': '代理执行',
  'tab.events': '事件记录',
  'page.iteration.not-started': '迭代未启动',
  'page.iteration.expand': '展开',
  'page.iteration.collapse': '收拢',
  'event-log.section.events': 'Agent 流转事件',
  'event-log.section.violations': '违规记录',
  'event-log.empty': '暂无记录',
  'event-log.empty.events': '暂无流转事件',
  'event-log.empty.violations': '暂无违规记录',
  'event-log.field.role': '执行角色',
  'event-log.field.agent': 'Agent（会话）',
  'event-log.field.stage': '阶段',
  'event-log.field.plan': '计划',
  'event-log.field.task': '任务',
  'event-log.field.category': '任务类别',
  'event-log.field.time': '时间',
  'event-log.field.kind': '类型',
  'event-log.field.status': '状态',
  'event-log.field.expected': '预期角色',
  'event-log.field.settled': '已结算',
  'event-log.field.duration': '耗时',
  'event-log.field.severity': '严重度',
  'event-log.field.code': '代码',
  'event-log.field.message': '信息',
  'event-log.kind.dispatch': '派发',
  'event-log.kind.settle': '结算',
  'event-log.yes': '是',
  'event-log.no': '否',
  'empty.waiting': '等待首条 engine-status catalog…',
  'empty.no-harness': '未检测到 Morning Star harness',
  'empty.no-harness-hint': '当前工作区未发现 .mstar/ harness 目录，详细面板保持未激活；检测到 harness 后自动呈现',
  'watermark.version': 'mstar {version}',
  'watermark.harness': 'harness: {dir}',
  'watermark.none': '无',
  'panel.unknown': '未知',
  'graph.pass': 'PASS',
  'graph.fail': 'FAIL',
  'zone.legend.title': '图例',
  'zone.legend.agent-running': '执行中实体（发光）',
  'zone.legend.agent-settled': '已完成实体（独立绿框 + ✓；off 阶段不显示）',
  'zone.legend.agent-idle': '未工作实体（虚线）',
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
  'zone.state.Todo': '待办',
  'zone.state.InProgress': '进行中',
  'zone.state.InReview': '审查中',
  'zone.state.Done': '已完成',
  'zone.state.blocked-unknown': '受阻/未知',
  'zone.agents.title': '代理执行',
  'zone.agents.summary': '{executing} 执行中 · {pending} 待执行',
  'zone.agents.on-demand': '按需执行',
  'zone.agents.unknown-sub': 'unknown / 未匹配角色',
  'zone.agents.bucket.implementor': 'implementor',
  'zone.agents.bucket.reviewer': 'sdd-reviewer',
  'zone.agents.group.phase-1': 'Phase 1 · 顺序完成（review-edit-chain）',
  'zone.agents.group.phase-2': 'Phase 2 · 循环迭代 plans',
  'zone.agents.group.phase-n': 'Phase {n}',
  'zone.agents.group.plan': 'plan: {plan}',
  'zone.agents.group.no-plan': '无进行中 plan',
  'zone.agents.group.plan-more': '+{n} 更多',
  'flow.empty': '暂无实际派发（记录自 agent-flow plan 合并起生效）',
  'flow.settle-only': '仅有结算记录（无派发证据）',
  'flow.degraded': 'agentFlow 证据缺失',
  'flow.unexpected': '未匹配角色',
  'flow.in-flight': '已派发',
  'flow.settled-ok': '已结算',
  'flow.error': '出错',
  'flow.advisory': '提示',
  'flow.denied': '拒绝',
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
  'tab.tasks': 'Task Iteration',
  'tab.agents': 'Agent Run',
  'tab.events': 'Event Log',
  'page.iteration.not-started': 'iteration not started',
  'page.iteration.expand': 'expand',
  'page.iteration.collapse': 'collapse',
  'event-log.section.events': 'Agent flow events',
  'event-log.section.violations': 'Violations',
  'event-log.empty': 'No records yet',
  'event-log.empty.events': 'No flow events yet',
  'event-log.empty.violations': 'No violations yet',
  'event-log.field.role': 'Role',
  'event-log.field.agent': 'Agent (session)',
  'event-log.field.stage': 'Stage',
  'event-log.field.plan': 'Plan',
  'event-log.field.task': 'Task',
  'event-log.field.category': 'Category',
  'event-log.field.time': 'Time',
  'event-log.field.kind': 'Kind',
  'event-log.field.status': 'Status',
  'event-log.field.expected': 'Expected role',
  'event-log.field.settled': 'Settled',
  'event-log.field.duration': 'Duration',
  'event-log.field.severity': 'Severity',
  'event-log.field.code': 'Code',
  'event-log.field.message': 'Message',
  'event-log.kind.dispatch': 'dispatch',
  'event-log.kind.settle': 'settle',
  'event-log.yes': 'yes',
  'event-log.no': 'no',
  'empty.waiting': 'Waiting for the first engine-status catalog…',
  'empty.no-harness': 'No Morning Star harness detected',
  'empty.no-harness-hint': 'No .mstar/ harness directory found in this workspace — the detail panel stays inactive and activates automatically once a harness is detected',
  'watermark.version': 'mstar {version}',
  'watermark.harness': 'harness: {dir}',
  'watermark.none': 'none',
  'panel.unknown': 'unknown',
  'graph.pass': 'PASS',
  'graph.fail': 'FAIL',
  'zone.legend.title': 'Legend',
  'zone.legend.agent-running': 'agent running (glow)',
  'zone.legend.agent-settled': 'settled agent (green done frame + ✓; off-tier roles show neither)',
  'zone.legend.agent-idle': 'idle agent (dashed)',
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
  'zone.state.Todo': 'Todo',
  'zone.state.InProgress': 'InProgress',
  'zone.state.InReview': 'InReview',
  'zone.state.Done': 'Done',
  'zone.state.blocked-unknown': 'Blocked / Unknown',
  'zone.agents.title': 'Agent Flow',
  'zone.agents.summary': '{executing} executing · {pending} pending',
  'zone.agents.on-demand': 'On-demand',
  'zone.agents.unknown-sub': 'unknown / unmatched roles',
  'zone.agents.bucket.implementor': 'implementor',
  'zone.agents.bucket.reviewer': 'sdd-reviewer',
  'zone.agents.group.phase-1': 'Phase 1 · sequential (review-edit-chain)',
  'zone.agents.group.phase-2': 'Phase 2 · iterative plan loop',
  'zone.agents.group.phase-n': 'Phase {n}',
  'zone.agents.group.plan': 'plan: {plan}',
  'zone.agents.group.no-plan': 'no in-progress plan',
  'zone.agents.group.plan-more': '+{n} more',
  'flow.empty': 'No actual dispatches yet (recording starts at agent-flow plan merge)',
  'flow.settle-only': 'Settle records only (no dispatch evidence)',
  'flow.degraded': 'No agent-flow evidence (ledger missing)',
  'flow.unexpected': 'Unexpected roles',
  'flow.in-flight': 'dispatched',
  'flow.settled-ok': 'settled ok',
  'flow.error': 'error',
  'flow.advisory': 'advisory',
  'flow.denied': 'denied',
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
