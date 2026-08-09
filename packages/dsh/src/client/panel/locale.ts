/**
 * `mstar-panel` locale namespace (spec §4.3): en (default) + zh, registered
 * via `ctx.locale.register(NS, { zh, en })` at plugin apply. The key union is
 * merged into the ui-slots `LocaleNamespaceMap` so the framework synthesizes
 * a typed `t` seat for the panel component (dictionary keys are checked
 * against the union by `LocaleDictOf`).
 */

import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace id for the workflow-viz panel. */
export const NS = 'mstar-panel'

/** Panel dictionary keys (union of every translatable string the panel renders). */
export type PanelKey =
  | 'view.mstar-workflow'
  | 'empty.waiting'
  | 'empty.no-harness'
  | 'header.version'
  | 'header.harness'
  | 'header.enforcement'
  | 'watermark.version'
  | 'watermark.harness'
  | 'watermark.enforcement'
  | 'watermark.hard'
  | 'watermark.soft'
  | 'watermark.none'
  | 'panel.unknown'
  | 'graph.placeholder'
  | 'iteration.title'
  | 'iteration.id'
  | 'iteration.transition'
  | 'iteration.plans-done'
  | 'iteration.gate'
  | 'iteration.pass'
  | 'iteration.fail'
  | 'iteration.entry'
  | 'iteration.exit'
  | 'iteration.status-path'
  | 'iteration.compass-path'
  | 'iteration.violations'
  | 'iteration.no-violations'
  | 'iteration.no-compass'
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
  'header.version': '版本',
  'header.harness': 'harness 目录',
  'header.enforcement': '执行策略',
  'watermark.version': 'mstar {version}',
  'watermark.harness': 'harness: {dir}',
  'watermark.enforcement': 'enforcement: {value}',
  'watermark.hard': 'hard',
  'watermark.soft': 'soft',
  'watermark.none': '无',
  'panel.unknown': '未知',
  'graph.placeholder': '图区占位 —— 工作流循环图在 Task 2 接入',
  'iteration.title': '迭代',
  'iteration.id': 'id',
  'iteration.transition': 'transition',
  'iteration.plans-done': 'all plans done',
  'iteration.gate': 'gate',
  'iteration.pass': 'PASS',
  'iteration.fail': 'FAIL',
  'iteration.entry': 'entry',
  'iteration.exit': 'exit',
  'iteration.status-path': 'status',
  'iteration.compass-path': 'compass',
  'iteration.violations': '违规 ({count})',
  'iteration.no-violations': '无违规',
  'iteration.no-compass': '无 steering compass / status.json',
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
  'header.version': 'version',
  'header.harness': 'harness',
  'header.enforcement': 'enforcement',
  'watermark.version': 'mstar {version}',
  'watermark.harness': 'harness: {dir}',
  'watermark.enforcement': 'enforcement: {value}',
  'watermark.hard': 'hard',
  'watermark.soft': 'soft',
  'watermark.none': 'none',
  'panel.unknown': 'unknown',
  'graph.placeholder': 'Graph canvas placeholder — workflow loop graph arrives in Task 2',
  'iteration.title': 'Iteration',
  'iteration.id': 'id',
  'iteration.transition': 'transition',
  'iteration.plans-done': 'all plans done',
  'iteration.gate': 'gate',
  'iteration.pass': 'PASS',
  'iteration.fail': 'FAIL',
  'iteration.entry': 'entry',
  'iteration.exit': 'exit',
  'iteration.status-path': 'status',
  'iteration.compass-path': 'compass',
  'iteration.violations': 'violations ({count})',
  'iteration.no-violations': 'no violations',
  'iteration.no-compass': 'No steering compass / status.json',
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
