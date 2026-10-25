/**
 * `mstar-panel` locale namespace: the HOST-ONLY chrome this plugin still owns.
 *
 * After the unified-product migration (plan dsh-panel-unification Tasks 2–5)
 * every product string comes from `@mstar-harness/ui`'s bilingual dictionary,
 * keyed by the host's locale. What is left here is the seat chrome the shared
 * layer cannot know: the panel's own name (tab type, guide capsule, nav
 * landmark, sidebar row), the host affordance that opens the full page, and the
 * seat's four transport states (which exist before any product screen does).
 *
 * The registry and the tab/zone/roadmap/event-log/state/freshness families are
 * DELETED with the surfaces that rendered them — dead copy in a shipped bundle
 * is inventory, not a translation.
 */

import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Locale namespace id for the workflow panel. */
export const NS = 'mstar-panel'

/** Panel dictionary keys: the host-only chrome above, and nothing else. */
export type PanelKey =
  | 'view.mstar-workflow'
  | 'guide.description'
  | 'panel.open-full-page'
  | 'empty.waiting'
  | 'empty.loading'
  | 'empty.unavailable'
  | 'empty.no-harness'
  | 'empty.no-harness-hint'
  | 'empty.no-session'
  | 'state.pick.pending'
  | 'state.pick.selected'
  | 'state.pick.failed'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'mstar-panel': PanelKey
  }
}

/** zh dictionary (repo bilingual convention; zh is the stub fallback locale). */
export const zh: LocaleDictOf<'mstar-panel'> = {
  'view.mstar-workflow': '晨星工作流',
  'guide.description': '查看工作区状态、计划与迭代进度',
  'panel.open-full-page': '在主页打开',
  'empty.waiting': '等待工作区快照…',
  'empty.loading': '正在读取工作区快照…',
  'empty.unavailable': '工作区快照不可用：{reason}',
  'empty.no-harness': '未检测到工作区 harness',
  'empty.no-harness-hint': '此工作区未声明 {HARNESS_DIR}，因此没有可读取的内容。',
  'empty.no-session': '此面板没有会话绑定（主面板不绑定会话），因此没有会话事实可显示。',
  'state.pick.pending': '正在提交选择…',
  'state.pick.selected': '已绑定 {workflowId}',
  'state.pick.failed': '选择失败：{reason}',
}

/** en dictionary (the host's fallback locale). */
export const en: LocaleDictOf<'mstar-panel'> = {
  'view.mstar-workflow': 'Morning Star Workflow',
  'guide.description': 'See the workspace state, plans and iteration progress',
  'panel.open-full-page': 'Open full page',
  'empty.waiting': 'Waiting for the workspace snapshot…',
  'empty.loading': 'Reading this workspace’s snapshot…',
  'empty.unavailable': 'The workspace snapshot is unavailable: {reason}',
  'empty.no-harness': 'No workspace harness detected',
  'empty.no-harness-hint': 'This workspace declares no {HARNESS_DIR}, so there is nothing to read.',
  'empty.no-session': 'This panel has no session binding (a main-area panel is not session-bound), so there are no session facts to show.',
  'state.pick.pending': 'Committing your pick…',
  'state.pick.selected': 'Bound to {workflowId}',
  'state.pick.failed': 'Pick failed: {reason}',
}
