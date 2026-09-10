/**
 * TabNav (spec panel-tabs §2/§6.1) —
 * the section nav, the shell's first flex zone (`flex: none`): the three
 * internal sections (任务迭代 / 代理执行 / 事件记录) of the one sidebar tab.
 * Section state is owned by the panel entry store (plan sidebar §L2.4 —
 * keyed by the sidebar tab record, default 'tasks', no routing); TabNav is a
 * controlled component receiving `active` + `onChange` (spec §6.1 interface
 * contract).
 *
 * Anchors: `data-mstar-tab-nav` (the nav frame), `data-mstar-tab="{id}"` on
 * every tab and `data-mstar-tab-active="true|false"` (activation state). The
 * active tab gets the business-token underline; inactive tabs stay secondary.
 * Visual language (plan sidebar §L2.3): the strip ABOVE this nav is the dsh
 * tab chrome (chips with borders — the host's, untouched); this nav is
 * content — `role="tablist"`, `role="tab"` + `aria-selected`, the underline
 * via `box-shadow`, no borders on the tabs.
 *
 * A11y: WAI-ARIA tablist, each tab a `role="tab"` button with
 * `aria-selected` (APG Tabs pattern). Deliberately minimal: every tab stays
 * Tab-reachable (no roving tabindex / arrow-key handling — that behavior
 * would be scope creep without an explicit keyboard contract).
 */

import * as React from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelKey } from './locale.ts'
import type { PanelSection } from './panel-store.ts'
import css from './panel.module.css'

export interface TabNavProps {
  active: PanelSection
  onChange: (tab: PanelSection) => void
  t: TranslateNS<'mstar-panel'>
}

/** Fixed section list: order = 任务迭代 / 代理执行 / 事件记录. */
const TABS: readonly { id: PanelSection; label: PanelKey }[] = [
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
