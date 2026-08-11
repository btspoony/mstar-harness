/**
 * TabNav (spec panel-tabs §2/§6.1, plan 20260811-panel-tabs-shell Task 1) —
 * the fixed header nav: 3 MenuTabs (任务迭代 / 代理执行 / 事件记录, F1.2)
 * switching the main content. Tab state is owned by PanelView
 * (`useState<PanelTab>`, default 'tasks', no routing — SSR-stable under
 * `renderToStaticMarkup`); TabNav is a controlled component receiving
 * `active` + `onChange` (spec §6.1 interface contract).
 *
 * Anchors: `data-mstar-tab-nav` (the nav frame), `data-mstar-tab="{id}"` on
 * every tab and `data-mstar-tab-active="true|false"` (activation state). The
 * active tab gets the business-token underline; inactive tabs stay secondary.
 *
 * A11y (QC wave): the nav is a WAI-ARIA tablist and each tab is a
 * `role="tab"` button with `aria-selected` (APG Tabs pattern, replacing the
 * former `aria-pressed` toggle). Deliberately minimal: every tab stays Tab-
 * reachable (no roving tabindex / arrow-key handling — that behavior would
 * be scope creep without an explicit keyboard contract).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelKey } from './locale.ts'
import css from './panel.module.css'

/** The three fixed panel tabs (spec §2 — D1 default = 'tasks'). */
export type PanelTab = 'tasks' | 'agents' | 'events'

export interface TabNavProps {
  active: PanelTab
  onChange: (tab: PanelTab) => void
  t: TranslateNS<'mstar-panel'>
}

/** Fixed tab list (F1.2): order = 任务迭代 / 代理执行 / 事件记录. */
const TABS: readonly { id: PanelTab; label: PanelKey }[] = [
  { id: 'tasks', label: 'tab.tasks' },
  { id: 'agents', label: 'tab.agents' },
  { id: 'events', label: 'tab.events' },
]

export function TabNav({ active, onChange, t }: TabNavProps) {
  return (
    <nav className={css.tabNav} data-mstar-tab-nav role="tablist">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          className={active === tab.id ? `${css.tab} ${css.tabActive}` : css.tab}
          data-mstar-tab={tab.id}
          data-mstar-tab-active={active === tab.id ? 'true' : 'false'}
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          {t(tab.label)}
        </button>
      ))}
    </nav>
  )
}
